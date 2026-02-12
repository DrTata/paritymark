const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'paritymark',
  password: process.env.DB_PASSWORD || 'paritymark',
  database: process.env.DB_NAME || 'paritymark',
});

let poolEnded = false;

/**
 * Perform a simple DB query to verify connectivity.
 * Returns true if the DB responds as expected.
 */
async function checkDbHealth() {
  const result = await pool.query('SELECT 1 AS ok');
  const row = result.rows[0];
  return row && Number(row.ok) === 1;
}

/**
 * Cleanly close the shared pool. Safe to call multiple times.
 */
async function endPool() {
  if (poolEnded) {
    return;
  }
  poolEnded = true;
  await pool.end();
}

module.exports = { pool, checkDbHealth, endPool };
