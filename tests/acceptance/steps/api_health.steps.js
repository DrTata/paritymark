const assert = require('assert');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { Given, When, Then, After, setDefaultTimeout } = require('@cucumber/cucumber');

setDefaultTimeout(60 * 1000);

const ROOT_DIR = path.resolve(__dirname, '../../..');
const API_PORT = 4100;

let apiProcess = null;
let lastResponse = null;
let lastBody = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealthOk(timeoutMs = 30000) {
  const start = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${API_PORT}/health`, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            try {
              const json = JSON.parse(body);
              if (res.statusCode === 200 && json && json.status === 'ok') {
                resolve();
              } else {
                reject(
                  new Error(
                    `Health not OK yet: status=${res.statusCode}, body=${body}`,
                  ),
                );
              }
            } catch (e) {
              reject(e);
            }
          });
        });
        req.on('error', reject);
      });
      // If we reach here, health is OK
      break;
    } catch (err) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Timed out waiting for API health endpoint to be ready: ${err.message}`,
        );
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(500);
    }
  }
}

async function waitForDbHealthUp(timeoutMs = 30000) {
  const start = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${API_PORT}/health`, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            try {
              const json = JSON.parse(body);
              if (
                res.statusCode === 200 &&
                json &&
                json.status === 'ok' &&
                json.db === 'up'
              ) {
                resolve();
              } else {
                reject(
                  new Error(
                    `DB health not up yet: status=${res.statusCode}, body=${body}`,
                  ),
                );
              }
            } catch (e) {
              reject(e);
            }
          });
        });
        req.on('error', reject);
      });
      // If we reach here, DB health is up
      break;
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

Given('the API server is running in non-DB health mode', async function () {
  if (apiProcess && !apiProcess.killed) {
    // Assume it is already running and healthy
    return;
  }

  apiProcess = spawn(process.execPath, ['apps/api/src/server.js'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      // Explicitly ensure we are in non-DB health mode
      API_USE_DB_HEALTH: 'false',
      // Ensure version endpoint reports a deterministic env
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Give the process a brief moment to start before health polling
  await sleep(1000);

  await waitForHealthOk();
});

Given(
  'the API server is running in DB-backed health mode with a reachable Postgres database',
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
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Give the process a brief moment to start before health polling
    await sleep(1000);

    await waitForDbHealthUp();
  },
);

When('I GET {string} from the API server', async function (pathName) {
  lastResponse = null;
  lastBody = null;

  await new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${API_PORT}${pathName}`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        lastBody = Buffer.concat(chunks).toString('utf8');
        lastResponse = {
          statusCode: res.statusCode,
          headers: res.headers,
        };
        resolve();
      });
    });
    req.on('error', reject);
  });
});

Then('the response status code is {int}', function (expectedStatus) {
  assert.ok(lastResponse, 'Expected a response to have been recorded');
  assert.strictEqual(
    lastResponse.statusCode,
    expectedStatus,
    `Expected status ${expectedStatus}, got ${lastResponse.statusCode}`,
  );
});

Then(
  'the JSON response body has property {string} equal to {string}',
  function (propName, expectedValue) {
    assert.ok(
      typeof lastBody === 'string',
      'Expected a string response body to be recorded',
    );

    let parsed;
    try {
      parsed = JSON.parse(lastBody);
    } catch (err) {
      throw new Error(
        `Expected JSON response body, but parsing failed: ${err.message}. Body was: ${lastBody}`,
      );
    }

    assert.ok(
      Object.prototype.hasOwnProperty.call(parsed, propName),
      `Expected JSON body to have property "${propName}", got: ${JSON.stringify(
        parsed,
      )}`,
    );

    assert.strictEqual(
      String(parsed[propName]),
      expectedValue,
      `Expected JSON body property "${propName}" to equal "${expectedValue}", got "${parsed[propName]}"`,
    );
  },
);

Then(
  'the JSON response body has property {string} which is a non-empty string',
  function (propName) {
    assert.ok(
      typeof lastBody === 'string',
      'Expected a string response body to be recorded',
    );

    let parsed;
    try {
      parsed = JSON.parse(lastBody);
    } catch (err) {
      throw new Error(
        `Expected JSON response body, but parsing failed: ${err.message}. Body was: ${lastBody}`,
      );
    }

    assert.ok(
      Object.prototype.hasOwnProperty.call(parsed, propName),
      `Expected JSON body to have property "${propName}", got: ${JSON.stringify(
        parsed,
      )}`,
    );

    const value = parsed[propName];
    assert.strictEqual(
      typeof value,
      'string',
      `Expected JSON body property "${propName}" to be a string, got ${typeof value}`,
    );
    assert.ok(
      value.length > 0,
      `Expected JSON body property "${propName}" to be a non-empty string, got "${value}"`,
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
  lastResponse = null;
  lastBody = null;
});
