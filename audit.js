const AUDIT_MAX_DETAIL = 2000;

function ensureAuditSchema(database) {
  if (!database) return;
  database.exec(`
    CREATE TABLE IF NOT EXISTS AUDIT_LOG (
      ID INTEGER PRIMARY KEY AUTOINCREMENT,
      CREATED_AT TEXT NOT NULL,
      USER_LOGIN TEXT,
      USER_ID INTEGER,
      ACTION TEXT NOT NULL,
      ENTITY_TYPE TEXT,
      ENTITY_ID TEXT,
      WINDOW_ID TEXT,
      SUMMARY TEXT,
      DETAIL TEXT
    );
    CREATE INDEX IF NOT EXISTS IDX_AUDIT_CREATED ON AUDIT_LOG(CREATED_AT DESC);
    CREATE INDEX IF NOT EXISTS IDX_AUDIT_USER ON AUDIT_LOG(USER_LOGIN);
  `);
}

function trimText(value, maxLen) {
  const text = value == null ? '' : String(value);
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

function logAudit(database, entry = {}) {
  if (!database) return;
  try {
    ensureAuditSchema(database);
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO AUDIT_LOG (
        CREATED_AT, USER_LOGIN, USER_ID, ACTION, ENTITY_TYPE, ENTITY_ID, WINDOW_ID, SUMMARY, DETAIL
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      now,
      entry.userLogin || null,
      entry.userId != null ? entry.userId : null,
      entry.action || 'UNKNOWN',
      entry.entityType || null,
      entry.entityId != null ? String(entry.entityId) : null,
      entry.windowId || null,
      trimText(entry.summary || '', 500),
      trimText(entry.detail || '', AUDIT_MAX_DETAIL)
    );
  } catch (_) {
    // audit must never block or slow the main flow
  }
}

function classifySqlAction(sql) {
  const head = String(sql || '').trim().split(/\s+/)[0].toUpperCase();
  if (head === 'INSERT') return 'DATA_INSERT';
  if (head === 'UPDATE') return 'DATA_UPDATE';
  if (head === 'DELETE') return 'DATA_DELETE';
  return null;
}

module.exports = {
  ensureAuditSchema,
  logAudit,
  classifySqlAction
};