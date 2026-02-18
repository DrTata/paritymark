'use strict';

const { getPermissionsForUser, getRolesForUser } = require('./identity');

/**
 * Build a basic operational profile for the given user row.
 *
 * Phase 1:
 * - Uses existing identity + roles only.
 * - Other sections are placeholders for future slices (assignments, standardisation, etc.).
 */
async function getProfileForUser(user) {
  if (!user) {
    throw new Error('user_required');
  }

  const [permissions, roles] = await Promise.all([
    getPermissionsForUser(user.id),
    getRolesForUser(user.id),
  ]);

  const roleSummaries = (roles || []).map((role) => ({
    id: role.id,
    key: role.key,
    name: role.name,
  }));

  const profile = {
    identity: {
      userId: user.id,
      externalId: user.external_id,
      displayName: user.display_name,
      fullName: user.display_name || null,
      staffOrExaminerId: null,
      loginId: user.external_id,
      roles: roleSummaries,
      tenant: null,
      accountStatus: 'ACTIVE',
      createdAt: user.created_at || null,
      lastLoginAt: null,
    },
    contact: {
      email: null,
      phone: null,
      notificationPreferences: {},
    },
    assignmentContext: {
      sessions: [],
      levels: [],
      subjects: [],
      papers: [],
      teamMembership: [],
    },
    securityAndCompliance: {
      twoFactorEnabled: false,
      consentFlags: {},
      securityFlags: {},
    },
    operationalAndQa: {
      standardisation: {},
      performanceMetrics: {},
    },
    // Flattened permissions list for convenience; derived from roles.
    permissions,
  };

  return profile;
}

module.exports = {
  getProfileForUser,
};
