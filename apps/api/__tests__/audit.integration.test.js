const http = require('http');
const { createServer } = require('../src/server');
const { endPool } = require('../src/db');
const {
  HELLO_AUDIT_EVENT_TYPE,
  getLatestAuditEventByType,
} = require('../src/audit');

jest.setTimeout(30000); // allow time for DB + request

describe('HELLO_AUDIT_EVENT via /version', () => {
  let server;
  let port;

  beforeAll((done) => {
    // We do not need DB-backed /health here
    process.env.API_USE_DB_HEALTH = 'false';
    process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
    process.env.DB_PORT = process.env.DB_PORT || '5432';
    process.env.DB_USER = process.env.DB_USER || 'paritymark';
    process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'paritymark';
    process.env.DB_NAME = process.env.DB_NAME || 'paritymark';

    // Enable hello audit emission on /version
    process.env.ENABLE_HELLO_AUDIT = 'true';

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
    await endPool();
  });

  test('writes a hello audit event when /version is called', (done) => {
    http
      .get(`http://127.0.0.1:${port}/version`, (res) => {
        expect(res.statusCode).toBe(200);

        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', async () => {
          try {
            const parsed = JSON.parse(data);
            expect(parsed).toHaveProperty('version');

            const event = await getLatestAuditEventByType(HELLO_AUDIT_EVENT_TYPE);

            expect(event).not.toBeNull();
            expect(event.event_type).toBe(HELLO_AUDIT_EVENT_TYPE);
            expect(event.payload).toBeDefined();
            expect(event.payload.meta).toBeDefined();
            expect(event.payload.meta.version).toBe(parsed.version);

            done();
          } catch (err) {
            done(err);
          }
        });
      })
      .on('error', (err) => {
        done(err);
      });
  });
});
