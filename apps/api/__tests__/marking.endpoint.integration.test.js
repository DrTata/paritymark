const http = require('http');
const { createServer } = require('../src/server');
const { pool } = require('../src/db');

const {
  ensureConfigTables,
  DEPLOYMENTS_TABLE_NAME,
  CONFIG_VERSIONS_TABLE_NAME,
  CONFIG_ARTIFACTS_TABLE_NAME,
} = require('../src/config');

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
} = require('../src/assessment');

const {
  ensureIngestionTables,
  RESPONSES_TABLE_NAME,
  upsertResponse,
} = require('../src/ingestion');

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
} = require('../src/identity');

const {
  ensureMarkingTables,
  RESPONSE_MARKS_TABLE_NAME,
} = require('../src/marking');

const {
  ensureAuditTable,
  AUDIT_TABLE_NAME,
} = require('../src/audit');

jest.setTimeout(30000);

function httpGetJson(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
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
            // leave json = null
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

function httpPostJson(port, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch (_err) {
            // leave json = null
          }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: raw,
            json,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Helper: seed a deployment + assessment tree + response
async function seedResponseForMarking() {
  await ensureConfigTables();
  await ensureAssessmentTables();
  await ensureIngestionTables();

  const deploymentCode = 'D_MARK_HTTP';
  const deploymentName = 'HTTP Marking Test';

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
    'S_MARK_1',
    'Series Mark 1',
  );
  const paperRow = await createPaper(
    seriesRow.id,
    'P_MARK_1',
    'Paper Mark 1',
  );
  const qigRow = await createQig(
    paperRow.id,
    'Q_MARK_1',
    'QIG Mark 1',
  );
  await createItem(qigRow.id, 'I_MARK_1', 20);

  const candidateId = 'C_MARK_1';
  const scriptUrl = 's3://bucket/C_MARK_1.pdf';

  const responseRow = await upsertResponse({
    qigId: qigRow.id,
    candidateId,
    scriptUrl,
    manifest: null,
    state: 'INGESTED',
  });

  return {
    deploymentCode,
    deploymentId,
    seriesRow,
    paperRow,
    qigRow,
    candidateId,
    responseRow,
  };
}

// Helper: create a user with given marking permissions
async function seedMarkerUserWithPermissions(
  externalId,
  displayName,
  permissionKeys,
) {
  await ensureIdentityTables();

  const user = await createUser(externalId, displayName);
  const role = await createRole(
    `MARKER_${externalId}`,
    `Marking test role for ${externalId}`,
  );

  await assignRoleToUser(user.id, role.id);

  // Create + assign each permission
  // eslint-disable-next-line no-restricted-syntax
  for (const key of permissionKeys) {
    // eslint-disable-next-line no-await-in-loop
    const perm = await createPermission(
      key,
      `Generated for marking endpoint tests (${key})`,
    );
    // eslint-disable-next-line no-await-in-loop
    await assignPermissionToRole(role.id, perm.id);
  }

  return user;
}

describe('Marking HTTP endpoints with RBAC', () => {
  let server;
  let port;

  beforeAll(async () => {
    // Ensure DB env vars are set for local dev / CI
    process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
    process.env.DB_PORT = process.env.DB_PORT || '5432';
    process.env.DB_USER = process.env.DB_USER || 'paritymark';
    process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'paritymark';
    process.env.DB_NAME = process.env.DB_NAME || 'paritymark';

    await ensureConfigTables();
    await ensureAssessmentTables();
    await ensureIngestionTables();
    await ensureIdentityTables();
    await ensureMarkingTables();
    await ensureAuditTable();

    server = createServer();
    await new Promise((resolve) => {
      const s = server.listen(0, () => {
        // @ts-ignore
        port = s.address().port;
        resolve();
      });
    });
  });

  beforeEach(async () => {
    // Make sure schema exists
    await ensureMarkingTables();
    await ensureIngestionTables();
    await ensureAssessmentTables();
    await ensureConfigTables();
    await ensureIdentityTables();
    await ensureAuditTable();

    // Clear marking / ingestion / assessment / config / audit / identity data
    await pool.query(`DELETE FROM ${RESPONSE_MARKS_TABLE_NAME}`);
    await pool.query(`DELETE FROM ${RESPONSES_TABLE_NAME}`);
    await pool.query(`DELETE FROM ${ASSESSMENT_ITEMS_TABLE_NAME}`);
    await pool.query(`DELETE FROM ${ASSESSMENT_QIGS_TABLE_NAME}`);
    await pool.query(`DELETE FROM ${ASSESSMENT_PAPERS_TABLE_NAME}`);
    await pool.query(`DELETE FROM ${ASSESSMENT_SERIES_TABLE_NAME}`);

    await pool.query(`DELETE FROM ${CONFIG_ARTIFACTS_TABLE_NAME}`);
    await pool.query(`DELETE FROM ${CONFIG_VERSIONS_TABLE_NAME}`);
    await pool.query(`DELETE FROM ${DEPLOYMENTS_TABLE_NAME}`);

    await pool.query(`DELETE FROM ${AUDIT_TABLE_NAME}`);

    await pool.query(`
      TRUNCATE TABLE
        ${USER_ROLES_TABLE_NAME},
        ${ROLE_PERMISSIONS_TABLE_NAME},
        ${PERMISSIONS_TABLE_NAME},
        ${ROLES_TABLE_NAME},
        ${USERS_TABLE_NAME}
      RESTART IDENTITY CASCADE
    `);
  });

  afterAll(async () => {
    if (server && server.close) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  });

  test('POST /marking/responses/:id/draft requires authentication and returns 401', async () => {
    const res = await httpPostJson(
      port,
      '/marking/responses/1/draft',
      { marks: { I1: 10 } },
    );

    expect(res.statusCode).toBe(401);
    expect(res.json).toEqual({
      error: 'unauthenticated',
      permission: 'marking.edit',
    });
  });

  test('POST /marking/responses/:id/draft returns 403 when user lacks marking.edit', async () => {
    const res = await httpPostJson(
      port,
      '/marking/responses/1/draft',
      { marks: { I1: 10 } },
      {
        'x-user-external-id': 'no-marking-edit',
        'x-user-display-name': 'No Marking Edit',
      },
    );

    expect(res.statusCode).toBe(403);
    expect(res.json).toEqual({
      error: 'forbidden',
      permission: 'marking.edit',
    });
  });

  test('GET /marking/responses/:id requires authentication and returns 401', async () => {
    const res = await httpGetJson(port, '/marking/responses/1');

    expect(res.statusCode).toBe(401);
    expect(res.json).toEqual({
      error: 'unauthenticated',
      permission: 'marking.view',
    });
  });

  test('GET /marking/responses/:id returns 403 when user lacks marking.view', async () => {
    const res = await httpGetJson(
      port,
      '/marking/responses/1',
      {
        'x-user-external-id': 'no-marking-view',
        'x-user-display-name': 'No Marking View',
      },
    );

    expect(res.statusCode).toBe(403);
    expect(res.json).toEqual({
      error: 'forbidden',
      permission: 'marking.view',
    });
  });

  test('POST /marking/responses/:id/draft returns 404 when response does not exist for authorised user', async () => {
    await seedMarkerUserWithPermissions(
      'marking-editor-404',
      'Marking Editor 404',
      ['marking.edit'],
    );

    const res = await httpPostJson(
      port,
      '/marking/responses/9999/draft',
      { marks: { I1: 10 } },
      {
        'x-user-external-id': 'marking-editor-404',
        'x-user-display-name': 'Marking Editor 404',
      },
    );

    expect(res.statusCode).toBe(404);
    expect(res.json).toEqual({
      error: 'response_not_found',
    });
  });

  test('GET /marking/responses/:id returns 404 when no mark exists for authorised user', async () => {
    const { responseRow } = await seedResponseForMarking();

    await seedMarkerUserWithPermissions(
      'marking-viewer-404',
      'Marking Viewer 404',
      ['marking.view'],
    );

    const res = await httpGetJson(
      port,
      `/marking/responses/${responseRow.id}`,
      {
        'x-user-external-id': 'marking-viewer-404',
        'x-user-display-name': 'Marking Viewer 404',
      },
    );

    expect(res.statusCode).toBe(404);
    expect(res.json).toEqual({
      error: 'mark_not_found',
    });
  });

  test('Marking endpoints allow draft, fetch and submit then lock the response', async () => {
    const { responseRow } = await seedResponseForMarking();

    await seedMarkerUserWithPermissions(
      'marker-1',
      'Marker One',
      ['marking.edit', 'marking.view'],
    );

    const headers = {
      'x-user-external-id': 'marker-1',
      'x-user-display-name': 'Marker One',
    };

    // 1) Save draft
    const draftRes = await httpPostJson(
      port,
      `/marking/responses/${responseRow.id}/draft`,
      { marks: { I1: 10 } },
      headers,
    );

    expect(draftRes.statusCode).toBe(200);
    expect(draftRes.json).toBeTruthy();
    expect(draftRes.json.mark).toBeDefined();
    expect(draftRes.json.mark.state).toBe('DRAFT');
    expect(draftRes.json.mark.payload).toMatchObject({ I1: 10 });

    // 2) Fetch draft
    const getDraftRes = await httpGetJson(
      port,
      `/marking/responses/${responseRow.id}`,
      headers,
    );

    expect(getDraftRes.statusCode).toBe(200);
    expect(getDraftRes.json).toBeTruthy();
    expect(getDraftRes.json.mark.state).toBe('DRAFT');
    expect(getDraftRes.json.mark.payload).toMatchObject({ I1: 10 });

    // 3) Submit marks
    const submitRes = await httpPostJson(
      port,
      `/marking/responses/${responseRow.id}/submit`,
      { marks: { I1: 12 } },
      headers,
    );

    expect(submitRes.statusCode).toBe(200);
    expect(submitRes.json).toBeTruthy();
    expect(submitRes.json.mark.state).toBe('SUBMITTED');
    expect(submitRes.json.mark.payload).toMatchObject({ I1: 12 });

    // 4) Fetch submitted marks
    const getSubmittedRes = await httpGetJson(
      port,
      `/marking/responses/${responseRow.id}`,
      headers,
    );

    expect(getSubmittedRes.statusCode).toBe(200);
    expect(getSubmittedRes.json).toBeTruthy();
    expect(getSubmittedRes.json.mark.state).toBe('SUBMITTED');
    expect(getSubmittedRes.json.mark.payload).toMatchObject({ I1: 12 });

    // 5) Attempt to overwrite after lock should return 409
    const lockedDraftRes = await httpPostJson(
      port,
      `/marking/responses/${responseRow.id}/draft`,
      { marks: { I1: 5 } },
      headers,
    );

    expect(lockedDraftRes.statusCode).toBe(409);
    expect(lockedDraftRes.json).toEqual({
      error: 'response_locked',
      reason: 'LOCKED',
    });

    // 6) Response still shows submitted marks
    const getAfterLockRes = await httpGetJson(
      port,
      `/marking/responses/${responseRow.id}`,
      headers,
    );

    expect(getAfterLockRes.statusCode).toBe(200);
    expect(getAfterLockRes.json.mark.state).toBe('SUBMITTED');
    expect(getAfterLockRes.json.mark.payload).toMatchObject({ I1: 12 });
  });
});
