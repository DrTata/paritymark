const {
  createUser,
  getUserByExternalId,
  getPermissionsForUser,
  userHasPermission,
  ensureIdentityTables,
} = require('./identity');

/**
 * Extract an external user id and display name from the HTTP request headers.
 * For Phase 1, this is a simple contract:
 *
 * - x-user-external-id: stable external identifier from upstream identity provider.
 * - x-user-display-name: optional human-readable name (fallback to external id).
 */
function extractUserFromHeaders(req) {
  const headers = (req && req.headers) || {};
  const externalId =
    headers['x-user-external-id'] || headers['X-User-External-Id'];
  const displayNameHeader =
    headers['x-user-display-name'] || headers['X-User-Display-Name'];

  if (!externalId) {
    return null;
  }

  return {
    externalId: String(externalId),
    displayName: String(displayNameHeader || externalId),
  };
}

/**
 * Get or create a user row for the incoming request based on headers.
 * Returns:
 * - null when no user headers are present (anonymous request).
 * - a user row when an external id is provided.
 */
async function getOrCreateUserForRequest(req) {
  await ensureIdentityTables();

  const extracted = extractUserFromHeaders(req);
  if (!extracted) {
    return null;
  }

  const { externalId, displayName } = extracted;

  const existing = await getUserByExternalId(externalId);
  if (existing && !existing.archived_at) {
    return existing;
  }

  const created = await createUser(externalId, displayName);
  return created;
}

/**
 * Check whether the request's user has a given permission key.
 *
 * Returns an object:
 * {
 *   allowed: boolean,
 *   permissionKey: string,
 *   reason: 'unauthenticated' | 'missing_permission' | 'granted',
 *   user: userRow | null,
 *   permissions?: string[] // only included when granted or explicitly loaded
 * }
 */
async function checkPermissionForRequest(req, permissionKey) {
  const user = await getOrCreateUserForRequest(req);

  if (!user) {
    return {
      allowed: false,
      permissionKey,
      reason: 'unauthenticated',
      user: null,
    };
  }

  const has = await userHasPermission(user.id, permissionKey);

  if (!has) {
    return {
      allowed: false,
      permissionKey,
      reason: 'missing_permission',
      user,
    };
  }

  const permissions = await getPermissionsForUser(user.id);

  return {
    allowed: true,
    permissionKey,
    reason: 'granted',
    user,
    permissions,
  };
}

/**
 * Enforce permission at the HTTP layer.
 *
 * This is the contract we will use in later slices to protect endpoints:
 *
 * - On success: returns true and does NOT write to the response.
 * - On failure:
 *   - Writes a 401 (unauthenticated) or 403 (forbidden) JSON response.
 *   - Returns false, signalling the caller to stop further handling.
 *
 * NOTE: In this slice we DO NOT wire this into any real endpoints yet.
 */
async function enforcePermission(req, res, permissionKey) {
  const result = await checkPermissionForRequest(req, permissionKey);

  if (result.allowed) {
    return true;
  }

  const status = result.reason === 'unauthenticated' ? 401 : 403;

  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      error: result.reason === 'unauthenticated' ? 'unauthenticated' : 'forbidden',
      permission: permissionKey,
    }),
  );

  return false;
}

module.exports = {
  extractUserFromHeaders,
  getOrCreateUserForRequest,
  checkPermissionForRequest,
  enforcePermission,
};
