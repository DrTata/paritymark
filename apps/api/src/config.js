const { pool } = require('./db');

const TENANTS_TABLE_NAME = 'tenants';
const DEPLOYMENTS_TABLE_NAME = 'deployments';
const CONFIG_VERSIONS_TABLE_NAME = 'config_versions';
const CONFIG_ARTIFACTS_TABLE_NAME = 'config_artifacts';

/**
 * Handle known-benign concurrency errors for CREATE TABLE / ALTER TABLE,
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

  // Duplicate object (e.g. constraint already exists)
  if (code === '42710') {
    return;
  }

  throw err;
}

/**
 * Ensure that the config-related tables exist.
 * This mirrors the lazy creation approach used in the audit module.
 *
 * Phase 0: this also creates the tenants table and ensures deployments
 * can be linked to tenants via tenant_id, but existing behaviour continues
 * to assume a single implicit tenant unless explicitly wired up.
 */
async function ensureConfigTables() {
  const createTenantsSql = `
    CREATE TABLE IF NOT EXISTS ${TENANTS_TABLE_NAME} (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at TIMESTAMPTZ
    )
  `;

  const createDeploymentsSql = `
    CREATE TABLE IF NOT EXISTS ${DEPLOYMENTS_TABLE_NAME} (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      deployment_type TEXT NOT NULL DEFAULT 'LIVE',
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
    createTenantsSql,
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

  // Phase 0 extensions: add deployment_type & tenant_id columns + FKs / checks
  const alterDeploymentsAddDeploymentTypeSql = `
    ALTER TABLE ${DEPLOYMENTS_TABLE_NAME}
    ADD COLUMN IF NOT EXISTS deployment_type TEXT NOT NULL DEFAULT 'LIVE'
  `;

  const alterDeploymentsAddDeploymentTypeCheckSql = `
    ALTER TABLE ${DEPLOYMENTS_TABLE_NAME}
    ADD CONSTRAINT deployments_deployment_type_check
    CHECK (deployment_type IN ('LIVE', 'PILOT', 'TRAINING', 'SANDBOX', 'ARCHIVED'))
  `;

  const alterDeploymentsAddTenantIdSql = `
    ALTER TABLE ${DEPLOYMENTS_TABLE_NAME}
    ADD COLUMN IF NOT EXISTS tenant_id INTEGER
  `;

  const alterDeploymentsAddTenantFkSql = `
    ALTER TABLE ${DEPLOYMENTS_TABLE_NAME}
    ADD CONSTRAINT deployments_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES ${TENANTS_TABLE_NAME}(id)
  `;

  const alterStatements = [
    alterDeploymentsAddDeploymentTypeSql,
    alterDeploymentsAddDeploymentTypeCheckSql,
    alterDeploymentsAddTenantIdSql,
    alterDeploymentsAddTenantFkSql,
  ];

  for (const sql of alterStatements) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(sql);
    } catch (err) {
      handleConcurrentDdlError(err);
    }
  }
}

/**
 * Fetch a tenant by its code.
 * Returns null if not found.
 */
async function getTenantByCode(code) {
  await ensureConfigTables();

  const selectSql = `
    SELECT id, code, name, status, created_at, archived_at
    FROM ${TENANTS_TABLE_NAME}
    WHERE code = $1
    LIMIT 1
  `;
  const result = await pool.query(selectSql, [code]);

  if (!result.rows || result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

/**
 * Ensure that the default tenant exists.
 *
 * This is Phase 0 scaffolding for a future multi-tenant model. Current
 * behaviour still effectively assumes a single tenant; this helper simply
 * makes that explicit in the DB and is designed to be idempotent and
 * concurrency-safe.
 */
async function ensureDefaultTenant() {
  await ensureConfigTables();

  const defaultCode = 'TENANT_DEFAULT';
  const defaultName = 'Default Tenant';

  // First, try to find an existing row.
  let tenant = await getTenantByCode(defaultCode);
  if (tenant) {
    return tenant;
  }

  const insertSql = `
    INSERT INTO ${TENANTS_TABLE_NAME} (code, name)
    VALUES ($1, $2)
    RETURNING id, code, name, status, created_at, archived_at
  `;

  try {
    const result = await pool.query(insertSql, [defaultCode, defaultName]);
    tenant = result.rows[0];
    return tenant;
  } catch (err) {
    // If another process created the tenant concurrently, handle unique violation
    // by re-reading the row.
    const code = err && err.code;
    if (code === '23505') {
      const existing = await getTenantByCode(defaultCode);
      if (existing) {
        return existing;
      }
    }
    throw err;
  }
}

/**
 * Phase 0 helper: attach all existing deployments to the default tenant.
 *
 * This is intended for migration / seeding flows and tests. It is safe to call
 * repeatedly and will backfill any deployment row where tenant_id IS NULL.
 */
async function attachAllDeploymentsToDefaultTenant() {
  await ensureConfigTables();
  const defaultTenant = await ensureDefaultTenant();

  await pool.query(
    `
      UPDATE ${DEPLOYMENTS_TABLE_NAME}
      SET tenant_id = $1
      WHERE tenant_id IS NULL
    `,
    [defaultTenant.id],
  );
}

/**
 * Fetch a deployment by its public code (e.g. "D1").
 * Returns null if not found.
 */
async function getDeploymentByCode(code) {
  await ensureConfigTables();

  const selectSql = `
    SELECT id, code, name, deployment_type, created_at, archived_at, tenant_id
    FROM ${DEPLOYMENTS_TABLE_NAME}
    WHERE code = $1
    LIMIT 1
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
  for (const row of (result.rows || [])) {
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

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Retire any currently ACTIVE versions for this deployment (except the target).
    await client.query(
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
    await client.query(
      `
        UPDATE ${CONFIG_VERSIONS_TABLE_NAME}
        SET status = 'ACTIVE',
            activated_at = NOW()
        WHERE id = $1
      `,
      [targetVersion.id],
    );

    // Re-fetch the activated version directly from the same transaction.
    const updatedResult = await client.query(
      `
        SELECT id,
               deployment_id,
               version_number,
               status,
               created_at,
               approved_at,
               activated_at,
               created_by
        FROM ${CONFIG_VERSIONS_TABLE_NAME}
        WHERE deployment_id = $1
          AND version_number = $2
        LIMIT 1
      `,
      [deployment.id, versionNumber],
    );

    const updated =
      updatedResult.rows && updatedResult.rows.length > 0
        ? updatedResult.rows[0]
        : null;

    await client.query('COMMIT');

    return {
      deployment: {
        id: deployment.id,
        code: deployment.code,
        name: deployment.name,
      },
      configVersion: updated,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // ignore rollback errors, surface the original failure
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Authoring helper: create a deployment row.
 * Simple helper for Phase 1 authoring flows.
 *
 * NOTE: For now this explicitly sets tenant_id to the default tenant so
 * that new deployments always have a tenant link. Existing deployments
 * created via direct INSERTs may still have tenant_id=NULL and should be
 * backfilled via attachAllDeploymentsToDefaultTenant() where needed.
 *
 * deploymentType is currently metadata-only: behaviour is still the same for
 * all types in Phase 0.
 */
async function createDeployment(code, name, deploymentType = 'LIVE') {
  await ensureConfigTables();

  const defaultTenant = await ensureDefaultTenant();

  const insertSql = `
    INSERT INTO ${DEPLOYMENTS_TABLE_NAME} (code, name, tenant_id, deployment_type)
    VALUES ($1, $2, $3, $4)
    RETURNING id, code, name, deployment_type, created_at, archived_at, tenant_id
  `;

  const result = await pool.query(insertSql, [
    code,
    name,
    defaultTenant.id,
    deploymentType,
  ]);
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
  TENANTS_TABLE_NAME,
  DEPLOYMENTS_TABLE_NAME,
  CONFIG_VERSIONS_TABLE_NAME,
  CONFIG_ARTIFACTS_TABLE_NAME,
  ensureConfigTables,
  getTenantByCode,
  ensureDefaultTenant,
  attachAllDeploymentsToDefaultTenant,
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

/**
 * Authoring helper: create a tenant row.
 *
 * Intended primarily for tests and internal tooling. This keeps tenant
 * creation logic in one place and stays consistent with ensureConfigTables.
 *
 * The helper is idempotent with respect to tenant code: if a tenant with
 * the given code already exists, it will be returned instead of throwing.
 */
async function createTenant(code, name, status = 'ACTIVE') {
  await ensureConfigTables();

  // First, try to find an existing row for this code.
  const existing = await getTenantByCode(code);
  if (existing) {
    return existing;
  }

  const insertSql = `
    INSERT INTO ${TENANTS_TABLE_NAME} (code, name, status)
    VALUES ($1, $2, $3)
    RETURNING id, code, name, status, created_at, archived_at
  `;

  try {
    const result = await pool.query(insertSql, [code, name, status]);
    return result.rows[0];
  } catch (err) {
    const errorCode = err && err.code;

    // Handle concurrent / duplicate creation by code.
    if (errorCode === '23505') {
      const existingAfter = await getTenantByCode(code);
      if (existingAfter) {
        return existingAfter;
      }
    }

    throw err;
  }
}

// Export createTenant without modifying the main module.exports shape.
module.exports.createTenant = createTenant;
