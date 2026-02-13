const { pool } = require('../src/db');
const {
  USERS_TABLE_NAME,
  ROLES_TABLE_NAME,
  PERMISSIONS_TABLE_NAME,
  USER_ROLES_TABLE_NAME,
  ROLE_PERMISSIONS_TABLE_NAME,
  ensureIdentityTables,
  createUser,
  createRole,
  createPermission,
  assignRoleToUser,
  assignPermissionToRole,
} = require('../src/identity');

const {
  extractUserFromHeaders,
  getOrCreateUserForRequest,
  checkPermissionForRequest,
} = require('../src/authz');

describe('authz / permission checks integration', () => {
  beforeAll(async () => {
    await ensureIdentityTables();
  });

  afterEach(async () => {
    // Clean up identity tables between tests to avoid cross-test contamination.
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

  test('extractUserFromHeaders returns null when no headers are present', () => {
    const req = { headers: {} };
    const extracted = extractUserFromHeaders(req);
    expect(extracted).toBeNull();
  });

  test('getOrCreateUserForRequest returns null for anonymous request', async () => {
    const req = { headers: {} };
    const user = await getOrCreateUserForRequest(req);
    expect(user).toBeNull();
  });

  test('getOrCreateUserForRequest creates a user when headers are provided', async () => {
    const req = {
      headers: {
        'x-user-external-id': 'user-1',
        'x-user-display-name': 'User One',
      },
    };

    const user = await getOrCreateUserForRequest(req);
    expect(user).not.toBeNull();
    expect(user.external_id).toBe('user-1');
    expect(user.display_name).toBe('User One');
  });

  test('checkPermissionForRequest returns unauthenticated when no user headers are present', async () => {
    const req = { headers: {} };

    const result = await checkPermissionForRequest(req, 'config.view');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('unauthenticated');
    expect(result.user).toBeNull();
  });

  test('checkPermissionForRequest returns missing_permission for user without roles/permissions', async () => {
    const req = {
      headers: {
        'x-user-external-id': 'user-2',
        'x-user-display-name': 'User Two',
      },
    };

    const result = await checkPermissionForRequest(req, 'config.view');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('missing_permission');
    expect(result.user).not.toBeNull();
    expect(result.user.external_id).toBe('user-2');
  });

  test('checkPermissionForRequest returns granted when user has a role with the permission', async () => {
    // Seed a user, role and permission using the identity helpers.
    const user = await createUser('user-3', 'User Three');
    const role = await createRole('config_admin', 'Config admin');
    const permission = await createPermission(
      'config.view',
      'View configuration',
    );

    await assignRoleToUser(user.id, role.id);
    await assignPermissionToRole(role.id, permission.id);

    const req = {
      headers: {
        'x-user-external-id': 'user-3',
        'x-user-display-name': 'User Three',
      },
    };

    const result = await checkPermissionForRequest(req, 'config.view');
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('granted');
    expect(result.user).not.toBeNull();
    expect(result.user.external_id).toBe('user-3');
    expect(result.permissions).toContain('config.view');
  });
});
