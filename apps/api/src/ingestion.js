const { pool } = require('./db');
const {
  ensureAssessmentTables,
  ASSESSMENT_QIGS_TABLE_NAME,
} = require('./assessment');

const RESPONSES_TABLE_NAME = 'responses';

/**
 * Handle known-benign concurrency errors for DDL, mirroring the
 * config/audit/identity modules' behaviour.
 */
function handleConcurrentDdlError(err) {
  const code = err && err.code;
  const message = (err && err.message) || '';

  // Duplicate table or index
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
 * Ensure that the ingestion / Response-related tables exist and
 * enforce the Responses uniqueness invariant:
 *
 *   ONE Response per (qig_id, candidate_id)
 *
 * We enforce this structurally via a UNIQUE INDEX, so that accidental
 * duplicate inserts are impossible even if a caller forgets to go
 * through upsertResponse.
 */
async function ensureIngestionTables() {
  await ensureAssessmentTables();

  const createResponsesSql = `
    CREATE TABLE IF NOT EXISTS ${RESPONSES_TABLE_NAME} (
      id SERIAL PRIMARY KEY,
      qig_id INTEGER NOT NULL REFERENCES ${ASSESSMENT_QIGS_TABLE_NAME}(id) ON DELETE CASCADE,
      candidate_id TEXT NOT NULL,
      script_url TEXT,
      manifest JSONB,
      state TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at TIMESTAMPTZ
    )
  `;

  try {
    await pool.query(createResponsesSql);
  } catch (err) {
    handleConcurrentDdlError(err);
  }

  // Structural uniqueness invariant:
  //   - One Response per (qig_id, candidate_id).
  //
  // We use a UNIQUE INDEX rather than a named constraint so that this
  // is idempotent across Postgres versions.
  const createUniqueIndexSql = `
    CREATE UNIQUE INDEX IF NOT EXISTS ${RESPONSES_TABLE_NAME}_qig_candidate_unique
      ON ${RESPONSES_TABLE_NAME} (qig_id, candidate_id)
  `;

  try {
    await pool.query(createUniqueIndexSql);
  } catch (err) {
    handleConcurrentDdlError(err);
  }
}

/**
 * Upsert a Response for a (qig_id, candidate_id).
 *
 * Supports both positional and object-style invocation to stay
 * backwards compatible with any existing callers:
 *
 *   upsertResponse(qigId, candidateId, scriptUrl, manifest, state)
 *   upsertResponse({ qigId, candidateId, scriptUrl, manifest, state })
 */
async function upsertResponse(
  qigIdOrOpts,
  candidateId,
  scriptUrl,
  manifest,
  state,
) {
  const opts =
    qigIdOrOpts && typeof qigIdOrOpts === 'object'
      ? qigIdOrOpts
      : {
          qigId: qigIdOrOpts,
          candidateId,
          scriptUrl,
          manifest,
          state,
        };

  const {
    qigId,
    candidateId: candidate,
    scriptUrl: url,
    manifest: manifestJson,
    state: responseState,
  } = opts;

  if (qigId == null) {
    throw new Error('upsertResponse: qigId is required');
  }
  if (!candidate) {
    throw new Error('upsertResponse: candidateId is required');
  }

  await ensureIngestionTables();

  const sql = `
    INSERT INTO ${RESPONSES_TABLE_NAME} (
      qig_id,
      candidate_id,
      script_url,
      manifest,
      state
    )
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (qig_id, candidate_id)
    DO UPDATE SET
      script_url = EXCLUDED.script_url,
      manifest   = EXCLUDED.manifest,
      state      = EXCLUDED.state
    RETURNING *;
  `;

  const params = [
    qigId,
    candidate,
    url || null,
    manifestJson || null,
    responseState || null,
  ];

  const { rows } = await pool.query(sql, params);
  return rows[0];
}

/**
 * Fetch a single Response by (qig_id, candidate_id).
 */
async function getResponseByQigAndCandidate(qigId, candidateId) {
  await ensureIngestionTables();

  const sql = `
    SELECT *
    FROM ${RESPONSES_TABLE_NAME}
    WHERE qig_id = $1
      AND candidate_id = $2
    LIMIT 1;
  `;

  const { rows } = await pool.query(sql, [qigId, candidateId]);
  return rows[0] || null;
}

/**
 * Fetch all Responses for a given qig_id.
 */
async function getResponsesForQig(qigId) {
  await ensureIngestionTables();

  const sql = `
    SELECT *
    FROM ${RESPONSES_TABLE_NAME}
    WHERE qig_id = $1
    ORDER BY id ASC;
  `;

  const { rows } = await pool.query(sql, [qigId]);
  return rows;
}

module.exports = {
  RESPONSES_TABLE_NAME,
  ensureIngestionTables,
  upsertResponse,
  getResponseByQigAndCandidate,
  getResponsesForQig,
};
