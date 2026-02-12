const http = require('http');
const { createServer } = require('../src/server');
const { pool } = require('../src/db');

jest.setTimeout(30000); // allow time for DB + request

describe('GET /health (DB-backed)', () => {
  let server;
  let port;

  beforeAll((done) => {
    // Ensure we use the DB-backed health path
    process.env.API_USE_DB_HEALTH = 'true';
    process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
    process.env.DB_PORT = process.env.DB_PORT || '5432';
    process.env.DB_USER = process.env.DB_USER || 'paritymark';
    process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'paritymark';
    process.env.DB_NAME = process.env.DB_NAME || 'paritymark';

    server = createServer();
    server.listen(0, () => {
      port = server.address().port;
      done();
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    // Close DB pool so Jest can exit cleanly
    await pool.end();
  });

  test('returns 200 and indicates db is up when Postgres is reachable', (done) => {
    http
      .get(`http://127.0.0.1:${port}/health`, (res) => {
        expect(res.statusCode).toBe(200);

        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          const parsed = JSON.parse(data);
          expect(parsed).toEqual({ status: 'ok', db: 'up' });
          done();
        });
      })
      .on('error', (err) => {
        done(err);
      });
  });
});
