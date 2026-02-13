import { fetchActiveConfig, fetchConfigVersions } from '@/lib/apiConfig';
import { ConfigVersionsPanel } from './ConfigVersionsPanel';

export const dynamic = 'force-dynamic';

const DEFAULT_DEPLOYMENT_CODE = 'D1';

export default async function ConfigPage() {
  let active: any;
  let versions: any;
  let error: string | null = null;

  try {
    active = await fetchActiveConfig(DEFAULT_DEPLOYMENT_CODE);
    versions = await fetchConfigVersions(DEFAULT_DEPLOYMENT_CODE);
  } catch (err) {
    error = err instanceof Error ? err.message : 'Unknown error';
  }

  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Config for deployment {DEFAULT_DEPLOYMENT_CODE}</h1>

      {error ? (
        <p data-testid="config-error">Failed to load config: {error}</p>
      ) : (
        <>
          <section style={{ marginTop: '1.5rem' }}>
            <h2>Active config</h2>

            {!active ? (
              <p>Loading active config...</p>
            ) : active.kind === 'unauthenticated' ? (
              <p data-testid="config-active-unauthenticated">
                You are not authenticated. Cannot load active config.
              </p>
            ) : active.kind === 'forbidden' ? (
              <p data-testid="config-active-forbidden">
                You do not have permission to view active config.
              </p>
            ) : active.kind === 'deployment_not_found' ? (
              <p data-testid="config-active-deployment-not-found">
                Deployment {active.deploymentCode} was not found.
              </p>
            ) : active.kind === 'active_config_not_found' ? (
              <p data-testid="config-active-not-found">
                No active config found for deployment {active.deploymentCode}.
              </p>
            ) : (
              <div data-testid="config-active-ok">
                <p>
                  Deployment:{' '}
                  <strong>
                    {active.deployment.code} – {active.deployment.name}
                  </strong>
                </p>
                <p>
                  Active version:{' '}
                  <strong>{active.configVersion.version_number}</strong>
                </p>
              </div>
            )}
          </section>

          <section style={{ marginTop: '2rem' }}>
            <h2>Config versions</h2>

            {!versions ? (
              <p>Loading versions...</p>
            ) : versions.kind === 'unauthenticated' ? (
              <p data-testid="config-versions-unauthenticated">
                You are not authenticated. Cannot load versions.
              </p>
            ) : versions.kind === 'forbidden' ? (
              <p data-testid="config-versions-forbidden">
                You do not have permission to view config versions.
              </p>
            ) : versions.kind === 'deployment_not_found' ? (
              <p data-testid="config-versions-deployment-not-found">
                Deployment {versions.deploymentCode} was not found.
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
