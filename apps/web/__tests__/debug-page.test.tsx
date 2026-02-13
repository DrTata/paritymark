import React from 'react';
import { render, screen } from '@testing-library/react';
import DebugPage from '@/app/debug/page';
import * as api from '@/lib/apiIdentity';

jest.mock('@/lib/apiIdentity');

const mockedFetch = api.fetchApiIdentity as jest.Mock;

describe('DebugPage', () => {
  test('renders unauthenticated identity summary and links', async () => {
    mockedFetch.mockResolvedValue({
      status: 'unauthenticated',
      user: null,
      permissions: [],
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
    mockedFetch.mockResolvedValue({
      status: 'authenticated',
      user: {
        id: 1,
        externalId: 'debug-user-1',
        displayName: 'Debug User',
      },
      permissions: ['config.view', 'other.permission'],
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
    mockedFetch.mockRejectedValue(new Error('Boom'));

    const ui = await DebugPage();
    render(ui as React.ReactElement);

    const msg = await screen.findByTestId('debug-identity-error');
    expect(msg.textContent).toContain('Failed to load identity');
    expect(msg.textContent).toContain('Boom');
  });
});
