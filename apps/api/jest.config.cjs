/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__', '<rootDir>/src'],
  // Ensure the Jest process exits cleanly after DB-backed integration tests,
  // avoiding "Jest did not exit one second after the test run has completed" warnings.
  forceExit: true,
};
