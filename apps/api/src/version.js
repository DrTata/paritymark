const pkg = require('../package.json');
const { writeAuditEvent, HELLO_AUDIT_EVENT_TYPE } = require('./audit');

function getVersionMeta() {
  return {
    service: 'api',
    name: pkg.name || 'api',
    version: pkg.version || '0.0.0',
    env: process.env.NODE_ENV || 'development',
  };
}

function versionHandler(_req, res) {
  const meta = getVersionMeta();

  // Fire-and-forget "hello" audit event when enabled.
  if (process.env.ENABLE_HELLO_AUDIT === 'true') {
    writeAuditEvent(HELLO_AUDIT_EVENT_TYPE, { meta }).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Failed to write audit event', err);
    });
  }

  const body = JSON.stringify(meta);

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(body);
}

module.exports = { versionHandler, getVersionMeta };
