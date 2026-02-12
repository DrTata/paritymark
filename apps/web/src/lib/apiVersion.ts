const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';

export type ApiVersionMeta = {
  service: string;
  name: string;
  version: string;
  env: string;
};

export async function fetchApiVersion(): Promise<ApiVersionMeta> {
  const res = await fetch(`${API_BASE_URL}/version`, {
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch API version: ${res.status} ${res.statusText}`);
  }

  return (await res.json()) as ApiVersionMeta;
}
