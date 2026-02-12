const assert = require('assert');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { Given, When, Then, After, setDefaultTimeout } = require('@cucumber/cucumber');

setDefaultTimeout(90 * 1000);

const ROOT_DIR = path.resolve(__dirname, '../../..');
const API_PORT = 4200;

let apiProcess = null;
let lastVersionMeta = null;
let lastAuditEvent = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpGetJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${API_PORT}${pathname}`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = body ? JSON.parse(body) : null;
        } catch (err) {
          return reject(
            new Error(
              `Failed to parse JSON from ${pathname}: ${err.message}. Body was: ${body}`,
            ),
          );
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
          json,
        });
      });
    });
    req.on('error', reject);
  });
}

async function waitForDbHealthUp(timeoutMs = 30000) {
  const start = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await httpGetJson('/health');
      if (
        res.statusCode === 200 &&
        res.json &&
        res.json.status === 'ok' &&
        res.json.db === 'up'
      ) {
        return;
      }
      throw new Error(
        `DB health not up yet: status=${res.statusCode}, body=${res.body}`,
      );
    } catch (err) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Timed out waiting for API DB health endpoint to be ready: ${err.message}`,
        );
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(500);
    }
  }
}

Given(
  'the API server is running with hello audit enabled and a reachable Postgres database',
  async function () {
    if (apiProcess && !apiProcess.killed) {
      // Assume it is already running and healthy
      return;
    }

    apiProcess = spawn(process.execPath, ['apps/api/src/server.js'], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        PORT: String(API_PORT),
        API_USE_DB_HEALTH: 'true',
        DB_HOST: process.env.DB_HOST || '127.0.0.1',
        DB_PORT: process.env.DB_PORT || '5432',
        DB_USER: process.env.DB_USER || 'paritymark',
        DB_PASSWORD: process.env.DB_PASSWORD || 'paritymark',
        DB_NAME: process.env.DB_NAME || 'paritymark',
        ENABLE_HELLO_AUDIT: 'true',
        ENABLE_HELLO_AUDIT_ENDPOINT: 'true',
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Give the process a brief moment to start before health polling
    await sleep(1000);
    await waitForDbHealthUp();
  },
);

When(
  'I request the API version and latest hello audit event',
  async function () {
    // First call /version to emit a HELLO_AUDIT_EVENT
    const versionRes = await httpGetJson('/version');
    assert.strictEqual(
      versionRes.statusCode,
      200,
      `Expected /version status 200, got ${versionRes.statusCode}`,
    );
    assert.ok(
      versionRes.json && typeof versionRes.json === 'object',
      `Expected JSON object from /version, got: ${versionRes.body}`,
    );
    lastVersionMeta = versionRes.json;

    // Then poll /audit/hello/latest until an event is available
    const timeoutMs = 30000;
    const start = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const auditRes = await httpGetJson('/audit/hello/latest');

      if (auditRes.statusCode === 200 && auditRes.json && auditRes.json.event) {
        lastAuditEvent = auditRes.json.event;
        return;
      }

      if (auditRes.statusCode !== 404) {
        throw new Error(
          `/audit/hello/latest returned unexpected status ${auditRes.statusCode}: ${auditRes.body}`,
        );
      }

      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Timed out waiting for hello audit event, last response: ${auditRes.body}`,
        );
      }

      // eslint-disable-next-line no-await-in-loop
      await sleep(500);
    }
  },
);

Then(
  'the hello audit endpoint returns an event whose payload meta version matches the version endpoint',
  function () {
    assert.ok(
      lastVersionMeta,
      'Expected version metadata to have been recorded from /version',
    );
    assert.ok(
      lastAuditEvent,
      'Expected a hello audit event to have been recorded from /audit/hello/latest',
    );

    assert.strictEqual(
      lastAuditEvent.event_type,
      'HELLO_AUDIT_EVENT',
      `Expected event_type HELLO_AUDIT_EVENT, got ${lastAuditEvent.event_type}`,
    );

    assert.ok(
      lastAuditEvent.payload &&
        lastAuditEvent.payload.meta &&
        typeof lastAuditEvent.payload.meta === 'object',
      `Expected audit event payload.meta to be an object, got: ${JSON.stringify(
        lastAuditEvent.payload,
      )}`,
    );

    const eventVersion =
      lastAuditEvent.payload.meta && lastAuditEvent.payload.meta.version;
    assert.ok(
      typeof eventVersion === 'string' && eventVersion.length > 0,
      `Expected payload.meta.version to be a non-empty string, got: ${eventVersion}`,
    );

    assert.strictEqual(
      eventVersion,
      lastVersionMeta.version,
      `Expected payload.meta.version (${eventVersion}) to match version endpoint version (${lastVersionMeta.version})`,
    );
  },
);

After(async function () {
  if (apiProcess && !apiProcess.killed) {
    apiProcess.kill('SIGINT');
    const timeoutMs = 5000;
    const start = Date.now();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        process.kill(apiProcess.pid, 0);
        if (Date.now() - start > timeoutMs) {
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(100);
      } catch (_err) {
        break; // process is gone
      }
    }
  }
  apiProcess = null;
  lastVersionMeta = null;
  lastAuditEvent = null;
});
