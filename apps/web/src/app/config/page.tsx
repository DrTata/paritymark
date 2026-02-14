import {
  fetchActiveConfig,
  fetchConfigVersions,
  type ConfigActiveResult,
  type ConfigVersionsResult,
} from '@/lib/apiConfig';
import { ConfigVersionsPanel } from './ConfigVersionsPanel';
import { getMessages, defaultLocale, type Locale } from '../../i18n';

export const dynamic = 'force-dynamic';

const DEFAULT_DEPLOYMENT_CODE = 'D1';

export default async function ConfigPage() {
  let active: ConfigActiveResult | null = null;
  let versions: ConfigVersionsResult | null = null;
  let error: string | null = null;

  try {
    active = await fetchActiveConfig(DEFAULT_DEPLOYMENT_CODE);
    versions = await fetchConfigVersions(DEFAULT_DEPLOYMENT_CODE);
  } catch (err) {
    error = err instanceof Error ? err.message : 'Unknown error';
  }

  // Derive locale from active config artifacts (if available),
  // falling back to the default locale.
  let locale: Locale = defaultLocale;
  if (active && active.kind === 'ok') {
    const artifacts = (active as any)?.artifacts;
    const maybeLocale = artifacts?.ui?.locale;

    if (maybeLocale === 'en-GB' || maybeLocale === 'fr-FR') {
      locale = maybeLocale;
    }
  }

  const messages = getMessages(locale);
  const t = messages.config;

  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>
        {t.titlePrefix} {DEFAULT_DEPLOYMENT_CODE}
      </h1>

      {error ? (
        <p data-testid="config-error">
          {t.activeErrorPrefix}: {error}
        </p>
      ) : (
        <>
          <section style={{ marginTop: '1.5rem' }}>
            <h2>{t.activeHeading}</h2>

            {!active ? (
              <p>{t.activeLoading}</p>
            ) : active.kind === 'unauthenticated' ? (
              <p data-testid="config-active-unauthenticated">
                {t.activeUnauthenticated}
              </p>
            ) : active.kind === 'forbidden' ? (
              <p data-testid="config-active-forbidden">
                {t.activeForbidden}
              </p>
            ) : active.kind === 'deployment_not_found' ? (
              <p data-testid="config-active-deployment-not-found">
                {t.activeDeploymentNotFoundPrefix}{' '}
                {active.deploymentCode}{' '}
                {t.activeDeploymentNotFoundSuffix}
              </p>
            ) : active.kind === 'active_config_not_found' ? (
              <p data-testid="config-active-not-found">
                {t.activeNotFoundPrefix}{' '}
                {active.deploymentCode}
                {t.activeNotFoundSuffix}
              </p>
            ) : (
              <div data-testid="config-active-ok">
                <p>
                  {t.activeSummaryDeploymentLabel}{' '}
                  <strong>
                    {active.deployment.code} – {active.deployment.name}
                  </strong>
                </p>
                <p>
                  {t.activeSummaryActiveVersionLabel}{' '}
                  <strong>{active.configVersion.version_number}</strong>
                </p>
              </div>
            )}
          </section>

          <section style={{ marginTop: '2rem' }}>
            <h2>{t.versionsHeading}</h2>

            {!versions ? (
              <p>{t.versionsLoading}</p>
            ) : versions.kind === 'unauthenticated' ? (
              <p data-testid="config-versions-unauthenticated">
                {t.versionsUnauthenticated}
              </p>
            ) : versions.kind === 'forbidden' ? (
              <p data-testid="config-versions-forbidden">
                {t.versionsForbidden}
              </p>
            ) : versions.kind === 'deployment_not_found' ? (
              <p data-testid="config-versions-deployment-not-found">
                {t.activeDeploymentNotFoundPrefix}{' '}
                {versions.deploymentCode}{' '}
                {t.activeDeploymentNotFoundSuffix}
              </p>
            ) : (
              <ConfigVersionsPanel
                deploymentCode={DEFAULT_DEPLOYMENT_CODE}
                versions={versions.versions}
              />
            )}
          </section>
        </>
      )}
    </main>
  );
}
