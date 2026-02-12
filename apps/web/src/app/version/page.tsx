import { fetchApiVersion } from '@/lib/apiVersion';

export const dynamic = 'force-dynamic';

export default async function VersionPage() {
  let meta;
  let error: string | null = null;

  try {
    meta = await fetchApiVersion();
  } catch (err) {
    error = err instanceof Error ? err.message : 'Unknown error';
  }

  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>API Version</h1>

      {error ? (
        <p data-testid="api-version-error">
          Failed to load API version: {error}
        </p>
      ) : meta ? (
        <pre
          data-testid="api-version-json"
          style={{
            background: '#f4f4f5',
            padding: '1rem',
            borderRadius: '0.5rem',
            overflowX: 'auto',
          }}
        >
          {JSON.stringify(meta, null, 2)}
        </pre>
      ) : (
        <p>Loading...</p>
      )}
    </main>
  );
}
