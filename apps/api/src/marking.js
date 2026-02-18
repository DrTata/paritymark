const { pool } = require('./db');
const {
  RESPONSES_TABLE_NAME,
  ensureIngestionTables,
} = require('./ingestion');
const {
  ensureAssessmentTables,
  ASSESSMENT_QIGS_TABLE_NAME,
  ASSESSMENT_PAPERS_TABLE_NAME,
  ASSESSMENT_SERIES_TABLE_NAME,
} = require('./assessment');
const {
  ensureConfigTables,
  DEPLOYMENTS_TABLE_NAME,
} = require('./config');
const {
  ensureIdentityTables,
  USERS_TABLE_NAME,
} = require('./identity');
const {
  ensureAuditTable,
  AUDIT_TABLE_NAME,
} = require('./audit');

const RESPONSE_MARKS_TABLE_NAME = 'response_marks';

const MARKING_DRAFT_SAVED_EVENT_TYPE = 'MARKING_DRAFT_SAVED';
const MARKING_SUBMITTED_EVENT_TYPE = 'MARKING_SUBMITTED';
const MARKING_LOCKED_EVENT_TYPE = 'MARKING_LOCKED';

/**
 * Handle known-benign concurrency errors for CREATE TABLE IF NOT EXISTS,
 * mirroring the config/audit/identity/ingestion modules' behaviour.
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
 * Ensure all marking-related tables exist.
 */
async function ensureMarkingTables() {
  await ensureIngestionTables();
  await ensureAssessmentTables();
  await ensureConfigTables();
  await ensureIdentityTables();
  await ensureAuditTable();

  const createResponseMarksSql = `
    CREATE TABLE IF NOT EXISTS ${RESPONSE_MARKS_TABLE_NAME} (
      id SERIAL PRIMARY KEY,
      response_id INTEGER NOT NULL REFERENCES ${RESPONSES_TABLE_NAME}(id) ON DELETE CASCADE,
      marker_user_id INTEGER NOT NULL REFERENCES ${USERS_TABLE_NAME}(id) ON DELETE CASCADE,
      state TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (response_id, marker_user_id)
    )
  `;

  try {
    await pool.query(createResponseMarksSql);
  } catch (err) {
    handleConcurrentDdlError(err);
  }
}

/**
 * Helper: build meta information for a Response for audit events.
 */
async function buildMarkingMetaForResponse(responseId) {
  await ensureAssessmentTables();
  await ensureConfigTables();
  await ensureIngestionTables();

  const sql = `
    SELECT
      r.id AS response_id,
      r.qig_id,
      q.code AS qig_code,
      p.id AS paper_id,
      s.id AS series_id,
      d.id AS deployment_id,
      d.code AS deployment_code
    FROM ${RESPONSES_TABLE_NAME} r
    JOIN ${ASSESSMENT_QIGS_TABLE_NAME} q
      ON r.qig_id = q.id
    JOIN ${ASSESSMENT_PAPERS_TABLE_NAME} p
      ON q.paper_id = p.id
    JOIN ${ASSESSMENT_SERIES_TABLE_NAME} s
      ON p.series_id = s.id
    JOIN ${DEPLOYMENTS_TABLE_NAME} d
      ON s.deployment_id = d.id
    WHERE r.id = $1
  `;

  const res = await pool.query(sql, [responseId]);
  if (!res.rows || res.rows.length === 0) {
    return null;
  }

  const row = res.rows[0];
  return {
    deploymentId: row.deployment_id,
    deploymentCode: row.deployment_code,
    qigId: row.qig_id,
    qigCode: row.qig_code,
    responseId: row.response_id,
  };
}

/**
 * Helper: fetch actor details for audit from users table.
 */
async function getActorForUserId(userId) {
  await ensureIdentityTables();

  const res = await pool.query(
    `SELECT id, external_id, display_name FROM ${USERS_TABLE_NAME} WHERE id = $1`,
    [userId],
  );
  if (!res.rows || res.rows.length === 0) {
    return null;
  }
  return res.rows[0];
}

/**
 * Insert a marking-related audit event.
 */
async function insertMarkingAuditEvent(eventType, responseId, markerUserId, operation) {
  await ensureAuditTable();

  const metaBase = await buildMarkingMetaForResponse(responseId);
  const actorBase = await getActorForUserId(markerUserId);

  const meta = {
    ...(metaBase || {}),
    operation,
    path: metaBase
      ? `/marking/responses/${metaBase.responseId}`
      : `/marking/responses/${responseId}`,
    method: 'INTERNAL',
  };

  const actor = actorBase
    ? {
        id: actorBase.id,
        externalId: actorBase.external_id,
        displayName: actorBase.display_name,
      }
    : {
        id: markerUserId,
      };

  const payload = { meta, actor };

  const insertSql = `
    INSERT INTO ${AUDIT_TABLE_NAME} (event_type, payload)
    VALUES ($1, $2::jsonb)
    RETURNING id, event_type, payload, created_at
  `;

  const res = await pool.query(insertSql, [eventType, payload]);
  return res.rows[0];
}

/**
 * Check whether a Response is locked.
 */
async function isResponseLocked(responseId) {
  await ensureIngestionTables();

  const res = await pool.query(
    `SELECT state FROM ${RESPONSES_TABLE_NAME} WHERE id = $1`,
    [responseId],
  );
  if (!res.rows || res.rows.length === 0) {
    return false;
  }
  const state = res.rows[0].state;
  return state === 'LOCKED';
}

/**
 * Lock a Response row by id.
 */
async function lockResponse(responseId) {
  await ensureIngestionTables();

  const res = await pool.query(
    `
      UPDATE ${RESPONSES_TABLE_NAME}
      SET state = 'LOCKED'
      WHERE id = $1
      RETURNING id, qig_id, candidate_id, script_url, manifest, state, created_at, archived_at
    `,
    [responseId],
  );

  if (!res.rows || res.rows.length === 0) {
    return null;
  }
  return res.rows[0];
}

/**
 * Save a draft mark for (response, marker). Overwrites existing draft/submission,
 * but enforces that locked Responses cannot be changed.
 */
async function saveDraftMark(responseId, markerUserId, payload) {
  await ensureMarkingTables();

  if (await isResponseLocked(responseId)) {
    const err = new Error('Response is locked');
    err.code = 'LOCKED';
    throw err;
  }

  const sql = `
    INSERT INTO ${RESPONSE_MARKS_TABLE_NAME} (response_id, marker_user_id, state, payload)
    VALUES ($1, $2, 'DRAFT', $3::jsonb)
    ON CONFLICT (response_id, marker_user_id)
    DO UPDATE SET
      state = 'DRAFT',
      payload = EXCLUDED.payload,
      updated_at = NOW()
    RETURNING id, response_id, marker_user_id, state, payload, created_at, updated_at
  `;

  const res = await pool.query(sql, [responseId, markerUserId, JSON.stringify(payload)]);
  const row = res.rows[0];

  await insertMarkingAuditEvent(
    MARKING_DRAFT_SAVED_EVENT_TYPE,
    responseId,
    markerUserId,
    'DRAFT_SAVED',
  );

  return row;
}

/**
 * Submit marks for (response, marker), lock the Response, and create audit events.
 */
async function submitMark(responseId, markerUserId, payload) {
  await ensureMarkingTables();

  if (await isResponseLocked(responseId)) {
    const err = new Error('Response is locked');
    err.code = 'LOCKED';
    throw err;
  }

  const sql = `
    INSERT INTO ${RESPONSE_MARKS_TABLE_NAME} (response_id, marker_user_id, state, payload)
    VALUES ($1, $2, 'SUBMITTED', $3::jsonb)
    ON CONFLICT (response_id, marker_user_id)
    DO UPDATE SET
      state = 'SUBMITTED',
      payload = EXCLUDED.payload,
      updated_at = NOW()
    RETURNING id, response_id, marker_user_id, state, payload, created_at, updated_at
  `;

  const res = await pool.query(sql, [responseId, markerUserId, JSON.stringify(payload)]);
  const row = res.rows[0];

  // Lock the underlying Response
  await lockResponse(responseId);

  // Audit events for submission + lock
  await insertMarkingAuditEvent(
    MARKING_SUBMITTED_EVENT_TYPE,
    responseId,
    markerUserId,
    'SUBMITTED',
  );
  await insertMarkingAuditEvent(
    MARKING_LOCKED_EVENT_TYPE,
    responseId,
    markerUserId,
    'LOCKED',
  );

  return row;
}

/**
 * Fetch mark record for (response, marker), or null if none.
 */
async function getMarkForResponse(responseId, markerUserId) {
  await ensureMarkingTables();

  const res = await pool.query(
    `
      SELECT id, response_id, marker_user_id, state, payload, created_at, updated_at
      FROM ${RESPONSE_MARKS_TABLE_NAME}
      WHERE response_id = $1 AND marker_user_id = $2
    `,
    [responseId, markerUserId],
  );

  if (!res.rows || res.rows.length === 0) {
    return null;
  }
  return res.rows[0];
}

module.exports = {
  RESPONSE_MARKS_TABLE_NAME,
  MARKING_DRAFT_SAVED_EVENT_TYPE,
  MARKING_SUBMITTED_EVENT_TYPE,
  MARKING_LOCKED_EVENT_TYPE,
  ensureMarkingTables,
  saveDraftMark,
  submitMark,
  getMarkForResponse,
  isResponseLocked,
  lockResponse,
};
