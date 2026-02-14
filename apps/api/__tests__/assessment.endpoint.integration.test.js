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

jest.setTimeout(30000); // allow time for DB + HTTP operations

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
            // If it's not JSON, leave json = null and still return the body for debugging.
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

describe('Assessment tree HTTP endpoint with RBAC', () => {
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
    await ensureIdentityTables();
    await ensureAssessmentTables();

    // Start API server on an ephemeral port
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
    // Clean assessment-related tables
    await pool.query(`DELETE FROM ${ASSESSMENT_ITEMS_TABLE_NAME}`);
    await pool.query(`DELETE FROM ${ASSESSMENT_QIGS_TABLE_NAME}`);
    await pool.query(`DELETE FROM ${ASSESSMENT_PAPERS_TABLE_NAME}`);
    await pool.query(`DELETE FROM ${ASSESSMENT_SERIES_TABLE_NAME}`);

    // Clean config-related tables
    await pool.query(`DELETE FROM ${CONFIG_ARTIFACTS_TABLE_NAME}`);
    await pool.query(`DELETE FROM ${CONFIG_VERSIONS_TABLE_NAME}`);
    await pool.query(`DELETE FROM ${DEPLOYMENTS_TABLE_NAME}`);

    // Clean identity tables
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
  });

  afterAll(async () => {
    if (server && server.close) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  });

  test('returns 401 unauthenticated when no user headers are provided', async () => {
    const res = await httpGetJson(port, '/assessment/D1/tree');

    expect(res.statusCode).toBe(401);
    expect(res.json).toEqual({
      error: 'unauthenticated',
      permission: 'assessment.view',
    });
  });

  test('returns 403 forbidden when user lacks assessment.view permission', async () => {
    const res = await httpGetJson(port, '/assessment/D1/tree', {
      'x-user-external-id': 'no-assessment-perm',
      'x-user-display-name': 'No Assessment Perm',
    });

    expect(res.statusCode).toBe(403);
    expect(res.json).toEqual({
      error: 'forbidden',
      permission: 'assessment.view',
    });
  });

  test('returns assessment tree for authorised user', async () => {
    // Seed identity: user with assessment.view permission
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

    // Seed a deployment and assessment structure
    const deploymentCode = 'D_ASSESS_HTTP';
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
    const itemRow = await createItem(qigRow.id, 'I_HTTP_1', 20);

    const res = await httpGetJson(
      port,
      `/assessment/${deploymentCode}/tree`,
      {
        'x-user-external-id': 'assessment-viewer-1',
        'x-user-display-name': 'Assessment Viewer One',
      },
    );

    expect(res.statusCode).toBe(200);
    expect(res.json).toBeTruthy();

    const { deployment, series } = res.json;

    expect(deployment).toMatchObject({
      id: deploymentId,
      code: deploymentCode,
      name: deploymentName,
    });

    expect(Array.isArray(series)).toBe(true);
    expect(series.length).toBe(1);

    const s = series[0];
    expect(s).toMatchObject({
      id: seriesRow.id,
      code: 'S_HTTP_1',
      name: 'Series HTTP 1',
    });

    expect(Array.isArray(s.papers)).toBe(true);
    expect(s.papers.length).toBe(1);

    const p = s.papers[0];
    expect(p).toMatchObject({
      id: paperRow.id,
      code: 'P_HTTP_1',
      name: 'Paper HTTP 1',
    });

    expect(Array.isArray(p.qigs)).toBe(true);
    expect(p.qigs.length).toBe(1);

    const q = p.qigs[0];
    expect(q).toMatchObject({
      id: qigRow.id,
      code: 'Q_HTTP_1',
      name: 'QIG HTTP 1',
    });

    expect(Array.isArray(q.items)).toBe(true);
    expect(q.items.length).toBe(1);

    const it = q.items[0];
    expect(it).toMatchObject({
      id: itemRow.id,
      code: 'I_HTTP_1',
      maxMark: 20,
    });
  });
});
