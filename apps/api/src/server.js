const http = require('http');
const { healthHandler } = require('./health');
const { checkDbHealth } = require('./db');
const { versionHandler } = require('./version');

function createServer() {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/version') {
      return versionHandler(req, res);
    }

    if (req.method === 'GET' && req.url === '/health') {
      const useDb = process.env.API_USE_DB_HEALTH === 'true';

      if (!useDb) {
        return healthHandler(req, res);
      }

      // DB-backed health path
      checkDbHealth()
        .then((ok) => {
          if (ok) {
            healthHandler(req, res, { db: 'up' });
          } else {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ status: 'error', db: 'down' }));
          }
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error('DB health check failed', err);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ status: 'error', db: 'down' }));
        });

      return;
    }

    res.statusCode = 404;
    res.end();
  });
}

if (require.main === module) {
  const port = process.env.PORT || 4000;
  const server = createServer();
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`API server listening on http://localhost:${port}`);
  });
}

module.exports = { createServer, healthHandler };
