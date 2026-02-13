import { fetchApiIdentity } from '@/lib/apiIdentity';

export const dynamic = 'force-dynamic';

export default async function DebugPage() {
  let me;
  let error: string | null = null;

  try {
    me = await fetchApiIdentity();
  } catch (err) {
    error = err instanceof Error ? err.message : 'Unknown error';
  }

  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>System debug dashboard</h1>

      <section style={{ marginTop: '1.5rem' }}>
        <h2>Identity</h2>

        {error ? (
          <p data-testid="debug-identity-error">
            Failed to load identity: {error}
          </p>
        ) : !me ? (
          <p>Loading identity...</p>
        ) : me.status === 'unauthenticated' ? (
          <p data-testid="debug-identity-unauthenticated">
            You are not authenticated. No user or permissions are available.
          </p>
        ) : (
          <div data-testid="debug-identity-authenticated">
            <p>
              External ID: <strong>{me.user.externalId}</strong>
            </p>
            <p>
              Display Name: <strong>{me.user.displayName}</strong>
            </p>

            <div>
              <p>Permissions:</p>
              {me.permissions.length === 0 ? (
                <span data-testid="debug-identity-no-permissions">
                  (none)
                </span>
              ) : (
                <ul data-testid="debug-identity-permissions-list">
                  {me.permissions.map((perm: string) => (
                    <li key={perm}>{perm}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h2>Panels</h2>
        <ul data-testid="debug-links">
          <li>
            <a href="/health">API health</a>
          </li>
          <li>
            <a href="/version">API version</a>
          </li>
          <li>
            <a href="/identity">Identity &amp; permissions</a>
          </li>
          <li>
            <a href="/config">Active config viewer</a>
          </li>
        </ul>
      </section>
    </main>
  );
}
