const { healthHandler } = require('../src/health');

function createMockResponse() {
  return {
    statusCode: undefined,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(chunk) {
      if (chunk) {
        this.body += chunk;
      }
    },
  };
}

describe('healthHandler', () => {
  test('returns 200 and a JSON body with status ok', () => {
    const res = createMockResponse();

    healthHandler({}, res);

    expect(res.statusCode).toBe(200);
    const contentType = res.headers['Content-Type'] || res.headers['content-type'];
    expect(contentType).toMatch(/application\/json/i);

    const parsed = JSON.parse(res.body);
    expect(parsed).toEqual({ status: 'ok' });
  });
});
