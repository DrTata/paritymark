const { pool } = require('./db');
const {
  DEPLOYMENTS_TABLE_NAME,
  ensureConfigTables,
} = require('./config');

const ASSESSMENT_SERIES_TABLE_NAME = 'assessment_series';
const ASSESSMENT_PAPERS_TABLE_NAME = 'assessment_papers';
const ASSESSMENT_QIGS_TABLE_NAME = 'assessment_qigs';
const ASSESSMENT_ITEMS_TABLE_NAME = 'assessment_items';

/**
 * Handle known-benign concurrency errors for CREATE TABLE IF NOT EXISTS,
 * mirroring the approach used in config and audit modules.
 */
function handleConcurrentDdlError(err) {
  const code = err && err.code;
  const message = (err && err.message) || '';

  // Duplicate table
  if (code === '42P07') {
    return;
  }

  // Unique violation on pg_type_typname_nsp_index during concurrent DDL
  if (code === '23505' && message.includes('pg_type_typname_nsp_index')) {
    return;
  }

  throw err;
}

/**
 * Ensure that the assessment-related tables exist.
 *
 * Tables:
 * - assessment_series: Series per deployment
 * - assessment_papers: Papers per Series
 * - assessment_qigs:   QIGs per Paper
 * - assessment_items:  Items per QIG
 *
 * This is designed to support MOD-02 Assessment Setup:
 * Series -> Paper -> QIG -> Items with unique codes and item max marks.
 */
async function ensureAssessmentTables() {
  // Ensure deployments/config tables exist first, so our FK to deployments is valid.
  await ensureConfigTables();

  const createSeriesSql = `
    CREATE TABLE IF NOT EXISTS ${ASSESSMENT_SERIES_TABLE_NAME} (
      id SERIAL PRIMARY KEY,
      deployment_id INTEGER NOT NULL REFERENCES ${DEPLOYMENTS_TABLE_NAME}(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at TIMESTAMPTZ,
      UNIQUE (deployment_id, code)
    )
  `;

  const createPapersSql = `
    CREATE TABLE IF NOT EXISTS ${ASSESSMENT_PAPERS_TABLE_NAME} (
      id SERIAL PRIMARY KEY,
      series_id INTEGER NOT NULL REFERENCES ${ASSESSMENT_SERIES_TABLE_NAME}(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at TIMESTAMPTZ,
      UNIQUE (series_id, code)
    )
  `;

  const createQigsSql = `
    CREATE TABLE IF NOT EXISTS ${ASSESSMENT_QIGS_TABLE_NAME} (
      id SERIAL PRIMARY KEY,
      paper_id INTEGER NOT NULL REFERENCES ${ASSESSMENT_PAPERS_TABLE_NAME}(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at TIMESTAMPTZ,
      UNIQUE (paper_id, code)
    )
  `;

  const createItemsSql = `
    CREATE TABLE IF NOT EXISTS ${ASSESSMENT_ITEMS_TABLE_NAME} (
      id SERIAL PRIMARY KEY,
      qig_id INTEGER NOT NULL REFERENCES ${ASSESSMENT_QIGS_TABLE_NAME}(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      max_mark INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at TIMESTAMPTZ,
      UNIQUE (qig_id, code)
    )
  `;

  const statements = [
    createSeriesSql,
    createPapersSql,
    createQigsSql,
    createItemsSql,
  ];

  for (const sql of statements) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(sql);
    } catch (err) {
      handleConcurrentDdlError(err);
    }
  }
}

/**
 * Basic helper: create a Series row.
 */
async function createSeries(deploymentId, code, name) {
  await ensureAssessmentTables();

  const insertSql = `
    INSERT INTO ${ASSESSMENT_SERIES_TABLE_NAME} (
      deployment_id, code, name
    )
    VALUES ($1, $2, $3)
    RETURNING id, deployment_id, code, name, created_at, archived_at
  `;
  const result = await pool.query(insertSql, [deploymentId, code, name]);
  return result.rows[0];
}

/**
 * Fetch Series by deployment + code.
 */
async function getSeriesByCode(deploymentId, code) {
  await ensureAssessmentTables();

  const selectSql = `
    SELECT id, deployment_id, code, name, created_at, archived_at
    FROM ${ASSESSMENT_SERIES_TABLE_NAME}
    WHERE deployment_id = $1 AND code = $2
    LIMIT 1
  `;
  const result = await pool.query(selectSql, [deploymentId, code]);
  return result.rows[0] || null;
}

/**
 * Create a Paper within a Series.
 */
async function createPaper(seriesId, code, name) {
  await ensureAssessmentTables();

  const insertSql = `
    INSERT INTO ${ASSESSMENT_PAPERS_TABLE_NAME} (
      series_id, code, name
    )
    VALUES ($1, $2, $3)
    RETURNING id, series_id, code, name, created_at, archived_at
  `;
  const result = await pool.query(insertSql, [seriesId, code, name]);
  return result.rows[0];
}

/**
 * Fetch Paper by series + code.
 */
async function getPaperByCode(seriesId, code) {
  await ensureAssessmentTables();

  const selectSql = `
    SELECT id, series_id, code, name, created_at, archived_at
    FROM ${ASSESSMENT_PAPERS_TABLE_NAME}
    WHERE series_id = $1 AND code = $2
    LIMIT 1
  `;
  const result = await pool.query(selectSql, [seriesId, code]);
  return result.rows[0] || null;
}

/**
 * Create a QIG within a Paper.
 */
async function createQig(paperId, code, name) {
  await ensureAssessmentTables();

  const insertSql = `
    INSERT INTO ${ASSESSMENT_QIGS_TABLE_NAME} (
      paper_id, code, name
    )
    VALUES ($1, $2, $3)
    RETURNING id, paper_id, code, name, created_at, archived_at
  `;
  const result = await pool.query(insertSql, [paperId, code, name]);
  return result.rows[0];
}

/**
 * Fetch QIG by paper + code.
 */
async function getQigByCode(paperId, code) {
  await ensureAssessmentTables();

  const selectSql = `
    SELECT id, paper_id, code, name, created_at, archived_at
    FROM ${ASSESSMENT_QIGS_TABLE_NAME}
    WHERE paper_id = $1 AND code = $2
    LIMIT 1
  `;
  const result = await pool.query(selectSql, [paperId, code]);
  return result.rows[0] || null;
}

/**
 * Create an Item within a QIG.
 * maxMark is stored as an integer to support validation per MOD-02.
 */
async function createItem(qigId, code, maxMark) {
  await ensureAssessmentTables();

  const insertSql = `
    INSERT INTO ${ASSESSMENT_ITEMS_TABLE_NAME} (
      qig_id, code, max_mark
    )
    VALUES ($1, $2, $3)
    RETURNING id, qig_id, code, max_mark, created_at, archived_at
  `;
  const result = await pool.query(insertSql, [qigId, code, maxMark]);
  return result.rows[0];
}

/**
 * Fetch Item by QIG + code.
 */
async function getItemByCode(qigId, code) {
  await ensureAssessmentTables();

  const selectSql = `
    SELECT id, qig_id, code, max_mark, created_at, archived_at
    FROM ${ASSESSMENT_ITEMS_TABLE_NAME}
    WHERE qig_id = $1 AND code = $2
    LIMIT 1
  `;
  const result = await pool.query(selectSql, [qigId, code]);
  return result.rows[0] || null;
}

/**
 * Build a hierarchical assessment tree for a deployment:
 * Series -> Papers -> QIGs -> Items.
 */
async function getAssessmentTreeForDeployment(deploymentId) {
  await ensureAssessmentTables();

  // Fetch all Series for the deployment.
  const seriesResult = await pool.query(
    `
      SELECT id, deployment_id, code, name, created_at, archived_at
      FROM ${ASSESSMENT_SERIES_TABLE_NAME}
      WHERE deployment_id = $1
      ORDER BY id ASC
    `,
    [deploymentId],
  );
  const seriesRows = seriesResult.rows || [];

  if (seriesRows.length === 0) {
    return [];
  }

  const seriesIds = seriesRows.map((s) => s.id);

  // Fetch all Papers for these Series.
  const papersResult = await pool.query(
    `
      SELECT id, series_id, code, name, created_at, archived_at
      FROM ${ASSESSMENT_PAPERS_TABLE_NAME}
      WHERE series_id = ANY($1::int[])
      ORDER BY id ASC
    `,
    [seriesIds],
  );
  const paperRows = papersResult.rows || [];
  const paperIds = paperRows.map((p) => p.id);

  // Fetch all QIGs for these Papers.
  let qigRows = [];
  let qigIds = [];
  if (paperIds.length > 0) {
    const qigsResult = await pool.query(
      `
        SELECT id, paper_id, code, name, created_at, archived_at
        FROM ${ASSESSMENT_QIGS_TABLE_NAME}
        WHERE paper_id = ANY($1::int[])
        ORDER BY id ASC
      `,
      [paperIds],
    );
    qigRows = qigsResult.rows || [];
    qigIds = qigRows.map((q) => q.id);
  }

  // Fetch all Items for these QIGs.
  let itemRows = [];
  if (qigIds.length > 0) {
    const itemsResult = await pool.query(
      `
        SELECT id, qig_id, code, max_mark, created_at, archived_at
        FROM ${ASSESSMENT_ITEMS_TABLE_NAME}
        WHERE qig_id = ANY($1::int[])
        ORDER BY id ASC
      `,
      [qigIds],
    );
    itemRows = itemsResult.rows || [];
  }

  // Index by parent ids for fast nesting.
  const papersBySeriesId = {};
  paperRows.forEach((p) => {
    if (!papersBySeriesId[p.series_id]) {
      papersBySeriesId[p.series_id] = [];
    }
    papersBySeriesId[p.series_id].push(p);
  });

  const qigsByPaperId = {};
  qigRows.forEach((q) => {
    if (!qigsByPaperId[q.paper_id]) {
      qigsByPaperId[q.paper_id] = [];
    }
    qigsByPaperId[q.paper_id].push(q);
  });

  const itemsByQigId = {};
  itemRows.forEach((i) => {
    if (!itemsByQigId[i.qig_id]) {
      itemsByQigId[i.qig_id] = [];
    }
    itemsByQigId[i.qig_id].push(i);
  });

  // Build the nested structure.
  const tree = seriesRows.map((s) => {
    const seriesPapers = papersBySeriesId[s.id] || [];
    return {
      id: s.id,
      code: s.code,
      name: s.name,
      papers: seriesPapers.map((p) => {
        const paperQigs = qigsByPaperId[p.id] || [];
        return {
          id: p.id,
          code: p.code,
          name: p.name,
          qigs: paperQigs.map((q) => {
            const qigItems = itemsByQigId[q.id] || [];
            return {
              id: q.id,
              code: q.code,
              name: q.name,
              items: qigItems.map((i) => ({
                id: i.id,
                code: i.code,
                maxMark: i.max_mark,
              })),
            };
          }),
        };
      }),
    };
  });

  return tree;
}

module.exports = {
  ASSESSMENT_SERIES_TABLE_NAME,
  ASSESSMENT_PAPERS_TABLE_NAME,
  ASSESSMENT_QIGS_TABLE_NAME,
  ASSESSMENT_ITEMS_TABLE_NAME,
  ensureAssessmentTables,
  createSeries,
  getSeriesByCode,
  createPaper,
  getPaperByCode,
  createQig,
  getQigByCode,
  createItem,
  getItemByCode,
  getAssessmentTreeForDeployment,
};
