const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';

export type ApiIdentityUser = {
  id: number;
  externalId: string;
  displayName: string;
};

export type ApiIdentityMe =
  | { status: 'unauthenticated'; user: null; permissions: string[] }
  | { status: 'authenticated'; user: ApiIdentityUser; permissions: string[] };

/**
 * Fetch the current identity and permissions from /identity/me.
 *
 * - 401 -> returns an unauthenticated state (does NOT throw).
 * - 200 -> returns authenticated state with user + permissions.
 * - Any other non-OK status -> throws.
 */
export async function fetchApiIdentity(): Promise<ApiIdentityMe> {
  const res = await fetch(API_BASE_URL + '/identity/me', {
    cache: 'no-store',
  });

  if (res.status === 401) {
    return {
      status: 'unauthenticated',
      user: null,
      permissions: [],
    };
  }

  if (!res.ok) {
    throw new Error(
      'Failed to fetch identity: ' + res.status + ' ' + res.statusText,
    );
  }

  const body = await res.json();

  return {
    status: 'authenticated',
    user: {
      id: body.user.id,
      externalId: body.user.externalId,
      displayName: body.user.displayName,
    },
    permissions: Array.isArray(body.permissions) ? body.permissions : [],
  };
}
