const { createServer } = require('./server');
const { checkDbHealth } = require('./db');

const PORT = process.env.PORT || 4000;

async function main() {
  try {
    // Optional sanity check on startup
    await checkDbHealth();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Database health check failed on startup', { error: err });
    // Do not exit for local dev; we log and continue.
  }

  const server = createServer();

  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`API server listening on port ${PORT}`);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
};
