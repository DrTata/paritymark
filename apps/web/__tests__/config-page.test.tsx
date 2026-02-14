import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ConfigPage from '@/app/config/page';
import * as api from '@/lib/apiConfig';

jest.mock('@/lib/apiConfig');

const mockedFetchActiveConfig = api.fetchActiveConfig as jest.Mock;
const mockedFetchConfigVersions = api.fetchConfigVersions as jest.Mock;
const mockedActivateConfigVersion = api.activateConfigVersion as jest.Mock;

describe('ConfigPage', () => {
  test('renders versions list and allows activation', async () => {
    mockedFetchActiveConfig.mockResolvedValue({
      kind: 'ok',
      deployment: { id: 1, code: 'D1', name: 'Example Deployment' },
      configVersion: {
        id: 1,
        deployment_id: 1,
        version_number: 1,
        status: 'ACTIVE',
      },
      artifacts: {},
    });

    mockedFetchConfigVersions.mockResolvedValue({
      kind: 'ok',
      deployment: { id: 1, code: 'D1', name: 'Example Deployment' },
      versions: [
        {
          id: 1,
          deployment_id: 1,
          version_number: 1,
          status: 'ACTIVE',
        },
        {
          id: 2,
          deployment_id: 1,
          version_number: 2,
          status: 'APPROVED',
        },
      ],
    });

    mockedActivateConfigVersion.mockResolvedValue({
      kind: 'ok',
      deployment: { id: 1, code: 'D1', name: 'Example Deployment' },
      configVersion: {
        id: 2,
        deployment_id: 1,
        version_number: 2,
        status: 'ACTIVE',
      },
    });

    const ui = await ConfigPage();
    render(ui as React.ReactElement);

    const table = await screen.findByTestId('config-versions-table');
    expect(table).toBeTruthy();

    const activeLabel = await screen.findByTestId(
      'config-version-1-active-label',
    );
    expect(activeLabel.textContent).toContain('ACTIVE');

    const button = await screen.findByTestId(
      'config-version-2-activate-button',
    );
    fireEvent.click(button);

    await waitFor(() => {
      expect(mockedActivateConfigVersion).toHaveBeenCalledWith('D1', 2);
    });

    const success = await screen.findByTestId('config-activation-success');
    expect(success.textContent).toContain('Activated version 2');
  });

  test('shows unauthenticated message when versions call returns unauthenticated', async () => {
    mockedFetchActiveConfig.mockResolvedValue({ kind: 'unauthenticated' });
    mockedFetchConfigVersions.mockResolvedValue({ kind: 'unauthenticated' });

    const ui = await ConfigPage();
    render(ui as React.ReactElement);

    const msg = await screen.findByTestId('config-versions-unauthenticated');
    expect(msg.textContent).toContain('not authenticated');
  });

  test('uses locale from active config artifacts to render French text', async () => {
    mockedFetchActiveConfig.mockResolvedValue({
      kind: 'ok',
      deployment: { id: 1, code: 'D1', name: 'Example Deployment' },
      configVersion: {
        id: 1,
        deployment_id: 1,
        version_number: 1,
        status: 'ACTIVE',
      },
      artifacts: {
        ui: {
          locale: 'fr-FR',
        },
      },
    });

    mockedFetchConfigVersions.mockResolvedValue({
      kind: 'ok',
      deployment: { id: 1, code: 'D1', name: 'Example Deployment' },
      versions: [
        {
          id: 1,
          deployment_id: 1,
          version_number: 1,
          status: 'ACTIVE',
        },
      ],
    });

    const ui = await ConfigPage();
    render(ui as React.ReactElement);

    // The <h1> is built from messages.config.titlePrefix + " " + DEFAULT_DEPLOYMENT_CODE.
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Config (FR) pour le déploiement D1');

    // And the active heading should also be the French variant.
    const activeHeading = await screen.findByRole('heading', {
      level: 2,
      name: 'Config active (FR)',
    });
    expect(activeHeading.textContent).toBe('Config active (FR)');
  });
});
