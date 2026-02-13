const assert = require('assert');
const path = require('path');
const http = require('http');
const { Given, When, Then, setDefaultTimeout } = require('@cucumber/cucumber');

setDefaultTimeout(90 * 1000);

const ROOT_DIR = path.resolve(__dirname, '../../..');
const API_PORT = 4300;

const { pool } = require(path.resolve(ROOT_DIR, 'apps/api/src/db'));
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

let currentActivationHeaders = {};
let lastActivationResponse = null;
let lastActivationBody = null;
let lastActivationJson = null;

async function clearAllIdentityData() {
  await ensureIdentityTables();
  await pool.query(`
    TRUNCATE TABLE
      ${USER_ROLES_TABLE_NAME},
      ${ROLE_PERMISSIONS_TABLE_NAME},
      ${PERMISSIONS_TABLE_NAME},
      ${ROLES_TABLE_NAME},
      ${USERS_TABLE_NAME}
    RESTART IDENTITY CASCADE
  `);
}

function httpPostJson(pathname) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: API_PORT,
      path: pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...currentActivationHeaders,
      },
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (body) {
          try {
            json = JSON.parse(body);
          } catch (err) {
            return reject(
              new Error(
                `Failed to parse JSON from ${pathname}: ${err.message}. Body was: ${body}`,
              ),
            );
          }
        }

        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
          json,
        });
      });
    });

    req.on('error', reject);
    // No request body needed for this endpoint in Phase 1.
    req.end();
  });
}

Given('I am an anonymous config activation caller', async function () {
  await clearAllIdentityData();
  currentActivationHeaders = {};
});

Given(
  'I am an authenticated config caller without activation permission',
  async function () {
    await clearAllIdentityData();

    const user = await createUser(
      'config-activation-no-permission',
      'Config activation caller without permission',
    );

    currentActivationHeaders = {
      'x-user-external-id': user.external_id,
      'x-user-display-name': user.display_name,
    };
  },
);

Given('I am an authorised config activator', async function () {
  await clearAllIdentityData();

  const user = await createUser('config-activator-1', 'Config Activator');
  const role = await createRole('config_activator', 'Config activator role');

  const activatePermission = await createPermission(
    'config.activate',
    'Activate configuration versions',
  );

  const viewPermission = await createPermission(
    'config.view',
    'View configuration',
  );

  await assignRoleToUser(user.id, role.id);
  await assignPermissionToRole(role.id, activatePermission.id);
  await assignPermissionToRole(role.id, viewPermission.id);

  currentActivationHeaders = {
    'x-user-external-id': user.external_id,
    'x-user-display-name': user.display_name,
  };
});

When(
  'I POST {string} to the config API server',
  async function (pathName) {
    lastActivationResponse = null;
    lastActivationBody = null;
    lastActivationJson = null;

    const res = await httpPostJson(pathName);
    lastActivationResponse = {
      statusCode: res.statusCode,
      headers: res.headers,
    };
    lastActivationBody = res.body;
    lastActivationJson = res.json;
  },
);

Then(
  'the config activation response status code is {int}',
  function (expectedStatus) {
    assert.ok(
      lastActivationResponse,
      'Expected a config activation API response to have been recorded',
    );

    assert.strictEqual(
      lastActivationResponse.statusCode,
      expectedStatus,
      `Expected config activation response status ${expectedStatus}, got ${lastActivationResponse.statusCode}`,
    );
  },
);

Then(
  'the JSON config activation error code is {string}',
  function (expectedErrorCode) {
    assert.ok(
      typeof lastActivationBody === 'string',
      'Expected a string config activation response body to be recorded',
    );

    let parsed;
    try {
      parsed = lastActivationJson || JSON.parse(lastActivationBody);
    } catch (err) {
      throw new Error(
        `Expected JSON config activation error response body, but parsing failed: ${err.message}. Body was: ${lastActivationBody}`,
      );
    }

    assert.ok(
      parsed && typeof parsed === 'object',
      `Expected JSON object from config activation endpoint, got: ${lastActivationBody}`,
    );

    assert.ok(
      Object.prototype.hasOwnProperty.call(parsed, 'error'),
      `Expected JSON activation error body to have property "error", got: ${JSON.stringify(
        parsed,
      )}`,
    );

    assert.strictEqual(
      parsed.error,
      expectedErrorCode,
      `Expected activation error code "${expectedErrorCode}", got "${parsed.error}"`,
    );
  },
);

Then(
  'the JSON config activation response contains an activated config version {int} for deployment {string}',
  function (expectedVersionNumber, deploymentCode) {
    assert.ok(
      typeof lastActivationBody === 'string',
      'Expected a string config activation response body to be recorded',
    );

    let parsed;
    try {
      parsed = lastActivationJson || JSON.parse(lastActivationBody);
    } catch (err) {
      throw new Error(
        `Expected JSON config activation response body, but parsing failed: ${err.message}. Body was: ${lastActivationBody}`,
      );
    }

    assert.ok(
      parsed && typeof parsed === 'object',
      `Expected JSON object from config activation endpoint, got: ${lastActivationBody}`,
    );

    const { deployment, configVersion } = parsed;

    assert.ok(
      deployment && typeof deployment === 'object',
      `Expected "deployment" object in activation response, got: ${JSON.stringify(
        deployment,
      )}`,
    );
    assert.strictEqual(
      deployment.code,
      deploymentCode,
      `Expected deployment.code to be "${deploymentCode}", got "${deployment.code}"`,
    );

    assert.ok(
      configVersion && typeof configVersion === 'object',
      `Expected "configVersion" object in activation response, got: ${JSON.stringify(
        configVersion,
      )}`,
    );

    assert.strictEqual(
      configVersion.version_number,
      expectedVersionNumber,
      `Expected configVersion.version_number to be ${expectedVersionNumber}, got ${configVersion.version_number}`,
    );

    assert.strictEqual(
      configVersion.status,
      'ACTIVE',
      `Expected configVersion.status to be "ACTIVE", got "${configVersion.status}"`,
    );
  },
);
