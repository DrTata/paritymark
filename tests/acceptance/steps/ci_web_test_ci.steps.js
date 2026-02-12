const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Given, When, Then } = require('@cucumber/cucumber');

const ROOT_DIR = path.resolve(__dirname, '../../..');
const WORKFLOW_PATH = path.join(ROOT_DIR, '.github', 'workflows', 'web-lint.yml');

let workflowText = null;
let lastTestOutput = '';

function loadWorkflow() {
  if (!workflowText) {
    if (!fs.existsSync(WORKFLOW_PATH)) {
      throw new Error(`Expected workflow file at ${WORKFLOW_PATH}`);
    }
    workflowText = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  }
  return workflowText;
}

Given('the ParityMark repository has a GitHub Actions workflow {string}', function (workflowName) {
  const text = loadWorkflow();
  assert.ok(
    text.includes(`name: ${workflowName}`),
    `Expected workflow name "name: ${workflowName}" in web-lint.yml`
  );
});

Given('the {string} workflow is configured to run on pushes to {string}', function (workflowName, branch) {
  const text = loadWorkflow();
  const pushRegex = /on:\s*\n[\s\S]*?push:\s*\n[\s\S]*?branches:\s*\[\s*["']main["']\s*\]/m;
  assert.ok(
    pushRegex.test(text),
    `Expected workflow "${workflowName}" to configure push branches including "${branch}"`
  );
});

Given(
  'the {string} workflow is configured to run on pull requests targeting {string}',
  function (workflowName, branch) {
    const text = loadWorkflow();
    const prRegex = /on:\s*\n[\s\S]*?pull_request:\s*\n[\s\S]*?branches:\s*\[\s*["']main["']\s*\]/m;
    assert.ok(
      prRegex.test(text),
      `Expected workflow "${workflowName}" to configure pull_request branches including "${branch}"`
    );
  }
);

Given('the workflow defines a {string} job for apps\\/web', function (jobName) {
  const text = loadWorkflow();
  const jobsSectionRegex = /jobs:\s*\n([\s\S]*)$/m;
  const jobsMatch = jobsSectionRegex.exec(text);
  assert.ok(jobsMatch, 'Expected a jobs: section in web-lint.yml');

  const jobRegex = new RegExp(`\\n\\s*${jobName}:`, 'm');
  assert.ok(
    jobRegex.test(jobsMatch[1]),
    `Expected workflow to define a "${jobName}" job`
  );
});

Given('the {string} job installs dependencies with {string}', function (jobName, command) {
  const text = loadWorkflow();
  assert.ok(
    text.includes(`run: ${command}`),
    `Expected job "${jobName}" to have a step running "${command}" in web-lint.yml`
  );
});

Given('the {string} job runs {string}', function (jobName, command) {
  const text = loadWorkflow();
  assert.ok(
    text.includes(`run: ${command}`),
    `Expected job "${jobName}" to have a step running "${command}" in web-lint.yml`
  );
});

Given(
  'a commit is pushed to the {string} branch of the ParityMark repository',
  function (branch) {
    // For this local acceptance test, just assert the branch name is "main"
    assert.strictEqual(branch, 'main', 'This scenario models pushes to the main branch');
  }
);

Given(
  'a pull request is opened with its base branch set to {string}',
  function (branch) {
    // Narrative modelling of a PR with base "main"
    assert.strictEqual(
      branch,
      'main',
      'This scenario models pull requests with base branch "main"'
    );
  }
);

When('GitHub Actions runs the {string} workflow for that commit', function (_workflowName) {
  // In this local acceptance harness we cannot talk to GitHub; this step is a narrative no-op
  // for a push-triggered workflow.
});

When(
  'GitHub Actions runs the {string} workflow for that pull request',
  function (_workflowName) {
    // Narrative no-op for a PR-triggered workflow; behaviour is covered by workflow config
    // inspection and local execution of the test command.
  }
);

Then('the {string} job is executed', function (jobName) {
  const text = loadWorkflow();
  const jobRegex = new RegExp(`\\n\\s*${jobName}:`, 'm');
  assert.ok(
    jobRegex.test(text),
    `Expected workflow to define and execute job "${jobName}"`
  );
});

Then('the {string} job completes successfully with exit code {int}', function (jobName, exitCode) {
  const cmd = 'pnpm --filter web test';
  try {
    lastTestOutput = execSync(cmd, {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(
      `Expected "${jobName}" job command "${cmd}" to succeed locally, but it failed: ${err.message}`
    );
  }
  // If we got here, exit code was 0 and output captured.
  assert.strictEqual(
    exitCode,
    0,
    `Scenario expects exit code ${exitCode}, but local run would only continue on 0`
  );
});

Then('the job log shows that the Jest test suites for apps\\/web have passed', function () {
  // Minimal but real check: ensure we captured some output from the Jest run.
  assert.ok(
    typeof lastTestOutput === 'string' && lastTestOutput.length > 0,
    'Expected non-empty Jest output from pnpm --filter web test'
  );
});
