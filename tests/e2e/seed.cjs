const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '../..');

const { pool } = require(path.resolve(ROOT_DIR, 'apps/api/src/db'));
const {
  ensureConfigTables,
  DEPLOYMENTS_TABLE_NAME,
  CONFIG_VERSIONS_TABLE_NAME,
  CONFIG_ARTIFACTS_TABLE_NAME,
} = require(path.resolve(ROOT_DIR, 'apps/api/src/config'));
const {
  ensureIdentityTables,
  USERS_TABLE_NAME,
  ROLES_TABLE_NAME,
  PERMISSIONS_TABLE_NAME,
  USER_ROLES_TABLE_NAME,
  ROLE_PERMISSIONS_TABLE_NAME,
  createUser,
  createRole,
  createPermission,
  assignRoleToUser,
  assignPermissionToRole,
} = require(path.resolve(ROOT_DIR, 'apps/api/src/identity'));
const {
  ensureAssessmentTables,
  ASSESSMENT_SERIES_TABLE_NAME,
  ASSESSMENT_PAPERS_TABLE_NAME,
  ASSESSMENT_QIGS_TABLE_NAME,
  ASSESSMENT_ITEMS_TABLE_NAME,
  createSeries,
  createPaper,
  createQig,
  createItem,
} = require(path.resolve(ROOT_DIR, 'apps/api/src/assessment'));

async function clearAllData() {
  await ensureConfigTables();
  await ensureIdentityTables();
  await ensureAssessmentTables();

  // Assessment tables
  await pool.query(`DELETE FROM ${ASSESSMENT_ITEMS_TABLE_NAME}`);
  await pool.query(`DELETE FROM ${ASSESSMENT_QIGS_TABLE_NAME}`);
  await pool.query(`DELETE FROM ${ASSESSMENT_PAPERS_TABLE_NAME}`);
  await pool.query(`DELETE FROM ${ASSESSMENT_SERIES_TABLE_NAME}`);

  // Config tables
  await pool.query(`DELETE FROM ${CONFIG_ARTIFACTS_TABLE_NAME}`);
  await pool.query(`DELETE FROM ${CONFIG_VERSIONS_TABLE_NAME}`);
  await pool.query(`DELETE FROM ${DEPLOYMENTS_TABLE_NAME}`);

  // Identity tables
  await pool.query(
    `
      TRUNCATE TABLE
        ${USER_ROLES_TABLE_NAME},
        ${ROLE_PERMISSIONS_TABLE_NAME},
        ${PERMISSIONS_TABLE_NAME},
        ${ROLES_TABLE_NAME},
        ${USERS_TABLE_NAME}
      RESTART IDENTITY CASCADE
    `,
  );
}

/**
 * Seed a single deployment with one series, one paper, one QIG and one item,
 * matching the assessment HTTP tests and the Assessment Debug page expectations.
 */
async function seedAssessmentTreeForDeployment(deploymentCode) {
  await ensureAssessmentTables();
  await ensureConfigTables();

  const deploymentName = 'HTTP Assessment Test';

  const deploymentResult = await pool.query(
    `
      INSERT INTO ${DEPLOYMENTS_TABLE_NAME} (code, name)
      VALUES ($1, $2)
      RETURNING id
    `,
    [deploymentCode, deploymentName],
  );
  const deploymentId = deploymentResult.rows[0].id;

  const seriesRow = await createSeries(
    deploymentId,
    'S_HTTP_1',
    'Series HTTP 1',
  );
  const paperRow = await createPaper(
    seriesRow.id,
    'P_HTTP_1',
    'Paper HTTP 1',
  );
  const qigRow = await createQig(
    paperRow.id,
    'Q_HTTP_1',
    'QIG HTTP 1',
  );
  await createItem(qigRow.id, 'I_HTTP_1', 20);

  return {
    deploymentId,
    deploymentCode,
    deploymentName,
  };
}

/**
 * Seed an identity user with the assessment.view and config.view permissions,
 * matching the headers used by the Assessment Debug page.
 */
async function seedAssessmentViewerIdentity() {
  await ensureIdentityTables();

  const user = await createUser(
    'assessment-viewer-1',
    'Assessment Viewer One',
  );
  const role = await createRole(
    'ASSESSMENT_VIEWER',
    'Assessment tree and config viewer',
  );

  const permissionsToGrant = [
    ['assessment.view', 'View assessment structures'],
    ['config.view', 'View config'],
  ];

  for (const [code, description] of permissionsToGrant) {
    // eslint-disable-next-line no-await-in-loop
    const perm = await createPermission(code, description);
    // eslint-disable-next-line no-await-in-loop
    await assignPermissionToRole(role.id, perm.id);
  }

  await assignRoleToUser(user.id, role.id);

  return user;
}

/**
 * Seed an ACTIVE config version for deployment D1 with ui.locale set to the
 * provided locale ('en-GB' or 'fr-FR'), plus basic permission_matrix and branding
 * artifacts so the payload matches expectations of the web layer.
 */
async function seedConfigActiveForLocale(locale) {
  await ensureConfigTables();

  const deploymentCode = 'D1';
  const deploymentName = 'Example Deployment';

  // Find or create deployment for D1
  const existingDep = await pool.query(
    `SELECT id FROM ${DEPLOYMENTS_TABLE_NAME} WHERE code = $1`,
    [deploymentCode],
  );

  let deploymentId;
  if (existingDep.rows.length > 0) {
    deploymentId = existingDep.rows[0].id;

    // Remove any existing versions & artifacts for this deployment
    await pool.query(
      `
        DELETE FROM ${CONFIG_ARTIFACTS_TABLE_NAME}
        WHERE config_version_id IN (
          SELECT id FROM ${CONFIG_VERSIONS_TABLE_NAME}
          WHERE deployment_id = $1
        )
      `,
      [deploymentId],
    );
    await pool.query(
      `DELETE FROM ${CONFIG_VERSIONS_TABLE_NAME} WHERE deployment_id = $1`,
      [deploymentId],
    );
  } else {
    const depResult = await pool.query(
      `
        INSERT INTO ${DEPLOYMENTS_TABLE_NAME} (code, name)
        VALUES ($1, $2)
        RETURNING id
      `,
      [deploymentCode, deploymentName],
    );
    deploymentId = depResult.rows[0].id;
  }

  const versionResult = await pool.query(
    `
      INSERT INTO ${CONFIG_VERSIONS_TABLE_NAME} (
        deployment_id,
        version_number,
        status,
        created_by
      )
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `,
    [deploymentId, 1, 'ACTIVE', 'playwright'],
  );
  const configVersionId = versionResult.rows[0].id;

  const permissionMatrix = {
    roles: ['ASSESSMENT_VIEWER'],
    permissions: {
      ASSESSMENT_VIEWER: ['assessment.view', 'config.view'],
    },
  };

  const branding = {
    logoUrl: 'https://example.org/logo.png',
    primaryColor: '#0044cc',
  };

  const ui = { locale };

  await pool.query(
    `
      INSERT INTO ${CONFIG_ARTIFACTS_TABLE_NAME} (
        config_version_id,
        artifact_type,
        payload
      )
      VALUES ($1, $2, $3),
             ($1, $4, $5),
             ($1, $6, $7)
    `,
    [
      configVersionId,
      'permission_matrix',
      permissionMatrix,
      'branding',
      branding,
      'ui',
      ui,
    ],
  );

  return { deploymentId, configVersionId };
}

module.exports = {
  clearAllData,
  seedAssessmentTreeForDeployment,
  seedAssessmentViewerIdentity,
  seedConfigActiveForLocale,
};
