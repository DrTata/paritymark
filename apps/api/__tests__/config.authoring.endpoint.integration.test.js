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
  createUser,
  createRole,
  createPermission,
  assignRoleToUser,
  assignPermissionToRole,
  USERS_TABLE_NAME,
  ROLES_TABLE_NAME,
  PERMISSIONS_TABLE_NAME,
  USER_ROLES_TABLE_NAME,
  ROLE_PERMISSIONS_TABLE_NAME,
} = require('../src/identity');

jest.setTimeout(30000); // allow time for DB + HTTP

async function makeRequest(path, options) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      const port = address.port;

      const method = (options && options.method) || 'GET';
      const headers = Object.assign(
        { 'Content-Type': 'application/json' },
        (options && options.headers) || {},
      );
      const body =
        options && options.body ? JSON.stringify(options.body) : null;

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers,
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            server.close();
            let parsed = null;
            if (data) {
              try {
                parsed = JSON.parse(data);
              } catch (err) {
                return reject(err);
              }
            }
            resolve({ statusCode: res.statusCode, body: parsed });
          });
        },
      );

      req.on('error', (err) => {
        server.close();
        reject(err);
      });

      if (body) {
        req.write(body);
      }

      req.end();
    });
  });
}

describe('Config authoring HTTP endpoint with RBAC', () => {
  beforeAll(async () => {
    // Ensure DB env vars are set for local dev / CI
    process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
    process.env.DB_PORT = process.env.DB_PORT || '5432';
    process.env.DB_USER = process.env.DB_USER || 'paritymark';
    process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'paritymark';
    process.env.DB_NAME = process.env.DB_NAME || 'paritymark';

    await ensureConfigTables();
    await ensureIdentityTables();
  });

  beforeEach(async () => {
    // Clean up config tables
    await pool.query(
      'TRUNCATE TABLE ' +
        CONFIG_ARTIFACTS_TABLE_NAME +
        ', ' +
        CONFIG_VERSIONS_TABLE_NAME +
        ', ' +
        DEPLOYMENTS_TABLE_NAME +
        ' RESTART IDENTITY CASCADE',
    );

    // Clean up identity tables
    await pool.query(
      'TRUNCATE TABLE ' +
        USER_ROLES_TABLE_NAME +
        ', ' +
        ROLE_PERMISSIONS_TABLE_NAME +
        ', ' +
        PERMISSIONS_TABLE_NAME +
        ', ' +
        ROLES_TABLE_NAME +
        ', ' +
        USERS_TABLE_NAME +
        ' RESTART IDENTITY CASCADE',
    );
  });

  test('returns 401 unauthenticated when no user headers are present', async () => {
    const result = await makeRequest('/config/HTTP_AUTH_D1/drafts', {
      method: 'POST',
      headers: {},
      body: {
        deploymentName: 'Should not matter',
      },
    });

    expect(result.statusCode).toBe(401);
    expect(result.body).toEqual({
      error: 'unauthenticated',
      permission: 'config.edit',
    });
  });

  test('returns 403 forbidden when user lacks config.edit permission', async () => {
    const result = await makeRequest('/config/HTTP_AUTH_D1/drafts', {
      method: 'POST',
      headers: {
        'x-user-external-id': 'no-edit-user',
        'x-user-display-name': 'No Edit User',
      },
      body: {
        deploymentName: 'Should not matter',
      },
    });

    expect(result.statusCode).toBe(403);
    expect(result.body).toEqual({
      error: 'forbidden',
      permission: 'config.edit',
    });
  });

  test('creates a draft config version with artifacts on success', async () => {
    // Seed a user with the config.edit permission
    const user = await createUser('editor-1', 'Editor One');
    const role = await createRole('config_editor', 'Config editor');
    const perm = await createPermission('config.edit', 'Edit configuration');

    await assignRoleToUser(user.id, role.id);
    await assignPermissionToRole(role.id, perm.id);

    const artifacts = {
      permission_matrix: {
        roles: ['ASSISTANT'],
        permissions: {
          ASSISTANT: ['MARK_SCRIPT'],
        },
      },
      branding: {
        logoUrl: 'https://example.org/logo.png',
        primaryColor: '#0044cc',
      },
    };

    const result = await makeRequest('/config/HTTP_AUTH_D1/drafts', {
      method: 'POST',
      headers: {
        'x-user-external-id': 'editor-1',
        'x-user-display-name': 'Editor One',
      },
      body: {
        deploymentName: 'HTTP Authoring Deployment',
        createdBy: 'editor-1',
        artifacts,
      },
    });

    expect(result.statusCode).toBe(201);
    expect(result.body).toBeDefined();

    const { deployment, configVersion, artifacts: returnedArtifacts } =
      result.body;

    expect(deployment).toBeDefined();
    expect(deployment.code).toBe('HTTP_AUTH_D1');
    expect(deployment.name).toBe('HTTP Authoring Deployment');

    expect(configVersion).toBeDefined();
    expect(configVersion.deployment_id).toBe(deployment.id);
    expect(configVersion.status).toBe('DRAFT');
    expect(configVersion.version_number).toBe(1);

    expect(returnedArtifacts).toEqual(artifacts);

    // Check DB state for versions
    const versionsResult = await pool.query(
      'SELECT id, version_number, status FROM ' +
        CONFIG_VERSIONS_TABLE_NAME +
        ' WHERE deployment_id = $1',
      [deployment.id],
    );
    expect(versionsResult.rows.length).toBe(1);
    const versionRow = versionsResult.rows[0];
    expect(versionRow.status).toBe('DRAFT');

    // Check DB state for artifacts
    const artifactsResult = await pool.query(
      'SELECT artifact_type, payload FROM ' +
        CONFIG_ARTIFACTS_TABLE_NAME +
        ' WHERE config_version_id = $1 ORDER BY artifact_type ASC',
      [versionRow.id],
    );
    const rows = artifactsResult.rows;
    expect(rows.length).toBe(2);

    const types = rows.map((r) => r.artifact_type).sort();
    expect(types).toEqual(['branding', 'permission_matrix']);

    const payloadByType = {};
    rows.forEach((r) => {
      payloadByType[r.artifact_type] = r.payload;
    });

    expect(payloadByType.permission_matrix).toEqual(
      artifacts.permission_matrix,
    );
    expect(payloadByType.branding).toEqual(artifacts.branding);
  });
});
