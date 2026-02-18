const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '../..');

const { pool } = require(path.resolve(ROOT_DIR, 'apps/api/src/db'));
const {
  ensureConfigTables,
  DEPLOYMENTS_TABLE_NAME,
  CONFIG_VERSIONS_TABLE_NAME,
  CONFIG_ARTIFACTS_TABLE_NAME,
  createDeployment,
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
 * Ensure a permission exists, returning its row { id, key, description }.
 * If it already exists (by unique key), it is reused instead of inserting.
 */
async function ensurePermissionExists(key, description) {
  await ensureIdentityTables();

  const existing = await pool.query(
    `SELECT id, key, description FROM ${PERMISSIONS_TABLE_NAME} WHERE key = $1`,
    [key],
  );

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  return createPermission(key, description);
}

/**
 * Seed a single deployment with one series, one paper, and two QIGs with items,
 * matching the assessment HTTP tests and the Assessment Debug/AE pages.
 * Idempotent: reuses existing rows if they already exist.
 */
async function seedAssessmentTreeForDeployment(deploymentCode) {
  await ensureAssessmentTables();
  await ensureConfigTables();

  const deploymentName = 'HTTP Assessment Test';

  // Find or create deployment
  const existingDep = await pool.query(
    `SELECT id FROM ${DEPLOYMENTS_TABLE_NAME} WHERE code = $1`,
    [deploymentCode],
  );

  let deploymentId;
  if (existingDep.rows.length > 0) {
    deploymentId = existingDep.rows[0].id;
  } else {
    const deploymentRow = await createDeployment(
      deploymentCode,
      deploymentName,
    );
    deploymentId = deploymentRow.id;
  }

  // Series S_HTTP_1 (idempotent)
  let seriesRow;
  const existingSeries = await pool.query(
    `SELECT id, code, name FROM ${ASSESSMENT_SERIES_TABLE_NAME} WHERE deployment_id = $1 AND code = $2`,
    [deploymentId, 'S_HTTP_1'],
  );
  if (existingSeries.rows.length > 0) {
    seriesRow = existingSeries.rows[0];
  } else {
    seriesRow = await createSeries(
      deploymentId,
      'S_HTTP_1',
      'Series HTTP 1',
    );
  }

  // Paper P_HTTP_1 (idempotent)
  let paperRow;
  const existingPaper = await pool.query(
    `SELECT id, code, name FROM ${ASSESSMENT_PAPERS_TABLE_NAME} WHERE series_id = $1 AND code = $2`,
    [seriesRow.id, 'P_HTTP_1'],
  );
  if (existingPaper.rows.length > 0) {
    paperRow = existingPaper.rows[0];
  } else {
    paperRow = await createPaper(
      seriesRow.id,
      'P_HTTP_1',
      'Paper HTTP 1',
    );
  }

  // QIG Q_HTTP_1 (idempotent)
  let qigRow1;
  const existingQig1 = await pool.query(
    `SELECT id, code, name FROM ${ASSESSMENT_QIGS_TABLE_NAME} WHERE paper_id = $1 AND code = $2`,
    [paperRow.id, 'Q_HTTP_1'],
  );
  if (existingQig1.rows.length > 0) {
    qigRow1 = existingQig1.rows[0];
  } else {
    qigRow1 = await createQig(
      paperRow.id,
      'Q_HTTP_1',
      'QIG HTTP 1',
    );
  }

  // Item I_HTTP_1 for Q_HTTP_1 (idempotent)
  const existingItem1 = await pool.query(
    `SELECT id, code, max_mark FROM ${ASSESSMENT_ITEMS_TABLE_NAME} WHERE qig_id = $1 AND code = $2`,
    [qigRow1.id, 'I_HTTP_1'],
  );
  if (existingItem1.rows.length === 0) {
    await createItem(qigRow1.id, 'I_HTTP_1', 20);
  }

  // QIG Q_HTTP_2 (idempotent)
  let qigRow2;
  const existingQig2 = await pool.query(
    `SELECT id, code, name FROM ${ASSESSMENT_QIGS_TABLE_NAME} WHERE paper_id = $1 AND code = $2`,
    [paperRow.id, 'Q_HTTP_2'],
  );
  if (existingQig2.rows.length > 0) {
    qigRow2 = existingQig2.rows[0];
  } else {
    qigRow2 = await createQig(
      paperRow.id,
      'Q_HTTP_2',
      'QIG HTTP 2',
    );
  }

  // Item I_HTTP_2 for Q_HTTP_2 (idempotent)
  const existingItem2 = await pool.query(
    `SELECT id, code, max_mark FROM ${ASSESSMENT_ITEMS_TABLE_NAME} WHERE qig_id = $1 AND code = $2`,
    [qigRow2.id, 'I_HTTP_2'],
  );
  if (existingItem2.rows.length === 0) {
    await createItem(qigRow2.id, 'I_HTTP_2', 10);
  }

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
    const perm = await ensurePermissionExists(code, description);
    // eslint-disable-next-line no-await-in-loop
    await assignPermissionToRole(role.id, perm.id);
  }

  await assignRoleToUser(user.id, role.id);

  return user;
}

/**
 * Seed an assessment author identity with assessment.edit and assessment.view,
 * matching the HTTP authoring acceptance tests.
 */
async function seedAssessmentAuthorIdentity() {
  await ensureIdentityTables();

  const user = await createUser(
    'assessment-author-http-1',
    'Assessment Author HTTP One',
  );
  const role = await createRole(
    'ASSESSMENT_AUTHOR',
    'Assessment author for HTTP tests',
  );

  const editPerm = await ensurePermissionExists(
    'assessment.edit',
    'Edit assessment structures',
  );
  const viewPerm = await ensurePermissionExists(
    'assessment.view',
    'View assessment structures',
  );

  await assignRoleToUser(user.id, role.id);
  await assignPermissionToRole(role.id, editPerm.id);
  await assignPermissionToRole(role.id, viewPerm.id);

  return user;
}

/**
 * Seed an AE identity for deployment D1 with assessment.view permission,
 * matching the Assessment Setup AE page identity headers (D1:ae_1) and
 * the AE_<deploymentCode>_<qigCode> scoping convention.
 *
 * Idempotent: reuses existing user/role if they already exist.
 */
async function seedAssessmentAeIdentity() {
  await ensureIdentityTables();

  const externalId = 'D1:ae_1';
  const displayName = 'AE ae_1 (D1)';
  const roleKey = 'AE_D1_Q_HTTP_1';

  // Find or create user
  let user;
  const existingUser = await pool.query(
    `SELECT id, external_id, display_name FROM ${USERS_TABLE_NAME} WHERE external_id = $1`,
    [externalId],
  );
  if (existingUser.rows.length > 0) {
    user = existingUser.rows[0];
  } else {
    user = await createUser(externalId, displayName);
  }

  // Find or create role
  let role;
  const existingRole = await pool.query(
    `SELECT id, key, name FROM ${ROLES_TABLE_NAME} WHERE key = $1`,
    [roleKey],
  );
  if (existingRole.rows.length > 0) {
    role = existingRole.rows[0];
  } else {
    role = await createRole(
      roleKey,
      'Assistant Examiner for D1 Q_HTTP_1',
    );
  }

  const viewPerm = await ensurePermissionExists(
    'assessment.view',
    'View assessment structures',
  );

  // These helpers are idempotent (ON CONFLICT DO NOTHING)
  await assignRoleToUser(user.id, role.id);
  await assignPermissionToRole(role.id, viewPerm.id);

  return user;
}

/**
 * Seed an ACTIVE config version for deployment D1 with ui.locale set to the
 * provided locale ('en-GB' or 'fr-FR'), plus basic permission_matrix and branding
 * artifacts so the payload matches expectations of the web layer.
 *
 * Optional options.permissionMatrix allows tests to override the config-driven
 * roles/permissions (e.g. to remove assessment.view).
 */
async function seedConfigActiveForLocale(locale, options = {}) {
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
    const depRow = await createDeployment(deploymentCode, deploymentName);
    deploymentId = depRow.id;
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

  const defaultPermissionMatrix = {
    roles: ['ASSESSMENT_VIEWER'],
    permissions: {
      ASSESSMENT_VIEWER: ['assessment.view', 'config.view'],
    },
  };

  // Allow tests to override the permission matrix to model RBAC config changes
  const permissionMatrix =
    // @ts-expect-error - options is plain JS, so we treat it structurally
    options.permissionMatrix || defaultPermissionMatrix;

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

/**
 * Helper for tests: seed config where the ASSESSMENT_VIEWER role
 * does NOT have assessment.view (only config.view).
 */
async function seedConfigActiveForLocaleWithoutAssessmentView(locale) {
  const permissionMatrix = {
    roles: ['ASSESSMENT_VIEWER'],
    permissions: {
      ASSESSMENT_VIEWER: ['config.view'],
    },
  };

  return seedConfigActiveForLocale(locale, { permissionMatrix });
}

/**
 * Remove assessment.view from whatever roles the assessment-viewer-1 has,
 * so that API RBAC returns 403 FORBIDDEN for tree/view requests.
 */
async function revokeAssessmentViewForViewer() {
  await ensureIdentityTables();

  const viewerExternalId = 'assessment-viewer-1';

  const userRes = await pool.query(
    `SELECT id FROM ${USERS_TABLE_NAME} WHERE external_id = $1`,
    [viewerExternalId],
  );

  if (userRes.rows.length === 0) {
    return;
  }

  const userId = userRes.rows[0].id;

  const rolesRes = await pool.query(
    `
      SELECT r.id
      FROM ${ROLES_TABLE_NAME} r
      JOIN ${USER_ROLES_TABLE_NAME} ur
        ON ur.role_id = r.id
      WHERE ur.user_id = $1
    `,
    [userId],
  );

  if (rolesRes.rows.length === 0) {
    return;
  }

  const permRes = await pool.query(
    `SELECT id FROM ${PERMISSIONS_TABLE_NAME} WHERE key = $1`,
    ['assessment.view'],
  );

  if (permRes.rows.length === 0) {
    return;
  }

  const permId = permRes.rows[0].id;
  const roleIds = rolesRes.rows.map((row) => row.id);

  await pool.query(
    `
      DELETE FROM ${ROLE_PERMISSIONS_TABLE_NAME}
      WHERE permission_id = $1
        AND role_id = ANY($2::int[])
    `,
    [permId, roleIds],
  );
}

module.exports = {
  clearAllData,
  seedAssessmentTreeForDeployment,
  seedAssessmentViewerIdentity,
  seedAssessmentAuthorIdentity,
  seedAssessmentAeIdentity,
  seedConfigActiveForLocale,
  seedConfigActiveForLocaleWithoutAssessmentView,
  revokeAssessmentViewForViewer,
};
