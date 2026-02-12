import React from 'react';
import { render, screen } from '@testing-library/react';
import VersionPage from '@/app/version/page';
import * as api from '@/lib/apiVersion';

jest.mock('@/lib/apiVersion');

const mockedFetch = api.fetchApiVersion as jest.Mock;

describe('VersionPage', () => {
  test('renders API version JSON when fetch succeeds', async () => {
    mockedFetch.mockResolvedValue({
      service: 'api',
      name: 'api',
      version: '0.1.0',
      env: 'test',
    });

    // VersionPage is an async server component; invoke it directly.
    const ui = await VersionPage();
    render(ui as React.ReactElement);

    const pre = await screen.findByTestId('api-version-json');
    expect(pre.textContent).toContain('"service": "api"');
    expect(pre.textContent).toContain('"version": "0.1.0"');
  });
});
