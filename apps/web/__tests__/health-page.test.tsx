import React from 'react';
import { render, screen } from '@testing-library/react';
import HealthPage from '@/app/health/page';
import * as api from '@/lib/apiHealth';

jest.mock('@/lib/apiHealth');

const mockedFetch = api.fetchApiHealth as jest.Mock;

describe('HealthPage', () => {
  test('renders API health when fetch succeeds', async () => {
    mockedFetch.mockResolvedValue({
      status: 'ok',
      db: 'up',
    });

    const ui = await HealthPage();
    render(ui as React.ReactElement);

    const okContainer = await screen.findByTestId('api-health-ok');
    expect(okContainer.textContent).toContain('Status: ok');
    expect(okContainer.textContent).toContain('DB: up');
  });
});
