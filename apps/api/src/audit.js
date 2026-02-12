const { pool } = require('./db');

const HELLO_AUDIT_EVENT_TYPE = 'HELLO_AUDIT_EVENT';
const AUDIT_TABLE_NAME = 'audit_events';

async function ensureAuditTable() {
  const createSql = `
    CREATE TABLE IF NOT EXISTS ${AUDIT_TABLE_NAME} (
      id SERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  try {
    await pool.query(createSql);
  } catch (err) {
    const code = err && err.code;
    const message = (err && err.message) || '';

    // In Postgres, concurrent CREATE TABLE IF NOT EXISTS can still raise:
    // - 42P07: duplicate-table error due to internal catalog constraints.
    // - 23505 + pg_type_typname_nsp_index: rare unique_violation in catalog when
    //   multiple workers create the same table/type at once.
    //
    // For Phase 0, we treat these specific cases as benign and rethrow everything else.

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
}

/**
 * Write an audit event with a JSON-serialisable payload.
 */
async function writeAuditEvent(eventType, payload) {
  await ensureAuditTable();

  const insertSql = `
    INSERT INTO ${AUDIT_TABLE_NAME} (event_type, payload)
    VALUES ($1, $2)
  `;
  await pool.query(insertSql, [eventType, payload]);
}

/**
 * Fetch the most recent audit event for a given type.
 * Returns null if none exist.
 */
async function getLatestAuditEventByType(eventType) {
  await ensureAuditTable();

  const selectSql = `
    SELECT id, event_type, payload, created_at
    FROM ${AUDIT_TABLE_NAME}
    WHERE event_type = $1
    ORDER BY created_at DESC
    LIMIT 1
  `;

  const result = await pool.query(selectSql, [eventType]);
  if (!result.rows || result.rows.length === 0) {
    return null;
  }
  return result.rows[0];
}

module.exports = {
  HELLO_AUDIT_EVENT_TYPE,
  writeAuditEvent,
  getLatestAuditEventByType,
};
