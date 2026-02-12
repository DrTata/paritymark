import { fetchApiHealth } from '@/lib/apiHealth';

export const dynamic = 'force-dynamic';

export default async function HealthPage() {
  let meta;
  let error: string | null = null;

  try {
    meta = await fetchApiHealth();
  } catch (err) {
    error = err instanceof Error ? err.message : 'Unknown error';
  }

  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>API Health</h1>

      {error ? (
        <p data-testid="api-health-error">
          Failed to load API health: {error}
        </p>
      ) : meta ? (
        <div data-testid="api-health-ok">
          <p>
            Status: <strong>{meta.status}</strong>
          </p>
          {'db' in meta && (
            <p>
              DB: <strong>{meta.db}</strong>
            </p>
          )}
        </div>
      ) : (
        <p>Loading...</p>
      )}
    </main>
  );
}
