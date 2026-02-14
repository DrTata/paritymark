export const API_BASE_URL =
  typeof window === 'undefined'
    ? process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000'
    : '';

function makeUrl(path: string): string {
  if (API_BASE_URL) {
    return API_BASE_URL + path;
  }
  return path;
}

export type ConfigDeployment = {
  id: number;
  code: string;
  name: string;
};

export type ConfigVersion = {
  id: number;
  deployment_id: number;
  version_number: number;
  status: string;
  created_at?: string;
  approved_at?: string | null;
  activated_at?: string | null;
  created_by?: string | null;
};

export type ConfigArtifacts = Record<string, unknown>;

export type ConfigActiveResult =
  | { kind: 'unauthenticated' }
  | { kind: 'forbidden' }
  | { kind: 'deployment_not_found'; deploymentCode: string }
  | { kind: 'active_config_not_found'; deploymentCode: string }
  | {
      kind: 'ok';
      deployment: ConfigDeployment;
      configVersion: ConfigVersion;
      artifacts: ConfigArtifacts;
    };

export type ConfigVersionsResult =
  | { kind: 'unauthenticated' }
  | { kind: 'forbidden' }
  | { kind: 'deployment_not_found'; deploymentCode: string }
  | {
      kind: 'ok';
      deployment: ConfigDeployment;
      versions: ConfigVersion[];
    };

export type ConfigActivationResult =
  | { kind: 'unauthenticated' }
  | { kind: 'forbidden' }
  | { kind: 'deployment_not_found'; deploymentCode: string }
  | {
      kind: 'config_version_not_found';
      deploymentCode: string;
      versionNumber: number;
    }
  | {
      kind: 'ok';
      deployment: ConfigDeployment;
      configVersion: ConfigVersion;
    };

type ErrorBody = {
  error?: string;
};

function isErrorBody(value: unknown): value is ErrorBody {
  return typeof value === 'object' && value !== null && 'error' in value;
}

export async function fetchActiveConfig(
  deploymentCode: string,
  extraHeaders: Record<string, string> = {},
): Promise<ConfigActiveResult> {
  const res = await fetch(
    makeUrl('/config/' + encodeURIComponent(deploymentCode) + '/active'),
    {
      cache: 'no-store',
      headers: extraHeaders,
    },
  );

  if (res.status === 401) {
    return { kind: 'unauthenticated' };
  }

  if (res.status === 403) {
    return { kind: 'forbidden' };
  }

  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // ignore JSON parse errors for non-JSON bodies
    }

    if (
      res.status === 404 &&
      isErrorBody(body) &&
      body.error === 'deployment_not_found'
    ) {
      return { kind: 'deployment_not_found', deploymentCode };
    }

    if (
      res.status === 404 &&
      isErrorBody(body) &&
      body.error === 'active_config_not_found'
    ) {
      return { kind: 'active_config_not_found', deploymentCode };
    }

    throw new Error(
      'Failed to fetch active config: ' + res.status + ' ' + res.statusText,
    );
  }

  const body = (await res.json()) as {
    deployment: ConfigDeployment;
    configVersion: ConfigVersion;
    artifacts?: ConfigArtifacts;
  };

  return {
    kind: 'ok',
    deployment: body.deployment,
    configVersion: body.configVersion,
    artifacts: body.artifacts || {},
  };
}

export async function fetchConfigVersions(
  deploymentCode: string,
  extraHeaders: Record<string, string> = {},
): Promise<ConfigVersionsResult> {
  const res = await fetch(
    makeUrl('/config/' + encodeURIComponent(deploymentCode) + '/versions'),
    {
      cache: 'no-store',
      headers: extraHeaders,
    },
  );

  if (res.status === 401) {
    return { kind: 'unauthenticated' };
  }

  if (res.status === 403) {
    return { kind: 'forbidden' };
  }

  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // ignore JSON parse errors for non-JSON bodies
    }

    if (
      res.status === 404 &&
      isErrorBody(body) &&
      body.error === 'deployment_not_found'
    ) {
      return { kind: 'deployment_not_found', deploymentCode };
    }

    throw new Error(
      'Failed to fetch config versions: ' + res.status + ' ' + res.statusText,
    );
  }

  const body = (await res.json()) as {
    deployment: ConfigDeployment;
    versions?: ConfigVersion[];
  };

  return {
    kind: 'ok',
    deployment: body.deployment,
    versions: Array.isArray(body.versions) ? body.versions : [],
  };
}

export async function activateConfigVersion(
  deploymentCode: string,
  versionNumber: number,
  extraHeaders: Record<string, string> = {},
): Promise<ConfigActivationResult> {
  const res = await fetch(
    makeUrl(
      '/config/' +
        encodeURIComponent(deploymentCode) +
        '/versions/' +
        String(versionNumber) +
        '/activate',
    ),
    {
      method: 'POST',
      cache: 'no-store',
      headers: extraHeaders,
    },
  );

  if (res.status === 401) {
    return { kind: 'unauthenticated' };
  }

  if (res.status === 403) {
    return { kind: 'forbidden' };
  }

  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // ignore JSON parse errors for non-JSON bodies
    }

    if (
      res.status === 404 &&
      isErrorBody(body) &&
      body.error === 'deployment_not_found'
    ) {
      return { kind: 'deployment_not_found', deploymentCode };
    }

    if (
      res.status === 404 &&
      isErrorBody(body) &&
      body.error === 'config_version_not_found'
    ) {
      return {
        kind: 'config_version_not_found',
        deploymentCode,
        versionNumber,
      };
    }

    throw new Error(
      'Failed to activate config version: ' +
        res.status +
        ' ' +
        res.statusText,
    );
  }

  const body = (await res.json()) as {
    deployment: ConfigDeployment;
    configVersion: ConfigVersion;
  };

  return {
    kind: 'ok',
    deployment: body.deployment,
    configVersion: body.configVersion,
  };
}
