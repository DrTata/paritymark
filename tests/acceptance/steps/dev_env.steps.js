const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');
const { Given, When, Then, After, setDefaultTimeout } = require('@cucumber/cucumber');

setDefaultTimeout(240 * 1000);

const ROOT_DIR = path.resolve(__dirname, '../../..');
const PKG_PATH = path.join(ROOT_DIR, 'package.json');

let devProcess = null;
let devOutput = '';

function readPackageJson() {
  const raw = fs.readFileSync(PKG_PATH, 'utf8');
  return JSON.parse(raw);
}

function findPids(port) {
  try {
    const output = execSync(
      `ss -tulpn | awk '/:${port} / {print $NF}' | sed -E 's/.*pid=([0-9]+),.*/\\1/'`,
      { encoding: 'utf8' }
    );
    return output
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (_err) {
    // ss may return non-zero if nothing matches; treat as "no processes"
    return [];
  }
}

function devOutputHasReadySignal(output) {
  // Treat the dev server as "ready" once logs mention port 3000 in a URL,
  // regardless of whether the host is localhost, 127.0.0.1, etc.
  return (
    /https?:\/\/[0-9A-Za-z\.\-]+:3000/.test(output) ||
    /Next\.js 16\.1\.6/.test(output) ||
    /Ready in/.test(output)
  );
}

Given('the ParityMark repository has a script file {string}', function (scriptRelPath) {
  const full = path.join(ROOT_DIR, scriptRelPath);
  assert.ok(fs.existsSync(full), `Expected script file to exist at ${full}`);
});

Given('the script {string} is executable', function (scriptRelPath) {
  const full = path.join(ROOT_DIR, scriptRelPath);
  fs.accessSync(full, fs.constants.X_OK);
});

Given(
  'the script {string} is wired in the root package.json as the {string} script',
  function (scriptRelPath, scriptName) {
    const pkg = readPackageJson();
    assert.ok(pkg.scripts, 'package.json has no scripts field');
    const expected = `bash ${scriptRelPath}`;
    assert.strictEqual(
      pkg.scripts[scriptName],
      expected,
      `Expected scripts["${scriptName}"] to be "${expected}", got "${pkg.scripts[scriptName]}"`,
    );
  },
);

Given(
  'the {string} script is invoked via {string} at the repository root',
  function (scriptName, invocation) {
    const pkg = readPackageJson();
    assert.strictEqual(
      pkg.scripts[scriptName],
      'bash scripts/dev-web.sh',
      `Expected scripts["${scriptName}"] to invoke dev-web helper`,
    );
    assert.strictEqual(invocation, 'pnpm run dev:web');
  },
);

Given('no process is currently listening on TCP port {int} on the VPS', function (port) {
  // Ensure the precondition by killing any processes we find
  const pids = findPids(port);
  for (const pid of pids) {
    try {
      process.kill(Number(pid));
    } catch (_err) {
      // ignore failures; we'll assert below
    }
  }
  const remaining = findPids(port);
  assert.strictEqual(
    remaining.length,
    0,
    `Expected no process on port ${port}, but found PIDs: ${remaining.join(', ')}`,
  );
});

Given(
  'there is an existing Next.js dev process listening on TCP port {int} on the VPS',
  async function (port) {
    // Simulate a stale dev server by starting a dummy HTTP server in a separate Node process.
    const serverCode = `
      const http = require('http');
      const server = http.createServer((req, res) => { res.end('stale'); });
      server.listen(${port}, () => {});
      // keep process alive
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['-e', serverCode], {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: 'ignore',
    });

    this.staleDevPid = child.pid;

    // Wait until the dummy server responds over HTTP
    const timeoutMs = 5000;
    const start = Date.now();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve, reject) => {
          const req = http.get(`http://localhost:${port}/`, (res) => {
            res.resume();
            res.on('end', resolve);
          });
          req.on('error', reject);
        });
        break;
      } catch (_err) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(
            `Timed out waiting for stale dev process PID ${child.pid} to respond on port ${port}`,
          );
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  },
);

Given(
  'that process would normally prevent a new {string} from acquiring the dev lock',
  function (expectedCommand) {
    // Narrative step: assert that we recorded a stale dev PID
    assert.ok(
      this.staleDevPid,
      'Expected a stale dev process PID to be recorded before starting dev-web helper',
    );
    assert.strictEqual(
      expectedCommand,
      'next dev',
      'Scenario documents that the conflicting command is "next dev"',
    );
  },
);

Given('the directory {string} does not contain a stale lock file', function (dirRelPath) {
  const full = path.join(ROOT_DIR, dirRelPath);
  if (fs.existsSync(full)) {
    fs.rmSync(full, { recursive: true, force: true });
  }
  assert.ok(!fs.existsSync(full), `Expected directory ${full} not to exist after cleanup`);
});

When('I run {string} from the repository root', async function (command) {
  const parts = command.split(' ').filter(Boolean);
  const cmd = parts[0];
  const args = parts.slice(1);

  devOutput = '';
  devProcess = spawn(cmd, args, {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  devProcess.stdout.on('data', (chunk) => {
    devOutput += chunk.toString();
  });
  devProcess.stderr.on('data', (chunk) => {
    devOutput += chunk.toString();
  });

  // Give the process a brief moment to start emitting logs before
  // subsequent steps begin polling devOutput.
  // Readiness is asserted separately.
  // eslint-disable-next-line no-await-in-loop
  await new Promise((resolve) => setTimeout(resolve, 1000));
});

Then(
  'the script logs that it is checking for processes on ports {int} and {int}',
  function (_port1, _port2) {
    assert.ok(
      devOutput.includes('Checking for processes on ports 3000 and 3001'),
      'Expected dev-web helper to log port check message',
    );
  },
);

Then(
  'the script logs that no processes are found on ports {int} and {int}',
  function (_port1, _port2) {
    assert.ok(
      devOutput.includes('No processes found on port 3000.'),
      'Expected message about no processes on port 3000',
    );
    assert.ok(
      devOutput.includes('No processes found on port 3001.'),
      'Expected message about no processes on port 3001',
    );
  },
);

Then(
  'the script logs that it is killing the process or processes on port {int}',
  function (port) {
    assert.ok(
      devOutput.includes(`Killing process(es) on port ${port}:`),
      `Expected dev-web helper to log killing processes on port ${port}`,
    );
  },
);

Then(
  'after the script has run, no process is listening on TCP port {int} or {int}',
  function (port1, port2) {
    assert.ok(
      this.staleDevPid,
      'Expected staleDevPid to be recorded for restart scenario',
    );

    // The stale dev PID should no longer be a live process
    let stillAlive = false;
    try {
      process.kill(this.staleDevPid, 0);
      stillAlive = true;
    } catch (_err) {
      // ESRCH (no such process) is what we want; treat any error as "not alive"
      stillAlive = false;
    }
    assert.ok(
      !stillAlive,
      `Expected stale dev PID ${this.staleDevPid} to be terminated`,
    );

    // Optional extra: ensure no stale PID is bound to these ports according to ss
    const stale = String(this.staleDevPid);
    const pids1 = findPids(port1);
    const pids2 = findPids(port2);
    assert.ok(
      !pids1.includes(stale) && !pids2.includes(stale),
      `Expected no stale dev process listening on ports ${port1} or ${port2}`,
    );
  },
);

Then('the script removes {string} if it exists', function (_dirRelPath) {
  assert.ok(
    devOutput.includes('Removing dev lock directory apps/web/.next/dev (if present)...'),
    'Expected log about removing dev lock directory (if present)',
  );
});

Then('the script removes {string}', function (dirRelPath) {
  assert.ok(
    devOutput.includes('Removing dev lock directory apps/web/.next/dev (if present)...'),
    'Expected log about removing dev lock directory',
  );
  const full = path.join(ROOT_DIR, dirRelPath);
  assert.ok(!fs.existsSync(full), `Expected directory ${full} to be removed by dev-web helper`);
});

Then('the script starts {string}', function (_expectedCommand) {
  assert.ok(
    devOutput.includes('Starting web dev server via Turborepo...'),
    'Expected log about starting web dev server via Turborepo',
  );
});

Then('the Next.js dev server starts successfully on port {int}', async function (_port) {
  const timeoutMs = 240_000;

  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (devOutputHasReadySignal(devOutput)) {
      break;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for Next.js dev server to start on port 3000');
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  assert.ok(
    /https?:\/\/[0-9A-Za-z\.\-]+:3000/.test(devOutput),
    'Expected dev logs to include a URL on port 3000',
  );
});

Then(
  'no {string} error is printed in the dev logs',
  function (errorMessage) {
    assert.ok(
      !devOutput.includes(errorMessage),
      `Expected dev logs not to contain error message: ${errorMessage}`,
    );
  },
);

Then(
  'the dev logs show a GET request to {string} returning HTTP {int}',
  async function (pathName, statusCode) {
    // Ensure we actually hit the dev server, with retries for CI slowness.
    const requestTimeoutMs = 30_000;
    const start = Date.now();
    let lastError;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve, reject) => {
          const req = http.get(`http://localhost:3000${pathName}`, (res) => {
            if (res.statusCode !== statusCode) {
              reject(
                new Error(
                  `Expected HTTP ${statusCode} for ${pathName}, got ${res.statusCode}`,
                ),
              );
            } else {
              res.resume();
              res.on('end', resolve);
            }
          });
          req.on('error', reject);
        });
        // If we get here, the request succeeded with the expected status.
        break;
      } catch (err) {
        lastError = err;
        if (Date.now() - start > requestTimeoutMs) {
          throw lastError;
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    // Wait for the GET / 200 log line to appear
    const logTimeoutMs = 10000;
    const logStart = Date.now();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (
        devOutput.includes(`GET ${pathName} ${statusCode}`) ||
        devOutput.includes(`GET ${pathName} 200 in`)
      ) {
        break;
      }
      if (Date.now() - logStart > logTimeoutMs) {
        throw new Error('Timed out waiting for GET log in dev output');
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  },
);

After(async function () {
  if (devProcess && !devProcess.killed) {
    devProcess.kill('SIGINT');
    const timeoutMs = 5000;
    const start = Date.now();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        process.kill(devProcess.pid, 0);
        if (Date.now() - start > timeoutMs) {
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (_err) {
        break; // process is gone
      }
    }
  }
  devProcess = null;
  devOutput = '';

  if (this.staleDevPid) {
    try {
      process.kill(this.staleDevPid);
    } catch (_err) {
      // ignore; process may already be dead
    }
    this.staleDevPid = undefined;
  }
});

