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
  getPermissionsForUser,
  userHasPermission,
} = require('../src/identity');

describe('identity / RBAC integration', () => {
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

  test('ensureIdentityTables can be called without error', async () => {
    await expect(ensureIdentityTables()).resolves.not.toThrow();
  });

  test('userHasPermission returns false when user has no roles/permissions', async () => {
    const user = await createUser('user-1', 'User One');

    const hasPermission = await userHasPermission(user.id, 'config.view');
    expect(hasPermission).toBe(false);

    const permissions = await getPermissionsForUser(user.id);
    expect(permissions).toEqual([]);
  });

  test('userHasPermission returns true when user has a role with a permission', async () => {
    const user = await createUser('user-2', 'User Two');
    const role = await createRole('admin', 'Administrator');
    const permission = await createPermission(
      'config.view',
      'View configuration',
    );

    await assignRoleToUser(user.id, role.id);
    await assignPermissionToRole(role.id, permission.id);

    const hasPermission = await userHasPermission(user.id, 'config.view');
    expect(hasPermission).toBe(true);

    const permissions = await getPermissionsForUser(user.id);
    expect(permissions).toContain('config.view');
  });
});
