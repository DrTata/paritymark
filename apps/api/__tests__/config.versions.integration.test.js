const { pool, endPool } = require('../src/db');
const {
  ensureConfigTables,
  getConfigVersionsForDeploymentId,
  DEPLOYMENTS_TABLE_NAME,
  CONFIG_VERSIONS_TABLE_NAME,
} = require('../src/config');

jest.setTimeout(30000); // allow time for DB operations

describe('Config backbone: getConfigVersionsForDeploymentId', () => {
  beforeAll(async () => {
    // Ensure DB env vars are set for local dev / CI
    process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
    process.env.DB_PORT = process.env.DB_PORT || '5432';
    process.env.DB_USER = process.env.DB_USER || 'paritymark';
    process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'paritymark';
    process.env.DB_NAME = process.env.DB_NAME || 'paritymark';

    await ensureConfigTables();

    // Clean up any existing test data for a stable baseline
    await pool.query(
      'DELETE FROM ' + CONFIG_VERSIONS_TABLE_NAME,
    );
    await pool.query(
      'DELETE FROM ' + DEPLOYMENTS_TABLE_NAME,
    );
  });

  afterAll(async () => {
    await endPool();
  });

  test('returns an empty array when deployment has no versions', async () => {
    const insertDeploymentSql =
      'INSERT INTO ' +
      DEPLOYMENTS_TABLE_NAME +
      ' (code, name) VALUES ($1, $2) RETURNING id';

    const deploymentCode = 'D_NO_VERSIONS';
    const deploymentName = 'Deployment with no versions';

    const deploymentResult = await pool.query(insertDeploymentSql, [
      deploymentCode,
      deploymentName,
    ]);
    const deploymentId = deploymentResult.rows[0].id;

    const versions = await getConfigVersionsForDeploymentId(deploymentId);

    expect(Array.isArray(versions)).toBe(true);
    expect(versions.length).toBe(0);
  });

  test('returns all versions for a deployment, ordered by version_number DESC', async () => {
    const insertDeploymentSql =
      'INSERT INTO ' +
      DEPLOYMENTS_TABLE_NAME +
      ' (code, name) VALUES ($1, $2) RETURNING id';

    const deploymentCode = 'D_VERSIONS';
    const deploymentName = 'Deployment with multiple versions';

    const deploymentResult = await pool.query(insertDeploymentSql, [
      deploymentCode,
      deploymentName,
    ]);
    const deploymentId = deploymentResult.rows[0].id;

    const insertConfigVersionSql =
      'INSERT INTO ' +
      CONFIG_VERSIONS_TABLE_NAME +
      ' (deployment_id, version_number, status, created_by)' +
      ' VALUES ($1, $2, $3, $4) RETURNING id';

    const createdBy = 'integration_test';

    // Insert three versions with different numbers and statuses
    await pool.query(insertConfigVersionSql, [
      deploymentId,
      1,
      'DRAFT',
      createdBy,
    ]);
    await pool.query(insertConfigVersionSql, [
      deploymentId,
      2,
      'APPROVED',
      createdBy,
    ]);
    await pool.query(insertConfigVersionSql, [
      deploymentId,
      3,
      'ACTIVE',
      createdBy,
    ]);

    const versions = await getConfigVersionsForDeploymentId(deploymentId);

    expect(Array.isArray(versions)).toBe(true);
    expect(versions.length).toBe(3);

    const versionNumbers = versions.map((v) => v.version_number);
    expect(versionNumbers).toEqual([3, 2, 1]);

    const statuses = versions.map((v) => v.status);
    expect(statuses).toEqual(['ACTIVE', 'APPROVED', 'DRAFT']);
  });
});
