const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';

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

export async function fetchActiveConfig(
  deploymentCode: string,
): Promise<ConfigActiveResult> {
  const res = await fetch(
    API_BASE_URL + '/config/' + encodeURIComponent(deploymentCode) + '/active',
    { cache: 'no-store' },
  );

  if (res.status === 401) {
    return { kind: 'unauthenticated' };
  }

  if (res.status === 403) {
    return { kind: 'forbidden' };
  }

  if (!res.ok) {
    let body: any = null;
    try {
      body = await res.json();
    } catch (_err) {
      // ignore JSON parse errors for non-JSON bodies
    }

    if (res.status === 404 && body && body.error === 'deployment_not_found') {
      return { kind: 'deployment_not_found', deploymentCode };
    }

    if (res.status === 404 && body && body.error === 'active_config_not_found') {
      return { kind: 'active_config_not_found', deploymentCode };
    }

    throw new Error(
      'Failed to fetch active config: ' + res.status + ' ' + res.statusText,
    );
  }

  const body = await res.json();

  return {
    kind: 'ok',
    deployment: body.deployment as ConfigDeployment,
    configVersion: body.configVersion as ConfigVersion,
    artifacts: (body.artifacts || {}) as ConfigArtifacts,
  };
}

export async function fetchConfigVersions(
  deploymentCode: string,
): Promise<ConfigVersionsResult> {
  const res = await fetch(
    API_BASE_URL +
      '/config/' +
      encodeURIComponent(deploymentCode) +
      '/versions',
    { cache: 'no-store' },
  );

  if (res.status === 401) {
    return { kind: 'unauthenticated' };
  }

  if (res.status === 403) {
    return { kind: 'forbidden' };
  }

  if (!res.ok) {
    let body: any = null;
    try {
      body = await res.json();
    } catch (_err) {
      // ignore JSON parse errors for non-JSON bodies
    }

    if (res.status === 404 && body && body.error === 'deployment_not_found') {
      return { kind: 'deployment_not_found', deploymentCode };
    }

    throw new Error(
      'Failed to fetch config versions: ' + res.status + ' ' + res.statusText,
    );
  }

  const body = await res.json();

  return {
    kind: 'ok',
    deployment: body.deployment as ConfigDeployment,
    versions: Array.isArray(body.versions)
      ? (body.versions as ConfigVersion[])
      : [],
  };
}

export async function activateConfigVersion(
  deploymentCode: string,
  versionNumber: number,
): Promise<ConfigActivationResult> {
  const res = await fetch(
    API_BASE_URL +
      '/config/' +
      encodeURIComponent(deploymentCode) +
      '/versions/' +
      String(versionNumber) +
      '/activate',
    {
      method: 'POST',
      cache: 'no-store',
    },
  );

  if (res.status === 401) {
    return { kind: 'unauthenticated' };
  }

  if (res.status === 403) {
    return { kind: 'forbidden' };
  }

  if (!res.ok) {
    let body: any = null;
    try {
      body = await res.json();
    } catch (_err) {
      // ignore JSON parse errors for non-JSON bodies
    }

    if (res.status === 404 && body && body.error === 'deployment_not_found') {
      return { kind: 'deployment_not_found', deploymentCode };
    }

    if (
      res.status === 404 &&
      body &&
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

  const body = await res.json();

  return {
    kind: 'ok',
    deployment: body.deployment as ConfigDeployment,
    configVersion: body.configVersion as ConfigVersion,
  };
}
