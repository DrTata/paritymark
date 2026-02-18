const assert = require('assert');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { Given, When, Then, After, setDefaultTimeout } = require('@cucumber/cucumber');

setDefaultTimeout(90 * 1000);

const ROOT_DIR = path.resolve(__dirname, '../../..');
const API_PORT = 4301;

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
const {
  ensureAuditTable,
  AUDIT_TABLE_NAME,
  ASSESSMENT_TREE_VIEWED_EVENT_TYPE,
  PERMISSION_DENIED_EVENT_TYPE,
  getLatestAuditEventByType,
} = require(path.resolve(ROOT_DIR, 'apps/api/src/audit'));

let apiProcess = null;
let lastTreeResponse = null;
let lastTreeBody = null;
let lastTreeJson = null;
let assessmentRequestHeaders = {};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpGetJson(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: API_PORT,
        path: pathname,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = body ? JSON.parse(body) : null;
          } catch (_err) {
            // Leave json as null; callers can still inspect body for debugging.
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
    req.end();
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
 * Clear all assessment/config/identity/audit data for a stable baseline.
 */
async function clearAllAssessmentData() {
  await ensureConfigTables();
  await ensureIdentityTables();
  await ensureAssessmentTables();
  await ensureAuditTable();

  // Assessment tables
  await pool.query(`DELETE FROM ${ASSESSMENT_ITEMS_TABLE_NAME}`);
  await pool.query(`DELETE FROM ${ASSESSMENT_QIGS_TABLE_NAME}`);
  await pool.query(`DELETE FROM ${ASSESSMENT_PAPERS_TABLE_NAME}`);
  await pool.query(`DELETE FROM ${ASSESSMENT_SERIES_TABLE_NAME}`);

  // Config tables: clear artifacts and versions before deleting deployments
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

  // Audit table
  await pool.query(`DELETE FROM ${AUDIT_TABLE_NAME}`);
}

/**
 * Seed a single deployment with one series, one paper, one QIG and one item,
 * matching the HTTP assessment test and the Assessment Debug page expectations.
 */
async function seedAssessmentTreeForDeployment(deploymentCode) {
  await clearAllAssessmentData();

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
    seriesId: seriesRow.id,
    paperId: paperRow.id,
    qigId: qigRow.id,
  };
}

/**
 * Start the API server on the assessment test port (if not already running),
 * with DB-backed health enabled.
 */
async function ensureApiServerRunningForAssessmentTests() {
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
  'the API server is running for assessment tests with an assessment tree for deployment {string}',
  async function (deploymentCode) {
    await seedAssessmentTreeForDeployment(deploymentCode);
    await ensureApiServerRunningForAssessmentTests();
  },
);

Given('I am an authorised assessment tree viewer', async function () {
  await ensureIdentityTables();

  const user = await createUser(
    'assessment-viewer-1',
    'Assessment Viewer One',
  );
  const role = await createRole('ASSESSMENT_VIEWER', 'Assessment tree viewer');
  const perm = await createPermission(
    'assessment.view',
    'View assessment structures',
  );

  await assignRoleToUser(user.id, role.id);
  await assignPermissionToRole(role.id, perm.id);

  assessmentRequestHeaders = {
    'x-user-external-id': user.external_id,
    'x-user-display-name': user.display_name,
  };
});

Given('I am an unauthorised assessment tree viewer', async function () {
  await ensureIdentityTables();

  const user = await createUser(
    'no-assessment-perm',
    'No Assessment Perm',
  );

  assessmentRequestHeaders = {
    'x-user-external-id': user.external_id,
    'x-user-display-name': user.display_name,
  };
});

When(
  'I GET {string} from the assessment API server',
  async function (pathName) {
    lastTreeResponse = null;
    lastTreeBody = null;
    lastTreeJson = null;

    const res = await httpGetJson(pathName, assessmentRequestHeaders);
    lastTreeResponse = {
      statusCode: res.statusCode,
      headers: res.headers,
    };
    lastTreeBody = res.body;
    lastTreeJson = res.json;
  },
);

Then(
  'the assessment tree response status code is {int}',
  function (expectedStatus) {
    assert.ok(
      lastTreeResponse,
      'Expected an assessment tree API response to have been recorded',
    );
    assert.strictEqual(
      lastTreeResponse.statusCode,
      expectedStatus,
      `Expected assessment tree response status ${expectedStatus}, got ${lastTreeResponse.statusCode}`,
    );
  },
);

Then(
  'the JSON assessment tree response contains a deployment {string} with at least one series, paper, QIG and item',
  function (deploymentCode) {
    assert.ok(
      typeof lastTreeBody === 'string',
      'Expected a string assessment tree response body to be recorded',
    );

    let parsed;
    try {
      parsed = lastTreeJson || JSON.parse(lastTreeBody);
    } catch (err) {
      throw new Error(
        `Expected JSON assessment tree response body, but parsing failed: ${err.message}. Body was: ${lastTreeBody}`,
      );
    }

    assert.ok(
      parsed && typeof parsed === 'object',
      `Expected JSON object from assessment tree endpoint, got: ${lastTreeBody}`,
    );

    const { deployment, series } = parsed;

    // Deployment checks
    assert.ok(
      deployment && typeof deployment === 'object',
      `Expected "deployment" object in assessment tree response, got: ${JSON.stringify(
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

    // Series checks
    assert.ok(
      Array.isArray(series),
      `Expected "series" to be an array, got: ${JSON.stringify(series)}`,
    );
    assert.ok(
      series.length >= 1,
      `Expected at least one series in assessment tree, got ${series.length}`,
    );

    const s = series[0];
    assert.strictEqual(
      s.code,
      'S_HTTP_1',
      `Expected first series.code to be "S_HTTP_1", got "${s.code}"`,
    );
    assert.strictEqual(
      s.name,
      'Series HTTP 1',
      `Expected first series.name to be "Series HTTP 1", got "${s.name}"`,
    );

    assert.ok(
      Array.isArray(s.papers),
      `Expected series.papers to be an array, got: ${JSON.stringify(s.papers)}`,
    );
    assert.ok(
      s.papers.length >= 1,
      `Expected at least one paper in series, got ${s.papers.length}`,
    );

    const p = s.papers[0];
    assert.strictEqual(
      p.code,
      'P_HTTP_1',
      `Expected first paper.code to be "P_HTTP_1", got "${p.code}"`,
    );
    assert.strictEqual(
      p.name,
      'Paper HTTP 1',
      `Expected first paper.name to be "Paper HTTP 1", got "${p.name}"`,
    );

    assert.ok(
      Array.isArray(p.qigs),
      `Expected paper.qigs to be an array, got: ${JSON.stringify(p.qigs)}`,
    );
    assert.ok(
      p.qigs.length >= 1,
      `Expected at least one QIG in paper, got ${p.qigs.length}`,
    );

    const q = p.qigs[0];
    assert.strictEqual(
      q.code,
      'Q_HTTP_1',
      `Expected first qig.code to be "Q_HTTP_1", got "${q.code}"`,
    );
    assert.strictEqual(
      q.name,
      'QIG HTTP 1',
      `Expected first qig.name to be "QIG HTTP 1", got "${q.name}"`,
    );

    assert.ok(
      Array.isArray(q.items),
      `Expected qig.items to be an array, got: ${JSON.stringify(q.items)}`,
    );
    assert.ok(
      q.items.length >= 1,
      `Expected at least one item in QIG, got ${q.items.length}`,
    );

    const it = q.items[0];
    assert.strictEqual(
      it.code,
      'I_HTTP_1',
      `Expected first item.code to be "I_HTTP_1", got "${it.code}"`,
    );
    assert.strictEqual(
      it.maxMark,
      20,
      `Expected first item.maxMark to be 20, got "${it.maxMark}"`,
    );
  },
);

Then(
  'the JSON assessment tree permission error is {string} for permission {string}',
  function (expectedError, expectedPermission) {
    assert.ok(
      typeof lastTreeBody === 'string',
      'Expected a string assessment tree response body to be recorded',
    );

    let parsed;
    try {
      parsed = lastTreeJson || JSON.parse(lastTreeBody);
    } catch (err) {
      throw new Error(
        `Expected JSON assessment tree response body, but parsing failed: ${err.message}. Body was: ${lastTreeBody}`,
      );
    }

    assert.ok(
      parsed && typeof parsed === 'object',
      `Expected JSON object from assessment tree endpoint, got: ${lastTreeBody}`,
    );

    assert.strictEqual(
      parsed.error,
      expectedError,
      `Expected error="${expectedError}", got "${parsed.error}"`,
    );
    assert.strictEqual(
      parsed.permission,
      expectedPermission,
      `Expected permission="${expectedPermission}", got "${parsed.permission}"`,
    );
  },
);

Then(
  'the JSON assessment tree error code is {string}',
  function (expectedErrorCode) {
    assert.ok(
      typeof lastTreeBody === 'string',
      'Expected a string assessment tree response body to be recorded',
    );

    let parsed;
    try {
      parsed = lastTreeJson || JSON.parse(lastTreeBody);
    } catch (err) {
      throw new Error(
        `Expected JSON assessment tree response body, but parsing failed: ${err.message}. Body was: ${lastTreeBody}`,
      );
    }

    assert.ok(
      parsed && typeof parsed === 'object',
      `Expected JSON object from assessment tree endpoint, got: ${lastTreeBody}`,
    );

    assert.strictEqual(
      parsed.error,
      expectedErrorCode,
      `Expected error="${expectedErrorCode}", got "${parsed.error}"`,
    );
  },
);

Then(
  'an assessment tree view audit event exists for deployment {string} and user {string}',
  async function (deploymentCode, userExternalId) {
    const event = await getLatestAuditEventByType(
      ASSESSMENT_TREE_VIEWED_EVENT_TYPE,
    );

    assert.ok(
      event,
      'Expected an ASSESSMENT_TREE_VIEWED audit event to exist',
    );
    assert.strictEqual(
      event.event_type,
      ASSESSMENT_TREE_VIEWED_EVENT_TYPE,
      `Expected event_type=${ASSESSMENT_TREE_VIEWED_EVENT_TYPE}, got ${event.event_type}`,
    );

    const payload = event.payload || {};
    const meta = payload.meta || {};
    const actor = payload.actor || {};

    assert.strictEqual(
      meta.deploymentCode,
      deploymentCode,
      `Expected meta.deploymentCode="${deploymentCode}", got "${meta.deploymentCode}"`,
    );
    assert.ok(
      typeof meta.deploymentId === 'number',
      `Expected numeric meta.deploymentId, got ${meta.deploymentId}`,
    );
    assert.strictEqual(
      meta.method,
      'GET',
      `Expected meta.method="GET", got "${meta.method}"`,
    );
    assert.ok(
      typeof meta.path === 'string' &&
        meta.path.indexOf(`/assessment/${deploymentCode}/tree`) === 0,
      `Expected meta.path to start with "/assessment/${deploymentCode}/tree", got "${meta.path}"`,
    );

    assert.strictEqual(
      actor.externalId,
      userExternalId,
      `Expected actor.externalId="${userExternalId}", got "${actor.externalId}"`,
    );
  },
);

Then(
  'a permission denied audit event exists for permission {string} and reason {string}',
  async function (permissionKey, reason) {
    const event = await getLatestAuditEventByType(
      PERMISSION_DENIED_EVENT_TYPE,
    );

    assert.ok(
      event,
      'Expected a PERMISSION_DENIED audit event to exist',
    );
    assert.strictEqual(
      event.event_type,
      PERMISSION_DENIED_EVENT_TYPE,
      `Expected event_type=${PERMISSION_DENIED_EVENT_TYPE}, got ${event.event_type}`,
    );

    const payload = event.payload || {};
    const meta = payload.meta || {};

    assert.strictEqual(
      meta.permission,
      permissionKey,
      `Expected meta.permission="${permissionKey}", got "${meta.permission}"`,
    );
    assert.strictEqual(
      meta.reason,
      reason,
      `Expected meta.reason="${reason}", got "${meta.reason}"`,
    );

    assert.strictEqual(
      meta.method,
      'GET',
      `Expected meta.method="GET", got "${meta.method}"`,
    );
    assert.ok(
      typeof meta.path === 'string' &&
        meta.path.indexOf('/assessment/') === 0,
      `Expected meta.path to start with "/assessment/", got "${meta.path}"`,
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
  lastTreeResponse = null;
  lastTreeBody = null;
  lastTreeJson = null;
  assessmentRequestHeaders = {};
});
