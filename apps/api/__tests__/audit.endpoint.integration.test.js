const http = require('http');
const { createServer } = require('../src/server');
const { endPool } = require('../src/db');

jest.setTimeout(30000); // allow time for DB + requests

describe('GET /audit/hello/latest (dev-only evidence endpoint)', () => {
  let server;
  let port;

  beforeAll((done) => {
    process.env.API_USE_DB_HEALTH = 'false';
    process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
    process.env.DB_PORT = process.env.DB_PORT || '5432';
    process.env.DB_USER = process.env.DB_USER || 'paritymark';
    process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'paritymark';
    process.env.DB_NAME = process.env.DB_NAME || 'paritymark';

    process.env.ENABLE_HELLO_AUDIT = 'true';
    process.env.ENABLE_HELLO_AUDIT_ENDPOINT = 'true';

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

  test('returns latest HELLO_AUDIT_EVENT after /version is called', (done) => {
    // First call /version to emit a hello audit event
    http
      .get(`http://127.0.0.1:${port}/version`, (res) => {
        expect(res.statusCode).toBe(200);

        let versionData = '';
        res.on('data', (chunk) => {
          versionData += chunk;
        });
        res.on('end', () => {
          let parsed;
          expect(() => {
            parsed = JSON.parse(versionData);
          }).not.toThrow();
          expect(parsed).toHaveProperty('version');

          // Small delay to reduce the chance of racing the INSERT
          setTimeout(() => {
            http
              .get(
                `http://127.0.0.1:${port}/audit/hello/latest`,
                (res2) => {
                  let data = '';
                  res2.on('data', (chunk) => {
                    data += chunk;
                  });
                  res2.on('end', () => {
                    try {
                      expect(res2.statusCode).toBe(200);
                      const body = JSON.parse(data);
                      expect(body.event).toBeDefined();
                      expect(body.event.event_type).toBe(
                        'HELLO_AUDIT_EVENT'
                      );
                      expect(body.event.payload).toBeDefined();
                      expect(body.event.payload.meta).toBeDefined();
                      expect(
                        body.event.payload.meta.version
                      ).toBe(parsed.version);
                      done();
                    } catch (err) {
                      done(err);
                    }
                  });
                }
              )
              .on('error', (err) => {
                done(err);
              });
          }, 50);
        });
      })
      .on('error', (err) => {
        done(err);
      });
  });
});
