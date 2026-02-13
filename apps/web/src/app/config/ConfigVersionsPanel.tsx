'use client';

import * as React from 'react';
import type { ConfigVersion } from '@/lib/apiConfig';
import { activateConfigVersion } from '@/lib/apiConfig';

type Props = {
  deploymentCode: string;
  versions: ConfigVersion[];
};

export function ConfigVersionsPanel({ deploymentCode, versions }: Props) {
  const [activating, setActivating] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(
    null,
  );

  async function handleActivate(versionNumber: number) {
    setError(null);
    setSuccessMessage(null);
    setActivating(versionNumber);

    try {
      const result = await activateConfigVersion(deploymentCode, versionNumber);

      if (result.kind === 'unauthenticated') {
        setError('You are not authenticated.');
      } else if (result.kind === 'forbidden') {
        setError('You do not have permission to activate configs.');
      } else if (result.kind === 'deployment_not_found') {
        setError('Deployment ' + deploymentCode + ' was not found.');
      } else if (result.kind === 'config_version_not_found') {
        setError(
          'Version ' +
            String(result.versionNumber) +
            ' was not found for deployment ' +
            deploymentCode +
            '.',
        );
      } else {
        setSuccessMessage(
          'Activated version ' +
            String(result.configVersion.version_number) +
            ' for deployment ' +
            deploymentCode +
            '.',
        );
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to activate config.',
      );
    } finally {
      setActivating(null);
    }
  }

  if (!versions || versions.length === 0) {
    return (
      <div data-testid="config-versions-empty">
        <p>No versions found for this deployment.</p>
      </div>
    );
  }

  const activeVersion = versions.find((v) => v.status === 'ACTIVE');

  return (
    <div>
      {error && (
        <p data-testid="config-activation-error">
          Activation error: {error}
        </p>
      )}
      {successMessage && (
        <p data-testid="config-activation-success">{successMessage}</p>
      )}

      {activeVersion && (
        <p data-testid="config-active-version">
          Current active version:{' '}
          <strong>{activeVersion.version_number}</strong>
        </p>
      )}

      <table
        data-testid="config-versions-table"
        style={{ marginTop: '1rem', borderCollapse: 'collapse' }}
      >
        <thead>
          <tr>
            <th style={{ textAlign: 'left', paddingRight: '1rem' }}>
              Version
            </th>
            <th style={{ textAlign: 'left', paddingRight: '1rem' }}>
              Status
            </th>
            <th style={{ textAlign: 'left' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.id || v.version_number}>
              <td style={{ paddingRight: '1rem' }}>{v.version_number}</td>
              <td style={{ paddingRight: '1rem' }}>{v.status}</td>
              <td>
                {v.status === 'ACTIVE' ? (
                  <span
                    data-testid={
                      'config-version-' +
                      String(v.version_number) +
                      '-active-label'
                    }
                  >
                    ACTIVE
                  </span>
                ) : (
                  <button
                    type="button"
                    data-testid={
                      'config-version-' +
                      String(v.version_number) +
                      '-activate-button'
                    }
                    onClick={() => handleActivate(v.version_number)}
                    disabled={activating === v.version_number}
                  >
                    {activating === v.version_number
                      ? 'Activating...'
                      : 'Activate'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
