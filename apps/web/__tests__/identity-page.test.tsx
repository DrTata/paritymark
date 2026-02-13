import React from 'react';
import { render, screen } from '@testing-library/react';
import IdentityPage from '@/app/identity/page';
import * as api from '@/lib/apiIdentity';

jest.mock('@/lib/apiIdentity');

const mockedFetch = api.fetchApiIdentity as jest.Mock;

describe('IdentityPage', () => {
  test('renders unauthenticated state when API returns unauthenticated', async () => {
    mockedFetch.mockResolvedValue({
      status: 'unauthenticated',
      user: null,
      permissions: [],
    });

    const ui = await IdentityPage();
    render(ui as React.ReactElement);

    const msg = await screen.findByTestId('identity-unauthenticated');
    expect(msg.textContent).toContain('not authenticated');
  });

  test('renders user and permissions when authenticated', async () => {
    mockedFetch.mockResolvedValue({
      status: 'authenticated',
      user: {
        id: 1,
        externalId: 'user-1',
        displayName: 'User One',
      },
      permissions: ['config.view', 'other.permission'],
    });

    const ui = await IdentityPage();
    render(ui as React.ReactElement);

    const section = await screen.findByTestId('identity-authenticated');
    expect(section.textContent).toContain('user-1');
    expect(section.textContent).toContain('User One');

    const list = await screen.findByTestId('identity-permissions-list');
    expect(list.textContent).toContain('config.view');
    expect(list.textContent).toContain('other.permission');
  });

  test('renders error message when fetch throws', async () => {
    mockedFetch.mockRejectedValue(new Error('Boom'));

    const ui = await IdentityPage();
    render(ui as React.ReactElement);

    const msg = await screen.findByTestId('identity-error');
    expect(msg.textContent).toContain('Failed to load identity');
    expect(msg.textContent).toContain('Boom');
  });
});
