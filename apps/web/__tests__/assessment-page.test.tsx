import React from 'react';
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import AssessmentDebugPage from '../src/app/assessment-debug/page';
import * as apiConfig from '@/lib/apiConfig';

jest.mock('@/lib/apiConfig');

const mockedFetchActiveConfig = apiConfig.fetchActiveConfig as jest.Mock;

describe('AssessmentDebugPage', () => {
  beforeEach(() => {
    (global as any).fetch = jest.fn();

    // Default active config: OK with no ui.locale (falls back to en-GB).
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
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('calls /assessment/.../tree and renders the nested tree on success', async () => {
    const mockResponse = {
      deployment: {
        id: 1,
        code: 'D_ASSESS_HTTP',
        name: 'HTTP Assessment Test',
      },
      series: [
        {
          id: 10,
          code: 'S_HTTP_1',
          name: 'Series HTTP 1',
          papers: [
            {
              id: 20,
              code: 'P_HTTP_1',
              name: 'Paper HTTP 1',
              qigs: [
                {
                  id: 30,
                  code: 'Q_HTTP_1',
                  name: 'QIG HTTP 1',
                  items: [
                    {
                      id: 40,
                      code: 'I_HTTP_1',
                      maxMark: 20,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    (global as any).fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });

    render(<AssessmentDebugPage />);

    const button = screen.getByRole('button', {
      name: /load assessment tree/i,
    });
    fireEvent.click(button);

    await waitFor(() => {
      expect((global as any).fetch).toHaveBeenCalledWith(
        expect.stringMatching(/\/assessment\/D_ASSESS_HTTP\/tree$/),
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-user-external-id': 'assessment-viewer-1',
            'x-user-display-name': 'Assessment Viewer One',
          }),
        }),
      );
    });

    // Check bits of the rendered tree (high-level labels)
    expect(
      await screen.findByText(/Series HTTP 1/i),
    ).not.toBeNull();
    expect(
      screen.getByText(/Paper HTTP 1/i),
    ).not.toBeNull();
    expect(
      screen.getByText(/QIG HTTP 1/i),
    ).not.toBeNull();

    // Check the summary section content
    const summary = screen.getByTestId('assessment-debug-summary');
    const summaryText = summary.textContent || '';
    expect(summaryText).toContain('HTTP Assessment Test (D_ASSESS_HTTP)');
    expect(summaryText).toContain('1 series');
    expect(summaryText).toContain('1 paper');
    expect(summaryText).toContain('1 QIG');
    expect(summaryText).toContain('1 item');

    // For the item line, assert on the JSON text inside the <pre> block
    const treePre = screen.getByTestId('assessment-debug-tree');
    const treeText = treePre.textContent || '';

    expect(treeText).toContain('"code": "I_HTTP_1"');
    expect(treeText).toContain('"maxMark": 20');
  });

  it('shows a useful error message when backend returns 401 unauthenticated', async () => {
    (global as any).fetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'unauthenticated' }),
    });

    render(<AssessmentDebugPage />);

    const button = screen.getByRole('button', {
      name: /load assessment tree/i,
    });
    fireEvent.click(button);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/401 unauthenticated/i);
  });

  it('uses locale from active config artifacts to render French assessment debug messages', async () => {
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

    // We don't need the tree to load here; we only care about the static i18n copy.
    (global as any).fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    render(<AssessmentDebugPage />);

    await waitFor(() => {
      // Title from messages.assessmentDebug.title for fr-FR
      const heading = screen.getByRole('heading', { level: 1 });
      expect(heading.textContent).toBe('Débogage des évaluations');

      // Description uses the French bundle; assert on a distinctive substring.
      const description = screen.getByTestId(
        'assessment-debug-description',
      );
      const descText = description.textContent || '';
      expect(descText).toContain('Vue de débogage');

      // Button label should be the French idle label.
      const button = screen.getByTestId('assessment-debug-load-button');
      const buttonText = button.textContent || '';
      expect(buttonText).toBe("Charger l'arbre d'évaluation");
    });
  });
});
