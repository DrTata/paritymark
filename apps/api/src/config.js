const { pool } = require('./db');

const DEPLOYMENTS_TABLE_NAME = 'deployments';
const CONFIG_VERSIONS_TABLE_NAME = 'config_versions';
const CONFIG_ARTIFACTS_TABLE_NAME = 'config_artifacts';

/**
 * Handle known-benign concurrency errors for CREATE TABLE IF NOT EXISTS,
 * mirroring the audit module's behaviour.
 */
function handleConcurrentDdlError(err) {
  const code = err && err.code;
  const message = (err && err.message) || '';

  // Duplicate table
  if (code === '42P07') {
    return;
  }

  // Unique violation on pg_type_typname_nsp_index during concurrent DDL
  if (code === '23505' && message.includes('pg_type_typname_nsp_index')) {
    return;
  }

  throw err;
}

/**
 * Ensure that the config-related tables exist.
 * This mirrors the lazy creation approach used in the audit module.
 */
async function ensureConfigTables() {
  const createDeploymentsSql = `
    CREATE TABLE IF NOT EXISTS ${DEPLOYMENTS_TABLE_NAME} (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at TIMESTAMPTZ
    )
  `;

  const createConfigVersionsSql = `
    CREATE TABLE IF NOT EXISTS ${CONFIG_VERSIONS_TABLE_NAME} (
      id SERIAL PRIMARY KEY,
      deployment_id INTEGER NOT NULL REFERENCES ${DEPLOYMENTS_TABLE_NAME}(id),
      version_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_at TIMESTAMPTZ,
      activated_at TIMESTAMPTZ,
      created_by TEXT,
      UNIQUE (deployment_id, version_number)
    )
  `;

  const createConfigArtifactsSql = `
    CREATE TABLE IF NOT EXISTS ${CONFIG_ARTIFACTS_TABLE_NAME} (
      id SERIAL PRIMARY KEY,
      config_version_id INTEGER NOT NULL REFERENCES ${CONFIG_VERSIONS_TABLE_NAME}(id) ON DELETE CASCADE,
      artifact_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (config_version_id, artifact_type)
    )
  `;

  const statements = [
    createDeploymentsSql,
    createConfigVersionsSql,
    createConfigArtifactsSql,
  ];

  for (const sql of statements) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(sql);
    } catch (err) {
      handleConcurrentDdlError(err);
    }
  }
}

/**
 * Fetch a deployment by its public code (e.g. "D1").
 * Returns null if not found.
 */
async function getDeploymentByCode(code) {
  await ensureConfigTables();

  const selectSql = `
    SELECT id, code, name, created_at, archived_at
    FROM ${DEPLOYMENTS_TABLE_NAME}
    WHERE code = $1
  `;
  const result = await pool.query(selectSql, [code]);

  if (!result.rows || result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

/**
 * Fetch the active config version for a deployment id.
 * Returns null if none exists.
 */
async function getActiveConfigVersionForDeploymentId(deploymentId) {
  await ensureConfigTables();

  const selectSql = `
    SELECT id, deployment_id, version_number, status, created_at, approved_at, activated_at, created_by
    FROM ${CONFIG_VERSIONS_TABLE_NAME}
    WHERE deployment_id = $1
      AND status = 'ACTIVE'
    ORDER BY activated_at DESC NULLS LAST, created_at DESC
    LIMIT 1
  `;
  const result = await pool.query(selectSql, [deploymentId]);

  if (!result.rows || result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

/**
 * Fetch a specific config version for a deployment by version_number.
 * Returns null if none exists.
 */
async function getConfigVersionForDeploymentAndNumber(
  deploymentId,
  versionNumber,
) {
  await ensureConfigTables();

  const selectSql = `
    SELECT id, deployment_id, version_number, status, created_at, approved_at, activated_at, created_by
    FROM ${CONFIG_VERSIONS_TABLE_NAME}
    WHERE deployment_id = $1
      AND version_number = $2
    LIMIT 1
  `;
  const result = await pool.query(selectSql, [deploymentId, versionNumber]);

  if (!result.rows || result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

/**
 * Fetch all config versions for a deployment id, newest version_number first.
 * Returns an array (possibly empty).
 */
async function getConfigVersionsForDeploymentId(deploymentId) {
  await ensureConfigTables();

  const selectSql = `
    SELECT id, deployment_id, version_number, status, created_at, approved_at, activated_at, created_by
    FROM ${CONFIG_VERSIONS_TABLE_NAME}
    WHERE deployment_id = $1
    ORDER BY version_number DESC
  `;
  const result = await pool.query(selectSql, [deploymentId]);

  return result.rows || [];
}

/**
 * Fetch all config artifacts for a given config_version_id.
 * Returns a map keyed by artifact_type with the JSON payload as the value.
 */
async function getArtifactsForConfigVersionId(configVersionId) {
  await ensureConfigTables();

  const selectSql = `
    SELECT id, config_version_id, artifact_type, payload, created_at
    FROM ${CONFIG_ARTIFACTS_TABLE_NAME}
    WHERE config_version_id = $1
  `;
  const result = await pool.query(selectSql, [configVersionId]);

  const artifactsByType = {};
  for (const row of result.rows || []) {
    artifactsByType[row.artifact_type] = row.payload;
  }

  return artifactsByType;
}

/**
 * High-level helper: fetch the active config for a deployment by its code.
 *
 * Returns one of:
 * - { deployment: null, configVersion: null, artifacts: {}, notFound: 'deployment' }
 *   when the deployment does not exist.
 * - { deployment, configVersion: null, artifacts: {}, notFound: 'active_config' }
 *   when there is no ACTIVE config version for that deployment.
 * - { deployment, configVersion, artifacts }
 *   on success.
 */
async function getActiveConfigForDeploymentCode(deploymentCode) {
  await ensureConfigTables();

  const deployment = await getDeploymentByCode(deploymentCode);
  if (!deployment || deployment.archived_at) {
    return {
      deployment: null,
      configVersion: null,
      artifacts: {},
      notFound: 'deployment',
    };
  }

  const configVersion = await getActiveConfigVersionForDeploymentId(
    deployment.id,
  );
  if (!configVersion) {
    return {
      deployment: {
        id: deployment.id,
        code: deployment.code,
        name: deployment.name,
      },
      configVersion: null,
      artifacts: {},
      notFound: 'active_config',
    };
  }

  const artifacts = await getArtifactsForConfigVersionId(configVersion.id);

  return {
    deployment: {
      id: deployment.id,
      code: deployment.code,
      name: deployment.name,
    },
    configVersion: {
      id: configVersion.id,
      deployment_id: configVersion.deployment_id,
      version_number: configVersion.version_number,
      status: configVersion.status,
      created_at: configVersion.created_at,
      approved_at: configVersion.approved_at,
      activated_at: configVersion.activated_at,
      created_by: configVersion.created_by,
    },
    artifacts,
  };
}

/**
 * High-level helper: activate a specific config version for a deployment by code.
 *
 * Returns one of:
 * - { deployment: null, configVersion: null, notFound: 'deployment' }
 *   when the deployment does not exist or is archived.
 * - { deployment, configVersion: null, notFound: 'config_version' }
 *   when the target version does not exist for that deployment.
 * - { deployment, configVersion }
 *   on success, where configVersion reflects the new ACTIVE version.
 */
async function activateConfigVersionForDeploymentCode(
  deploymentCode,
  versionNumber,
) {
  await ensureConfigTables();

  const deployment = await getDeploymentByCode(deploymentCode);
  if (!deployment || deployment.archived_at) {
    return {
      deployment: null,
      configVersion: null,
      notFound: 'deployment',
    };
  }

  const targetVersion = await getConfigVersionForDeploymentAndNumber(
    deployment.id,
    versionNumber,
  );
  if (!targetVersion) {
    return {
      deployment: {
        id: deployment.id,
        code: deployment.code,
        name: deployment.name,
      },
      configVersion: null,
      notFound: 'config_version',
    };
  }

  await pool.query('BEGIN');

  try {
    // Retire any currently ACTIVE versions for this deployment (except the target).
    await pool.query(
      `
        UPDATE ${CONFIG_VERSIONS_TABLE_NAME}
        SET status = 'RETIRED'
        WHERE deployment_id = $1
          AND status = 'ACTIVE'
          AND id <> $2
      `,
      [deployment.id, targetVersion.id],
    );

    // Activate the target version.
    await pool.query(
      `
        UPDATE ${CONFIG_VERSIONS_TABLE_NAME}
        SET status = 'ACTIVE',
            activated_at = NOW()
        WHERE id = $1
      `,
      [targetVersion.id],
    );

    // Re-fetch the activated version to return the latest metadata.
    const updated = await getConfigVersionForDeploymentAndNumber(
      deployment.id,
      versionNumber,
    );

    await pool.query('COMMIT');

    return {
      deployment: {
        id: deployment.id,
        code: deployment.code,
        name: deployment.name,
      },
      configVersion: updated,
    };
  } catch (err) {
    await pool.query('ROLLBACK');
    throw err;
  }
}

/**
 * Authoring helper: create a deployment row.
 * Simple helper for Phase 1 authoring flows.
 */
async function createDeployment(code, name) {
  await ensureConfigTables();

  const insertSql = `
    INSERT INTO ${DEPLOYMENTS_TABLE_NAME} (code, name)
    VALUES ($1, $2)
    RETURNING id, code, name, created_at, archived_at
  `;

  const result = await pool.query(insertSql, [code, name]);
  return result.rows[0];
}

/**
 * Authoring helper: create a new DRAFT config version for a deployment code.
 *
 * Returns:
 * - { deployment: null, configVersion: null, notFound: 'deployment' } if missing.
 * - { deployment, configVersion } with the new DRAFT row otherwise.
 *
 * Version numbers are allocated as (max existing version_number + 1),
 * starting from 1.
 */
async function createDraftConfigVersionForDeploymentCode(
  deploymentCode,
  createdBy,
) {
  await ensureConfigTables();

  const deployment = await getDeploymentByCode(deploymentCode);
  if (!deployment || deployment.archived_at) {
    return {
      deployment: null,
      configVersion: null,
      notFound: 'deployment',
    };
  }

  const maxSql = `
    SELECT COALESCE(MAX(version_number), 0) AS max_version
    FROM ${CONFIG_VERSIONS_TABLE_NAME}
    WHERE deployment_id = $1
  `;
  const maxResult = await pool.query(maxSql, [deployment.id]);
  const nextVersionNumber = Number(maxResult.rows[0].max_version) + 1;

  const insertSql = `
    INSERT INTO ${CONFIG_VERSIONS_TABLE_NAME} (
      deployment_id,
      version_number,
      status,
      created_by
    )
    VALUES ($1, $2, $3, $4)
    RETURNING id, deployment_id, version_number, status, created_at, approved_at, activated_at, created_by
  `;

  const result = await pool.query(insertSql, [
    deployment.id,
    nextVersionNumber,
    'DRAFT',
    createdBy || null,
  ]);
  const configVersion = result.rows[0];

  return {
    deployment: {
      id: deployment.id,
      code: deployment.code,
      name: deployment.name,
    },
    configVersion,
  };
}

/**
 * Authoring helper: insert or update a config artifact for a given version.
 *
 * Uses the UNIQUE (config_version_id, artifact_type) constraint to upsert.
 */
async function upsertConfigArtifact(configVersionId, artifactType, payload) {
  await ensureConfigTables();

  const upsertSql = `
    INSERT INTO ${CONFIG_ARTIFACTS_TABLE_NAME} (
      config_version_id,
      artifact_type,
      payload
    )
    VALUES ($1, $2, $3)
    ON CONFLICT (config_version_id, artifact_type)
    DO UPDATE SET payload = EXCLUDED.payload
    RETURNING id, config_version_id, artifact_type, payload, created_at
  `;

  const result = await pool.query(upsertSql, [
    configVersionId,
    artifactType,
    payload,
  ]);
  return result.rows[0];
}

module.exports = {
  DEPLOYMENTS_TABLE_NAME,
  CONFIG_VERSIONS_TABLE_NAME,
  CONFIG_ARTIFACTS_TABLE_NAME,
  ensureConfigTables,
  getDeploymentByCode,
  getActiveConfigVersionForDeploymentId,
  getConfigVersionForDeploymentAndNumber,
  getConfigVersionsForDeploymentId,
  getArtifactsForConfigVersionId,
  getActiveConfigForDeploymentCode,
  activateConfigVersionForDeploymentCode,
  createDeployment,
  createDraftConfigVersionForDeploymentCode,
  upsertConfigArtifact,
};
