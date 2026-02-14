const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '../..');
const API_PORT = 4000;
const PID_FILE = path.resolve(__dirname, '.api-server-pid');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpGetJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: API_PORT,
        path: pathname,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = body ? JSON.parse(body) : null;
          } catch (_err) {
            // leave json = null for callers to inspect body
          }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body,
            json,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function waitForApiHealthUp(timeoutMs = 30000) {
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
        `API health not ready yet: status=${res.statusCode}, body=${res.body}`,
      );
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

module.exports = async () => {
  // Ensure DB env vars are set for seeding and API
  process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
  process.env.DB_PORT = process.env.DB_PORT || '5432';
  process.env.DB_USER = process.env.DB_USER || 'paritymark';
  process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'paritymark';
  process.env.DB_NAME = process.env.DB_NAME || 'paritymark';

  // Start API server on port 4000
  const apiProcess = spawn(process.execPath, ['apps/api/src/server.js'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      API_USE_DB_HEALTH: 'true',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  fs.writeFileSync(PID_FILE, String(apiProcess.pid), 'utf8');

  // Give it a moment and then poll /health until DB is up
  await sleep(1000);
  await waitForApiHealthUp();

  // Seed DB for the smoke tests
  const {
    clearAllData,
    seedAssessmentTreeForDeployment,
    seedAssessmentViewerIdentity,
    seedConfigActiveForLocale,
  } = require('./seed.cjs');

  await clearAllData();
  await seedAssessmentTreeForDeployment('D_ASSESS_HTTP');
  await seedAssessmentViewerIdentity();
  await seedConfigActiveForLocale('en-GB');
};
