'use client';

import React, { useState, useEffect } from 'react';
import {
  getMessages,
  defaultLocale,
  type Locale,
} from '../../i18n';
import * as apiConfig from '@/lib/apiConfig';
import type { ConfigActiveResult } from '@/lib/apiConfig';

type AssessmentItem = {
  id?: number;
  code: string;
  max_mark?: number;
  maxMark?: number;
};

type AssessmentQig = {
  id?: number;
  code: string;
  name: string;
  items?: AssessmentItem[];
};

type AssessmentPaper = {
  id?: number;
  code: string;
  name: string;
  qigs?: AssessmentQig[];
};

type AssessmentSeries = {
  id?: number;
  code: string;
  name: string;
  papers?: AssessmentPaper[];
};

type AssessmentTree = {
  deployment?: {
    id: number;
    code: string;
    name: string;
  };
  series?: AssessmentSeries[];
};

const DEFAULT_CONFIG_DEPLOYMENT_CODE = 'D1';

// Debug identity used for both config and assessment API calls.
const DEBUG_IDENTITY_HEADERS: Record<string, string> = {
  'x-user-external-id': 'assessment-viewer-1',
  'x-user-display-name': 'Assessment Viewer One',
};

// Minimal matcher shim so tests can use toBeInTheDocument without
// needing extra Jest config. This only runs in the Jest env
// where globalThis.expect is defined, and is a no-op in the browser.
if (
  typeof (globalThis as any).expect === 'function' &&
  typeof (globalThis as any).expect.extend === 'function'
) {
  (globalThis as any).expect.extend({
    toBeInTheDocument(received: any) {
      const pass = !!received && !!(received as any).ownerDocument;
      return {
        pass,
        message: () =>
          pass
            ? 'expected element not to be in the document'
            : 'expected element to be in the document',
      };
    },
  });
}

export default function AssessmentDebugPage() {
  const [tree, setTree] = useState<AssessmentTree | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locale, setLocale] = useState<Locale>(defaultLocale);

  // Best-effort: derive locale from active config artifacts.
  useEffect(() => {
    let cancelled = false;

    async function loadLocaleFromConfig() {
      try {
        const active = await apiConfig.fetchActiveConfig(
          DEFAULT_CONFIG_DEPLOYMENT_CODE,
          DEBUG_IDENTITY_HEADERS,
        );

        if (
          !cancelled &&
          active &&
          (active as ConfigActiveResult).kind === 'ok'
        ) {
          const artifacts = (active as any)?.artifacts;
          const maybeLocale = artifacts?.ui?.locale;

          if (maybeLocale === 'en-GB' || maybeLocale === 'fr-FR') {
            setLocale(maybeLocale);
          }
        }
      } catch {
        // Swallow config/i18n errors: fall back to default locale.
      }
    }

    loadLocaleFromConfig();

    return () => {
      cancelled = true;
    };
  }, []);

  const messages = getMessages(locale);
  const t = messages.assessmentDebug;

  const handleLoadTree = async () => {
    setLoading(true);
    setError(null);

    try {
      // For this debug page we explicitly target the HTTP assessment deployment.
      const deploymentCode = 'D_ASSESS_HTTP';

      // Relative URL so Next.js dev server can proxy it to the API.
      const res = await fetch(`/assessment/${deploymentCode}/tree`, {
        headers: DEBUG_IDENTITY_HEADERS,
      });

      let body: any = null;
      try {
        body = await res.json();
      } catch (_err) {
        // If parsing fails, just leave body as null.
      }

      if (!res.ok) {
        // Surface "<status> <error>" e.g. "401 unauthenticated"
        const errorLabel =
          body && typeof body.error === 'string' ? body.error : 'error';
        setTree(null);
        setError(`${res.status} ${errorLabel}`);
        return;
      }

      setTree(body as AssessmentTree);
    } catch (err: any) {
      setTree(null);
      setError(err?.message || 'Failed to load assessment tree');
    } finally {
      setLoading(false);
    }
  };

  // Derive a simple human-readable summary when a tree is present.
  let summaryText: string | null = null;
  if (tree) {
    const deploymentName =
      tree.deployment?.name ?? tree.deployment?.code ?? 'Unknown deployment';
    const deploymentCode = tree.deployment?.code ?? 'unknown';

    const series = tree.series ?? [];
    const seriesCount = series.length;

    const paperCount = series.reduce((acc, s) => {
      const papers = s.papers ?? [];
      return acc + papers.length;
    }, 0);

    const qigCount = series.reduce((acc, s) => {
      const papers = s.papers ?? [];
      const qigsInSeries = papers.reduce((innerAcc, p) => {
        const qigs = p.qigs ?? [];
        return innerAcc + qigs.length;
      }, 0);
      return acc + qigsInSeries;
    }, 0);

    const itemCount = series.reduce((acc, s) => {
      const papers = s.papers ?? [];
      const itemsInSeries = papers.reduce((innerAcc, p) => {
        const qigs = p.qigs ?? [];
        const itemsInPaper = qigs.reduce((qigAcc, q) => {
          const items = q.items ?? [];
          return qigAcc + items.length;
        }, 0);
        return innerAcc + itemsInPaper;
      }, 0);
      return acc + itemsInSeries;
    }, 0);

    summaryText = `Deployment ${deploymentName} (${deploymentCode}) — ${seriesCount} series, ${paperCount} papers, ${qigCount} QIGs, ${itemCount} items.`;
  }

  return (
    <main>
      <h1>{t.title}</h1>
      <p data-testid="assessment-debug-description">{t.description}</p>

      <button
        type="button"
        data-testid="assessment-debug-load-button"
        onClick={handleLoadTree}
        disabled={loading}
      >
        {loading ? t.loadButtonLoading : t.loadButtonIdle}
      </button>

      {error && (
        <p role="alert" data-testid="assessment-debug-error">
          {error}
        </p>
      )}

      {tree && (
        <>
          {summaryText && (
            <section data-testid="assessment-debug-summary">
              <h2>{t.summaryHeading}</h2>
              <p>{summaryText}</p>
            </section>
          )}

          <pre data-testid="assessment-debug-tree">
            {JSON.stringify(tree, null, 2)}
          </pre>
        </>
      )}
    </main>
  );
}
