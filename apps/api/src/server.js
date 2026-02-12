const http = require('http');
const { healthHandler } = require('./health');

function createServer() {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      return healthHandler(req, res);
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
