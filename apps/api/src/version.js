const pkg = require('../package.json');

function getVersionMeta() {
  return {
    service: 'api',
    name: pkg.name || 'api',
    version: pkg.version || '0.0.0',
    env: process.env.NODE_ENV || 'development',
  };
}

function versionHandler(_req, res) {
  const body = JSON.stringify(getVersionMeta());

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(body);
}

module.exports = { versionHandler, getVersionMeta };
