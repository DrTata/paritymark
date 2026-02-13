import { fetchApiIdentity } from '@/lib/apiIdentity';

export const dynamic = 'force-dynamic';

export default async function IdentityPage() {
  let me;
  let error: string | null = null;

  try {
    me = await fetchApiIdentity();
  } catch (err) {
    error = err instanceof Error ? err.message : 'Unknown error';
  }

  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Current user &amp; permissions</h1>

      {error ? (
        <p data-testid="identity-error">
          Failed to load identity: {error}
        </p>
      ) : !me ? (
        <p>Loading...</p>
      ) : me.status === 'unauthenticated' ? (
        <p data-testid="identity-unauthenticated">
          You are not authenticated. No user or permissions are available.
        </p>
      ) : (
        <section data-testid="identity-authenticated">
          <h2>User</h2>
          <p>
            External ID: <strong>{me.user.externalId}</strong>
          </p>
          <p>
            Display Name: <strong>{me.user.displayName}</strong>
          </p>

          <h2 style={{ marginTop: '1.5rem' }}>Permissions</h2>
          {me.permissions.length === 0 ? (
            <p data-testid="identity-no-permissions">
              You have no permissions assigned.
            </p>
          ) : (
            <ul data-testid="identity-permissions-list">
              {me.permissions.map((perm: string) => (
                <li key={perm}>{perm}</li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
