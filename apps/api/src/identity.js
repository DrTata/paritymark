const { pool } = require('./db');

const USERS_TABLE_NAME = 'users';
const ROLES_TABLE_NAME = 'roles';
const PERMISSIONS_TABLE_NAME = 'permissions';
const USER_ROLES_TABLE_NAME = 'user_roles';
const ROLE_PERMISSIONS_TABLE_NAME = 'role_permissions';

/**
 * Handle known-benign concurrency errors for CREATE TABLE IF NOT EXISTS,
 * mirroring the config/audit modules' behaviour.
 */
function handleConcurrentDdlError(err) {
  const code = err && err.code;
  const message = (err && err.message) || '';

  // Duplicate table
  if (code === '42P07') {
    return;
  }

  // Unique violation on pg_type_typname_nsp_index during concurrent DDL
  if (code === '23505' && message.includes('pg_type_typname_nsp_index')) {
    return;
  }

  throw err;
}

/**
 * Ensure that the identity-related tables exist.
 * This mirrors the lazy creation approach used in the audit and config modules.
 */
async function ensureIdentityTables() {
  const createUsersSql = `
    CREATE TABLE IF NOT EXISTS ${USERS_TABLE_NAME} (
      id SERIAL PRIMARY KEY,
      external_id TEXT UNIQUE,
      display_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at TIMESTAMPTZ
    )
  `;

  const createRolesSql = `
    CREATE TABLE IF NOT EXISTS ${ROLES_TABLE_NAME} (
      id SERIAL PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at TIMESTAMPTZ
    )
  `;

  const createPermissionsSql = `
    CREATE TABLE IF NOT EXISTS ${PERMISSIONS_TABLE_NAME} (
      id SERIAL PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  const createUserRolesSql = `
    CREATE TABLE IF NOT EXISTS ${USER_ROLES_TABLE_NAME} (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES ${USERS_TABLE_NAME}(id) ON DELETE CASCADE,
      role_id INTEGER NOT NULL REFERENCES ${ROLES_TABLE_NAME}(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, role_id)
    )
  `;

  const createRolePermissionsSql = `
    CREATE TABLE IF NOT EXISTS ${ROLE_PERMISSIONS_TABLE_NAME} (
      id SERIAL PRIMARY KEY,
      role_id INTEGER NOT NULL REFERENCES ${ROLES_TABLE_NAME}(id) ON DELETE CASCADE,
      permission_id INTEGER NOT NULL REFERENCES ${PERMISSIONS_TABLE_NAME}(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (role_id, permission_id)
    )
  `;

  const statements = [
    createUsersSql,
    createRolesSql,
    createPermissionsSql,
    createUserRolesSql,
    createRolePermissionsSql,
  ];

  for (const sql of statements) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(sql);
    } catch (err) {
      handleConcurrentDdlError(err);
    }
  }
}

/**
 * Create a user with an optional external_id and a required display_name.
 * Returns the created row.
 */
async function createUser(externalId, displayName) {
  await ensureIdentityTables();

  const insertSql = `
    INSERT INTO ${USERS_TABLE_NAME} (external_id, display_name)
    VALUES ($1, $2)
    RETURNING id, external_id, display_name, created_at, archived_at
  `;

  const result = await pool.query(insertSql, [externalId, displayName]);
  return result.rows[0];
}

/**
 * Create a role with a unique key and human-readable name.
 * Returns the created row.
 */
async function createRole(key, name) {
  await ensureIdentityTables();

  const insertSql = `
    INSERT INTO ${ROLES_TABLE_NAME} (key, name)
    VALUES ($1, $2)
    RETURNING id, key, name, created_at, archived_at
  `;

  const result = await pool.query(insertSql, [key, name]);
  return result.rows[0];
}

/**
 * Create a permission with a unique key and optional description.
 * Returns the created row.
 */
async function createPermission(key, description) {
  await ensureIdentityTables();

  const insertSql = `
    INSERT INTO ${PERMISSIONS_TABLE_NAME} (key, description)
    VALUES ($1, $2)
    RETURNING id, key, description, created_at
  `;

  const result = await pool.query(insertSql, [key, description || null]);
  return result.rows[0];
}

/**
 * Assign a role to a user.
 * This is idempotent thanks to the UNIQUE (user_id, role_id) constraint.
 */
async function assignRoleToUser(userId, roleId) {
  await ensureIdentityTables();

  const insertSql = `
    INSERT INTO ${USER_ROLES_TABLE_NAME} (user_id, role_id)
    VALUES ($1, $2)
    ON CONFLICT (user_id, role_id) DO NOTHING
  `;

  await pool.query(insertSql, [userId, roleId]);
}

/**
 * Assign a permission to a role.
 * This is idempotent thanks to the UNIQUE (role_id, permission_id) constraint.
 */
async function assignPermissionToRole(roleId, permissionId) {
  await ensureIdentityTables();

  const insertSql = `
    INSERT INTO ${ROLE_PERMISSIONS_TABLE_NAME} (role_id, permission_id)
    VALUES ($1, $2)
    ON CONFLICT (role_id, permission_id) DO NOTHING
  `;

  await pool.query(insertSql, [roleId, permissionId]);
}

/**
 * Fetch a user by internal id.
 * Returns null if not found.
 */
async function getUserById(id) {
  await ensureIdentityTables();

  const selectSql = `
    SELECT id, external_id, display_name, created_at, archived_at
    FROM ${USERS_TABLE_NAME}
    WHERE id = $1
  `;

  const result = await pool.query(selectSql, [id]);
  if (!result.rows || result.rows.length === 0) {
    return null;
  }
  return result.rows[0];
}

/**
 * Fetch a user by external id.
 * Returns null if not found.
 */
async function getUserByExternalId(externalId) {
  await ensureIdentityTables();

  const selectSql = `
    SELECT id, external_id, display_name, created_at, archived_at
    FROM ${USERS_TABLE_NAME}
    WHERE external_id = $1
  `;

  const result = await pool.query(selectSql, [externalId]);
  if (!result.rows || result.rows.length === 0) {
    return null;
  }
  return result.rows[0];
}

/**
 * Fetch all permission keys for a given user id via roles.
 * Returns an array of permission key strings.
 */
async function getPermissionsForUser(userId) {
  await ensureIdentityTables();

  const selectSql = `
    SELECT DISTINCT p.key AS permission_key
    FROM ${PERMISSIONS_TABLE_NAME} p
    JOIN ${ROLE_PERMISSIONS_TABLE_NAME} rp
      ON rp.permission_id = p.id
    JOIN ${USER_ROLES_TABLE_NAME} ur
      ON ur.role_id = rp.role_id
    WHERE ur.user_id = $1
  `;

  const result = await pool.query(selectSql, [userId]);
  return (result.rows || []).map((row) => row.permission_key);
}

/**
 * Fetch all roles for a given user id.
 * Returns an array of role rows { id, key, name, created_at, archived_at }.
 * Archived roles are excluded to avoid stale AE/QIG scoping.
 */
async function getRolesForUser(userId) {
  await ensureIdentityTables();

  const selectSql = `
    SELECT r.id, r.key, r.name, r.created_at, r.archived_at
    FROM ${ROLES_TABLE_NAME} r
    JOIN ${USER_ROLES_TABLE_NAME} ur
      ON ur.role_id = r.id
    WHERE ur.user_id = $1
      AND r.archived_at IS NULL
  `;

  const result = await pool.query(selectSql, [userId]);
  return result.rows || [];
}

/**
 * Check whether a user has a specific permission key via their roles.
 * Returns a boolean.
 */
async function userHasPermission(userId, permissionKey) {
  await ensureIdentityTables();

  const selectSql = `
    SELECT 1
    FROM ${PERMISSIONS_TABLE_NAME} p
    JOIN ${ROLE_PERMISSIONS_TABLE_NAME} rp
      ON rp.permission_id = p.id
    JOIN ${USER_ROLES_TABLE_NAME} ur
      ON ur.role_id = rp.role_id
    WHERE ur.user_id = $1
      AND p.key = $2
    LIMIT 1
  `;

  const result = await pool.query(selectSql, [userId, permissionKey]);
  return result.rowCount > 0;
}

/**
 * Fetch a role by its unique key.
 * Returns null if not found.
 */
async function getRoleByKey(key) {
  await ensureIdentityTables();

  const selectSql = `
    SELECT id, key, name, created_at, archived_at
    FROM ${ROLES_TABLE_NAME}
    WHERE key = $1
  `;

  const result = await pool.query(selectSql, [key]);
  if (!result.rows || result.rows.length === 0) {
    return null;
  }
  return result.rows[0];
}

/**
 * Fetch a permission by its unique key.
 * Returns null if not found.
 */
async function getPermissionByKey(key) {
  await ensureIdentityTables();

  const selectSql = `
    SELECT id, key, description, created_at
    FROM ${PERMISSIONS_TABLE_NAME}
    WHERE key = $1
  `;

  const result = await pool.query(selectSql, [key]);
  if (!result.rows || result.rows.length === 0) {
    return null;
  }
  return result.rows[0];
}

/**
 * Core RM-style roles and permissions used for dev seeding.
 *
 * These are intentionally minimal for Phase 1 and only cover the
 * System Administrator and Assessment Administrator roles.
 */
const CORE_ROLES = [
  { key: 'system-admin', name: 'System Administrator' },
  { key: 'assessment-admin', name: 'Assessment Administrator' },
];

const CORE_PERMISSIONS = [
  {
    key: 'config.view',
    description: 'View configuration and deployment settings',
  },
  {
    key: 'config.edit',
    description: 'Edit configuration and author drafts',
  },
  {
    key: 'config.activate',
    description: 'Activate configuration versions',
  },
  {
    key: 'assessment.view',
    description: 'View assessment tree and sessions',
  },
  {
    key: 'assessment.manage',
    description: 'Manage assessment setup and workflow',
  },
];

/**
 * Mapping from role key -> array of permission keys.
 */
const CORE_ROLE_PERMISSIONS = {
  'system-admin': [
    'config.view',
    'config.edit',
    'config.activate',
    'assessment.view',
    'assessment.manage',
  ],
  'assessment-admin': ['config.view', 'assessment.view', 'assessment.manage'],
};

/**
 * Ensure the core roles and permissions model exists in the database and that
 * role-permission links are in place.
 *
 * This is safe and idempotent and is primarily used by dev seeding helpers.
 */
async function ensureCoreRbacModel() {
  await ensureIdentityTables();

  const rolesByKey = new Map();
  for (const roleDef of CORE_ROLES) {
    // eslint-disable-next-line no-await-in-loop
    let role = await getRoleByKey(roleDef.key);
    if (!role) {
      // eslint-disable-next-line no-await-in-loop
      role = await createRole(roleDef.key, roleDef.name);
    }
    rolesByKey.set(roleDef.key, role);
  }

  const permsByKey = new Map();
  for (const permDef of CORE_PERMISSIONS) {
    // eslint-disable-next-line no-await-in-loop
    let perm = await getPermissionByKey(permDef.key);
    if (!perm) {
      // eslint-disable-next-line no-await-in-loop
      perm = await createPermission(permDef.key, permDef.description);
    }
    permsByKey.set(permDef.key, perm);
  }

  const entries = Object.entries(CORE_ROLE_PERMISSIONS);
  for (const [roleKey, permKeys] of entries) {
    const role = rolesByKey.get(roleKey);
    if (!role) {
      // eslint-disable-next-line no-continue
      continue;
    }

    for (const permKey of permKeys) {
      const perm = permsByKey.get(permKey);
      if (!perm) {
        // eslint-disable-next-line no-continue
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await assignPermissionToRole(role.id, perm.id);
    }
  }
}

/**
 * Dev-only helper: ensure that the well-known admin@pm account exists with
 * System Administrator and Assessment Administrator roles attached.
 *
 * This is only invoked for that specific external id and is safe to call on
 * every request that carries the header.
 */
async function ensureDevAdminSeed(externalId, displayName) {
  if (!externalId || externalId !== 'admin@pm') {
    return null;
  }

  await ensureIdentityTables();
  await ensureCoreRbacModel();

  let user = await getUserByExternalId(externalId);
  if (!user) {
    user = await createUser(
      externalId,
      displayName || 'System Administrator',
    );
  }

  const systemAdminRole = await getRoleByKey('system-admin');
  const assessmentAdminRole = await getRoleByKey('assessment-admin');

  if (systemAdminRole) {
    await assignRoleToUser(user.id, systemAdminRole.id);
  }
  if (assessmentAdminRole) {
    await assignRoleToUser(user.id, assessmentAdminRole.id);
  }

  return user;
}

module.exports = {
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
  getUserById,
  getUserByExternalId,
  getPermissionsForUser,
  getRolesForUser,
  userHasPermission,
  getRoleByKey,
  getPermissionByKey,
  ensureCoreRbacModel,
  ensureDevAdminSeed,
};
