const pkg = require('../package.json');
const {
  HELLO_AUDIT_EVENT_TYPE,
  writeAuditEvent,
} = require('./audit');

/**
 * Compute version metadata for the API service.
 *
 * This is used by both the /version HTTP handler and tests.
 */
function getVersionMeta() {
  return {
    service: 'api',
    name: pkg.name || 'api',
    version: pkg.version,
    env: process.env.NODE_ENV || 'development',
  };
}

/**
 * HTTP handler for GET /version.
 *
 * Responds with version metadata derived from package.json and environment.
 * When ENABLE_HELLO_AUDIT === 'true', also writes a HELLO_AUDIT_EVENT
 * audit row so integration tests and the /audit/hello/latest endpoint
 * can assert on it.
 */
async function versionHandler(req, res) {
  const body = getVersionMeta();

  const enableHelloAudit =
    process.env.ENABLE_HELLO_AUDIT === 'true';

  if (enableHelloAudit) {
    try {
      await writeAuditEvent(HELLO_AUDIT_EVENT_TYPE, {
        meta: {
          version: body.version,
          service: body.service,
          name: body.name,
          env: body.env,
          path: req && req.url,
          method: req && req.method,
        },
      });
    } catch (err) {
      // Best-effort: log, but never fail /version.
      // eslint-disable-next-line no-console
      console.error('Failed to write HELLO_AUDIT_EVENT', {
        error: err,
        path: req && req.url,
        method: req && req.method,
      });
    }
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

module.exports = { versionHandler, getVersionMeta };
