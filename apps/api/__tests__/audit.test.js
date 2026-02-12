jest.mock('../src/db', () => {
  const queryMock = jest.fn();
  return {
    pool: {
      query: queryMock,
    },
    checkDbHealth: jest.fn(),
    endPool: jest.fn(),
    __queryMock: queryMock,
  };
});

const db = require('../src/db');
const {
  HELLO_AUDIT_EVENT_TYPE,
  writeAuditEvent,
  getLatestAuditEventByType,
} = require('../src/audit');

describe('audit module', () => {
  beforeEach(() => {
    db.__queryMock.mockReset();
  });

  test('writeAuditEvent ensures table and inserts event', async () => {
    db.__queryMock
      .mockResolvedValueOnce({ rows: [] }) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [] }); // INSERT

    const payload = { meta: { version: '0.1.0' } };

    await writeAuditEvent(HELLO_AUDIT_EVENT_TYPE, payload);

    expect(db.__queryMock).toHaveBeenCalledTimes(2);

    const [createSql] = db.__queryMock.mock.calls[0];
    expect(createSql).toMatch(/CREATE TABLE IF NOT EXISTS\s+audit_events/i);

    const [insertSql, insertParams] = db.__queryMock.mock.calls[1];
    expect(insertSql).toMatch(/INSERT INTO\s+audit_events/i);
    expect(insertParams[0]).toBe(HELLO_AUDIT_EVENT_TYPE);
    expect(insertParams[1]).toEqual(payload);
  });

  test('getLatestAuditEventByType ensures table and returns latest row', async () => {
    const fakeRow = {
      id: 1,
      event_type: HELLO_AUDIT_EVENT_TYPE,
      payload: { meta: { version: '0.1.0' } },
      created_at: new Date().toISOString(),
    };

    db.__queryMock
      .mockResolvedValueOnce({ rows: [] }) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [fakeRow] }); // SELECT

    const result = await getLatestAuditEventByType(HELLO_AUDIT_EVENT_TYPE);

    expect(db.__queryMock).toHaveBeenCalledTimes(2);

    const [createSql] = db.__queryMock.mock.calls[0];
    expect(createSql).toMatch(/CREATE TABLE IF NOT EXISTS\s+audit_events/i);

    const [selectSql, selectParams] = db.__queryMock.mock.calls[1];
    expect(selectSql).toMatch(/SELECT\s+id,\s*event_type,\s*payload,\s*created_at\s+FROM\s+audit_events/i);
    expect(selectParams[0]).toBe(HELLO_AUDIT_EVENT_TYPE);

    expect(result).toEqual(fakeRow);
  });
});
