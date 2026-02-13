const assert = require('assert');
const path = require('path');
const { Given, When, Then, setDefaultTimeout } = require('@cucumber/cucumber');

setDefaultTimeout(90 * 1000);

const ROOT_DIR = path.resolve(__dirname, '../../..');

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

/**
 * Clear all config-related data for a stable baseline.
 * This mirrors the approach used in config_model.steps.js, but is scoped for
 * identity/RBAC scenarios.
 */
async function clearAllConfigData() {
  await ensureConfigTables();

  // Remove artifacts first due to FK to config_versions
  await pool.query('DELETE FROM ' + CONFIG_ARTIFACTS_TABLE_NAME);
  await pool.query('DELETE FROM ' + CONFIG_VERSIONS_TABLE_NAME);
  await pool.query('DELETE FROM ' + DEPLOYMENTS_TABLE_NAME);
}

/**
 * Ensure that a deployment with the given code exists, returning its id.
 */
async function ensureDeploymentExists(deploymentCode) {
  await ensureConfigTables();

  const selectSql =
    'SELECT id FROM ' + DEPLOYMENTS_TABLE_NAME + ' WHERE code = $1';
  const existing = await pool.query(selectSql, [deploymentCode]);

  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }

  const insertSql =
    'INSERT INTO ' +
    DEPLOYMENTS_TABLE_NAME +
    ' (code, name) VALUES ($1, $2) RETURNING id';
  const deploymentName = 'Deployment ' + deploymentCode;

  const inserted = await pool.query(insertSql, [deploymentCode, deploymentName]);
  return inserted.rows[0].id;
}

/**
 * Ensure that the given deployment has a single ACTIVE config version.
 * Any existing config versions for this deployment are removed and replaced
 * with a fresh ACTIVE version_number = 1.
 */
async function ensureActiveConfigForDeployment(deploymentCode) {
  await ensureConfigTables();

  const deploymentId = await ensureDeploymentExists(deploymentCode);

  // Remove any existing config versions + artifacts for this deployment
  await pool.query(
    'DELETE FROM ' +
      CONFIG_ARTIFACTS_TABLE_NAME +
      ' WHERE config_version_id IN (SELECT id FROM ' +
      CONFIG_VERSIONS_TABLE_NAME +
      ' WHERE deployment_id = $1)',
    [deploymentId],
  );

  await pool.query(
    'DELETE FROM ' +
      CONFIG_VERSIONS_TABLE_NAME +
      ' WHERE deployment_id = $1',
    [deploymentId],
  );

  const insertConfigVersionSql =
    'INSERT INTO ' +
    CONFIG_VERSIONS_TABLE_NAME +
    ' (deployment_id, version_number, status, created_by) ' +
    'VALUES ($1, $2, $3, $4)';
  const versionNumber = 1;
  const status = 'ACTIVE';
  const createdBy = 'identity_rbac_acceptance';

  await pool.query(insertConfigVersionSql, [
    deploymentId,
    versionNumber,
    status,
    createdBy,
  ]);
}

/**
 * Clear all identity-related data for a stable baseline.
 */
async function clearAllIdentityData() {
  await ensureIdentityTables();
  await pool.query(
    'TRUNCATE TABLE ' +
      USER_ROLES_TABLE_NAME + ', ' +
      ROLE_PERMISSIONS_TABLE_NAME + ', ' +
      PERMISSIONS_TABLE_NAME + ', ' +
      ROLES_TABLE_NAME + ', ' +
      USERS_TABLE_NAME +
      ' RESTART IDENTITY CASCADE',
  );
}

/**
 * Ensure an identity/RBAC context exists on the Cucumber World for this scenario.
 */
function ensureIdentityContext(world, deploymentCode) {
  if (!world.identityContext) {
    world.identityContext = {
      deploymentCode: deploymentCode,
      usersByName: {},        // "admin_1" -> user row, "ae_1" -> user row
      rolesByName: {},        // "ADMIN", "AE" -> role rows
      seriesByName: {},       // "S1" -> series record
      papersByName: {},       // "P1" -> paper record
      qigsByName: {},         // "Q1" -> QIG record
      aeAssignmentsByQig: {}, // "Q1" -> ["ae_1", ...]
      lastViewAttempt: null,  // { userName, qigName, allowed }
      auditEvents: [],        // [{ eventType, actorName, targetUserName, qigName, timestamp }]
    };
  } else {
    if (!world.identityContext.deploymentCode && deploymentCode) {
      world.identityContext.deploymentCode = deploymentCode;
    }
    world.identityContext.usersByName = world.identityContext.usersByName || {};
    world.identityContext.rolesByName = world.identityContext.rolesByName || {};
    world.identityContext.seriesByName = world.identityContext.seriesByName || {};
    world.identityContext.papersByName = world.identityContext.papersByName || {};
    world.identityContext.qigsByName = world.identityContext.qigsByName || {};
    world.identityContext.aeAssignmentsByQig =
      world.identityContext.aeAssignmentsByQig || {};
    world.identityContext.lastViewAttempt =
      world.identityContext.lastViewAttempt || null;
    world.identityContext.auditEvents =
      world.identityContext.auditEvents || [];
  }
  return world.identityContext;
}

/**
 * Step: a Deployment "<code>" exists
 */
Given('a Deployment {string} exists', async function (deploymentCode) {
  await clearAllConfigData();
  await ensureDeploymentExists(deploymentCode);
});

/**
 * Step: Deployment "<code>" has an ACTIVE ConfigVersion
 */
Given(
  'Deployment {string} has an ACTIVE ConfigVersion',
  async function (deploymentCode) {
    await ensureActiveConfigForDeployment(deploymentCode);
  },
);

/**
 * Step: an admin user "<user>" exists in Deployment "<deployment>"
 */
Given(
  'an admin user {string} exists in Deployment {string}',
  async function (userName, deploymentCode) {
    await clearAllIdentityData();
    const ctx = ensureIdentityContext(this, deploymentCode);

    const externalId = deploymentCode + ':' + userName;
    const displayName = 'Admin ' + userName + ' (' + deploymentCode + ')';

    const user = await createUser(externalId, displayName);

    const adminRole = await createRole('ADMIN', 'Deployment administrator');
    const adminPerm = await createPermission(
      'admin.all',
      'Full administrative access within a deployment',
    );

    await assignRoleToUser(user.id, adminRole.id);
    // FIX: pass the permission ID, not the whole object
    await assignPermissionToRole(adminRole.id, adminPerm.id);

    ctx.usersByName[userName] = user;
    ctx.rolesByName.ADMIN = adminRole;
  },
);

/**
 * Step: "<actor>" creates user "<userName>"
 */
When('{string} creates user {string}', async function (actorName, userName) {
  const ctx = ensureIdentityContext(
    this,
    (this.identityContext && this.identityContext.deploymentCode) || 'D1',
  );

  const actor = ctx.usersByName[actorName];
  assert.ok(
    actor,
    'Expected actor "' +
      actorName +
      '" to exist in identity context before creating user "' +
      userName +
      '"',
  );

  const deploymentCode = ctx.deploymentCode || 'D1';
  const externalId = deploymentCode + ':' + userName;
  const displayName = 'User ' + userName + ' (' + deploymentCode + ')';

  const user = await createUser(externalId, displayName);
  ctx.usersByName[userName] = user;
});

/**
 * Step: "<actor>" creates Series "<seriesName>"
 */
When('{string} creates Series {string}', async function (actorName, seriesName) {
  const ctx = ensureIdentityContext(
    this,
    (this.identityContext && this.identityContext.deploymentCode) || 'D1',
  );

  const actor = ctx.usersByName[actorName];
  assert.ok(
    actor,
    'Expected actor "' +
      actorName +
      '" to exist before creating Series "' +
      seriesName +
      '"',
  );

  const series = {
    name: seriesName,
    deploymentCode: ctx.deploymentCode || 'D1',
    createdBy: actorName,
  };

  ctx.seriesByName[seriesName] = series;
});

/**
 * Step: "<actor>" creates Paper "<paperName>" in Series "<seriesName>"
 */
When(
  '{string} creates Paper {string} in Series {string}',
  async function (actorName, paperName, seriesName) {
    const ctx = ensureIdentityContext(
      this,
      (this.identityContext && this.identityContext.deploymentCode) || 'D1',
    );

    const actor = ctx.usersByName[actorName];
    assert.ok(
      actor,
      'Expected actor "' +
        actorName +
        '" to exist before creating Paper "' +
        paperName +
        '"',
    );

    const series = ctx.seriesByName[seriesName];
    assert.ok(
      series,
      'Expected Series "' +
        seriesName +
        '" to exist before creating Paper "' +
        paperName +
        '"',
    );

    const paper = {
      name: paperName,
      seriesName: seriesName,
      deploymentCode: ctx.deploymentCode || 'D1',
      createdBy: actorName,
    };

    ctx.papersByName[paperName] = paper;
  },
);

/**
 * Step: "<actor>" creates QIG "<qigName>" in Paper "<paperName>"
 */
When(
  '{string} creates QIG {string} in Paper {string}',
  async function (actorName, qigName, paperName) {
    const ctx = ensureIdentityContext(
      this,
      (this.identityContext && this.identityContext.deploymentCode) || 'D1',
    );

    const actor = ctx.usersByName[actorName];
    assert.ok(
      actor,
      'Expected actor "' +
        actorName +
        '" to exist before creating QIG "' +
        qigName +
        '"',
    );

    const paper = ctx.papersByName[paperName];
    assert.ok(
      paper,
      'Expected Paper "' +
        paperName +
        '" to exist before creating QIG "' +
        qigName +
        '"',
    );

    const qig = {
      name: qigName,
      paperName: paperName,
      seriesName: paper.seriesName,
      deploymentCode: ctx.deploymentCode || 'D1',
      createdBy: actorName,
    };

    ctx.qigsByName[qigName] = qig;
  },
);

/**
 * Step: "<actor>" assigns role AE to user "<userName>" scoped to QIG "<qigName>"
 */
When(
  '{string} assigns role AE to user {string} scoped to QIG {string}',
  async function (actorName, userName, qigName) {
    const ctx = ensureIdentityContext(
      this,
      (this.identityContext && this.identityContext.deploymentCode) || 'D1',
    );

    const actor = ctx.usersByName[actorName];
    assert.ok(
      actor,
      'Expected actor "' +
        actorName +
        '" to exist before assigning AE role',
    );

    const aeUser = ctx.usersByName[userName];
    assert.ok(
      aeUser,
      'Expected AE user "' +
        userName +
        '" to exist before assigning AE role',
    );

    const qig = ctx.qigsByName[qigName];
    assert.ok(
      qig,
      'Expected QIG "' +
        qigName +
        '" to exist before assigning AE role scoped to it',
    );

    // Ensure AE role and qig.view permission exist and are linked.
    let aeRole = ctx.rolesByName.AE;
    if (!aeRole) {
      aeRole = await createRole('AE', 'Assistant Examiner');
      ctx.rolesByName.AE = aeRole;
    }

    const viewPerm = await createPermission(
      'qig.view',
      'View QIG details in marking UI',
    );

    await assignRoleToUser(aeUser.id, aeRole.id);
    await assignPermissionToRole(aeRole.id, viewPerm.id);

    // Record QIG-scoped assignment in memory.
    if (!ctx.aeAssignmentsByQig[qigName]) {
      ctx.aeAssignmentsByQig[qigName] = [];
    }
    if (ctx.aeAssignmentsByQig[qigName].indexOf(userName) === -1) {
      ctx.aeAssignmentsByQig[qigName].push(userName);
    }

    // Record an audit-style event in the scenario context.
    ctx.auditEvents.push({
      eventType: 'ROLE_ASSIGNED',
      actorName: actorName,
      targetUserName: userName,
      qigName: qigName,
      timestamp: new Date().toISOString(),
    });
  },
);

/**
 * Step: user "<userName>" has role AE assigned only to QIG "<qigName>"
 */
Given(
  'user {string} has role AE assigned only to QIG {string}',
  async function (userName, qigName) {
    await clearAllIdentityData();
    const ctx = ensureIdentityContext(
      this,
      (this.identityContext && this.identityContext.deploymentCode) || 'D1',
    );

    const deploymentCode = ctx.deploymentCode || 'D1';

    // Create an AE user.
    const externalId = deploymentCode + ':' + userName;
    const displayName = 'AE ' + userName + ' (' + deploymentCode + ')';
    const aeUser = await createUser(externalId, displayName);
    ctx.usersByName[userName] = aeUser;

    // Create synthetic Series/Paper/QIG for this QIG name if needed.
    const seriesName = 'S_for_' + qigName;
    const paperName = 'P_for_' + qigName;

    ctx.seriesByName[seriesName] = {
      name: seriesName,
      deploymentCode: deploymentCode,
      createdBy: userName,
    };

    ctx.papersByName[paperName] = {
      name: paperName,
      seriesName: seriesName,
      deploymentCode: deploymentCode,
      createdBy: userName,
    };

    ctx.qigsByName[qigName] = {
      name: qigName,
      paperName: paperName,
      seriesName: seriesName,
      deploymentCode: deploymentCode,
      createdBy: userName,
    };

    // AE role + qig.view permission.
    const aeRole = await createRole('AE', 'Assistant Examiner');
    const viewPerm = await createPermission(
      'qig.view',
      'View QIG details in marking UI',
    );
    await assignRoleToUser(aeUser.id, aeRole.id);
    await assignPermissionToRole(aeRole.id, viewPerm.id);

    // Scoped assignment: only this QIG.
    ctx.aeAssignmentsByQig = {};
    ctx.aeAssignmentsByQig[qigName] = [userName];
  },
);

/**
 * Step: "<userName>" requests to view QIG "<qigName>"
 */
When(
  '{string} requests to view QIG {string}',
  async function (userName, qigName) {
    const ctx = ensureIdentityContext(
      this,
      (this.identityContext && this.identityContext.deploymentCode) || 'D1',
    );

    const aeUser = ctx.usersByName[userName];
    assert.ok(
      aeUser,
      'Expected user "' +
        userName +
        '" to exist before requesting to view QIG "' +
        qigName +
        '"',
    );

    const assignedUsers =
      (ctx.aeAssignmentsByQig && ctx.aeAssignmentsByQig[qigName]) || [];
    const allowed = assignedUsers.indexOf(userName) !== -1;

    ctx.lastViewAttempt = {
      userName: userName,
      qigName: qigName,
      allowed: allowed,
    };
  },
);

/**
 * Step: user "<userName>" can view QIG "<qigName>"
 */
Then(
  'user {string} can view QIG {string}',
  function (userName, qigName) {
    const ctx = ensureIdentityContext(
      this,
      (this.identityContext && this.identityContext.deploymentCode) || 'D1',
    );

    const assignedUsers =
      (ctx.aeAssignmentsByQig && ctx.aeAssignmentsByQig[qigName]) || [];
    assert.ok(
      assignedUsers.indexOf(userName) !== -1,
      'Expected user "' +
        userName +
        '" to be allowed to view QIG "' +
        qigName +
        '", but no AE assignment was recorded for that QIG',
    );

    ctx.lastViewAttempt = {
      userName: userName,
      qigName: qigName,
      allowed: true,
    };
  },
);

/**
 * Step: the system denies access with reason "<reason>"
 */
Then(
  'the system denies access with reason {string}',
  function (reason) {
    const ctx = ensureIdentityContext(
      this,
      (this.identityContext && this.identityContext.deploymentCode) || 'D1',
    );

    assert.strictEqual(
      reason,
      'FORBIDDEN',
      'Expected reason to be "FORBIDDEN" as per spec, got "' + reason + '"',
    );

    assert.ok(
      ctx.lastViewAttempt && ctx.lastViewAttempt.allowed === false,
      'Expected last view attempt to have been denied (allowed === false)',
    );
  },
);

/**
 * Step: an audit event exists for "<eventType>" with actor "<actorName>"
 */
Then(
  'an audit event exists for {string} with actor {string}',
  function (eventType, actorName) {
    const ctx = ensureIdentityContext(
      this,
      (this.identityContext && this.identityContext.deploymentCode) || 'D1',
    );

    const events = ctx.auditEvents || [];
    const match = events.find(function (e) {
      return e.eventType === eventType && e.actorName === actorName;
    });

    assert.ok(
      match,
      'Expected an audit event with eventType="' +
        eventType +
        '" and actorName="' +
        actorName +
        '", but found: ' +
        JSON.stringify(events),
    );
  },
);
