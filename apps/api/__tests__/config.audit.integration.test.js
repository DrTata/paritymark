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
  ensureAuditTable,
  AUDIT_TABLE_NAME,
  CONFIG_DRAFT_CREATED_EVENT_TYPE,
  CONFIG_ACTIVATED_EVENT_TYPE,
  getLatestAuditEventByType,
} = require('../src/audit');

jest.setTimeout(30000); // allow time for DB + HTTP operations

function httpRequestJson(port, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload
            ? { 'Content-Length': Buffer.byteLength(payload) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = bodyText ? JSON.parse(bodyText) : null;
          } catch (_err) {
            // Leave json = null; caller can still inspect bodyText if needed.
          }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: bodyText,
            json,
          });
        });
      },
    );

    req.on('error', reject);

    if (payload) {
      req.write(payload);
    }

    req.end();
  });
}

describe('Config audit events for drafts and activation', () => {
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
    await ensureAuditTable();

    server = createServer();
    await new Promise((resolve) => {
      const s = server.listen(0, () => {
        // eslint-disable-next-line no-param-reassign
        port = s.address().port;
        resolve();
      });
    });
  });

  beforeEach(async () => {
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

    // Clean audit table
    await pool.query(`DELETE FROM ${AUDIT_TABLE_NAME}`);
  });

  afterAll(async () => {
    if (server && server.close) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  });

  test('writes CONFIG_DRAFT_CREATED audit event when a config draft is created', async () => {
    // Seed identity: user with config.edit permission
    const user = await createUser(
      'config-editor-1',
      'Config Editor One',
    );
    const role = await createRole('CONFIG_EDITOR', 'Config editor');
    const perm = await createPermission(
      'config.edit',
      'Create config drafts',
    );
    await assignRoleToUser(user.id, role.id);
    await assignPermissionToRole(role.id, perm.id);

    const res = await httpRequestJson(
      port,
      'POST',
      '/config/D1/drafts',
      {
        deploymentName: 'Deployment D1',
        artifacts: {
          example: { hello: 'world' },
        },
      },
      {
        'x-user-external-id': 'config-editor-1',
        'x-user-display-name': 'Config Editor One',
      },
    );

    expect(res.statusCode).toBe(201);
    expect(res.json).toBeTruthy();

    const event = await getLatestAuditEventByType(
      CONFIG_DRAFT_CREATED_EVENT_TYPE,
    );

    expect(event).not.toBeNull();
    expect(event.event_type).toBe(CONFIG_DRAFT_CREATED_EVENT_TYPE);
    expect(event.payload).toBeDefined();
    expect(event.payload.meta).toBeDefined();
    expect(event.payload.meta).toMatchObject({
      deploymentCode: 'D1',
      path: '/config/D1/drafts',
      method: 'POST',
    });
    expect(typeof event.payload.meta.deploymentId).toBe('number');
    expect(typeof event.payload.meta.configVersionId).toBe('number');

    expect(event.payload.actor).toBeDefined();
    expect(event.payload.actor.externalId).toBe('config-editor-1');
  });

  test('writes CONFIG_ACTIVATED audit event when a config version is activated', async () => {
    // Seed identity: user with config.edit permission to create a draft
    const editor = await createUser(
      'config-editor-1',
      'Config Editor One',
    );
    const editorRole = await createRole('CONFIG_EDITOR', 'Config editor');
    const editPerm = await createPermission(
      'config.edit',
      'Create config drafts',
    );
    await assignRoleToUser(editor.id, editorRole.id);
    await assignPermissionToRole(editorRole.id, editPerm.id);

    // Create a draft for deployment D2
    const draftRes = await httpRequestJson(
      port,
      'POST',
      '/config/D2/drafts',
      {
        deploymentName: 'Deployment D2',
      },
      {
        'x-user-external-id': 'config-editor-1',
        'x-user-display-name': 'Config Editor One',
      },
    );

    expect(draftRes.statusCode).toBe(201);

    // Look up deployment + latest version_number for D2
    const deploymentResult = await pool.query(
      `SELECT id FROM ${DEPLOYMENTS_TABLE_NAME} WHERE code = $1`,
      ['D2'],
    );
    expect(deploymentResult.rows.length).toBe(1);
    const deploymentId = deploymentResult.rows[0].id;

    const versionResult = await pool.query(
      `SELECT version_number, id FROM ${CONFIG_VERSIONS_TABLE_NAME} WHERE deployment_id = $1 ORDER BY id DESC LIMIT 1`,
      [deploymentId],
    );
    expect(versionResult.rows.length).toBe(1);
    const versionNumber = versionResult.rows[0].version_number;

    // Seed identity: user with config.activate permission
    const activator = await createUser(
      'config-activator-1',
      'Config Activator One',
    );
    const activatorRole = await createRole(
      'CONFIG_ACTIVATOR',
      'Config activator',
    );
    const activatePerm = await createPermission(
      'config.activate',
      'Activate config versions',
    );
    await assignRoleToUser(activator.id, activatorRole.id);
    await assignPermissionToRole(activatorRole.id, activatePerm.id);

    const activatePath = `/config/D2/versions/${versionNumber}/activate`;

    const activateRes = await httpRequestJson(
      port,
      'POST',
      activatePath,
      null,
      {
        'x-user-external-id': 'config-activator-1',
        'x-user-display-name': 'Config Activator One',
      },
    );

    expect(activateRes.statusCode).toBe(200);
    expect(activateRes.json).toBeTruthy();

    const event = await getLatestAuditEventByType(
      CONFIG_ACTIVATED_EVENT_TYPE,
    );

    expect(event).not.toBeNull();
    expect(event.event_type).toBe(CONFIG_ACTIVATED_EVENT_TYPE);
    expect(event.payload).toBeDefined();
    expect(event.payload.meta).toBeDefined();
    expect(event.payload.meta).toMatchObject({
      deploymentCode: 'D2',
      versionNumber,
      path: activatePath,
      method: 'POST',
    });
    expect(typeof event.payload.meta.deploymentId).toBe('number');
    expect(typeof event.payload.meta.configVersionId).toBe('number');

    expect(event.payload.actor).toBeDefined();
    expect(event.payload.actor.externalId).toBe('config-activator-1');
  });
});
