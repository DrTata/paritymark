const http = require('http');
const { createServer } = require('../src/server');
const { pool, endPool } = require('../src/db');
const {
  ensureConfigTables,
  DEPLOYMENTS_TABLE_NAME,
  CONFIG_VERSIONS_TABLE_NAME,
  CONFIG_ARTIFACTS_TABLE_NAME,
  createDeployment,
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

jest.setTimeout(30000); // allow time for DB + HTTP operations

function httpPostJson(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
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

describe('Config activation HTTP endpoint with RBAC', () => {
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

  afterAll(async () => {
    if (server && server.close) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    await endPool();
  });

  test('returns 401 unauthenticated when no user headers are provided', async () => {
    const res = await httpPostJson(
      port,
      '/config/D1/versions/1/activate',
    );

    expect(res.statusCode).toBe(401);
    expect(res.json).toMatchObject({ error: 'unauthenticated' });
  });

  test('activates config version and returns deployment + configVersion for authorised user', async () => {
    // Seed identity: user with config.activate permission
    const user = await createUser('activator-1', 'Activator One');
    const role = await createRole('config_activator', 'Config activator');
    const permission = await createPermission(
      'config.activate',
      'Activate config versions',
    );

    await assignRoleToUser(user.id, role.id);
    await assignPermissionToRole(role.id, permission.id);

    // Seed a deployment with two versions via helper
    const deploymentCode = 'D_ACT_HTTP';
    const deploymentName = 'HTTP activation test';
    const deployment = await createDeployment(deploymentCode, deploymentName);
    const deploymentId = deployment.id;

    const insertVersionSql = `
      INSERT INTO ${CONFIG_VERSIONS_TABLE_NAME} (
        deployment_id,
        version_number,
        status,
        created_by
      )
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `;
    // v1 starts as ACTIVE
    await pool.query(insertVersionSql, [
      deploymentId,
      1,
      'ACTIVE',
      'test',
    ]);
    // v2 is APPROVED and will be activated
    const v2Result = await pool.query(insertVersionSql, [
      deploymentId,
      2,
      'APPROVED',
      'test',
    ]);
    const v2Id = v2Result.rows[0].id;

    const res = await httpPostJson(
      port,
      `/config/${deploymentCode}/versions/2/activate`,
      {
        'x-user-external-id': 'activator-1',
        'x-user-display-name': 'Activator One',
      },
    );

    expect(res.statusCode).toBe(200);
    expect(res.json).toBeTruthy();
    expect(res.json.deployment).toMatchObject({
      id: deploymentId,
      code: deploymentCode,
      name: deploymentName,
    });
    expect(res.json.configVersion).toMatchObject({
      id: v2Id,
      deployment_id: deploymentId,
      version_number: 2,
      status: 'ACTIVE',
    });
  });
});
