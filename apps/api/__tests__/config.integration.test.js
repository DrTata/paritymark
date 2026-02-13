const { pool, endPool } = require('../src/db');
const {
  ensureConfigTables,
  getActiveConfigForDeploymentCode,
  activateConfigVersionForDeploymentCode,
  DEPLOYMENTS_TABLE_NAME,
  CONFIG_VERSIONS_TABLE_NAME,
  CONFIG_ARTIFACTS_TABLE_NAME,
} = require('../src/config');

jest.setTimeout(30000); // allow time for DB operations

describe('Config backbone: getActiveConfigForDeploymentCode and activation helper', () => {
  beforeAll(async () => {
    // Ensure DB env vars are set for local dev / CI
    process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
    process.env.DB_PORT = process.env.DB_PORT || '5432';
    process.env.DB_USER = process.env.DB_USER || 'paritymark';
    process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'paritymark';
    process.env.DB_NAME = process.env.DB_NAME || 'paritymark';

    await ensureConfigTables();

    // Clean up any existing test data for a stable baseline
    await pool.query(`DELETE FROM ${CONFIG_ARTIFACTS_TABLE_NAME}`);
    await pool.query(`DELETE FROM ${CONFIG_VERSIONS_TABLE_NAME}`);
    await pool.query(`DELETE FROM ${DEPLOYMENTS_TABLE_NAME}`);
  });

  afterAll(async () => {
    await endPool();
  });

  test('returns notFound=deployment when deployment code does not exist', async () => {
    const result = await getActiveConfigForDeploymentCode('NON_EXISTENT');

    expect(result.deployment).toBeNull();
    expect(result.configVersion).toBeNull();
    expect(result.artifacts).toEqual({});
    expect(result.notFound).toBe('deployment');
  });

  test('returns notFound=active_config when deployment exists but no ACTIVE config version', async () => {
    // Insert a deployment without any config versions
    const insertDeploymentSql = `
      INSERT INTO ${DEPLOYMENTS_TABLE_NAME} (code, name)
      VALUES ($1, $2)
      RETURNING id
    `;
    const deploymentCode = 'D_NO_ACTIVE';
    const deploymentName = 'Deployment without active config';

    const deploymentResult = await pool.query(insertDeploymentSql, [
      deploymentCode,
      deploymentName,
    ]);
    const deploymentId = deploymentResult.rows[0].id;

    // Sanity: no config_versions rows for this deployment
    const versionsResult = await pool.query(
      `SELECT * FROM ${CONFIG_VERSIONS_TABLE_NAME} WHERE deployment_id = $1`,
      [deploymentId],
    );
    expect(versionsResult.rows.length).toBe(0);

    const result = await getActiveConfigForDeploymentCode(deploymentCode);

    expect(result.deployment).toEqual({
      id: deploymentId,
      code: deploymentCode,
      name: deploymentName,
    });
    expect(result.configVersion).toBeNull();
    expect(result.artifacts).toEqual({});
    expect(result.notFound).toBe('active_config');
  });

  test('returns active config with artifacts for an existing deployment', async () => {
    // Insert a deployment
    const insertDeploymentSql = `
      INSERT INTO ${DEPLOYMENTS_TABLE_NAME} (code, name)
      VALUES ($1, $2)
      RETURNING id
    `;
    const deploymentCode = 'D1';
    const deploymentName = 'Example Deployment';

    const deploymentResult = await pool.query(insertDeploymentSql, [
      deploymentCode,
      deploymentName,
    ]);
    const deploymentId = deploymentResult.rows[0].id;

    // Insert an ACTIVE config version
    const insertConfigVersionSql = `
      INSERT INTO ${CONFIG_VERSIONS_TABLE_NAME} (
        deployment_id,
        version_number,
        status,
        created_by
      )
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `;
    const versionNumber = 1;
    const status = 'ACTIVE';
    const createdBy = 'system';

    const configVersionResult = await pool.query(insertConfigVersionSql, [
      deploymentId,
      versionNumber,
      status,
      createdBy,
    ]);
    const configVersionId = configVersionResult.rows[0].id;

    // Insert a couple of artifacts for this config version
    const insertArtifactSql = `
      INSERT INTO ${CONFIG_ARTIFACTS_TABLE_NAME} (
        config_version_id,
        artifact_type,
        payload
      )
      VALUES ($1, $2, $3)
    `;

    const permissionMatrix = {
      roles: ['ASSISTANT', 'TEAM_LEADER'],
      permissions: {
        ASSISTANT: ['MARK_SCRIPT'],
        TEAM_LEADER: ['MARK_SCRIPT', 'VIEW_REPORTS'],
      },
    };

    const branding = {
      logoUrl: 'https://example.org/logo.png',
      primaryColor: '#0044cc',
    };

    await pool.query(insertArtifactSql, [
      configVersionId,
      'permission_matrix',
      permissionMatrix,
    ]);
    await pool.query(insertArtifactSql, [
      configVersionId,
      'branding',
      branding,
    ]);

    const result = await getActiveConfigForDeploymentCode(deploymentCode);

    expect(result.deployment).toEqual({
      id: deploymentId,
      code: deploymentCode,
      name: deploymentName,
    });

    expect(result.configVersion).toMatchObject({
      id: configVersionId,
      deployment_id: deploymentId,
      version_number: versionNumber,
      status,
      created_by: createdBy,
    });

    expect(result.artifacts).toHaveProperty('permission_matrix');
    expect(result.artifacts).toHaveProperty('branding');
    expect(result.artifacts.permission_matrix).toEqual(permissionMatrix);
    expect(result.artifacts.branding).toEqual(branding);
  });

  test('activation helper returns notFound=config_version when target version does not exist', async () => {
    // Insert a deployment with no versions matching the requested number
    const insertDeploymentSql = `
      INSERT INTO ${DEPLOYMENTS_TABLE_NAME} (code, name)
      VALUES ($1, $2)
      RETURNING id
    `;
    const deploymentCode = 'D_ACTIVATE_MISSING';
    const deploymentName = 'Deployment without target version';

    const deploymentResult = await pool.query(insertDeploymentSql, [
      deploymentCode,
      deploymentName,
    ]);
    const deploymentId = deploymentResult.rows[0].id;
    expect(deploymentId).toBeTruthy();

    const activationResult =
      await activateConfigVersionForDeploymentCode(deploymentCode, 42);

    expect(activationResult.deployment).toEqual({
      id: deploymentId,
      code: deploymentCode,
      name: deploymentName,
    });
    expect(activationResult.configVersion).toBeNull();
    expect(activationResult.notFound).toBe('config_version');
  });

  test('activation helper sets target version ACTIVE and retires previous ACTIVE versions', async () => {
    // Insert a deployment
    const insertDeploymentSql = `
      INSERT INTO ${DEPLOYMENTS_TABLE_NAME} (code, name)
      VALUES ($1, $2)
      RETURNING id
    `;
    const deploymentCode = 'D_ACTIVATE';
    const deploymentName = 'Deployment with multiple versions';

    const deploymentResult = await pool.query(insertDeploymentSql, [
      deploymentCode,
      deploymentName,
    ]);
    const deploymentId = deploymentResult.rows[0].id;

    // Insert an initially ACTIVE config version (v1)
    const insertConfigVersionSql = `
      INSERT INTO ${CONFIG_VERSIONS_TABLE_NAME} (
        deployment_id,
        version_number,
        status,
        created_by
      )
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `;
    const createdBy = 'system';

    const v1Result = await pool.query(insertConfigVersionSql, [
      deploymentId,
      1,
      'ACTIVE',
      createdBy,
    ]);
    const v1Id = v1Result.rows[0].id;

    // Insert another version (v2) as non-active (e.g. APPROVED)
    const v2Result = await pool.query(insertConfigVersionSql, [
      deploymentId,
      2,
      'APPROVED',
      createdBy,
    ]);
    const v2Id = v2Result.rows[0].id;

    expect(v1Id).toBeTruthy();
    expect(v2Id).toBeTruthy();

    const activationResult =
      await activateConfigVersionForDeploymentCode(deploymentCode, 2);

    // Check returned shape
    expect(activationResult.deployment).toEqual({
      id: deploymentId,
      code: deploymentCode,
      name: deploymentName,
    });
    expect(activationResult.configVersion).toBeDefined();
    expect(activationResult.configVersion.version_number).toBe(2);
    expect(activationResult.configVersion.status).toBe('ACTIVE');
    expect(activationResult.configVersion.activated_at).toBeTruthy();

    // Check DB state: v2 is ACTIVE, v1 is RETIRED
    const versionsResult = await pool.query(
      `SELECT version_number, status FROM ${CONFIG_VERSIONS_TABLE_NAME} WHERE deployment_id = $1 ORDER BY version_number ASC`,
      [deploymentId],
    );
    const rows = versionsResult.rows;

    expect(rows).toEqual([
      { version_number: 1, status: 'RETIRED' },
      { version_number: 2, status: 'ACTIVE' },
    ]);
  });
});
