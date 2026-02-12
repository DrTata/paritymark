const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';

export type ApiHealthMeta = {
  status: string;
  db?: string;
};

export async function fetchApiHealth(): Promise<ApiHealthMeta> {
  const res = await fetch(`${API_BASE_URL}/health`, {
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch API health: ${res.status} ${res.statusText}`);
  }

  return (await res.json()) as ApiHealthMeta;
}
