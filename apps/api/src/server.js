const http = require('http');
const { healthHandler } = require('./health');
const { checkDbHealth } = require('./db');
const { versionHandler } = require('./version');
const {
  HELLO_AUDIT_EVENT_TYPE,
  getLatestAuditEventByType,
} = require('./audit');
const {
  getActiveConfigForDeploymentCode,
  activateConfigVersionForDeploymentCode,
  getConfigVersionsForDeploymentId,
  getDeploymentByCode,
  createDraftConfigVersionForDeploymentCode,
  upsertConfigArtifact,
  createDeployment,
} = require('./config');
const { enforcePermission, getOrCreateUserForRequest } = require('./authz');
const { getPermissionsForUser } = require('./identity');
const { v4: uuidv4 } = require('uuid'); // To generate a requestId

// Function to log events
function logRequest(req, res, startTime) {
  const duration = Date.now() - startTime;
  const requestId = req.headers['x-request-id'] || uuidv4(); // Generate new requestId if missing
  res.setHeader('X-Request-Id', requestId); // Attach requestId to the response

  // Log basic request and response details
  console.log({
    method: req.method,
    path: req.url,
    status: res.statusCode,
    duration,
    requestId,
  });

  return requestId;
}

// Read and parse a JSON request body.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';

    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1000000) {
        // Prevent excessively large bodies
        reject(new Error('request_body_too_large'));
      }
    });

    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }

      try {
        const parsed = JSON.parse(data);
        resolve(parsed);
      } catch (err) {
        reject(err);
      }
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

function createServer() {
  return http.createServer((req, res) => {
    const startTime = Date.now();
    const requestId = logRequest(req, res, startTime); // Log request and get requestId

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
          // Log DB health error with requestId
          console.error('DB health check failed', { error: err, requestId });
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ status: 'error', db: 'down' }));
        });

      return;
    }

    if (req.method === 'GET' && req.url === '/audit/hello/latest') {
      const enabled =
        process.env.ENABLE_HELLO_AUDIT_ENDPOINT === 'true';

      if (!enabled) {
        res.statusCode = 404;
        res.end();
        return;
      }

      getLatestAuditEventByType(HELLO_AUDIT_EVENT_TYPE)
        .then((event) => {
          res.setHeader('Content-Type', 'application/json');
          if (!event) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'not_found' }));
            return;
          }
          res.statusCode = 200;
          res.end(JSON.stringify({ event }));
        })
        .catch((err) => {
          // Log error with requestId
          console.error('Failed to fetch hello audit event', { error: err, requestId });
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'internal_error' }));
        });

      return;
    }

    if (req.method === 'GET' && req.url === '/identity/me') {
      getOrCreateUserForRequest(req)
        .then((user) => {
          if (!user) {
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'unauthenticated' }));
            return;
          }

          return getPermissionsForUser(user.id).then((permissions) => {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                user: {
                  id: user.id,
                  externalId: user.external_id,
                  displayName: user.display_name,
                },
                permissions,
              }),
            );
          });
        })
        .catch((err) => {
          console.error('Failed to resolve identity for /identity/me', {
            error: err,
            requestId,
          });
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'internal_error' }));
          }
        });

      return;
    }

    // Config-related endpoints
    if (req.url && req.url.startsWith('/config/')) {
      const [path] = req.url.split('?');
      const segments = path.split('/').filter(Boolean); // e.g. ["config", "D1", "active"]

      // GET /config/:deploymentCode/active
      if (
        req.method === 'GET' &&
        segments.length === 3 &&
        segments[0] === 'config' &&
        segments[2] === 'active'
      ) {
        const deploymentCode = decodeURIComponent(segments[1]);
        const permissionKey = 'config.view';

        // Enforce RBAC for viewing active config.
        enforcePermission(req, res, permissionKey)
          .then((allowed) => {
            if (!allowed) {
              // Response already written by enforcePermission (401/403).
              return;
            }

            return getActiveConfigForDeploymentCode(deploymentCode)
              .then((result) => {
                res.setHeader('Content-Type', 'application/json');

                if (result.notFound === 'deployment') {
                  res.statusCode = 404;
                  res.end(JSON.stringify({ error: 'deployment_not_found' }));
                  return;
                }

                if (result.notFound === 'active_config') {
                  res.statusCode = 404;
                  res.end(JSON.stringify({ error: 'active_config_not_found' }));
                  return;
                }

                res.statusCode = 200;
                res.end(
                  JSON.stringify({
                    deployment: result.deployment,
                    configVersion: result.configVersion,
                    artifacts: result.artifacts,
                  }),
                );
              })
              .catch((err) => {
                // Log error with requestId
                console.error('Failed to fetch active config', { error: err, requestId });
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_error' }));
              });
          })
          .catch((err) => {
            console.error('Failed to enforce permission for config endpoint', {
              error: err,
              requestId,
            });
            if (!res.headersSent) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'internal_error' }));
            }
          });

        return;
      }

      // POST /config/:deploymentCode/versions/:versionNumber/activate
      if (
        req.method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'config' &&
        segments[2] === 'versions' &&
        segments[4] === 'activate'
      ) {
        const deploymentCode = decodeURIComponent(segments[1]);
        const versionNumber = parseInt(segments[3], 10);

        if (Number.isNaN(versionNumber)) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'invalid_version_number' }));
          return;
        }

        const permissionKey = 'config.activate';

        enforcePermission(req, res, permissionKey)
          .then((allowed) => {
            if (!allowed) {
              // Response already written (401/403).
              return;
            }

            return activateConfigVersionForDeploymentCode(
              deploymentCode,
              versionNumber,
            )
              .then((result) => {
                res.setHeader('Content-Type', 'application/json');

                if (result.notFound === 'deployment') {
                  res.statusCode = 404;
                  res.end(JSON.stringify({ error: 'deployment_not_found' }));
                  return;
                }

                if (result.notFound === 'config_version') {
                  res.statusCode = 404;
                  res.end(JSON.stringify({ error: 'config_version_not_found' }));
                  return;
                }

                res.statusCode = 200;
                res.end(
                  JSON.stringify({
                    deployment: result.deployment,
                    configVersion: result.configVersion,
                  }),
                );
              })
              .catch((err) => {
                console.error('Failed to activate config version', {
                  error: err,
                  requestId,
                });
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_error' }));
              });
          })
          .catch((err) => {
            console.error(
              'Failed to enforce permission for config activation endpoint',
              {
                error: err,
                requestId,
              },
            );
            if (!res.headersSent) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'internal_error' }));
            }
          });

        return;
      }

      // POST /config/:deploymentCode/drafts  (authoring endpoint)
      if (
        req.method === 'POST' &&
        segments.length === 3 &&
        segments[0] === 'config' &&
        segments[2] === 'drafts'
      ) {
        const deploymentCode = decodeURIComponent(segments[1]);
        // Permission key must match tests: "config.edit"
        const permissionKey = 'config.edit';

        enforcePermission(req, res, permissionKey)
          .then((allowed) => {
            if (!allowed) {
              // Response already written (401/403).
              return;
            }

            // Now parse JSON body and create a draft config version.
            (async () => {
              let parsedBody;
              try {
                parsedBody = await readJsonBody(req);
              } catch (err) {
                console.error(
                  'Failed to parse JSON body for config draft endpoint',
                  { error: err, requestId },
                );

                if (!res.headersSent) {
                  res.statusCode = 400;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({ error: 'invalid_json' }));
                }
                return;
              }

              const artifacts =
                parsedBody &&
                typeof parsedBody === 'object' &&
                parsedBody.artifacts &&
                typeof parsedBody.artifacts === 'object' &&
                parsedBody.artifacts !== null
                  ? parsedBody.artifacts
                  : {};

              let createdBy = null;
              try {
                const user = await getOrCreateUserForRequest(req);
                if (user && user.external_id) {
                  createdBy = user.external_id;
                } else if (user && user.display_name) {
                  createdBy = user.display_name;
                }
              } catch (err) {
                // If we fail to resolve the user here, continue with null createdBy.
              }

              let draftResult;
              try {
                draftResult = await createDraftConfigVersionForDeploymentCode(
                  deploymentCode,
                  createdBy,
                );
              } catch (err) {
                console.error('Failed to create draft config version', {
                  error: err,
                  requestId,
                });

                if (!res.headersSent) {
                  res.statusCode = 500;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({ error: 'internal_error' }));
                }
                return;
              }

              // If helper reports deployment not found, auto-create it and retry.
              if (draftResult && draftResult.notFound === 'deployment') {
                try {
                  const deploymentName =
                    parsedBody &&
                    typeof parsedBody.deploymentName === 'string' &&
                    parsedBody.deploymentName.trim()
                      ? parsedBody.deploymentName.trim()
                      : deploymentCode;

                  await createDeployment(deploymentCode, deploymentName);

                  draftResult =
                    await createDraftConfigVersionForDeploymentCode(
                      deploymentCode,
                      createdBy,
                    );
                } catch (err) {
                  console.error(
                    'Failed to create deployment for draft endpoint',
                    { error: err, requestId },
                  );

                  if (!res.headersSent) {
                    res.statusCode = 500;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: 'internal_error' }));
                  }
                  return;
                }
              }

              if (
                !draftResult ||
                !draftResult.deployment ||
                !draftResult.configVersion
              ) {
                console.error(
                  'Draft config helper returned unexpected result',
                  {
                    deploymentCode,
                    result: draftResult,
                    requestId,
                  },
                );

                if (!res.headersSent) {
                  res.statusCode = 500;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({ error: 'internal_error' }));
                }
                return;
              }

              // Upsert artifacts for this draft version
              const upsertEntries = Object.entries(artifacts || {});
              try {
                for (const [artifactType, artifactPayload] of upsertEntries) {
                  // eslint-disable-next-line no-await-in-loop
                  await upsertConfigArtifact(
                    draftResult.configVersion.id,
                    artifactType,
                    artifactPayload,
                  );
                }
              } catch (err) {
                console.error('Failed to upsert config artifacts for draft', {
                  error: err,
                  requestId,
                });

                if (!res.headersSent) {
                  res.statusCode = 500;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({ error: 'internal_error' }));
                }
                return;
              }

              if (!res.headersSent) {
                res.statusCode = 201;
                res.setHeader('Content-Type', 'application/json');
                res.end(
                  JSON.stringify({
                    deployment: draftResult.deployment,
                    configVersion: draftResult.configVersion,
                    artifacts,
                  }),
                );
              }
            })().catch((err) => {
              console.error('Unhandled error in config draft endpoint', {
                error: err,
                requestId,
              });
              if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_error' }));
              }
            });
          })
          .catch((err) => {
            console.error(
              'Failed to enforce permission for config draft endpoint',
              {
                error: err,
                requestId,
              },
            );
            if (!res.headersSent) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'internal_error' }));
            }
          });

        return;
      }
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
