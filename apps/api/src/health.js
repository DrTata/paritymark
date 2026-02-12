function healthHandler(_req, res, extraFields = {}) {
  const body = JSON.stringify({ status: 'ok', ...extraFields });

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(body);
}

module.exports = { healthHandler };
