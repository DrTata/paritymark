import React from 'react';
import { render, screen } from '@testing-library/react';
import DebugPage from '@/app/debug/page';
import * as apiIdentity from '@/lib/apiIdentity';
import * as apiConfig from '@/lib/apiConfig';

jest.mock('@/lib/apiIdentity');
jest.mock('@/lib/apiConfig');

const mockedFetchIdentity = apiIdentity.fetchApiIdentity as jest.Mock;
const mockedFetchActiveConfig = apiConfig.fetchActiveConfig as jest.Mock;

describe('DebugPage', () => {
  test('renders unauthenticated identity summary and links', async () => {
    mockedFetchIdentity.mockResolvedValue({
      status: 'unauthenticated',
      user: null,
      permissions: [],
    });

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

    const ui = await DebugPage();
    render(ui as React.ReactElement);

    const msg = await screen.findByTestId(
      'debug-identity-unauthenticated',
    );
    expect(msg.textContent).toContain('not authenticated');

    const links = await screen.findAllByRole('link');
    const hrefs = links.map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual(
      expect.arrayContaining(['/health', '/version', '/identity', '/config']),
    );
  });

  test('renders authenticated identity summary with permissions', async () => {
    mockedFetchIdentity.mockResolvedValue({
      status: 'authenticated',
      user: {
        id: 1,
        externalId: 'debug-user-1',
        displayName: 'Debug User',
      },
      permissions: ['config.view', 'other.permission'],
    });

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

    const ui = await DebugPage();
    render(ui as React.ReactElement);

    const section = await screen.findByTestId(
      'debug-identity-authenticated',
    );
    expect(section.textContent).toContain('debug-user-1');
    expect(section.textContent).toContain('Debug User');

    const list = await screen.findByTestId(
      'debug-identity-permissions-list',
    );
    expect(list.textContent).toContain('config.view');
    expect(list.textContent).toContain('other.permission');
  });

  test('renders error message when identity fetch throws', async () => {
    mockedFetchIdentity.mockRejectedValue(new Error('Boom'));

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

    const ui = await DebugPage();
    render(ui as React.ReactElement);

    const msg = await screen.findByTestId('debug-identity-error');
    expect(msg.textContent).toContain('Failed to load identity');
    expect(msg.textContent).toContain('Boom');
  });

  test('uses locale from active config artifacts to render French debug messages', async () => {
    // Identity: unauthenticated is fine — we care about the debug copy/i18n here.
    mockedFetchIdentity.mockResolvedValue({
      status: 'unauthenticated',
      user: null,
      permissions: [],
    });

    // Active config includes ui.locale = 'fr-FR'
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

    const ui = await DebugPage();
    render(ui as React.ReactElement);

    // Title from messages.debug.title for fr-FR
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent).toContain('Tableau de débogage du système');

    // Identity section heading in French
    const identityHeading = await screen.findByRole('heading', {
      level: 2,
      name: 'Identité',
    });
    expect(identityHeading.textContent).toBe('Identité');

    // Panels heading in French
    const panelsHeading = await screen.findByRole('heading', {
      level: 2,
      name: 'Panneaux',
    });
    expect(panelsHeading.textContent).toBe('Panneaux');

    // Link labels from messages.debug.* in fr-FR
    const links = await screen.findAllByRole('link');
    const linkTexts = links.map((link) => link.textContent);

    expect(linkTexts).toEqual(
      expect.arrayContaining([
        "État de l'API",
        "Version de l'API",
        'Identité & permissions',
        'Visionneuse de config active',
      ]),
    );
  });
});
