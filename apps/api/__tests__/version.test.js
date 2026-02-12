const { versionHandler, getVersionMeta } = require('../src/version');
const pkg = require('../package.json');

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

describe('version endpoint', () => {
  test('getVersionMeta returns expected shape', () => {
    const meta = getVersionMeta();

    expect(meta).toMatchObject({
      service: 'api',
      name: pkg.name,
      version: pkg.version,
    });
    expect(typeof meta.env).toBe('string');
  });

  test('versionHandler returns 200 and JSON body with version metadata', () => {
    const res = createMockResponse();

    versionHandler({}, res);

    expect(res.statusCode).toBe(200);
    const contentType = res.headers['Content-Type'] || res.headers['content-type'];
    expect(contentType).toMatch(/application\/json/i);

    const parsed = JSON.parse(res.body);
    expect(parsed).toMatchObject({
      service: 'api',
      name: pkg.name,
      version: pkg.version,
    });
    expect(typeof parsed.env).toBe('string');
  });
});
