const { pool, endPool } = require('../src/db');
const {
  ensureConfigTables,
  createDeployment,
  getDeploymentByCode,
  createDraftConfigVersionForDeploymentCode,
  getConfigVersionsForDeploymentId,
  upsertConfigArtifact,
  DEPLOYMENTS_TABLE_NAME,
  CONFIG_VERSIONS_TABLE_NAME,
  CONFIG_ARTIFACTS_TABLE_NAME,
} = require('../src/config');

jest.setTimeout(30000); // allow time for DB operations

describe('Config authoring helpers', () => {
  beforeAll(async () => {
    // Ensure DB env vars are set for local dev / CI
    process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
    process.env.DB_PORT = process.env.DB_PORT || '5432';
    process.env.DB_USER = process.env.DB_USER || 'paritymark';
    process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'paritymark';
    process.env.DB_NAME = process.env.DB_NAME || 'paritymark';

    await ensureConfigTables();

    // Clean up any existing test data for a stable baseline
    await pool.query('DELETE FROM ' + CONFIG_ARTIFACTS_TABLE_NAME);
    await pool.query('DELETE FROM ' + CONFIG_VERSIONS_TABLE_NAME);
    await pool.query('DELETE FROM ' + DEPLOYMENTS_TABLE_NAME);
  });

  afterAll(async () => {
    await endPool();
  });

  test('createDeployment inserts deployment retrievable via getDeploymentByCode', async () => {
    const depCode = 'AUTH_D1';
    const depName = 'Authoring Deployment 1';

    const created = await createDeployment(depCode, depName);
    expect(created).toBeDefined();
    expect(created.code).toBe(depCode);
    expect(created.name).toBe(depName);

    const fetched = await getDeploymentByCode(depCode);
    expect(fetched).toBeDefined();
    expect(fetched.id).toBe(created.id);
    expect(fetched.code).toBe(depCode);
    expect(fetched.name).toBe(depName);
  });

  test('createDraftConfigVersionForDeploymentCode returns notFound when deployment missing', async () => {
    const result =
      await createDraftConfigVersionForDeploymentCode('NO_SUCH_DEPLOYMENT', 'tester');

    expect(result.deployment).toBeNull();
    expect(result.configVersion).toBeNull();
    expect(result.notFound).toBe('deployment');
  });

  test('createDraftConfigVersionForDeploymentCode allocates version numbers starting at 1', async () => {
    const depCode = 'AUTH_SEQ';
    const depName = 'Authoring Sequential Deployment';
    const createdDep = await createDeployment(depCode, depName);

    const first =
      await createDraftConfigVersionForDeploymentCode(depCode, 'author-1');
    expect(first.deployment).toBeDefined();
    expect(first.deployment.id).toBe(createdDep.id);
    expect(first.configVersion).toBeDefined();
    expect(first.configVersion.version_number).toBe(1);
    expect(first.configVersion.status).toBe('DRAFT');
    expect(first.configVersion.created_by).toBe('author-1');

    const second =
      await createDraftConfigVersionForDeploymentCode(depCode, 'author-2');
    expect(second.configVersion.version_number).toBe(2);
    expect(second.configVersion.status).toBe('DRAFT');
    expect(second.configVersion.created_by).toBe('author-2');

    const versions = await getConfigVersionsForDeploymentId(createdDep.id);
    const versionNumbers = versions.map((v) => v.version_number);
    expect(versionNumbers).toEqual([2, 1]);
  });

  test('upsertConfigArtifact inserts and then updates payload for same version/type', async () => {
    const depCode = 'AUTH_ART';
    const depName = 'Authoring Artifacts Deployment';
    const dep = await createDeployment(depCode, depName);

    const draft =
      await createDraftConfigVersionForDeploymentCode(depCode, 'author-art');
    const configVersionId = draft.configVersion.id;

    const firstPayload = { foo: 'bar' };
    const first = await upsertConfigArtifact(
      configVersionId,
      'permission_matrix',
      firstPayload,
    );
    expect(first).toBeDefined();
    expect(first.config_version_id).toBe(configVersionId);
    expect(first.artifact_type).toBe('permission_matrix');
    expect(first.payload).toEqual(firstPayload);

    const secondPayload = { foo: 'baz', extra: true };
    const second = await upsertConfigArtifact(
      configVersionId,
      'permission_matrix',
      secondPayload,
    );
    expect(second).toBeDefined();
    expect(second.id).toBe(first.id);
    expect(second.payload).toEqual(secondPayload);

    const selectSql =
      'SELECT payload FROM ' +
      CONFIG_ARTIFACTS_TABLE_NAME +
      ' WHERE config_version_id = $1 AND artifact_type = $2';

    const rows = await pool.query(selectSql, [
      configVersionId,
      'permission_matrix',
    ]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].payload).toEqual(secondPayload);
  });
});
