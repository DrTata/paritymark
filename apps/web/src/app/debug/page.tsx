import { fetchApiIdentity } from '@/lib/apiIdentity';
import { fetchActiveConfig, type ConfigActiveResult } from '@/lib/apiConfig';
import { getMessages, defaultLocale, type Locale } from '../../i18n';

export const dynamic = 'force-dynamic';

const DEFAULT_DEPLOYMENT_CODE = 'D1';

export default async function DebugPage() {
  let me;
  let error: string | null = null;
  let locale: Locale = defaultLocale;

  // Identity fetch: if this fails, we show an identity error.
  try {
    me = await fetchApiIdentity();
  } catch (err) {
    error = err instanceof Error ? err.message : 'Unknown error';
  }

  // Config fetch for locale: best-effort only, never affects identity error state.
  try {
    const active = await fetchActiveConfig(DEFAULT_DEPLOYMENT_CODE);

    if (active && (active as ConfigActiveResult).kind === 'ok') {
      const artifacts = (active as any)?.artifacts;
      const maybeLocale = artifacts?.ui?.locale;

      if (maybeLocale === 'en-GB' || maybeLocale === 'fr-FR') {
        locale = maybeLocale;
      }
    }
  } catch {
    // Swallow config/i18n errors: debug page should still render
    // using the default locale and identity state.
  }

  const messages = getMessages(locale);
  const t = messages.debug;

  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>{t.title}</h1>

      <section style={{ marginTop: '1.5rem' }}>
        <h2>{t.identityHeading}</h2>

        {error ? (
          <p data-testid="debug-identity-error">
            {t.errorPrefix}: {error}
          </p>
        ) : !me ? (
          <p>{t.loading}</p>
        ) : me.status === 'unauthenticated' ? (
          <p data-testid="debug-identity-unauthenticated">
            {t.unauthenticated}
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
        <h2>{t.panelsHeading}</h2>
        <ul data-testid="debug-links">
          <li>
            <a href="/health">{t.linkHealthLabel}</a>
          </li>
          <li>
            <a href="/version">{t.linkVersionLabel}</a>
          </li>
          <li>
            <a href="/identity">{t.linkIdentityLabel}</a>
          </li>
          <li>
            <a href="/config">{t.linkConfigLabel}</a>
          </li>
        </ul>
      </section>
    </main>
  );
}
