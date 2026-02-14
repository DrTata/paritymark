const assert = require('assert');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { Given, When, Then, After, setDefaultTimeout } = require('@cucumber/cucumber');

setDefaultTimeout(90 * 1000);

const ROOT_DIR = path.resolve(__dirname, '../../..');
const API_PORT = 4300;

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

let apiProcess = null;
let lastConfigResponse = null;
let lastConfigBody = null;
let lastConfigJson = null;
let configRequestHeaders = {};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpGetJson(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: 'localhost',
        port: API_PORT,
        path: pathname,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = body ? JSON.parse(body) : null;
          } catch (err) {
            return reject(
              new Error(
                `Failed to parse JSON from ${pathname}: ${err.message}. Body was: ${body}`,
              ),
            );
          }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body,
            json,
          });
        });
      },
    );
    req.on('error', reject);
  });
}

async function waitForDbHealthUp(timeoutMs = 30000) {
  const start = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await httpGetJson('/health');
      if (
        res.statusCode === 200 &&
        res.json &&
        res.json.status === 'ok' &&
        res.json.db === 'up'
      ) {
        return;
      }
      throw new Error(
        `DB health not up yet: status=${res.statusCode}, body=${res.body}`,
      );
    } catch (err) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Timed out waiting for API DB health endpoint to be ready: ${err.message}`,
        );
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(500);
    }
  }
}

/**
 * Clear all config-related data for a stable baseline.
 */
async function clearAllConfigData() {
  await ensureConfigTables();
  await pool.query(`DELETE FROM ${CONFIG_ARTIFACTS_TABLE_NAME}`);
  await pool.query(`DELETE FROM ${CONFIG_VERSIONS_TABLE_NAME}`);
  await pool.query(`DELETE FROM ${DEPLOYMENTS_TABLE_NAME}`);
}

/**
 * Clear all identity-related data for a stable baseline.
 */
async function clearAllIdentityData() {
  await ensureIdentityTables();
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
 * Seed the database with a single deployment that has no ACTIVE config version.
 */
async function seedDeploymentWithoutActiveConfig(deploymentCode) {
  await clearAllConfigData();

  const insertDeploymentSql = `
    INSERT INTO ${DEPLOYMENTS_TABLE_NAME} (code, name)
    VALUES ($1, $2)
    RETURNING id
  `;
  const deploymentName = `Deployment ${deploymentCode} without active config`;

  await pool.query(insertDeploymentSql, [deploymentCode, deploymentName]);
}

/**
 * Seed the database with an ACTIVE config for deployment D1,
 * including permission_matrix, branding, and ui locale artifacts.
 */
async function seedActiveConfigForD1() {
  await clearAllConfigData();

  // Insert deployment D1
  const insertDeploymentSql = `
    INSERT INTO ${DEPLOYMENTS_TABLE_NAME} (code, name)
    VALUES ($1, $2)
    RETURNING id
  `;
  const deploymentCode = 'D1';
  const deploymentName = 'Example Deployment D1';

  const deploymentResult = await pool.query(insertDeploymentSql, [
    deploymentCode,
    deploymentName,
  ]);
  const deploymentId = deploymentResult.rows[0].id;

  // Insert ACTIVE config version
  const insertConfigVersionSql = `
    INSERT INTO ${CONFIG_VERSIONS_TABLE_NAME} (
      deployment_id,
      version_number,
      status,
      created_by
    )
    VALUES ($1, $2, $3, $4)
    RETURNING id
  `;
  const versionNumber = 1;
  const status = 'ACTIVE';
  const createdBy = 'acceptance_test';

  const configVersionResult = await pool.query(insertConfigVersionSql, [
    deploymentId,
    versionNumber,
    status,
    createdBy,
  ]);
  const configVersionId = configVersionResult.rows[0].id;

  // Insert permission_matrix, branding, and ui artifacts
  const insertArtifactSql = `
    INSERT INTO ${CONFIG_ARTIFACTS_TABLE_NAME} (
      config_version_id,
      artifact_type,
      payload
    )
    VALUES ($1, $2, $3)
 `;

  const permissionMatrix = {
    roles: ['ASSISTANT', 'TEAM_LEADER'],
    permissions: {
      ASSISTANT: ['MARK_SCRIPT'],
      TEAM_LEADER: ['MARK_SCRIPT', 'VIEW_REPORTS'],
    },
  };

  const branding = {
    logoUrl: 'https://example.org/logo.png',
    primaryColor: '#0044cc',
  };

  const ui = {
    locale: 'fr-FR',
  };

  await pool.query(insertArtifactSql, [
    configVersionId,
    'permission_matrix',
    permissionMatrix,
  ]);
  await pool.query(insertArtifactSql, [
    configVersionId,
    'branding',
    branding,
  ]);
  await pool.query(insertArtifactSql, [configVersionId, 'ui', ui]);
}

/**
 * Seed an authorised config viewer user (with config.view permission).
 */
async function seedConfigViewerUser() {
  await clearAllIdentityData();

  const user = await createUser('config-viewer-1', 'Config Viewer One');
  const role = await createRole('config_viewer', 'Config Viewer');
  const permission = await createPermission(
    'config.view',
    'View configuration',
  );

  await assignRoleToUser(user.id, role.id);
  await assignPermissionToRole(role.id, permission.id);

  return user;
}

/**
 * Seed an authenticated user without any permissions.
 */
async function seedAuthenticatedUserWithoutConfigPermission() {
  await clearAllIdentityData();

  const user = await createUser(
    'config-no-permission-1',
    'Config No Permission',
  );

  // Intentionally do not assign roles or permissions.
  return user;
}

/**
 * Start the API server on the config test port (if not already running),
 * with DB-backed health enabled.
 */
async function ensureApiServerRunningForConfigTests() {
  if (apiProcess && !apiProcess.killed) {
    // Assume it is already running and healthy
    return;
  }

  apiProcess = spawn(process.execPath, ['apps/api/src/server.js'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      API_USE_DB_HEALTH: 'true',
      DB_HOST: process.env.DB_HOST || '127.0.0.1',
      DB_PORT: process.env.DB_PORT || '5432',
      DB_USER: process.env.DB_USER || 'paritymark',
      DB_PASSWORD: process.env.DB_PASSWORD || 'paritymark',
      DB_NAME: process.env.DB_NAME || 'paritymark',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Give the process a brief moment to start before health polling
  await sleep(1000);
  await waitForDbHealthUp();
}

Given(
  'the API server is running for config tests with no deployments',
  async function () {
    await clearAllConfigData();
    await ensureApiServerRunningForConfigTests();
  },
);

Given(
  'the API server is running for config tests with deployment {string} and no active config version',
  async function (deploymentCode) {
    await seedDeploymentWithoutActiveConfig(deploymentCode);
    await ensureApiServerRunningForConfigTests();
  },
);

Given(
  'the API server is running for config tests with an active config for deployment {string}',
  async function (_deploymentCode) {
    // At present we always seed D1; the parameter is kept for readability/future use.
    await seedActiveConfigForD1();
    await ensureApiServerRunningForConfigTests();
  },
);

Given('I am an authorised config viewer', async function () {
  await seedConfigViewerUser();
  configRequestHeaders = {
    'x-user-external-id': 'config-viewer-1',
    'x-user-display-name': 'Config Viewer One',
  };
});

Given('I am an anonymous config caller', function () {
  configRequestHeaders = {};
});

Given(
  'I am an authenticated config caller without config view permission',
  async function () {
    await seedAuthenticatedUserWithoutConfigPermission();
    configRequestHeaders = {
      'x-user-external-id': 'config-no-permission-1',
      'x-user-display-name': 'Config No Permission',
    };
  },
);

When(
  'I GET {string} from the config API server',
  async function (pathName) {
    lastConfigResponse = null;
    lastConfigBody = null;
    lastConfigJson = null;

    const res = await httpGetJson(pathName, configRequestHeaders);
    lastConfigResponse = {
      statusCode: res.statusCode,
      headers: res.headers,
    };
    lastConfigBody = res.body;
    lastConfigJson = res.json;
  },
);

Then(
  'the config response status code is {int}',
  function (expectedStatus) {
    assert.ok(
      lastConfigResponse,
      'Expected a config API response to have been recorded',
    );
    assert.strictEqual(
      lastConfigResponse.statusCode,
      expectedStatus,
      `Expected config response status ${expectedStatus}, got ${lastConfigResponse.statusCode}`,
    );
  },
);

Then(
  'the JSON config error code is {string}',
  function (expectedErrorCode) {
    assert.ok(
      typeof lastConfigBody === 'string',
      'Expected a string config response body to be recorded',
    );

    let parsed;
    try {
      parsed = lastConfigJson || JSON.parse(lastConfigBody);
    } catch (err) {
      throw new Error(
        `Expected JSON config error response body, but parsing failed: ${err.message}. Body was: ${lastConfigBody}`,
      );
    }

    assert.ok(
      parsed && typeof parsed === 'object',
      `Expected JSON object from config error endpoint, got: ${lastConfigBody}`,
    );

    assert.ok(
      Object.prototype.hasOwnProperty.call(parsed, 'error'),
      `Expected JSON error body to have property "error", got: ${JSON.stringify(
        parsed,
      )}`,
    );

    assert.strictEqual(
      parsed.error,
      expectedErrorCode,
      `Expected error code "${expectedErrorCode}", got "${parsed.error}"`,
    );
  },
);

Then(
  'the JSON config response contains an active config for deployment {string} with permission_matrix, branding, and ui locale artifacts',
  function (deploymentCode) {
    assert.ok(
      typeof lastConfigBody === 'string',
      'Expected a string config response body to be recorded',
    );

    let parsed;
    try {
      parsed = lastConfigJson || JSON.parse(lastConfigBody);
    } catch (err) {
      throw new Error(
        `Expected JSON config response body, but parsing failed: ${err.message}. Body was: ${lastConfigBody}`,
      );
    }

    assert.ok(
      parsed && typeof parsed === 'object',
      `Expected JSON object from config endpoint, got: ${lastConfigBody}`,
    );

    const { deployment, configVersion, artifacts } = parsed;

    // Deployment checks
    assert.ok(
      deployment && typeof deployment === 'object',
      `Expected "deployment" object in config response, got: ${JSON.stringify(
        deployment,
      )}`,
    );
    assert.strictEqual(
      deployment.code,
      deploymentCode,
      `Expected deployment.code to be "${deploymentCode}", got "${deployment.code}"`,
    );
    assert.ok(
      typeof deployment.name === 'string' && deployment.name.length > 0,
      `Expected deployment.name to be a non-empty string, got: ${deployment.name}`,
    );

    // Config version checks
    assert.ok(
      configVersion && typeof configVersion === 'object',
      `Expected "configVersion" object in config response, got: ${JSON.stringify(
        configVersion,
      )}`,
    );
    assert.strictEqual(
      configVersion.status,
      'ACTIVE',
      `Expected configVersion.status to be "ACTIVE", got "${configVersion.status}"`,
    );

    // Artifacts checks
    assert.ok(
      artifacts && typeof artifacts === 'object',
      `Expected "artifacts" object in config response, got: ${JSON.stringify(
        artifacts,
      )}`,
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(artifacts, 'permission_matrix'),
      `Expected artifacts to include "permission_matrix", got: ${Object.keys(
        artifacts,
      ).join(', ')}`,
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(artifacts, 'branding'),
      `Expected artifacts to include "branding", got: ${Object.keys(
        artifacts,
      ).join(', ')}`,
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(artifacts, 'ui'),
      `Expected artifacts to include "ui", got: ${Object.keys(
        artifacts,
      ).join(', ')}`,
    );

    const ui = artifacts.ui;
    assert.ok(
      ui && typeof ui === 'object',
      `Expected "ui" artifact to be an object, got: ${JSON.stringify(ui)}`,
    );
    assert.strictEqual(
      ui.locale,
      'fr-FR',
      `Expected ui.locale to be "fr-FR", got ${JSON.stringify(ui.locale)}`,
    );
  },
);

After(async function () {
  if (apiProcess && !apiProcess.killed) {
    apiProcess.kill('SIGINT');
    const timeoutMs = 5000;
    const start = Date.now();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        process.kill(apiProcess.pid, 0);
        if (Date.now() - start > timeoutMs) {
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(100);
      } catch (_err) {
        break; // process is gone
      }
    }
  }
  apiProcess = null;
  lastConfigResponse = null;
  lastConfigBody = null;
  lastConfigJson = null;
  configRequestHeaders = {};
});
