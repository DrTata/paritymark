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
  getRolesForUser,
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

  test('getRolesForUser returns only non-archived roles for a user', async () => {
    const user = await createUser('user-3', 'User Three');

    const activeRole = await createRole('role_active', 'Active role');
    const archivedRole = await createRole('role_archived', 'Archived role');

    await assignRoleToUser(user.id, activeRole.id);
    await assignRoleToUser(user.id, archivedRole.id);

    // Archive one of the roles
    await pool.query(
      `UPDATE ${ROLES_TABLE_NAME} SET archived_at = NOW() WHERE id = $1`,
      [archivedRole.id],
    );

    const roles = await getRolesForUser(user.id);
    const roleKeys = roles.map((r) => r.key);

    expect(roleKeys).toContain('role_active');
    expect(roleKeys).not.toContain('role_archived');
  });
});
