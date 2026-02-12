function healthHandler(_req, res) {
  const body = JSON.stringify({ status: 'ok' });

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(body);
}

module.exports = { healthHandler };
