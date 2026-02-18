const http = require('http');
const { createServer } = require('../src/server');
const { pool } = require('../src/db');
const {
  ensureConfigTables,
  DEPLOYMENTS_TABLE_NAME,
  CONFIG_VERSIONS_TABLE_NAME,
  CONFIG_ARTIFACTS_TABLE_NAME,
} = require('../src/config');
const {
  ensureIdentityTables,
  USERS_TABLE_NAME,
  ROLES_TABLE_NAME,
  PERMISSIONS_TABLE_NAME,
  USER_ROLES_TABLE_NAME,
  ROLE_PERMISSIONS_TABLE_NAME,
  createUser,
  createRole,
  createPermission,
  assignRoleToUser,
  assignPermissionToRole,
} = require('../src/identity');
const {
  ensureAssessmentTables,
  ASSESSMENT_SERIES_TABLE_NAME,
  ASSESSMENT_PAPERS_TABLE_NAME,
  ASSESSMENT_QIGS_TABLE_NAME,
  ASSESSMENT_ITEMS_TABLE_NAME,
  createSeries,
  createPaper,
  createQig,
  createItem,
} = require('../src/assessment');
const {
  ensureAuditTable,
  AUDIT_TABLE_NAME,
  PERMISSION_DENIED_EVENT_TYPE,
  ASSESSMENT_TREE_VIEWED_EVENT_TYPE,
  ASSESSMENT_STRUCTURE_UPDATED_EVENT_TYPE,
  getLatestAuditEventByType,
} = require('../src/audit');
const {
  ensureIngestionTables,
  RESPONSES_TABLE_NAME,
  upsertResponse,
} = require('../src/ingestion');

jest.setTimeout(30000); // allow time for DB + HTTP operations

function httpGetJson(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = body ? JSON.parse(body) : null;
          } catch (_err) {
            // If it's not JSON, leave json = null and still return the body for debugging.
          }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body,
            json,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function httpPostJson(port, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch (_err) {
            // leave json = null
          }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: raw,
            json,
          });
        });
      },
    );

    req.on('error', reject);
    req.write(JSON.stringify(body || {}));
    req.end();
  });
}

function extractQigCodes(series) {
  const codes = [];
  (series || []).forEach((s) => {
    if (!s || !Array.isArray(s.papers)) {
      return;
    }
    s.papers.forEach((p) => {
      if (!p || !Array.isArray(p.qigs)) {
        return;
      }
      p.qigs.forEach((q) => {
        if (q && typeof q.code === 'string') {
          codes.push(q.code);
        }
      });
    });
  });
  return codes;
}

describe('Assessment tree HTTP endpoint with RBAC + audit', () => {
  let server;
  let port;

  beforeAll(async () => {
    // Ensure DB env vars are set for local dev / CI
    process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
    process.env.DB_PORT = process.env.DB_PORT || '5432';
    process.env.DB_USER = process.env.DB_USER || 'paritymark';
    process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'paritymark';
    process.env.DB_NAME = process.env.DB_NAME || 'paritymark';

    await ensureConfigTables();
    await ensureIdentityTables();
    await ensureAssessmentTables();
    await ensureIngestionTables();
    await ensureAuditTable();

    // Start API server on an ephemeral port
    server = createServer();
    await new Promise((resolve) => {
      const s = server.listen(0, () => {
        // @ts-ignore
        port = s.address().port;
        resolve();
      });
    });
  });

  beforeEach(async () => {
    // Clean ingestion-related tables (responses) and assessment-related tables
    await pool.query(`DELETE FROM ${RESPONSES_TABLE_NAME}`);
    await pool.query(`DELETE FROM ${ASSESSMENT_ITEMS_TABLE_NAME}`);
    await pool.query(`DELETE FROM ${ASSESSMENT_QIGS_TABLE_NAME}`);
    await pool.query(`DELETE FROM ${ASSESSMENT_PAPERS_TABLE_NAME}`);
    await pool.query(`DELETE FROM ${ASSESSMENT_SERIES_TABLE_NAME}`);

    // Clean config-related tables
    await pool.query(`DELETE FROM ${CONFIG_ARTIFACTS_TABLE_NAME}`);
    await pool.query(`DELETE FROM ${CONFIG_VERSIONS_TABLE_NAME}`);
    await pool.query(`DELETE FROM ${DEPLOYMENTS_TABLE_NAME}`);

    // Clean identity tables
    await pool.query(
      `
      TRUNCATE TABLE
        ${USER_ROLES_TABLE_NAME},
        ${ROLE_PERMISSIONS_TABLE_NAME},
        ${PERMISSIONS_TABLE_NAME},
        ${ROLES_TABLE_NAME},
        ${USERS_TABLE_NAME}
      RESTART IDENTITY CASCADE
    `,
    );

    // Clean audit table
    await pool.query(`DELETE FROM ${AUDIT_TABLE_NAME}`);
  });

  afterAll(async () => {
    if (server && server.close) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  });

  test('returns 401 unauthenticated when no user headers are provided and writes PERMISSION_DENIED audit event', async () => {
    const res = await httpGetJson(port, '/assessment/D1/tree');

    expect(res.statusCode).toBe(401);
    expect(res.json).toEqual({
      error: 'unauthenticated',
      permission: 'assessment.view',
    });

    const event = await getLatestAuditEventByType(
      PERMISSION_DENIED_EVENT_TYPE,
    );

    expect(event).not.toBeNull();
    expect(event.event_type).toBe(PERMISSION_DENIED_EVENT_TYPE);
    expect(event.payload).toBeDefined();
    expect(event.payload.meta).toMatchObject({
      permission: 'assessment.view',
      reason: 'unauthenticated',
      path: '/assessment/D1/tree',
      method: 'GET',
    });
    expect(event.payload.subject).toBeNull();
  });

  test('returns 403 forbidden when user lacks assessment.view permission and writes PERMISSION_DENIED audit event', async () => {
    const res = await httpGetJson(port, '/assessment/D1/tree', {
      'x-user-external-id': 'no-assessment-perm',
      'x-user-display-name': 'No Assessment Perm',
    });

    expect(res.statusCode).toBe(403);
    expect(res.json).toEqual({
      error: 'forbidden',
      permission: 'assessment.view',
    });

    const event = await getLatestAuditEventByType(
      PERMISSION_DENIED_EVENT_TYPE,
    );

    expect(event).not.toBeNull();
    expect(event.event_type).toBe(PERMISSION_DENIED_EVENT_TYPE);
    expect(event.payload).toBeDefined();
    expect(event.payload.meta).toMatchObject({
      permission: 'assessment.view',
      reason: 'missing_permission',
      path: '/assessment/D1/tree',
      method: 'GET',
    });
    expect(event.payload.subject).toBeDefined();
    expect(event.payload.subject.externalId).toBe('no-assessment-perm');
  });

  test('returns 404 deployment_not_found when deployment does not exist (authorised user) and still logs PERMISSION_DENIED only when auth fails', async () => {
    // Seed identity: user with assessment.view permission
    const user = await createUser(
      'assessment-viewer-1',
      'Assessment Viewer One',
    );
    const role = await createRole('ASSESSMENT_VIEWER', 'Assessment tree viewer');
    const perm = await createPermission(
      'assessment.view',
      'View assessment structures',
    );
    await assignRoleToUser(user.id, role.id);
    await assignPermissionToRole(role.id, perm.id);

    const res = await httpGetJson(port, '/assessment/D_UNKNOWN/tree', {
      'x-user-external-id': 'assessment-viewer-1',
      'x-user-display-name': 'Assessment Viewer One',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json).toEqual({
      error: 'deployment_not_found',
    });

    // For authorised user + unknown deployment, we do NOT expect a PERMISSION_DENIED event,
    // but we also do not expect a view event because the deployment is missing.
    const deniedEvent = await getLatestAuditEventByType(
      PERMISSION_DENIED_EVENT_TYPE,
    );
    expect(deniedEvent).toBeNull();

    const viewEvent = await getLatestAuditEventByType(
      ASSESSMENT_TREE_VIEWED_EVENT_TYPE,
    );
    expect(viewEvent).toBeNull();
  });

  test('returns assessment tree for authorised user and writes ASSESSMENT_TREE_VIEWED audit event', async () => {
    // Seed identity: user with assessment.view permission
    const user = await createUser(
      'assessment-viewer-1',
      'Assessment Viewer One',
    );
    const role = await createRole('ASSESSMENT_VIEWER', 'Assessment tree viewer');
    const perm = await createPermission(
      'assessment.view',
      'View assessment structures',
    );
    await assignRoleToUser(user.id, role.id);
    await assignPermissionToRole(role.id, perm.id);

    // Seed a deployment and assessment structure
    const deploymentCode = 'D_ASSESS_HTTP';
    const deploymentName = 'HTTP Assessment Test';

    const deploymentResult = await pool.query(
      `
      INSERT INTO ${DEPLOYMENTS_TABLE_NAME} (code, name)
      VALUES ($1, $2)
      RETURNING id
    `,
      [deploymentCode, deploymentName],
    );
    const deploymentId = deploymentResult.rows[0].id;

    const seriesRow = await createSeries(
      deploymentId,
      'S_HTTP_1',
      'Series HTTP 1',
    );
    const paperRow = await createPaper(
      seriesRow.id,
      'P_HTTP_1',
      'Paper HTTP 1',
    );
    const qigRow = await createQig(
      paperRow.id,
      'Q_HTTP_1',
      'QIG HTTP 1',
    );
    const itemRow = await createItem(qigRow.id, 'I_HTTP_1', 20);

    const res = await httpGetJson(
      port,
      `/assessment/${deploymentCode}/tree`,
      {
        'x-user-external-id': 'assessment-viewer-1',
        'x-user-display-name': 'Assessment Viewer One',
      },
    );

    expect(res.statusCode).toBe(200);
    expect(res.json).toBeTruthy();

    const { deployment, series } = res.json;

    expect(deployment).toMatchObject({
      id: deploymentId,
      code: deploymentCode,
      name: deploymentName,
    });

    expect(Array.isArray(series)).toBe(true);
    expect(series.length).toBe(1);

    const s = series[0];
    expect(s).toMatchObject({
      id: seriesRow.id,
      code: 'S_HTTP_1',
      name: 'Series HTTP 1',
    });

    expect(Array.isArray(s.papers)).toBe(true);
    expect(s.papers.length).toBe(1);

    const p = s.papers[0];
    expect(p).toMatchObject({
      id: paperRow.id,
      code: 'P_HTTP_1',
      name: 'Paper HTTP 1',
    });

    expect(Array.isArray(p.qigs)).toBe(true);
    expect(p.qigs.length).toBe(1);

    const q = p.qigs[0];
    expect(q).toMatchObject({
      id: qigRow.id,
      code: 'Q_HTTP_1',
      name: 'QIG HTTP 1',
    });

    expect(Array.isArray(q.items)).toBe(true);
    expect(q.items.length).toBe(1);

    const it = q.items[0];
    expect(it).toMatchObject({
      id: itemRow.id,
      code: 'I_HTTP_1',
      maxMark: 20,
    });

    const event = await getLatestAuditEventByType(
      ASSESSMENT_TREE_VIEWED_EVENT_TYPE,
    );

    expect(event).not.toBeNull();
    expect(event.event_type).toBe(ASSESSMENT_TREE_VIEWED_EVENT_TYPE);
    expect(event.payload).toBeDefined();
    expect(event.payload.meta).toMatchObject({
      deploymentId,
      deploymentCode,
      path: `/assessment/${deploymentCode}/tree`,
      method: 'GET',
    });
    expect(event.payload.actor).toBeDefined();
    expect(event.payload.actor.externalId).toBe('assessment-viewer-1');
  });

  test('POST /assessment/:deploymentCode/series requires authentication and writes PERMISSION_DENIED audit event', async () => {
    const res = await httpPostJson(
      port,
      '/assessment/D1/series',
      { code: 'S1', name: 'Series 1' },
    );

    expect(res.statusCode).toBe(401);
    expect(res.json).toEqual({
      error: 'unauthenticated',
      permission: 'assessment.edit',
    });

    const event = await getLatestAuditEventByType(
      PERMISSION_DENIED_EVENT_TYPE,
    );

    expect(event).not.toBeNull();
    expect(event.event_type).toBe(PERMISSION_DENIED_EVENT_TYPE);
    expect(event.payload).toBeDefined();
    expect(event.payload.meta).toMatchObject({
      permission: 'assessment.edit',
      reason: 'unauthenticated',
      path: '/assessment/D1/series',
      method: 'POST',
    });
    expect(event.payload.subject).toBeNull();
  });

  test('POST /assessment/:deploymentCode/series returns 403 when user lacks assessment.edit and writes PERMISSION_DENIED audit event', async () => {
    const res = await httpPostJson(
      port,
      '/assessment/D1/series',
      { code: 'S1', name: 'Series 1' },
      {
        'x-user-external-id': 'no-assessment-edit',
        'x-user-display-name': 'No Assessment Edit',
      },
    );

    expect(res.statusCode).toBe(403);
    expect(res.json).toEqual({
      error: 'forbidden',
      permission: 'assessment.edit',
    });

    const event = await getLatestAuditEventByType(
      PERMISSION_DENIED_EVENT_TYPE,
    );

    expect(event).not.toBeNull();
    expect(event.event_type).toBe(PERMISSION_DENIED_EVENT_TYPE);
    expect(event.payload).toBeDefined();
    expect(event.payload.meta).toMatchObject({
      permission: 'assessment.edit',
      reason: 'missing_permission',
      path: '/assessment/D1/series',
      method: 'POST',
    });
    expect(event.payload.subject).toBeDefined();
    expect(event.payload.subject.externalId).toBe('no-assessment-edit');
  });

  test('can create assessment structure via HTTP authoring endpoints', async () => {
    // Seed deployment
    const deploymentCode = 'D1';
    const deploymentName = 'Deployment D1';

    const deploymentResult = await pool.query(
      `
        INSERT INTO ${DEPLOYMENTS_TABLE_NAME} (code, name)
        VALUES ($1, $2)
        RETURNING id
      `,
      [deploymentCode, deploymentName],
    );
    const deploymentId = deploymentResult.rows[0].id;

    // Seed identity: user with assessment.edit and assessment.view permissions
    const user = await createUser(
      'assessment-author-1',
      'Assessment Author One',
    );
    const role = await createRole('ASSESSMENT_AUTHOR', 'Assessment author');
    const editPerm = await createPermission(
      'assessment.edit',
      'Edit assessment structures',
    );
    const viewPerm = await createPermission(
      'assessment.view',
      'View assessment structures',
    );

    await assignRoleToUser(user.id, role.id);
    await assignPermissionToRole(role.id, editPerm.id);
    await assignPermissionToRole(role.id, viewPerm.id);

    const authHeaders = {
      'x-user-external-id': 'assessment-author-1',
      'x-user-display-name': 'Assessment Author One',
    };

    // 1) Create Series
    const seriesRes = await httpPostJson(
      port,
      `/assessment/${deploymentCode}/series`,
      { code: 'S1', name: 'Series 1' },
      authHeaders,
    );

    expect(seriesRes.statusCode).toBe(201);
    expect(seriesRes.json).toBeTruthy();
    expect(seriesRes.json.series).toMatchObject({
      code: 'S1',
      name: 'Series 1',
      deploymentId,
    });

    // 2) Create Paper in Series
    const paperRes = await httpPostJson(
      port,
      `/assessment/${deploymentCode}/series/S1/papers`,
      { code: 'P1', name: 'Paper 1' },
      authHeaders,
    );

    expect(paperRes.statusCode).toBe(201);
    expect(paperRes.json).toBeTruthy();
    expect(paperRes.json.paper).toMatchObject({
      code: 'P1',
      name: 'Paper 1',
    });

    // 3) Create QIG in Paper
    const qigRes = await httpPostJson(
      port,
      `/assessment/${deploymentCode}/series/S1/papers/P1/qigs`,
      { code: 'Q1', name: 'QIG 1' },
      authHeaders,
    );

    expect(qigRes.statusCode).toBe(201);
    expect(qigRes.json).toBeTruthy();
    expect(qigRes.json.qig).toMatchObject({
      code: 'Q1',
      name: 'QIG 1',
    });

    // 4) Create Item in QIG
    const itemRes = await httpPostJson(
      port,
      `/assessment/${deploymentCode}/series/S1/papers/P1/qigs/Q1/items`,
      { code: 'I1', maxMark: 20 },
      authHeaders,
    );

    expect(itemRes.statusCode).toBe(201);
    expect(itemRes.json).toBeTruthy();
    expect(itemRes.json.item).toMatchObject({
      code: 'I1',
      maxMark: 20,
    });

    // 5) Fetch assessment tree and verify structure
    const treeRes = await httpGetJson(
      port,
      `/assessment/${deploymentCode}/tree`,
      authHeaders,
    );

    expect(treeRes.statusCode).toBe(200);
    expect(treeRes.json).toBeTruthy();

    const { deployment, series } = treeRes.json;

    expect(deployment).toMatchObject({
      id: deploymentId,
      code: deploymentCode,
      name: deploymentName,
    });

    expect(Array.isArray(series)).toBe(true);

    const s = series.find((row) => row.code === 'S1');
    expect(s).toBeDefined();
    expect(s.name).toBe('Series 1');
    expect(Array.isArray(s.papers)).toBe(true);

    const p = s.papers.find((row) => row.code === 'P1');
    expect(p).toBeDefined();
    expect(p.name).toBe('Paper 1');
    expect(Array.isArray(p.qigs)).toBe(true);

    const q = p.qigs.find((row) => row.code === 'Q1');
    expect(q).toBeDefined();
    expect(q.name).toBe('QIG 1');
    expect(Array.isArray(q.items)).toBe(true);

    const it = q.items.find((row) => row.code === 'I1');
    expect(it).toBeDefined();
    expect(it.maxMark).toBe(20);
  });

  test('writes ASSESSMENT_STRUCTURE_UPDATED audit event when item is created via authorised HTTP authoring', async () => {
    const deploymentCode = 'D_AUDIT_HTTP';
    const deploymentName = 'Deployment Audit HTTP';

    const deploymentResult = await pool.query(
      `
        INSERT INTO ${DEPLOYMENTS_TABLE_NAME} (code, name)
        VALUES ($1, $2)
        RETURNING id
      `,
      [deploymentCode, deploymentName],
    );
    const deploymentId = deploymentResult.rows[0].id;

    // Seed identity: user with assessment.edit and assessment.view permissions
    const user = await createUser(
      'assessment-author-2',
      'Assessment Author Two',
    );
    const role = await createRole('ASSESSMENT_AUTHOR', 'Assessment author');
    const editPerm = await createPermission(
      'assessment.edit',
      'Edit assessment structures',
    );
    const viewPerm = await createPermission(
      'assessment.view',
      'View assessment structures',
    );

    await assignRoleToUser(user.id, role.id);
    await assignPermissionToRole(role.id, editPerm.id);
    await assignPermissionToRole(role.id, viewPerm.id);

    const authHeaders = {
      'x-user-external-id': 'assessment-author-2',
      'x-user-display-name': 'Assessment Author Two',
    };

    // Create Series / Paper / QIG / Item via HTTP
    const seriesRes = await httpPostJson(
      port,
      `/assessment/${deploymentCode}/series`,
      { code: 'S1', name: 'Series 1' },
      authHeaders,
    );
    expect(seriesRes.statusCode).toBe(201);

    const paperRes = await httpPostJson(
      port,
      `/assessment/${deploymentCode}/series/S1/papers`,
      { code: 'P1', name: 'Paper 1' },
      authHeaders,
    );
    expect(paperRes.statusCode).toBe(201);

    const qigRes = await httpPostJson(
      port,
      `/assessment/${deploymentCode}/series/S1/papers/P1/qigs`,
      { code: 'Q1', name: 'QIG 1' },
      authHeaders,
    );
    expect(qigRes.statusCode).toBe(201);

    const itemRes = await httpPostJson(
      port,
      `/assessment/${deploymentCode}/series/S1/papers/P1/qigs/Q1/items`,
      { code: 'I1', maxMark: 10 },
      authHeaders,
    );
    expect(itemRes.statusCode).toBe(201);

    const event = await getLatestAuditEventByType(
      ASSESSMENT_STRUCTURE_UPDATED_EVENT_TYPE,
    );

    expect(event).not.toBeNull();
    expect(event.event_type).toBe(ASSESSMENT_STRUCTURE_UPDATED_EVENT_TYPE);
    expect(event.payload).toBeDefined();

    const meta = event.payload.meta || {};
    const actor = event.payload.actor || {};

    expect(actor.externalId).toBe('assessment-author-2');
    expect(meta).toMatchObject({
      deploymentId,
      deploymentCode,
      structureType: 'item',
      structureCode: 'I1',
      path: `/assessment/${deploymentCode}/series/S1/papers/P1/qigs/Q1/items`,
      method: 'POST',
    });
  });

  test('AE QIG scoping filters tree for AE user while non-AE viewer sees full tree', async () => {
    await ensureIdentityTables();

    // Seed identity: one viewer and one AE, both with assessment.view
    const viewer = await createUser('ae-scope-viewer', 'AE Scope Viewer');
    const aeUser = await createUser('ae-scope-1', 'AE Scope One');

    const viewPerm = await createPermission(
      'assessment.view',
      'View assessment structures',
    );

    const viewerRole = await createRole(
      'ASSESSMENT_VIEWER_2',
      'Assessment tree viewer (multi-QIG)',
    );
    const aeRole = await createRole(
      'AE_D_AE_HTTP_Q_HTTP_1',
      'AE for D_AE_HTTP Q_HTTP_1',
    );

    await assignRoleToUser(viewer.id, viewerRole.id);
    await assignPermissionToRole(viewerRole.id, viewPerm.id);

    await assignRoleToUser(aeUser.id, aeRole.id);
    await assignPermissionToRole(aeRole.id, viewPerm.id);

    // Seed deployment with two QIGs
    const deploymentCode = 'D_AE_HTTP';
    const deploymentName = 'AE HTTP Assessment Test';

    const deploymentResult = await pool.query(
      `
      INSERT INTO ${DEPLOYMENTS_TABLE_NAME} (code, name)
      VALUES ($1, $2)
      RETURNING id
    `,
      [deploymentCode, deploymentName],
    );
    const deploymentId = deploymentResult.rows[0].id;

    const seriesRow = await createSeries(
      deploymentId,
      'S_HTTP_MULTI',
      'Series HTTP Multi',
    );
    const paperRow = await createPaper(
      seriesRow.id,
      'P_HTTP_MULTI',
      'Paper HTTP Multi',
    );

    const qigRow1 = await createQig(
      paperRow.id,
      'Q_HTTP_1',
      'QIG HTTP 1',
    );
    const qigRow2 = await createQig(
      paperRow.id,
      'Q_HTTP_2',
      'QIG HTTP 2',
    );

    await createItem(qigRow1.id, 'I_HTTP_1', 20);
    await createItem(qigRow2.id, 'I_HTTP_2', 10);

    const viewerHeaders = {
      'x-user-external-id': 'ae-scope-viewer',
      'x-user-display-name': 'AE Scope Viewer',
    };

    const aeHeaders = {
      'x-user-external-id': 'ae-scope-1',
      'x-user-display-name': 'AE Scope One',
    };

    // Viewer (no AE_* role) should see full tree (both QIGs)
    const viewerRes = await httpGetJson(
      port,
      `/assessment/${deploymentCode}/tree`,
      viewerHeaders,
    );

    expect(viewerRes.statusCode).toBe(200);
    expect(viewerRes.json).toBeTruthy();

    const viewerQigCodes = extractQigCodes(viewerRes.json.series);
    expect(viewerQigCodes).toEqual(
      expect.arrayContaining(['Q_HTTP_1', 'Q_HTTP_2']),
    );

    // AE user with AE_D_AE_HTTP_Q_HTTP_1 should see only Q_HTTP_1
    const aeRes = await httpGetJson(
      port,
      `/assessment/${deploymentCode}/tree`,
      aeHeaders,
    );

    expect(aeRes.statusCode).toBe(200);
    expect(aeRes.json).toBeTruthy();

    const aeQigCodes = extractQigCodes(aeRes.json.series);
    expect(aeQigCodes).toContain('Q_HTTP_1');
    expect(aeQigCodes).not.toContain('Q_HTTP_2');
  });

  // -----------------------------------------------------------------------
  // Response media endpoint tests
  // -----------------------------------------------------------------------

  test('GET /responses/:id/media requires authentication and returns 401', async () => {
    const res = await httpGetJson(port, '/responses/1/media');

    expect(res.statusCode).toBe(401);
    expect(res.json).toEqual({
      error: 'unauthenticated',
      permission: 'assessment.view',
    });
  });

  test('GET /responses/:id/media returns 403 when user lacks assessment.view', async () => {
    const res = await httpGetJson(port, '/responses/1/media', {
      'x-user-external-id': 'no-response-view',
      'x-user-display-name': 'No Response View',
    });

    expect(res.statusCode).toBe(403);
    expect(res.json).toEqual({
      error: 'forbidden',
      permission: 'assessment.view',
    });
  });

  test('GET /responses/:id/media returns 404 when response does not exist for authorised user', async () => {
    // Seed identity: user with assessment.view permission
    const user = await createUser(
      'response-viewer-404',
      'Response Viewer 404',
    );
    const role = await createRole('RESPONSE_VIEWER', 'Response viewer');
    const perm = await createPermission(
      'assessment.view',
      'View assessment structures / responses',
    );
    await assignRoleToUser(user.id, role.id);
    await assignPermissionToRole(role.id, perm.id);

    const res = await httpGetJson(port, '/responses/9999/media', {
      'x-user-external-id': 'response-viewer-404',
      'x-user-display-name': 'Response Viewer 404',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json).toEqual({
      error: 'response_not_found',
    });
  });

  test('GET /responses/:id/media returns response media pointer for authorised user', async () => {
    // Seed deployment/assessment structure + response
    const deploymentCode = 'D_RESP_HTTP';
    const deploymentName = 'Response Media Test';

    const deploymentResult = await pool.query(
      `
      INSERT INTO ${DEPLOYMENTS_TABLE_NAME} (code, name)
      VALUES ($1, $2)
      RETURNING id
    `,
      [deploymentCode, deploymentName],
    );
    const deploymentId = deploymentResult.rows[0].id;

    const seriesRow = await createSeries(
      deploymentId,
      'S_RESP_1',
      'Series Response 1',
    );
    const paperRow = await createPaper(
      seriesRow.id,
      'P_RESP_1',
      'Paper Response 1',
    );
    const qigRow = await createQig(
      paperRow.id,
      'Q_RESP_1',
      'QIG Response 1',
    );

    const candidateId = 'C_RESP_1';
    const scriptUrl = 's3://example-bucket/C_RESP_1_P_RESP_1.pdf';

    const responseRow = await upsertResponse({
      qigId: qigRow.id,
      candidateId,
      scriptUrl,
      manifest: null,
      state: 'INGESTED',
    });

    // Seed identity: user with assessment.view permission
    const user = await createUser(
      'response-viewer-1',
      'Response Viewer One',
    );
    const role = await createRole('RESPONSE_VIEWER', 'Response viewer');
    const perm = await createPermission(
      'assessment.view',
      'View assessment structures / responses',
    );
    await assignRoleToUser(user.id, role.id);
    await assignPermissionToRole(role.id, perm.id);

    const res = await httpGetJson(
      port,
      `/responses/${responseRow.id}/media`,
      {
        'x-user-external-id': 'response-viewer-1',
        'x-user-display-name': 'Response Viewer One',
      },
    );

    expect(res.statusCode).toBe(200);
    expect(res.json).toBeTruthy();
    expect(res.json.response).toMatchObject({
      id: responseRow.id,
      qigId: qigRow.id,
      candidateId,
      scriptUrl,
      state: 'INGESTED',
    });
  });
});
