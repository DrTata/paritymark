const http = require('http');
const crypto = require('crypto');
const { healthHandler } = require('./health');
const { checkDbHealth, pool } = require('./db');
const { versionHandler } = require('./version');
const {
  HELLO_AUDIT_EVENT_TYPE,
  getLatestAuditEventByType,
  ASSESSMENT_TREE_VIEWED_EVENT_TYPE,
  ASSESSMENT_STRUCTURE_UPDATED_EVENT_TYPE,
  CONFIG_DRAFT_CREATED_EVENT_TYPE,
  CONFIG_ACTIVATED_EVENT_TYPE,
  writeAuditEvent,
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
const {
  getPermissionsForUser,
  getRolesForUser,
} = require('./identity');
const { getProfileForUser } = require('./profile');
const {
  getAssessmentTreeForDeployment,
  createSeries,
  getSeriesByCode,
  createPaper,
  getPaperByCode,
  createQig,
  getQigByCode,
  createItem,
} = require('./assessment');
const {
  ensureIngestionTables,
  RESPONSES_TABLE_NAME,
} = require('./ingestion');
const {
  ensureMarkingTables,
  saveDraftMark,
  submitMark,
  getMarkForResponse,
} = require('./marking');

// Generate a requestId without relying on ESM-only uuid package
function generateRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

// Function to log events
function logRequest(req, res, startTime) {
  const duration = Date.now() - startTime;
  const requestId = req.headers['x-request-id'] || generateRequestId();
  res.setHeader('X-Request-Id', requestId);

  // eslint-disable-next-line no-console
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

// Extract AE QIG scope from roles for a given deploymentCode.
function extractAeQigCodesForDeployment(roles, deploymentCode) {
  const codes = new Set();

  if (!Array.isArray(roles) || !deploymentCode) {
    return codes;
  }

  roles.forEach((role) => {
    if (!role || typeof role.key !== 'string') {
      return;
    }

    const key = role.key;
    if (!key.startsWith('AE_')) {
      return;
    }

    const rest = key.slice(3); // remove "AE_"
    if (!rest) {
      return;
    }

    const parts = rest.split('_');
    if (parts.length < 2) {
      return;
    }

    const indexOfQ = parts.findIndex((p) => p && p.startsWith('Q'));
    if (indexOfQ === -1) {
      return;
    }

    const deploymentParts = parts.slice(0, indexOfQ);
    const qigParts = parts.slice(indexOfQ);
    if (deploymentParts.length === 0 || qigParts.length === 0) {
      return;
    }

    const depCodeFromRole = deploymentParts.join('_');
    const qigCodeFromRole = qigParts.join('_');

    if (depCodeFromRole === deploymentCode) {
      codes.add(qigCodeFromRole);
    }
  });

  return codes;
}

// Apply AE QIG scoping to an assessment tree.
function filterAssessmentTreeForAeRoles(seriesTree, aeQigCodes) {
  if (!Array.isArray(seriesTree) || !aeQigCodes || aeQigCodes.size === 0) {
    return seriesTree;
  }

  return seriesTree
    .map((s) => {
      if (!s || !Array.isArray(s.papers)) {
        return s;
      }

      const filteredPapers = s.papers
        .map((p) => {
          if (!p || !Array.isArray(p.qigs)) {
            return p;
          }

          const filteredQigs = p.qigs.filter(
            (q) =>
              q && typeof q.code === 'string' && aeQigCodes.has(q.code),
          );

          return {
            ...p,
            qigs: filteredQigs,
          };
        })
        .filter(
          (p) => p && Array.isArray(p.qigs) && p.qigs.length > 0,
        );

      return {
        ...s,
        papers: filteredPapers,
      };
    })
    .filter(
      (s) => s && Array.isArray(s.papers) && s.papers.length > 0,
    );
}

function normaliseMarkRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    responseId: row.response_id,
    markerUserId: row.marker_user_id,
    state: row.state,
    payload: row.payload,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normaliseResponseRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    qigId: row.qig_id,
    candidateId: row.candidate_id,
    scriptUrl: row.script_url,
    manifest: row.manifest,
    state: row.state,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
}

async function writeAssessmentStructureUpdatedAudit(
  req,
  deployment,
  structureType,
  structureCode,
  user,
  requestId,
) {
  if (!deployment || !deployment.id || !deployment.code) {
    return;
  }

  try {
    await writeAuditEvent(ASSESSMENT_STRUCTURE_UPDATED_EVENT_TYPE, {
      meta: {
        deploymentId: deployment.id,
        deploymentCode: deployment.code,
        structureType,
        structureCode,
        path: req && req.url ? req.url : null,
        method: req && req.method ? req.method : null,
      },
      actor: user
        ? {
            id: user.id,
            externalId: user.external_id,
            displayName: user.display_name,
          }
        : null,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Failed to write assessment structure updated audit event', {
      error: err,
      requestId,
      deploymentId: deployment.id,
      deploymentCode: deployment.code,
      structureType,
      structureCode,
    });
  }
}

function createServer() {
  return http.createServer((req, res) => {
    const startTime = Date.now();

    // Basic CORS support so the web dev server (different port) and
    // Playwright-run browsers can call the API directly.
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, x-user-external-id, x-user-display-name',
    );
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET,POST,OPTIONS',
    );

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const requestId = logRequest(req, res, startTime);

    // /version
    if (req.method === 'GET' && req.url === '/version') {
      return versionHandler(req, res);
    }

    // /health (with optional DB-backed mode)
    if (req.method === 'GET' && req.url === '/health') {
      const useDb = process.env.API_USE_DB_HEALTH === 'true';

      if (!useDb) {
        return healthHandler(req, res);
      }

      checkDbHealth()
        .then((ok) => {
          if (ok) {
            healthHandler(req, res, { db: 'up' });
          } else {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({ status: 'error', db: 'down' }),
            );
          }
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error('DB health check failed', { error: err, requestId });
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({ status: 'error', db: 'down' }),
          );
        });

      return;
    }

    // /audit/hello/latest (feature-flagged)
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
          // eslint-disable-next-line no-console
          console.error('Failed to fetch hello audit event', {
            error: err,
            requestId,
          });
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'internal_error' }));
        });

      return;
    }

    // /identity/me
    if (req.method === 'GET' && req.url === '/identity/me') {
      getOrCreateUserForRequest(req)
        .then((user) => {
          if (!user) {
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'unauthenticated' }));
            return;
          }

          return Promise.all([
            getPermissionsForUser(user.id),
            getRolesForUser(user.id),
          ]).then(([permissions, roles]) => {
            const roleSummaries = (roles || []).map((role) => ({
              id: role.id,
              key: role.key,
              name: role.name,
            }));

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
                roles: roleSummaries,
              }),
            );
          });
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
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

    // /me/profile
    if (req.method === 'GET' && req.url === '/me/profile') {
      getOrCreateUserForRequest(req)
        .then((user) => {
          if (!user) {
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'unauthenticated' }));
            return;
          }

          return getProfileForUser(user).then((profile) => {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ profile }));
          });
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error('Failed to resolve profile for /me/profile', {
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

    // Assessment-related endpoints
    if (req.url && req.url.startsWith('/assessment/')) {
      const [path] = req.url.split('?');
      const segments = path.split('/').filter(Boolean); // e.g. ["assessment", "D1", "tree"]

      // GET /assessment/:deploymentCode/tree
      if (
        req.method === 'GET' &&
        segments.length === 3 &&
        segments[0] === 'assessment' &&
        segments[2] === 'tree'
      ) {
        const deploymentCode = decodeURIComponent(segments[1]);
        const permissionKey = 'assessment.view';

        enforcePermission(req, res, permissionKey)
          .then((allowed) => {
            if (!allowed) {
              // Response already written (401/403).
              return;
            }

            (async () => {
              let user = null;
              let roles = [];
              try {
                user = await getOrCreateUserForRequest(req);
                if (user) {
                  roles = await getRolesForUser(user.id);
                }
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                  'Failed to resolve user/roles for assessment tree',
                  { error: err, requestId },
                );
              }

              try {
                const deployment = await getDeploymentByCode(
                  deploymentCode,
                );

                if (!deployment || deployment.archived_at) {
                  res.statusCode = 404;
                  res.setHeader(
                    'Content-Type',
                    'application/json',
                  );
                  res.end(
                    JSON.stringify({
                      error: 'deployment_not_found',
                    }),
                  );
                  return;
                }

                const seriesTree =
                  await getAssessmentTreeForDeployment(
                    deployment.id,
                  );

                const aeQigCodes = extractAeQigCodesForDeployment(
                  roles,
                  deploymentCode,
                );
                const filteredSeries = filterAssessmentTreeForAeRoles(
                  seriesTree,
                  aeQigCodes,
                );

                // Audit: ASSESSMENT_TREE_VIEWED
                try {
                  if (user) {
                    await writeAuditEvent(
                      ASSESSMENT_TREE_VIEWED_EVENT_TYPE,
                      {
                        meta: {
                          deploymentId: deployment.id,
                          deploymentCode: deployment.code,
                          path: req && req.url ? req.url : null,
                          method:
                            req && req.method ? req.method : null,
                        },
                        actor: {
                          id: user.id,
                          externalId: user.external_id,
                          displayName: user.display_name,
                        },
                      },
                    );
                  }
                } catch (err) {
                  // eslint-disable-next-line no-console
                  console.error(
                    'Failed to write assessment tree viewed audit event',
                    { error: err, requestId },
                  );
                }

                res.statusCode = 200;
                res.setHeader(
                  'Content-Type',
                  'application/json',
                );
                res.end(
                  JSON.stringify({
                    deployment: {
                      id: deployment.id,
                      code: deployment.code,
                      name: deployment.name,
                    },
                    series: filteredSeries,
                  }),
                );
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                  'Failed to fetch assessment tree',
                  {
                    error: err,
                    requestId,
                  },
                );
                if (!res.headersSent) {
                  res.statusCode = 500;
                  res.setHeader(
                    'Content-Type',
                    'application/json',
                  );
                  res.end(
                    JSON.stringify({
                      error: 'internal_error',
                    }),
                  );
                }
              }
            })().catch((err) => {
              // eslint-disable-next-line no-console
              console.error(
                'Unhandled error in assessment tree endpoint',
                { error: err, requestId },
              );
              if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_error' }));
              }
            });
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error(
              'Failed to enforce permission for assessment endpoint',
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

      // POST /assessment/:deploymentCode/series
      if (
        req.method === 'POST' &&
        segments.length === 3 &&
        segments[0] === 'assessment' &&
        segments[2] === 'series'
      ) {
        const deploymentCode = decodeURIComponent(segments[1]);
        const permissionKey = 'assessment.edit';

        enforcePermission(req, res, permissionKey)
          .then((allowed) => {
            if (!allowed) {
              // 401/403 already written.
              return;
            }

            (async () => {
              let body;
              try {
                body = await readJsonBody(req);
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                  'Failed to parse JSON body for series endpoint',
                  { error: err, requestId },
                );
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(
                  JSON.stringify({ error: 'invalid_json' }),
                );
                return;
              }

              const code =
                body && typeof body.code === 'string'
                  ? body.code
                  : null;
              const name =
                body && typeof body.name === 'string'
                  ? body.name
                  : null;

              if (!code || !name) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(
                  JSON.stringify({ error: 'invalid_payload' }),
                );
                return;
              }

              try {
                const deployment = await getDeploymentByCode(
                  deploymentCode,
                );
                if (!deployment || deployment.archived_at) {
                  res.statusCode = 404;
                  res.setHeader(
                    'Content-Type',
                    'application/json',
                  );
                  res.end(
                    JSON.stringify({
                      error: 'deployment_not_found',
                    }),
                  );
                  return;
                }

                const seriesRow = await createSeries(
                  deployment.id,
                  code,
                  name,
                );

                let user = null;
                try {
                  user = await getOrCreateUserForRequest(req);
                } catch (err) {
                  // eslint-disable-next-line no-console
                  console.error(
                    'Failed to resolve user for series audit',
                    { error: err, requestId },
                  );
                }

                await writeAssessmentStructureUpdatedAudit(
                  req,
                  deployment,
                  'series',
                  seriesRow.code,
                  user,
                  requestId,
                );

                res.statusCode = 201;
                res.setHeader(
                  'Content-Type',
                  'application/json',
                );
                res.end(
                  JSON.stringify({
                    series: {
                      id: seriesRow.id,
                      deploymentId: seriesRow.deployment_id,
                      code: seriesRow.code,
                      name: seriesRow.name,
                    },
                  }),
                );
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                  'Failed to create series via HTTP endpoint',
                  { error: err, requestId },
                );
                if (!res.headersSent) {
                  res.statusCode = 500;
                  res.setHeader(
                    'Content-Type',
                    'application/json',
                  );
                  res.end(
                    JSON.stringify({
                      error: 'internal_error',
                    }),
                  );
                }
              }
            })().catch((err) => {
              // eslint-disable-next-line no-console
              console.error(
                'Unhandled error in series creation endpoint',
                { error: err, requestId },
              );
              if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_error' }));
              }
            });
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error(
              'Failed to enforce permission for series endpoint',
              { error: err, requestId },
            );
            if (!res.headersSent) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'internal_error' }));
            }
          });

        return;
      }

      // POST /assessment/:deploymentCode/series/:seriesCode/papers
      if (
        req.method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'assessment' &&
        segments[2] === 'series' &&
        segments[4] === 'papers'
      ) {
        const deploymentCode = decodeURIComponent(segments[1]);
        const seriesCode = decodeURIComponent(segments[3]);
        const permissionKey = 'assessment.edit';

        enforcePermission(req, res, permissionKey)
          .then((allowed) => {
            if (!allowed) {
              return;
            }

            (async () => {
              let body;
              try {
                body = await readJsonBody(req);
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                  'Failed to parse JSON body for paper endpoint',
                  { error: err, requestId },
                );
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(
                  JSON.stringify({ error: 'invalid_json' }),
                );
                return;
              }

              const code =
                body && typeof body.code === 'string'
                  ? body.code
                  : null;
              const name =
                body && typeof body.name === 'string'
                  ? body.name
                  : null;

              if (!code || !name) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(
                  JSON.stringify({ error: 'invalid_payload' }),
                );
                return;
              }

              try {
                const deployment = await getDeploymentByCode(
                  deploymentCode,
                );
                if (!deployment || deployment.archived_at) {
                  res.statusCode = 404;
                  res.setHeader(
                    'Content-Type',
                    'application/json',
                  );
                  res.end(
                    JSON.stringify({
                      error: 'deployment_not_found',
                    }),
                  );
                  return;
                }

                const seriesRow = await getSeriesByCode(
                  deployment.id,
                  seriesCode,
                );
                if (!seriesRow) {
                  res.statusCode = 404;
                  res.setHeader(
                    'Content-Type',
                    'application/json',
                  );
                  res.end(
                    JSON.stringify({ error: 'series_not_found' }),
                  );
                  return;
                }

                const paperRow = await createPaper(
                  seriesRow.id,
                  code,
                  name,
                );

                let user = null;
                try {
                  user = await getOrCreateUserForRequest(req);
                } catch (err) {
                  // eslint-disable-next-line no-console
                  console.error(
                    'Failed to resolve user for paper audit',
                    { error: err, requestId },
                  );
                }

                await writeAssessmentStructureUpdatedAudit(
                  req,
                  deployment,
                  'paper',
                  paperRow.code,
                  user,
                  requestId,
                );

                res.statusCode = 201;
                res.setHeader(
                  'Content-Type',
                  'application/json',
                );
                res.end(
                  JSON.stringify({
                    paper: {
                      id: paperRow.id,
                      seriesId: paperRow.series_id,
                      code: paperRow.code,
                      name: paperRow.name,
                    },
                  }),
                );
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                  'Failed to create paper via HTTP endpoint',
                  { error: err, requestId },
                );
                if (!res.headersSent) {
                  res.statusCode = 500;
                  res.setHeader(
                    'Content-Type',
                    'application/json',
                  );
                  res.end(
                    JSON.stringify({
                      error: 'internal_error',
                    }),
                  );
                }
              }
            })().catch((err) => {
              // eslint-disable-next-line no-console
              console.error(
                'Unhandled error in paper creation endpoint',
                { error: err, requestId },
              );
              if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_error' }));
              }
            });
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error(
              'Failed to enforce permission for paper endpoint',
              { error: err, requestId },
            );
            if (!res.headersSent) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'internal_error' }));
            }
          });

        return;
      }

      // POST /assessment/:deploymentCode/series/:seriesCode/papers/:paperCode/qigs
      if (
        req.method === 'POST' &&
        segments.length === 7 &&
        segments[0] === 'assessment' &&
        segments[2] === 'series' &&
        segments[4] === 'papers' &&
        segments[6] === 'qigs'
      ) {
        const deploymentCode = decodeURIComponent(segments[1]);
        const seriesCode = decodeURIComponent(segments[3]);
        const paperCode = decodeURIComponent(segments[5]);
        const permissionKey = 'assessment.edit';

        enforcePermission(req, res, permissionKey)
          .then((allowed) => {
            if (!allowed) {
              return;
            }

            (async () => {
              let body;
              try {
                body = await readJsonBody(req);
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                  'Failed to parse JSON body for qig endpoint',
                  { error: err, requestId },
                );
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(
                  JSON.stringify({ error: 'invalid_json' }),
                );
                return;
              }

              const code =
                body && typeof body.code === 'string'
                  ? body.code
                  : null;
              const name =
                body && typeof body.name === 'string'
                  ? body.name
                  : null;

              if (!code || !name) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(
                  JSON.stringify({ error: 'invalid_payload' }),
                );
                return;
              }

              try {
                const deployment = await getDeploymentByCode(
                  deploymentCode,
                );
                if (!deployment || deployment.archived_at) {
                  res.statusCode = 404;
                  res.setHeader(
                    'Content-Type',
                    'application/json',
                  );
                  res.end(
                    JSON.stringify({
                      error: 'deployment_not_found',
                    }),
                  );
                  return;
                }

                const seriesRow = await getSeriesByCode(
                  deployment.id,
                  seriesCode,
                );
                if (!seriesRow) {
                  res.statusCode = 404;
                  res.setHeader(
                    'Content-Type',
                    'application/json',
                  );
                  res.end(
                    JSON.stringify({ error: 'series_not_found' }),
                  );
                  return;
                }

                const paperRow = await getPaperByCode(
                  seriesRow.id,
                  paperCode,
                );
                if (!paperRow) {
                  res.statusCode = 404;
                  res.setHeader(
                    'Content-Type',
                    'application/json',
                  );
                  res.end(
                    JSON.stringify({ error: 'paper_not_found' }),
                  );
                  return;
                }

                const qigRow = await createQig(
                  paperRow.id,
                  code,
                  name,
                );

                let user = null;
                try {
                  user = await getOrCreateUserForRequest(req);
                } catch (err) {
                  // eslint-disable-next-line no-console
                  console.error(
                    'Failed to resolve user for qig audit',
                    { error: err, requestId },
                  );
                }

                await writeAssessmentStructureUpdatedAudit(
                  req,
                  deployment,
                  'qig',
                  qigRow.code,
                  user,
                  requestId,
                );

                res.statusCode = 201;
                res.setHeader(
                  'Content-Type',
                  'application/json',
                );
                res.end(
                  JSON.stringify({
                    qig: {
                      id: qigRow.id,
                      paperId: qigRow.paper_id,
                      code: qigRow.code,
                      name: qigRow.name,
                    },
                  }),
                );
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                  'Failed to create qig via HTTP endpoint',
                  { error: err, requestId },
                );
                if (!res.headersSent) {
                  res.statusCode = 500;
                  res.setHeader(
                    'Content-Type',
                    'application/json',
                  );
                  res.end(
                    JSON.stringify({
                      error: 'internal_error',
                    }),
                  );
                }
              }
            })().catch((err) => {
              // eslint-disable-next-line no-console
              console.error(
                'Unhandled error in qig creation endpoint',
                { error: err, requestId },
              );
              if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_error' }));
              }
            });
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error(
              'Failed to enforce permission for qig endpoint',
              { error: err, requestId },
            );
            if (!res.headersSent) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'internal_error' }));
            }
          });

        return;
      }

      // POST /assessment/:deploymentCode/series/:seriesCode/papers/:paperCode/qigs/:qigCode/items
      if (
        req.method === 'POST' &&
        segments.length === 9 &&
        segments[0] === 'assessment' &&
        segments[2] === 'series' &&
        segments[4] === 'papers' &&
        segments[6] === 'qigs' &&
        segments[8] === 'items'
      ) {
        const deploymentCode = decodeURIComponent(segments[1]);
        const seriesCode = decodeURIComponent(segments[3]);
        const paperCode = decodeURIComponent(segments[5]);
        const qigCode = decodeURIComponent(segments[7]);
        const permissionKey = 'assessment.edit';

        enforcePermission(req, res, permissionKey)
          .then((allowed) => {
            if (!allowed) {
              return;
            }

            (async () => {
              let body;
              try {
                body = await readJsonBody(req);
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                  'Failed to parse JSON body for item endpoint',
                  { error: err, requestId },
                );
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(
                  JSON.stringify({ error: 'invalid_json' }),
                );
                return;
              }

              const code =
                body && typeof body.code === 'string'
                  ? body.code
                  : null;
              const maxMark =
                body && Number.isInteger(body.maxMark)
                  ? body.maxMark
                  : null;

              if (!code || maxMark == null) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(
                  JSON.stringify({ error: 'invalid_payload' }),
                );
                return;
              }

              try {
                const deployment = await getDeploymentByCode(
                  deploymentCode,
                );
                if (!deployment || deployment.archived_at) {
                  res.statusCode = 404;
                  res.setHeader(
                    'Content-Type',
                    'application/json',
                  );
                  res.end(
                    JSON.stringify({
                      error: 'deployment_not_found',
                    }),
                  );
                  return;
                }

                const seriesRow = await getSeriesByCode(
                  deployment.id,
                  seriesCode,
                );
                if (!seriesRow) {
                  res.statusCode = 404;
                  res.setHeader(
                    'Content-Type',
                    'application/json',
                  );
                  res.end(
                    JSON.stringify({ error: 'series_not_found' }),
                  );
                  return;
                }

                const paperRow = await getPaperByCode(
                  seriesRow.id,
                  paperCode,
                );
                if (!paperRow) {
                  res.statusCode = 404;
                  res.setHeader(
                    'Content-Type',
                    'application/json',
                  );
                  res.end(
                    JSON.stringify({ error: 'paper_not_found' }),
                  );
                  return;
                }

                const qigRow = await getQigByCode(
                  paperRow.id,
                  qigCode,
                );
                if (!qigRow) {
                  res.statusCode = 404;
                  res.setHeader(
                    'Content-Type',
                    'application/json',
                  );
                  res.end(
                    JSON.stringify({ error: 'qig_not_found' }),
                  );
                  return;
                }

                const itemRow = await createItem(
                  qigRow.id,
                  code,
                  maxMark,
                );

                let user = null;
                try {
                  user = await getOrCreateUserForRequest(req);
                } catch (err) {
                  // eslint-disable-next-line no-console
                  console.error(
                    'Failed to resolve user for item audit',
                    { error: err, requestId },
                  );
                }

                await writeAssessmentStructureUpdatedAudit(
                  req,
                  deployment,
                  'item',
                  itemRow.code,
                  user,
                  requestId,
                );

                res.statusCode = 201;
                res.setHeader(
                  'Content-Type',
                  'application/json',
                );
                res.end(
                  JSON.stringify({
                    item: {
                      id: itemRow.id,
                      qigId: itemRow.qig_id,
                      code: itemRow.code,
                      maxMark: itemRow.max_mark,
                    },
                  }),
                );
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                  'Failed to create item via HTTP endpoint',
                  { error: err, requestId },
                );
                if (!res.headersSent) {
                  res.statusCode = 500;
                  res.setHeader(
                    'Content-Type',
                    'application/json',
                  );
                  res.end(
                    JSON.stringify({
                      error: 'internal_error',
                    }),
                  );
                }
              }
            })().catch((err) => {
              // eslint-disable-next-line no-console
              console.error(
                'Unhandled error in item creation endpoint',
                { error: err, requestId },
              );
              if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_error' }));
              }
            });
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error(
              'Failed to enforce permission for item endpoint',
              { error: err, requestId },
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
                  res.end(
                    JSON.stringify({
                      error: 'deployment_not_found',
                    }),
                  );
                  return;
                }

                if (result.notFound === 'active_config') {
                  res.statusCode = 404;
                  res.end(
                    JSON.stringify({
                      error: 'active_config_not_found',
                    }),
                  );
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
                // eslint-disable-next-line no-console
                console.error('Failed to fetch active config', {
                  error: err,
                  requestId,
                });
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(
                  JSON.stringify({ error: 'internal_error' }),
                );
              });
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
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
          res.end(
            JSON.stringify({ error: 'invalid_version_number' }),
          );
          return;
        }

        const permissionKey = 'config.activate';

        enforcePermission(req, res, permissionKey)
          .then((allowed) => {
            if (!allowed) {
              // Response already written (401/403).
              return;
            }

            (async () => {
              try {
                const result =
                  await activateConfigVersionForDeploymentCode(
                    deploymentCode,
                    versionNumber,
                  );

                res.setHeader(
                  'Content-Type',
                  'application/json',
                );

                if (result.notFound === 'deployment') {
                  res.statusCode = 404;
                  res.end(
                    JSON.stringify({
                      error: 'deployment_not_found',
                    }),
                  );
                  return;
                }

                if (result.notFound === 'config_version') {
                  res.statusCode = 404;
                  res.end(
                    JSON.stringify({
                      error: 'config_version_not_found',
                    }),
                  );
                  return;
                }

                // Audit: CONFIG_ACTIVATED
                try {
                  const user = await getOrCreateUserForRequest(
                    req,
                  );
                  if (user) {
                    await writeAuditEvent(
                      CONFIG_ACTIVATED_EVENT_TYPE,
                      {
                        meta: {
                          deploymentId: result.deployment.id,
                          deploymentCode: result.deployment.code,
                          configVersionId:
                            result.configVersion.id,
                          versionNumber,
                          path: req && req.url ? req.url : null,
                          method:
                            req && req.method ? req.method : null,
                        },
                        actor: {
                          id: user.id,
                          externalId: user.external_id,
                          displayName: user.display_name,
                        },
                      },
                    );
                  }
                } catch (err) {
                  // eslint-disable-next-line no-console
                  console.error(
                    'Failed to write config activated audit event',
                    { error: err, requestId },
                  );
                }

                res.statusCode = 200;
                res.end(
                  JSON.stringify({
                    deployment: result.deployment,
                    configVersion: result.configVersion,
                  }),
                );
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error('Failed to activate config version', {
                  error: err,
                  requestId,
                });
                res.statusCode = 500;
                res.setHeader(
                  'Content-Type',
                  'application/json',
                );
                res.end(
                  JSON.stringify({ error: 'internal_error' }),
                );
              }
            })().catch((err) => {
              // eslint-disable-next-line no-console
              console.error(
                'Unhandled error in config activation endpoint',
                { error: err, requestId },
              );
              if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_error' }));
              }
            });
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
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

            (async () => {
              let parsedBody;
              try {
                parsedBody = await readJsonBody(req);
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                  'Failed to parse JSON body for config draft endpoint',
                  { error: err, requestId },
                );

                if (!res.headersSent) {
                  res.statusCode = 400;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(
                    JSON.stringify({ error: 'invalid_json' }),
                  );
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
              } catch (_err) {
                // If we fail to resolve the user here, continue with null createdBy.
              }

              let draftResult;
              try {
                draftResult = await createDraftConfigVersionForDeploymentCode(
                  deploymentCode,
                  createdBy,
                );
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error('Failed to create draft config version', {
                  error: err,
                  requestId,
                });

                if (!res.headersSent) {
                  res.statusCode = 500;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(
                    JSON.stringify({ error: 'internal_error' }),
                  );
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
                  // eslint-disable-next-line no-console
                  console.error(
                    'Failed to create deployment for draft endpoint',
                    { error: err, requestId },
                  );

                  if (!res.headersSent) {
                    res.statusCode = 500;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(
                      JSON.stringify({ error: 'internal_error' }),
                    );
                  }
                  return;
                }
              }

              if (
                !draftResult ||
                !draftResult.deployment ||
                !draftResult.configVersion
              ) {
                // eslint-disable-next-line no-console
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
                  res.end(
                    JSON.stringify({ error: 'internal_error' }),
                  );
                }
                return;
              }

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
                // eslint-disable-next-line no-console
                console.error(
                  'Failed to upsert config artifacts for draft',
                  {
                    error: err,
                    requestId,
                  },
                );

                if (!res.headersSent) {
                  res.statusCode = 500;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(
                    JSON.stringify({ error: 'internal_error' }),
                  );
                }
                return;
              }

              // Audit: CONFIG_DRAFT_CREATED
              try {
                const user = await getOrCreateUserForRequest(req);
                if (user) {
                  await writeAuditEvent(
                    CONFIG_DRAFT_CREATED_EVENT_TYPE,
                    {
                      meta: {
                        deploymentId: draftResult.deployment.id,
                        deploymentCode: draftResult.deployment.code,
                        configVersionId:
                          draftResult.configVersion.id,
                        path: req && req.url ? req.url : null,
                        method:
                          req && req.method ? req.method : null,
                      },
                      actor: {
                        id: user.id,
                        externalId: user.external_id,
                        displayName: user.display_name,
                      },
                    },
                  );
                }
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                  'Failed to write config draft created audit event',
                  { error: err, requestId },
                );
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
              // eslint-disable-next-line no-console
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
            // eslint-disable-next-line no-console
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

    // Marking-related endpoints
    if (req.url && req.url.startsWith('/marking/')) {
      const [path] = req.url.split('?');
      const segments = path.split('/').filter(Boolean); // e.g. ["marking", "responses", "1", "draft"]

      // POST /marking/responses/:id/draft
      if (
        req.method === 'POST' &&
        segments.length === 4 &&
        segments[0] === 'marking' &&
        segments[1] === 'responses' &&
        segments[3] === 'draft'
      ) {
        const responseId = parseInt(segments[2], 10);
        if (Number.isNaN(responseId)) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({ error: 'invalid_response_id' }),
          );
          return;
        }

        const permissionKey = 'marking.edit';

        enforcePermission(req, res, permissionKey)
          .then((allowed) => {
            if (!allowed) {
              return;
            }

            (async () => {
              await ensureMarkingTables();
              await ensureIngestionTables();

              try {
                const existing = await pool.query(
                  `SELECT id FROM ${RESPONSES_TABLE_NAME} WHERE id = $1`,
                  [responseId],
                );
                if (!existing.rows || existing.rows.length === 0) {
                  res.statusCode = 404;
                  res.setHeader(
                    'Content-Type',
                    'application/json',
                  );
                  res.end(
                    JSON.stringify({
                      error: 'response_not_found',
                    }),
                  );
                  return;
                }
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                  'Failed to check response existence for draft endpoint',
                  { error: err, requestId },
                );
                res.statusCode = 500;
                res.setHeader(
                  'Content-Type',
                  'application/json',
                );
                res.end(
                  JSON.stringify({ error: 'internal_error' }),
                );
                return;
              }

              let body;
              try {
                body = await readJsonBody(req);
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                  'Failed to parse JSON body for marking draft endpoint',
                  { error: err, requestId },
                );
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(
                  JSON.stringify({ error: 'invalid_json' }),
                );
                return;
              }

              const marks =
                body &&
                typeof body === 'object' &&
                body.marks &&
                typeof body.marks === 'object'
                  ? body.marks
                  : null;

              if (!marks) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(
                  JSON.stringify({ error: 'invalid_marks' }),
                );
                return;
              }

              let user;
              try {
                user = await getOrCreateUserForRequest(req);
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                  'Failed to resolve user for marking draft',
                  { error: err, requestId },
                );
                res.statusCode = 500;
                res.setHeader(
                  'Content-Type',
                  'application/json',
                );
                res.end(
                  JSON.stringify({ error: 'internal_error' }),
                );
                return;
              }

              if (!user) {
                res.statusCode = 401;
                res.setHeader('Content-Type', 'application/json');
                res.end(
                  JSON.stringify({ error: 'unauthenticated' }),
                );
                return;
              }

              try {
                const row = await saveDraftMark(
                  responseId,
                  user.id,
                  marks,
                );
                const mark = normaliseMarkRow(row);

                res.statusCode = 200;
                res.setHeader(
                  'Content-Type',
                  'application/json',
                );
                res.end(JSON.stringify({ mark }));
              } catch (err) {
                if (err && err.code === 'LOCKED') {
                  res.statusCode = 409;
                  res.setHeader(
                    'Content-Type',
                    'application/json',
                  );
                  res.end(
                    JSON.stringify({
                      error: 'response_locked',
                      reason: err.code || 'LOCKED',
                    }),
                  );
                  return;
                }

                // eslint-disable-next-line no-console
                console.error(
                  'Failed to save marking draft',
                  { error: err, requestId },
                );
                res.statusCode = 500;
                res.setHeader(
                  'Content-Type',
                  'application/json',
                );
                res.end(
                  JSON.stringify({ error: 'internal_error' }),
                );
              }
            })().catch((err) => {
              // eslint-disable-next-line no-console
              console.error(
                'Unhandled error in marking draft endpoint',
                { error: err, requestId },
              );
              if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_error' }));
              }
            });
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error(
              'Failed to enforce permission for marking draft endpoint',
              { error: err, requestId },
            );
            if (!res.headersSent) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'internal_error' }));
            }
          });

        return;
      }

      // POST /marking/responses/:id/submit
      if (
        req.method === 'POST' &&
        segments.length === 4 &&
        segments[0] === 'marking' &&
        segments[1] === 'responses' &&
        segments[3] === 'submit'
      ) {
        const responseId = parseInt(segments[2], 10);
        if (Number.isNaN(responseId)) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({ error: 'invalid_response_id' }),
          );
          return;
        }

        const permissionKey = 'marking.edit';

        enforcePermission(req, res, permissionKey)
          .then((allowed) => {
            if (!allowed) {
              return;
            }

            (async () => {
              await ensureMarkingTables();
              await ensureIngestionTables();

              try {
                const existing = await pool.query(
                  `SELECT id FROM ${RESPONSES_TABLE_NAME} WHERE id = $1`,
                  [responseId],
                );
                if (!existing.rows || existing.rows.length === 0) {
                  res.statusCode = 404;
                  res.setHeader(
                    'Content-Type',
                    'application/json',
                  );
                  res.end(
                    JSON.stringify({
                      error: 'response_not_found',
                    }),
                  );
                  return;
                }
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                  'Failed to check response existence for submit endpoint',
                  { error: err, requestId },
                );
                res.statusCode = 500;
                res.setHeader(
                  'Content-Type',
                  'application/json',
                );
                res.end(
                  JSON.stringify({ error: 'internal_error' }),
                );
                return;
              }

              let body;
              try {
                body = await readJsonBody(req);
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                  'Failed to parse JSON body for marking submit endpoint',
                  { error: err, requestId },
                );
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(
                  JSON.stringify({ error: 'invalid_json' }),
                );
                return;
              }

              const marks =
                body &&
                typeof body === 'object' &&
                body.marks &&
                typeof body.marks === 'object'
                  ? body.marks
                  : null;

              if (!marks) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(
                  JSON.stringify({ error: 'invalid_marks' }),
                );
                return;
              }

              let user;
              try {
                user = await getOrCreateUserForRequest(req);
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                  'Failed to resolve user for marking submit',
                  { error: err, requestId },
                );
                res.statusCode = 500;
                res.setHeader(
                  'Content-Type',
                  'application/json',
                );
                res.end(
                  JSON.stringify({ error: 'internal_error' }),
                );
                return;
              }

              if (!user) {
                res.statusCode = 401;
                res.setHeader('Content-Type', 'application/json');
                res.end(
                  JSON.stringify({ error: 'unauthenticated' }),
                );
                return;
              }

              try {
                const row = await submitMark(
                  responseId,
                  user.id,
                  marks,
                );
                const mark = normaliseMarkRow(row);

                res.statusCode = 200;
                res.setHeader(
                  'Content-Type',
                  'application/json',
                );
                res.end(JSON.stringify({ mark }));
              } catch (err) {
                if (err && err.code === 'LOCKED') {
                  res.statusCode = 409;
                  res.setHeader(
                    'Content-Type',
                    'application/json',
                  );
                  res.end(
                    JSON.stringify({
                      error: 'response_locked',
                      reason: err.code || 'LOCKED',
                    }),
                  );
                  return;
                }

                // eslint-disable-next-line no-console
                console.error(
                  'Failed to submit marks',
                  { error: err, requestId },
                );
                res.statusCode = 500;
                res.setHeader(
                  'Content-Type',
                  'application/json',
                );
                res.end(
                  JSON.stringify({ error: 'internal_error' }),
                );
              }
            })().catch((err) => {
              // eslint-disable-next-line no-console
              console.error(
                'Unhandled error in marking submit endpoint',
                { error: err, requestId },
              );
              if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_error' }));
              }
            });
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error(
              'Failed to enforce permission for marking submit endpoint',
              { error: err, requestId },
            );
            if (!res.headersSent) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'internal_error' }));
            }
          });

        return;
      }

      // GET /marking/responses/:id
      if (
        req.method === 'GET' &&
        segments.length === 3 &&
        segments[0] === 'marking' &&
        segments[1] === 'responses'
      ) {
        const responseId = parseInt(segments[2], 10);
        if (Number.isNaN(responseId)) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({ error: 'invalid_response_id' }),
          );
          return;
        }

        const permissionKey = 'marking.view';

        enforcePermission(req, res, permissionKey)
          .then((allowed) => {
            if (!allowed) {
              return;
            }

            (async () => {
              await ensureMarkingTables();
              await ensureIngestionTables();

              try {
                const existing = await pool.query(
                  `SELECT id FROM ${RESPONSES_TABLE_NAME} WHERE id = $1`,
                  [responseId],
                );
                if (!existing.rows || existing.rows.length === 0) {
                  res.statusCode = 404;
                  res.setHeader(
                    'Content-Type',
                    'application/json',
                  );
                  res.end(
                    JSON.stringify({
                      error: 'response_not_found',
                    }),
                  );
                  return;
                }
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                  'Failed to check response existence for get mark endpoint',
                  { error: err, requestId },
                );
                res.statusCode = 500;
                res.setHeader(
                  'Content-Type',
                  'application/json',
                );
                res.end(
                  JSON.stringify({ error: 'internal_error' }),
                );
                return;
              }

              let user;
              try {
                user = await getOrCreateUserForRequest(req);
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                  'Failed to resolve user for get mark',
                  { error: err, requestId },
                );
                res.statusCode = 500;
                res.setHeader(
                  'Content-Type',
                  'application/json',
                );
                res.end(
                  JSON.stringify({ error: 'internal_error' }),
                );
                return;
              }

              if (!user) {
                res.statusCode = 401;
                res.setHeader('Content-Type', 'application/json');
                res.end(
                  JSON.stringify({ error: 'unauthenticated' }),
                );
                return;
              }

              try {
                const row = await getMarkForResponse(
                  responseId,
                  user.id,
                );
                if (!row) {
                  res.statusCode = 404;
                  res.setHeader(
                    'Content-Type',
                    'application/json',
                  );
                  res.end(
                    JSON.stringify({ error: 'mark_not_found' }),
                  );
                  return;
                }

                const mark = normaliseMarkRow(row);
                res.statusCode = 200;
                res.setHeader(
                  'Content-Type',
                  'application/json',
                );
                res.end(JSON.stringify({ mark }));
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                  'Failed to fetch mark for response',
                  { error: err, requestId },
                );
                res.statusCode = 500;
                res.setHeader(
                  'Content-Type',
                  'application/json',
                );
                res.end(
                  JSON.stringify({ error: 'internal_error' }),
                );
              }
            })().catch((err) => {
              // eslint-disable-next-line no-console
              console.error(
                'Unhandled error in get marking endpoint',
                { error: err, requestId },
              );
              if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_error' }));
              }
            });
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error(
              'Failed to enforce permission for get marking endpoint',
              { error: err, requestId },
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

    // Response media endpoint: /responses/:id/media
    if (req.url && req.url.startsWith('/responses/')) {
      const [path] = req.url.split('?');
      const segments = path.split('/').filter(Boolean); // e.g. ["responses", "1", "media"]

      if (
        req.method === 'GET' &&
        segments.length === 3 &&
        segments[0] === 'responses' &&
        segments[2] === 'media'
      ) {
        const responseId = parseInt(segments[1], 10);
        if (Number.isNaN(responseId)) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({ error: 'invalid_response_id' }),
          );
          return;
        }

        const permissionKey = 'assessment.view';

        enforcePermission(req, res, permissionKey)
          .then((allowed) => {
            if (!allowed) {
              return;
            }

            (async () => {
              await ensureIngestionTables();

              try {
                const result = await pool.query(
                  `
                    SELECT id, qig_id, candidate_id, script_url, manifest, state, created_at, archived_at
                    FROM ${RESPONSES_TABLE_NAME}
                    WHERE id = $1
                  `,
                  [responseId],
                );

                if (!result.rows || result.rows.length === 0) {
                  res.statusCode = 404;
                  res.setHeader(
                    'Content-Type',
                    'application/json',
                  );
                  res.end(
                    JSON.stringify({
                      error: 'response_not_found',
                    }),
                  );
                  return;
                }

                const responseRow = normaliseResponseRow(
                  result.rows[0],
                );
                res.statusCode = 200;
                res.setHeader(
                  'Content-Type',
                  'application/json',
                );
                res.end(JSON.stringify({ response: responseRow }));
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error(
                  'Failed to fetch response media pointer',
                  { error: err, requestId },
                );
                res.statusCode = 500;
                res.setHeader(
                  'Content-Type',
                  'application/json',
                );
                res.end(
                  JSON.stringify({ error: 'internal_error' }),
                );
              }
            })().catch((err) => {
              // eslint-disable-next-line no-console
              console.error(
                'Unhandled error in response media endpoint',
                { error: err, requestId },
              );
              if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'internal_error' }));
              }
            });
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error(
              'Failed to enforce permission for response media endpoint',
              { error: err, requestId },
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

    // Fallback 404
    res.statusCode = 404;
    res.end();
  });
}

if (require.main === module) {
  const port = process.env.PORT || 4000;
  const server = createServer();
  // eslint-disable-next-line no-console
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`API server listening on http://localhost:${port}`);
  });
}

module.exports = { createServer, healthHandler };
