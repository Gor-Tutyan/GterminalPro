const CFG_APP_ID = 1;
const META_MIGRATED_V2_NO_JSON = 'migrated_v2_no_json';

const FIELD_BASE_KEYS = new Set([
  'field', 'title', 'type', 'useInInsert', 'useInUpdate',
  'required', 'hiddenInForm', 'disabled', 'readonly'
]);

const FIELD_COLUMN_KEYS = new Set([
  'defaultValue', 'placeholder', 'help', 'dependsOn', 'lookupQuery', 'lookupWindow',
  'systemVariable', 'width', 'height', 'searchable', 'copyFrom'
]);

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

const schemaReadyDbs = new WeakSet();
const columnCache = new WeakMap();

function ensureColumn(database, table, column, ddl) {
  let dbCache = columnCache.get(database);
  if (!dbCache) {
    dbCache = new Map();
    columnCache.set(database, dbCache);
  }
  const key = table + '.' + column;
  if (dbCache.has(key)) return;
  const cols = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
  dbCache.set(key, true);
}

function ensureFieldColumns(database) {
  const cols = [
    ['DEFAULT_VALUE', 'TEXT'], ['PLACEHOLDER', 'TEXT'], ['HELP_TEXT', 'TEXT'],
    ['DEPENDS_ON', 'TEXT'], ['LOOKUP_QUERY', 'TEXT'], ['LOOKUP_WINDOW', 'TEXT'],
    ['SYSTEM_VARIABLE', 'TEXT'], ['WIDTH', 'TEXT'], ['HEIGHT', 'TEXT'],
    ['SEARCHABLE', 'INTEGER DEFAULT 0'], ['AUTO_TYPE', 'TEXT'], ['AUTO_QUERY', 'TEXT'],
    ['AUTO_FORMAT', 'TEXT'], ['AUTO_CONSTANT', 'TEXT'], ['AUTO_MIN', 'TEXT'], ['AUTO_MAX', 'TEXT'],
    ['COPY_FROM_FIELD', 'TEXT'], ['COND_SHOW_FIELD', 'TEXT'], ['COND_SHOW_VALUE', 'TEXT'],
    ['COND_REQUIRED_FIELD', 'TEXT']
  ];
  cols.forEach(([name, ddl]) => ensureColumn(database, 'CFG_FIELDS', name, ddl));
}

function tableExists(database, table) {
  try {
    const row = database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(table);
    return !!row;
  } catch (_) {
    return false;
  }
}

function upgradeLegacyTableColumns(database) {
  if (!database) return;

  if (tableExists(database, 'CFG_FILTERS')) {
    [
      ['DEFAULT_OPERATOR', 'TEXT'],
      ['FILTER_TYPE', 'TEXT'],
      ['FILTER_FORMAT', 'TEXT'],
      ['FILTER_PLACEHOLDER', 'TEXT']
    ].forEach(([name, ddl]) => ensureColumn(database, 'CFG_FILTERS', name, ddl));
  }

  if (tableExists(database, 'CFG_FORM_BUTTONS')) {
    [
      ['POSITION', 'TEXT'], ['MODES', 'TEXT'], ['SUCCESS_MSG', 'TEXT'], ['ERROR_MSG', 'TEXT'],
      ['TEMPLATE_DIR', 'TEXT'], ['TEMPLATE_FILE', 'TEXT'], ['OUTPUT_FILENAME', 'TEXT'],
      ['STYLE_BG', 'TEXT'], ['STYLE_COLOR', 'TEXT'], ['STYLE_WIDTH', 'TEXT'], ['STYLE_HEIGHT', 'TEXT'],
      ['SAVE_AFTER', 'INTEGER DEFAULT 0'],
      ['SHOW_WHEN_FIELD', 'TEXT'], ['SHOW_WHEN_OPERATOR', 'TEXT'], ['SHOW_WHEN_VALUE', 'TEXT'],
      ['SHOW_WHEN_SQL', 'TEXT'], ['SHOW_WHEN_PARAM_FIELDS', 'TEXT']
    ].forEach(([name, ddl]) => ensureColumn(database, 'CFG_FORM_BUTTONS', name, ddl));
  }

  if (tableExists(database, 'CFG_ROW_FORMAT')) {
    [
      ['FIELD_NAME', 'TEXT'], ['OPERATOR', 'TEXT'], ['VALUE', 'TEXT'],
      ['ENABLED', 'INTEGER DEFAULT 1'], ['STYLE_BORDER', 'TEXT'], ['STYLE_BG', 'TEXT'], ['STYLE_COLOR', 'TEXT'],
      ['CONDITION_TYPE', 'TEXT'], ['VARIANTS_JSON', 'TEXT'],
      ['ICON_COLUMN', 'TEXT'], ['ICON_TEXT', 'TEXT'], ['ICON_COLOR', 'TEXT']
    ].forEach(([name, ddl]) => ensureColumn(database, 'CFG_ROW_FORMAT', name, ddl));
  }

  if (tableExists(database, 'CFG_REPORTS')) {
    [
      ['REPORT_ID', 'TEXT'], ['TITLE', 'TEXT'], ['DESCRIPTION', 'TEXT'],
      ['QUERY_SQL', 'TEXT'], ['EXPORT_FILENAME', 'TEXT'], ['PAGE_SIZE', 'INTEGER']
    ].forEach(([name, ddl]) => ensureColumn(database, 'CFG_REPORTS', name, ddl));
  }

  if (tableExists(database, 'CFG_RELATIONS')) {
    [
      ['REL_TYPE', 'TEXT'], ['TARGET_ID', 'TEXT'], ['TARGET_WINDOW', 'TEXT'],
      ['FOREIGN_KEY', 'TEXT'], ['CHILD_FOREIGN_KEY', 'TEXT']
    ].forEach(([name, ddl]) => ensureColumn(database, 'CFG_RELATIONS', name, ddl));
  }
}

function flattenAutoValue(auto) {
  if (!auto || typeof auto !== 'object') return {};
  return {
    AUTO_TYPE: auto.type || null,
    AUTO_QUERY: auto.query || auto.sql || null,
    AUTO_FORMAT: auto.format || null,
    AUTO_CONSTANT: auto.value != null ? String(auto.value) : null,
    AUTO_MIN: auto.min != null ? String(auto.min) : null,
    AUTO_MAX: auto.max != null ? String(auto.max) : null,
    COPY_FROM_FIELD: auto.copyFrom || auto.from || null
  };
}

function unflattenAutoValue(row) {
  if (!row.AUTO_TYPE && !row.AUTO_QUERY && !row.SYSTEM_VARIABLE) return null;
  if (row.SYSTEM_VARIABLE) return null;
  const auto = { type: row.AUTO_TYPE || 'sql' };
  if (row.AUTO_QUERY) auto.query = row.AUTO_QUERY;
  if (row.AUTO_FORMAT) auto.format = row.AUTO_FORMAT;
  if (row.AUTO_CONSTANT != null) auto.value = row.AUTO_CONSTANT;
  if (row.AUTO_MIN != null) auto.min = row.AUTO_MIN;
  if (row.AUTO_MAX != null) auto.max = row.AUTO_MAX;
  if (row.COPY_FROM_FIELD) auto.copyFrom = row.COPY_FROM_FIELD;
  return auto;
}

function emptyFieldChildren() {
  return { validations: [], transforms: [], options: [], conditionalDefaults: [], extras: [] };
}

function loadFieldChildrenBatch(database, windowId) {
  const byField = {};
  const bucket = (fieldName) => {
    if (!byField[fieldName]) byField[fieldName] = emptyFieldChildren();
    return byField[fieldName];
  };

  database.prepare(`
    SELECT FIELD_NAME, VAL_TYPE, ERROR_MSG, MIN_LEN, MAX_LEN, MIN_VAL, MAX_VAL, EXACT_LEN, PATTERN,
           QUERY_SQL, REF_FIELDS, LANGUAGE, START_POS, LENGTH_POS, POSITION_VALUE, CUSTOM_SQL
    FROM CFG_FIELD_VALIDATIONS
    WHERE WINDOW_ID = ? ORDER BY FIELD_NAME, SORT_ORDER, ID
  `).all(windowId).forEach((r) => {
    const v = { type: r.VAL_TYPE, error: r.ERROR_MSG || '' };
    if (r.MIN_LEN != null) v.min = r.MIN_LEN;
    if (r.MAX_LEN != null) v.max = r.MAX_LEN;
    if (r.MIN_VAL != null) v.min = r.MIN_VAL;
    if (r.MAX_VAL != null) v.max = r.MAX_VAL;
    if (r.EXACT_LEN != null) v.exact = r.EXACT_LEN;
    if (r.PATTERN) v.pattern = r.PATTERN;
    if (r.QUERY_SQL) v.query = r.QUERY_SQL;
    if (r.REF_FIELDS) v.fields = r.REF_FIELDS.split(',').map((s) => s.trim()).filter(Boolean);
    if (r.LANGUAGE) v.language = r.LANGUAGE;
    if (r.START_POS != null) v.start = r.START_POS;
    if (r.LENGTH_POS != null) v.length = r.LENGTH_POS;
    if (r.POSITION_VALUE) v.value = r.POSITION_VALUE;
    if (r.CUSTOM_SQL) v.sql = r.CUSTOM_SQL;
    bucket(r.FIELD_NAME).validations.push(v);
  });

  database.prepare(`
    SELECT FIELD_NAME, TRANS_TYPE, LENGTH_N, START_POS, DELIMITER, TAKE_INDEX, REGEX_PATTERN
    FROM CFG_FIELD_TRANSFORMS WHERE WINDOW_ID = ? ORDER BY FIELD_NAME, SORT_ORDER, ID
  `).all(windowId).forEach((r) => {
    const t = { type: r.TRANS_TYPE };
    if (r.LENGTH_N != null) t.length = r.LENGTH_N;
    if (r.START_POS != null) t.start = r.START_POS;
    if (r.DELIMITER) t.delimiter = r.DELIMITER;
    if (r.TAKE_INDEX != null) t.take = r.TAKE_INDEX;
    if (r.REGEX_PATTERN) t.pattern = r.REGEX_PATTERN;
    bucket(r.FIELD_NAME).transforms.push(t);
  });

  database.prepare(`
    SELECT FIELD_NAME, OPT_VALUE, OPT_DISPLAY FROM CFG_FIELD_OPTIONS
    WHERE WINDOW_ID = ? ORDER BY FIELD_NAME, SORT_ORDER, ID
  `).all(windowId).forEach((r) => {
    bucket(r.FIELD_NAME).options.push({
      value: r.OPT_VALUE,
      display: r.OPT_DISPLAY || r.OPT_VALUE
    });
  });

  database.prepare(`
    SELECT FIELD_NAME, WHEN_FIELD, WHEN_VALUE, DEFAULT_VAL FROM CFG_FIELD_COND_DEFAULTS
    WHERE WINDOW_ID = ? ORDER BY FIELD_NAME, SORT_ORDER, ID
  `).all(windowId).forEach((r) => {
    bucket(r.FIELD_NAME).conditionalDefaults.push({
      whenField: r.WHEN_FIELD,
      whenValue: r.WHEN_VALUE,
      defaultValue: r.DEFAULT_VAL
    });
  });

  database.prepare(`
    SELECT FIELD_NAME, EXTRA_KEY, EXTRA_VALUE FROM CFG_FIELD_EXTRA
    WHERE WINDOW_ID = ? ORDER BY FIELD_NAME, ID
  `).all(windowId).forEach((r) => {
    bucket(r.FIELD_NAME).extras.push({ EXTRA_KEY: r.EXTRA_KEY, EXTRA_VALUE: r.EXTRA_VALUE });
  });

  return byField;
}

function loadFieldChildren(database, windowId, fieldName) {
  const validations = database.prepare(`
    SELECT VAL_TYPE, ERROR_MSG, MIN_LEN, MAX_LEN, MIN_VAL, MAX_VAL, EXACT_LEN, PATTERN,
           QUERY_SQL, REF_FIELDS, LANGUAGE, START_POS, LENGTH_POS, POSITION_VALUE, CUSTOM_SQL
    FROM CFG_FIELD_VALIDATIONS
    WHERE WINDOW_ID = ? AND FIELD_NAME = ? ORDER BY SORT_ORDER, ID
  `).all(windowId, fieldName).map((r) => {
    const v = { type: r.VAL_TYPE, error: r.ERROR_MSG || '' };
    if (r.MIN_LEN != null) v.min = r.MIN_LEN;
    if (r.MAX_LEN != null) v.max = r.MAX_LEN;
    if (r.MIN_VAL != null) v.min = r.MIN_VAL;
    if (r.MAX_VAL != null) v.max = r.MAX_VAL;
    if (r.EXACT_LEN != null) v.exact = r.EXACT_LEN;
    if (r.PATTERN) v.pattern = r.PATTERN;
    if (r.QUERY_SQL) v.query = r.QUERY_SQL;
    if (r.REF_FIELDS) v.fields = r.REF_FIELDS.split(',').map((s) => s.trim()).filter(Boolean);
    if (r.LANGUAGE) v.language = r.LANGUAGE;
    if (r.START_POS != null) v.start = r.START_POS;
    if (r.LENGTH_POS != null) v.length = r.LENGTH_POS;
    if (r.POSITION_VALUE) v.value = r.POSITION_VALUE;
    if (r.CUSTOM_SQL) v.sql = r.CUSTOM_SQL;
    return v;
  });

  const transforms = database.prepare(`
    SELECT TRANS_TYPE, LENGTH_N, START_POS, DELIMITER, TAKE_INDEX, REGEX_PATTERN
    FROM CFG_FIELD_TRANSFORMS WHERE WINDOW_ID = ? AND FIELD_NAME = ? ORDER BY SORT_ORDER, ID
  `).all(windowId, fieldName).map((r) => {
    const t = { type: r.TRANS_TYPE };
    if (r.LENGTH_N != null) t.length = r.LENGTH_N;
    if (r.START_POS != null) t.start = r.START_POS;
    if (r.DELIMITER) t.delimiter = r.DELIMITER;
    if (r.TAKE_INDEX != null) t.take = r.TAKE_INDEX;
    if (r.REGEX_PATTERN) t.pattern = r.REGEX_PATTERN;
    return t;
  });

  const options = database.prepare(`
    SELECT OPT_VALUE, OPT_DISPLAY FROM CFG_FIELD_OPTIONS
    WHERE WINDOW_ID = ? AND FIELD_NAME = ? ORDER BY SORT_ORDER, ID
  `).all(windowId, fieldName).map((r) => ({
    value: r.OPT_VALUE,
    display: r.OPT_DISPLAY || r.OPT_VALUE
  }));

  const conditionalDefaults = database.prepare(`
    SELECT WHEN_FIELD, WHEN_VALUE, DEFAULT_VAL FROM CFG_FIELD_COND_DEFAULTS
    WHERE WINDOW_ID = ? AND FIELD_NAME = ? ORDER BY SORT_ORDER, ID
  `).all(windowId, fieldName).map((r) => ({
    whenField: r.WHEN_FIELD,
    whenValue: r.WHEN_VALUE,
    defaultValue: r.DEFAULT_VAL
  }));

  const extras = database.prepare(`
    SELECT EXTRA_KEY, EXTRA_VALUE FROM CFG_FIELD_EXTRA
    WHERE WINDOW_ID = ? AND FIELD_NAME = ? ORDER BY ID
  `).all(windowId, fieldName);

  return { validations, transforms, options, conditionalDefaults, extras };
}

function applyExtrasToField(field, extras) {
  extras.forEach((row) => {
    if (!row.EXTRA_KEY) return;
    if (row.EXTRA_KEY.includes('.')) {
      const parts = row.EXTRA_KEY.split('.');
      let cur = field;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!cur[parts[i]]) cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = row.EXTRA_VALUE;
    } else {
      field[row.EXTRA_KEY] = row.EXTRA_VALUE;
    }
  });
}

function mergeFieldRow(database, windowId, row, fieldChildrenBatch) {
  const field = {
    field: row.FIELD_NAME,
    title: row.TITLE || row.FIELD_NAME,
    type: row.FIELD_TYPE || 'text',
    useInInsert: row.USE_INSERT !== 0,
    useInUpdate: row.USE_UPDATE !== 0,
    required: row.REQUIRED === 1,
    hiddenInForm: row.HIDDEN === 1,
    disabled: row.DISABLED === 1,
    readonly: row.READONLY === 1
  };
  if (row.DEFAULT_VALUE != null && row.DEFAULT_VALUE !== '') field.defaultValue = row.DEFAULT_VALUE;
  if (row.PLACEHOLDER) field.placeholder = row.PLACEHOLDER;
  if (row.HELP_TEXT) field.help = row.HELP_TEXT;
  if (row.DEPENDS_ON) field.dependsOn = row.DEPENDS_ON;
  if (row.LOOKUP_QUERY) field.lookupQuery = row.LOOKUP_QUERY;
  if (row.LOOKUP_WINDOW) field.lookupWindow = row.LOOKUP_WINDOW;
  if (row.SYSTEM_VARIABLE) field.systemVariable = row.SYSTEM_VARIABLE;
  if (row.WIDTH) field.width = row.WIDTH;
  if (row.HEIGHT) field.height = row.HEIGHT;
  if (row.SEARCHABLE === 1) field.searchable = true;
  const auto = unflattenAutoValue(row);
  if (auto) field.autoValue = auto;

  if (row.COND_SHOW_FIELD || row.COND_REQUIRED_FIELD) {
    field.conditional = field.conditional || {};
    if (row.COND_SHOW_FIELD) {
      field.conditional.showWhen = { field: row.COND_SHOW_FIELD, value: row.COND_SHOW_VALUE || '' };
    }
    if (row.COND_REQUIRED_FIELD) {
      field.conditional.requiredWhen = { field: row.COND_REQUIRED_FIELD, value: row.COND_SHOW_VALUE || '' };
    }
  }

  const children = fieldChildrenBatch && fieldChildrenBatch[row.FIELD_NAME]
    ? fieldChildrenBatch[row.FIELD_NAME]
    : loadFieldChildren(database, windowId, row.FIELD_NAME);
  if (children.validations.length) field.validations = children.validations;
  if (children.transforms.length) field.transforms = children.transforms;
  if (children.options.length) field.options = children.options;
  if (children.conditionalDefaults.length) field.conditionalDefaults = children.conditionalDefaults;
  if (children.extras.length) applyExtrasToField(field, children.extras);

  if (row.PROPS_JSON) {
    const legacyProps = parseJson(row.PROPS_JSON, {});
    if (legacyProps && Object.keys(legacyProps).length) Object.assign(field, legacyProps);
  }

  if (!field.useInInsert) delete field.useInInsert;
  if (!field.useInUpdate) delete field.useInUpdate;
  if (!field.required) delete field.required;
  if (!field.hiddenInForm) delete field.hiddenInForm;
  if (!field.disabled) delete field.disabled;
  if (!field.readonly) delete field.readonly;
  return field;
}

function collectFieldExtras(field) {
  const extras = [];
  const skip = new Set([
    ...FIELD_BASE_KEYS, ...FIELD_COLUMN_KEYS,
    'validations', 'transforms', 'options', 'conditionalDefaults', 'autoValue', 'conditional', 'systemVariable'
  ]);
  Object.keys(field).forEach((key) => {
    if (skip.has(key)) return;
    const val = field[key];
    if (val == null) return;
    if (typeof val === 'object') {
      extras.push({ key, value: JSON.stringify(val) });
    } else {
      extras.push({ key, value: String(val) });
    }
  });
  return extras;
}

function saveFieldChildren(database, windowId, field) {
  const fieldName = field.field;
  database.prepare('DELETE FROM CFG_FIELD_VALIDATIONS WHERE WINDOW_ID = ? AND FIELD_NAME = ?').run(windowId, fieldName);
  database.prepare('DELETE FROM CFG_FIELD_TRANSFORMS WHERE WINDOW_ID = ? AND FIELD_NAME = ?').run(windowId, fieldName);
  database.prepare('DELETE FROM CFG_FIELD_OPTIONS WHERE WINDOW_ID = ? AND FIELD_NAME = ?').run(windowId, fieldName);
  database.prepare('DELETE FROM CFG_FIELD_COND_DEFAULTS WHERE WINDOW_ID = ? AND FIELD_NAME = ?').run(windowId, fieldName);
  database.prepare('DELETE FROM CFG_FIELD_EXTRA WHERE WINDOW_ID = ? AND FIELD_NAME = ?').run(windowId, fieldName);

  const insVal = database.prepare(`
    INSERT INTO CFG_FIELD_VALIDATIONS (
      WINDOW_ID, FIELD_NAME, SORT_ORDER, VAL_TYPE, ERROR_MSG, MIN_LEN, MAX_LEN, MIN_VAL, MAX_VAL,
      EXACT_LEN, PATTERN, QUERY_SQL, REF_FIELDS, LANGUAGE, START_POS, LENGTH_POS, POSITION_VALUE, CUSTOM_SQL
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  (field.validations || []).forEach((v, idx) => {
    if (!v || !v.type) return;
    insVal.run(
      windowId, fieldName, idx, v.type, v.error || null,
      v.min != null && v.type === 'length' ? v.min : null,
      v.max != null && v.type === 'length' ? v.max : null,
      v.min != null && v.type !== 'length' ? v.min : null,
      v.max != null && v.type !== 'length' ? v.max : null,
      v.exact != null ? v.exact : null,
      v.pattern || null, v.query || null,
      Array.isArray(v.fields) ? v.fields.join(',') : null,
      v.language || null, v.start != null ? v.start : null, v.length != null ? v.length : null,
      v.value || null, v.sql || null
    );
  });

  const insTr = database.prepare(`
    INSERT INTO CFG_FIELD_TRANSFORMS (WINDOW_ID, FIELD_NAME, SORT_ORDER, TRANS_TYPE, LENGTH_N, START_POS, DELIMITER, TAKE_INDEX, REGEX_PATTERN)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  (field.transforms || []).forEach((t, idx) => {
    if (!t || !t.type) return;
    insTr.run(windowId, fieldName, idx, t.type, t.length != null ? t.length : null, t.start != null ? t.start : null,
      t.delimiter || null, t.take != null ? t.take : null, t.pattern || null);
  });

  const insOpt = database.prepare(`
    INSERT INTO CFG_FIELD_OPTIONS (WINDOW_ID, FIELD_NAME, SORT_ORDER, OPT_VALUE, OPT_DISPLAY) VALUES (?, ?, ?, ?, ?)
  `);
  (field.options || []).forEach((o, idx) => {
    if (!o) return;
    insOpt.run(windowId, fieldName, idx, o.value != null ? String(o.value) : '', o.display || o.value || '');
  });

  const insCd = database.prepare(`
    INSERT INTO CFG_FIELD_COND_DEFAULTS (WINDOW_ID, FIELD_NAME, SORT_ORDER, WHEN_FIELD, WHEN_VALUE, DEFAULT_VAL) VALUES (?, ?, ?, ?, ?, ?)
  `);
  (field.conditionalDefaults || []).forEach((c, idx) => {
    if (!c) return;
    insCd.run(windowId, fieldName, idx, c.whenField || c.field || null, c.whenValue != null ? String(c.whenValue) : null, c.defaultValue != null ? String(c.defaultValue) : null);
  });

  const insEx = database.prepare(`
    INSERT INTO CFG_FIELD_EXTRA (WINDOW_ID, FIELD_NAME, EXTRA_KEY, EXTRA_VALUE) VALUES (?, ?, ?, ?)
  `);
  collectFieldExtras(field).forEach((ex) => insEx.run(windowId, fieldName, ex.key, ex.value));
}

const META_MIGRATED_JSON_BLOB = 'migrated_json_blob';
const META_MIGRATED_LEGACY_CONFIG = 'migrated_legacy_config';

function ensureForeignKeys(database) {
  try {
    database.pragma('foreign_keys = ON');
  } catch (_) {}
}

function getMeta(database, key) {
  try {
    const row = database.prepare('SELECT VALUE FROM CFG_META WHERE KEY = ?').get(key);
    return row && row.VALUE != null ? String(row.VALUE) : null;
  } catch (_) {
    return null;
  }
}

function setMeta(database, key, value) {
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO CFG_META (KEY, VALUE, UPDATED_AT)
    VALUES (?, ?, ?)
    ON CONFLICT(KEY) DO UPDATE SET VALUE = excluded.VALUE, UPDATED_AT = excluded.UPDATED_AT
  `).run(key, String(value), now);
}

function isMigrationDone(database, key) {
  return getMeta(database, key) === '1';
}

function ensureMigrationFlags(database) {
  if (!hasStructuredConfig(database)) return;
  if (!isMigrationDone(database, META_MIGRATED_JSON_BLOB)) {
    setMeta(database, META_MIGRATED_JSON_BLOB, '1');
  }
  if (!isMigrationDone(database, META_MIGRATED_LEGACY_CONFIG)) {
    setMeta(database, META_MIGRATED_LEGACY_CONFIG, '1');
  }
}

function validateWindowsUniqueness(windows) {
  const ids = new Set();
  const titles = new Set();
  (windows || []).forEach((win) => {
    const id = String(win.id || win.windowId || '').trim();
    const title = String(win.title || '').trim();
    if (!id) throw new Error('У каждого окна должен быть уникальный ID');
    if (!title) throw new Error('У каждого окна должно быть название');
    if (ids.has(id)) throw new Error('Дублирующий ID окна: ' + id);
    const titleKey = title.toLowerCase();
    if (titles.has(titleKey)) throw new Error('Дублирующее название окна: ' + title);
    ids.add(id);
    titles.add(titleKey);
  });
}

function validateSingleWindowUniqueness(database, win, excludeWindowId) {
  const id = String(win.id || win.windowId || '').trim();
  const title = String(win.title || '').trim();
  if (!id) throw new Error('У каждого окна должен быть уникальный ID');
  if (!title) throw new Error('У каждого окна должно быть название');
  const exclude = String(excludeWindowId || '').trim();
  const idConflict = database.prepare(`
    SELECT WINDOW_ID FROM CFG_WINDOWS WHERE WINDOW_ID = ? AND WINDOW_ID != ?
  `).get(id, exclude);
  if (idConflict) throw new Error('Дублирующий ID окна: ' + id);
  const titleConflict = database.prepare(`
    SELECT WINDOW_ID FROM CFG_WINDOWS WHERE LOWER(TITLE) = LOWER(?) AND WINDOW_ID != ?
  `).get(title, exclude);
  if (titleConflict) throw new Error('Дублирующее название окна: ' + title);
}

function ensureConfigSchema(database) {
  if (!database) return;
  if (schemaReadyDbs.has(database)) return;
  ensureForeignKeys(database);
  database.exec(`
    CREATE TABLE IF NOT EXISTS CFG_META (
      KEY TEXT PRIMARY KEY,
      VALUE TEXT,
      UPDATED_AT TEXT
    );

    CREATE TABLE IF NOT EXISTS CFG_APP (
      ID INTEGER PRIMARY KEY CHECK (ID = 1),
      TITLE TEXT NOT NULL DEFAULT 'GTerminalPro',
      UPDATED_AT TEXT
    );

    CREATE TABLE IF NOT EXISTS CFG_WINDOWS (
      WINDOW_ID TEXT PRIMARY KEY,
      TITLE TEXT NOT NULL UNIQUE,
      ICON TEXT DEFAULT 'fa-table',
      WIN_TYPE TEXT DEFAULT '',
      DATABASE_PATH TEXT,
      QUERY_SQL TEXT,
      SORT_ORDER INTEGER NOT NULL DEFAULT 0,
      DS_QUERY TEXT,
      DS_TABLE TEXT,
      DS_DATABASE TEXT,
      DS_PRIMARY_KEY TEXT,
      LU_LABEL TEXT,
      LU_QUERY TEXT,
      INS_TABLE TEXT,
      UPD_TABLE TEXT,
      UPD_KEY_FIELD TEXT,
      DEL_TABLE TEXT,
      DEL_KEY_FIELD TEXT,
      FORM_TITLE TEXT,
      FORM_TABLE TEXT,
      UPDATED_AT TEXT
    );

    CREATE TABLE IF NOT EXISTS CFG_GRID_COLS (
      ID INTEGER PRIMARY KEY AUTOINCREMENT,
      WINDOW_ID TEXT NOT NULL,
      SORT_ORDER INTEGER NOT NULL DEFAULT 0,
      FIELD_NAME TEXT NOT NULL,
      TITLE TEXT,
      WIDTH TEXT,
      FOREIGN KEY (WINDOW_ID) REFERENCES CFG_WINDOWS(WINDOW_ID) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS CFG_DETAIL_COLS (
      ID INTEGER PRIMARY KEY AUTOINCREMENT,
      WINDOW_ID TEXT NOT NULL,
      SORT_ORDER INTEGER NOT NULL DEFAULT 0,
      FIELD_NAME TEXT NOT NULL,
      TITLE TEXT,
      FOREIGN KEY (WINDOW_ID) REFERENCES CFG_WINDOWS(WINDOW_ID) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS CFG_FILTERS (
      ID INTEGER PRIMARY KEY AUTOINCREMENT,
      WINDOW_ID TEXT NOT NULL,
      SORT_ORDER INTEGER NOT NULL DEFAULT 0,
      FIELD_NAME TEXT,
      TITLE TEXT,
      DEFAULT_OPERATOR TEXT,
      FILTER_TYPE TEXT,
      FILTER_FORMAT TEXT,
      FILTER_PLACEHOLDER TEXT,
      FOREIGN KEY (WINDOW_ID) REFERENCES CFG_WINDOWS(WINDOW_ID) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS CFG_FILTER_OPERATORS (
      ID INTEGER PRIMARY KEY AUTOINCREMENT,
      WINDOW_ID TEXT NOT NULL,
      FILTER_SORT INTEGER NOT NULL DEFAULT 0,
      OP_SORT INTEGER NOT NULL DEFAULT 0,
      OPERATOR TEXT NOT NULL,
      FOREIGN KEY (WINDOW_ID) REFERENCES CFG_WINDOWS(WINDOW_ID) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS CFG_FILTER_CUSTOM_OPS (
      ID INTEGER PRIMARY KEY AUTOINCREMENT,
      WINDOW_ID TEXT NOT NULL,
      FILTER_SORT INTEGER NOT NULL DEFAULT 0,
      OP_SORT INTEGER NOT NULL DEFAULT 0,
      LABEL TEXT,
      SQL_TEXT TEXT,
      NEEDS_VALUE INTEGER DEFAULT 1,
      FOREIGN KEY (WINDOW_ID) REFERENCES CFG_WINDOWS(WINDOW_ID) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS CFG_FIELDS (
      ID INTEGER PRIMARY KEY AUTOINCREMENT,
      WINDOW_ID TEXT NOT NULL,
      SORT_ORDER INTEGER NOT NULL DEFAULT 0,
      FIELD_NAME TEXT NOT NULL,
      TITLE TEXT,
      FIELD_TYPE TEXT DEFAULT 'text',
      USE_INSERT INTEGER NOT NULL DEFAULT 1,
      USE_UPDATE INTEGER NOT NULL DEFAULT 1,
      REQUIRED INTEGER NOT NULL DEFAULT 0,
      HIDDEN INTEGER NOT NULL DEFAULT 0,
      DISABLED INTEGER NOT NULL DEFAULT 0,
      READONLY INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (WINDOW_ID) REFERENCES CFG_WINDOWS(WINDOW_ID) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS CFG_FIELD_VALIDATIONS (
      ID INTEGER PRIMARY KEY AUTOINCREMENT,
      WINDOW_ID TEXT NOT NULL,
      FIELD_NAME TEXT NOT NULL,
      SORT_ORDER INTEGER NOT NULL DEFAULT 0,
      VAL_TYPE TEXT,
      ERROR_MSG TEXT,
      MIN_LEN INTEGER, MAX_LEN INTEGER, MIN_VAL TEXT, MAX_VAL TEXT, EXACT_LEN INTEGER,
      PATTERN TEXT, QUERY_SQL TEXT, REF_FIELDS TEXT, LANGUAGE TEXT,
      START_POS INTEGER, LENGTH_POS INTEGER, POSITION_VALUE TEXT, CUSTOM_SQL TEXT,
      FOREIGN KEY (WINDOW_ID) REFERENCES CFG_WINDOWS(WINDOW_ID) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS CFG_FIELD_TRANSFORMS (
      ID INTEGER PRIMARY KEY AUTOINCREMENT,
      WINDOW_ID TEXT NOT NULL,
      FIELD_NAME TEXT NOT NULL,
      SORT_ORDER INTEGER NOT NULL DEFAULT 0,
      TRANS_TYPE TEXT,
      LENGTH_N INTEGER, START_POS INTEGER, DELIMITER TEXT, TAKE_INDEX INTEGER, REGEX_PATTERN TEXT,
      FOREIGN KEY (WINDOW_ID) REFERENCES CFG_WINDOWS(WINDOW_ID) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS CFG_FIELD_OPTIONS (
      ID INTEGER PRIMARY KEY AUTOINCREMENT,
      WINDOW_ID TEXT NOT NULL,
      FIELD_NAME TEXT NOT NULL,
      SORT_ORDER INTEGER NOT NULL DEFAULT 0,
      OPT_VALUE TEXT, OPT_DISPLAY TEXT,
      FOREIGN KEY (WINDOW_ID) REFERENCES CFG_WINDOWS(WINDOW_ID) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS CFG_FIELD_COND_DEFAULTS (
      ID INTEGER PRIMARY KEY AUTOINCREMENT,
      WINDOW_ID TEXT NOT NULL,
      FIELD_NAME TEXT NOT NULL,
      SORT_ORDER INTEGER NOT NULL DEFAULT 0,
      WHEN_FIELD TEXT, WHEN_VALUE TEXT, DEFAULT_VAL TEXT,
      FOREIGN KEY (WINDOW_ID) REFERENCES CFG_WINDOWS(WINDOW_ID) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS CFG_FIELD_EXTRA (
      ID INTEGER PRIMARY KEY AUTOINCREMENT,
      WINDOW_ID TEXT NOT NULL,
      FIELD_NAME TEXT NOT NULL,
      EXTRA_KEY TEXT NOT NULL,
      EXTRA_VALUE TEXT,
      FOREIGN KEY (WINDOW_ID) REFERENCES CFG_WINDOWS(WINDOW_ID) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS CFG_FORM_BUTTONS (
      ID INTEGER PRIMARY KEY AUTOINCREMENT,
      WINDOW_ID TEXT NOT NULL,
      SORT_ORDER INTEGER NOT NULL DEFAULT 0,
      LABEL TEXT,
      ACTION TEXT,
      POSITION TEXT,
      MODES TEXT,
      SUCCESS_MSG TEXT,
      ERROR_MSG TEXT,
      TEMPLATE_DIR TEXT,
      TEMPLATE_FILE TEXT,
      OUTPUT_FILENAME TEXT,
      STYLE_BG TEXT,
      STYLE_COLOR TEXT,
      STYLE_WIDTH TEXT,
      STYLE_HEIGHT TEXT,
      SAVE_AFTER INTEGER DEFAULT 0,
      FOREIGN KEY (WINDOW_ID) REFERENCES CFG_WINDOWS(WINDOW_ID) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS CFG_BUTTON_CELL_MAP (
      ID INTEGER PRIMARY KEY AUTOINCREMENT,
      WINDOW_ID TEXT NOT NULL,
      BTN_SORT INTEGER NOT NULL DEFAULT 0,
      FIELD_NAME TEXT NOT NULL,
      CELL_REF TEXT NOT NULL,
      FOREIGN KEY (WINDOW_ID) REFERENCES CFG_WINDOWS(WINDOW_ID) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS CFG_BUTTON_SETFIELDS (
      ID INTEGER PRIMARY KEY AUTOINCREMENT,
      WINDOW_ID TEXT NOT NULL,
      BTN_SORT INTEGER NOT NULL DEFAULT 0,
      SET_SORT INTEGER NOT NULL DEFAULT 0,
      FIELD_NAME TEXT,
      VALUE_TYPE TEXT,
      SET_VALUE TEXT,
      FOREIGN KEY (WINDOW_ID) REFERENCES CFG_WINDOWS(WINDOW_ID) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS CFG_ROW_FORMAT (
      ID INTEGER PRIMARY KEY AUTOINCREMENT,
      WINDOW_ID TEXT NOT NULL,
      SORT_ORDER INTEGER NOT NULL DEFAULT 0,
      FIELD_NAME TEXT,
      OPERATOR TEXT,
      VALUE TEXT,
      ENABLED INTEGER DEFAULT 1,
      STYLE_BORDER TEXT,
      STYLE_BG TEXT,
      STYLE_COLOR TEXT,
      FOREIGN KEY (WINDOW_ID) REFERENCES CFG_WINDOWS(WINDOW_ID) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS CFG_REPORTS (
      ID INTEGER PRIMARY KEY AUTOINCREMENT,
      WINDOW_ID TEXT NOT NULL,
      REPORT_ID TEXT NOT NULL,
      SORT_ORDER INTEGER NOT NULL DEFAULT 0,
      TITLE TEXT,
      DESCRIPTION TEXT,
      QUERY_SQL TEXT,
      EXPORT_FILENAME TEXT,
      PAGE_SIZE INTEGER,
      FOREIGN KEY (WINDOW_ID) REFERENCES CFG_WINDOWS(WINDOW_ID) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS CFG_REPORT_GRID (
      ID INTEGER PRIMARY KEY AUTOINCREMENT,
      WINDOW_ID TEXT NOT NULL,
      REPORT_ID TEXT NOT NULL,
      SORT_ORDER INTEGER NOT NULL DEFAULT 0,
      FIELD_NAME TEXT NOT NULL,
      TITLE TEXT,
      FOREIGN KEY (WINDOW_ID) REFERENCES CFG_WINDOWS(WINDOW_ID) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS CFG_RELATIONS (
      ID INTEGER PRIMARY KEY AUTOINCREMENT,
      WINDOW_ID TEXT NOT NULL,
      SORT_ORDER INTEGER NOT NULL DEFAULT 0,
      REL_TYPE TEXT,
      TARGET_ID TEXT,
      TARGET_WINDOW TEXT,
      FOREIGN_KEY TEXT,
      CHILD_FOREIGN_KEY TEXT,
      FOREIGN KEY (WINDOW_ID) REFERENCES CFG_WINDOWS(WINDOW_ID) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS IDX_CFG_GRID_WIN ON CFG_GRID_COLS(WINDOW_ID, SORT_ORDER);
    CREATE INDEX IF NOT EXISTS IDX_CFG_DETAIL_WIN ON CFG_DETAIL_COLS(WINDOW_ID, SORT_ORDER);
    CREATE INDEX IF NOT EXISTS IDX_CFG_FILTER_WIN ON CFG_FILTERS(WINDOW_ID, SORT_ORDER);
    CREATE INDEX IF NOT EXISTS IDX_CFG_FIELD_WIN ON CFG_FIELDS(WINDOW_ID, SORT_ORDER);
    CREATE INDEX IF NOT EXISTS IDX_CFG_BTN_WIN ON CFG_FORM_BUTTONS(WINDOW_ID, SORT_ORDER);
    CREATE INDEX IF NOT EXISTS IDX_CFG_ROW_WIN ON CFG_ROW_FORMAT(WINDOW_ID, SORT_ORDER);
    CREATE INDEX IF NOT EXISTS IDX_CFG_REPORT_WIN ON CFG_REPORTS(WINDOW_ID, SORT_ORDER);
    CREATE INDEX IF NOT EXISTS IDX_CFG_REL_WIN ON CFG_RELATIONS(WINDOW_ID, SORT_ORDER);
  `);
  ensureFieldColumns(database);
  upgradeLegacyTableColumns(database);
  schemaReadyDbs.add(database);
}

function hasStructuredConfig(database) {
  try {
    const row = database.prepare('SELECT COUNT(*) AS cnt FROM CFG_WINDOWS').get();
    return !!(row && row.cnt > 0);
  } catch (_) {
    return false;
  }
}

function getConfigStamp(database) {
  try {
    const app = database.prepare('SELECT UPDATED_AT FROM CFG_APP WHERE ID = ?').get(CFG_APP_ID);
    const wins = database.prepare('SELECT MAX(UPDATED_AT) AS m FROM CFG_WINDOWS').get();
    return [app && app.UPDATED_AT ? app.UPDATED_AT : '', wins && wins.m ? wins.m : ''].join('|');
  } catch (_) {
    return '';
  }
}

function loadWindowChildMaps(database, windowId) {
  const grid = database.prepare(`
    SELECT FIELD_NAME, TITLE, WIDTH
    FROM CFG_GRID_COLS WHERE WINDOW_ID = ? ORDER BY SORT_ORDER, ID
  `).all(windowId).map((row) => {
    const col = { field: row.FIELD_NAME, title: row.TITLE || row.FIELD_NAME };
    if (row.WIDTH) col.width = row.WIDTH;
    return col;
  });

  const details = database.prepare(`
    SELECT FIELD_NAME, TITLE
    FROM CFG_DETAIL_COLS WHERE WINDOW_ID = ? ORDER BY SORT_ORDER, ID
  `).all(windowId).map((row) => ({
    field: row.FIELD_NAME,
    title: row.TITLE || row.FIELD_NAME
  }));

  const filterRows = database.prepare(`
    SELECT * FROM CFG_FILTERS WHERE WINDOW_ID = ? ORDER BY SORT_ORDER, ID
  `).all(windowId);

  const filterOpsBySort = {};
  database.prepare(`
    SELECT FILTER_SORT, OPERATOR FROM CFG_FILTER_OPERATORS
    WHERE WINDOW_ID = ? ORDER BY FILTER_SORT, OP_SORT, ID
  `).all(windowId).forEach((op) => {
    const key = op.FILTER_SORT;
    if (!filterOpsBySort[key]) filterOpsBySort[key] = [];
    if (op.OPERATOR) filterOpsBySort[key].push(op.OPERATOR);
  });

  const filterCustomBySort = {};
  database.prepare(`
    SELECT FILTER_SORT, LABEL, SQL_TEXT, NEEDS_VALUE FROM CFG_FILTER_CUSTOM_OPS
    WHERE WINDOW_ID = ? ORDER BY FILTER_SORT, OP_SORT, ID
  `).all(windowId).forEach((op) => {
    const key = op.FILTER_SORT;
    if (!filterCustomBySort[key]) filterCustomBySort[key] = [];
    const label = op.LABEL || '';
    const sql = op.SQL_TEXT || '';
    if (!label && !sql) return;
    filterCustomBySort[key].push({
      label,
      sql,
      needsValue: op.NEEDS_VALUE !== 0
    });
  });

  const filters = filterRows.map((row) => {
    const filter = {
      field: row.FIELD_NAME,
      title: row.TITLE || row.FIELD_NAME
    };
    let operators = filterOpsBySort[row.SORT_ORDER] || [];
    let customOperators = filterCustomBySort[row.SORT_ORDER] || [];
    if (!operators.length && row.OPERATORS_JSON) operators = parseJson(row.OPERATORS_JSON, []);
    if (!customOperators.length && row.CUSTOM_OPS_JSON) customOperators = parseJson(row.CUSTOM_OPS_JSON, []);
    if (operators.length) {
      filter.operators = operators;
    } else if (row.FILTER_TYPE === 'choice') {
      filter.operators = [];
    }
    if (customOperators.length) filter.customOperators = customOperators;
    if (row.DEFAULT_OPERATOR) filter.defaultOperator = row.DEFAULT_OPERATOR;
    if (row.FILTER_TYPE) filter.type = row.FILTER_TYPE;
    if (row.FILTER_FORMAT) filter.format = row.FILTER_FORMAT;
    if (row.FILTER_PLACEHOLDER) filter.placeholder = row.FILTER_PLACEHOLDER;
    return filter;
  });

  const fieldRows = database.prepare(`
    SELECT * FROM CFG_FIELDS WHERE WINDOW_ID = ? ORDER BY SORT_ORDER, ID
  `).all(windowId);
  const fieldChildrenBatch = loadFieldChildrenBatch(database, windowId);
  const fields = fieldRows.map((row) => mergeFieldRow(database, windowId, row, fieldChildrenBatch));

  const btnCellMapBySort = {};
  database.prepare(`
    SELECT BTN_SORT, FIELD_NAME, CELL_REF FROM CFG_BUTTON_CELL_MAP
    WHERE WINDOW_ID = ? ORDER BY BTN_SORT, ID
  `).all(windowId).forEach((m) => {
    if (!btnCellMapBySort[m.BTN_SORT]) btnCellMapBySort[m.BTN_SORT] = {};
    btnCellMapBySort[m.BTN_SORT][m.FIELD_NAME] = m.CELL_REF;
  });

  const btnSetFieldsBySort = {};
  database.prepare(`
    SELECT BTN_SORT, FIELD_NAME, VALUE_TYPE, SET_VALUE FROM CFG_BUTTON_SETFIELDS
    WHERE WINDOW_ID = ? ORDER BY BTN_SORT, SET_SORT, ID
  `).all(windowId).forEach((s) => {
    if (!btnSetFieldsBySort[s.BTN_SORT]) btnSetFieldsBySort[s.BTN_SORT] = [];
    btnSetFieldsBySort[s.BTN_SORT].push({
      field: s.FIELD_NAME,
      valueType: s.VALUE_TYPE || 'constant',
      value: s.SET_VALUE
    });
  });

  const formCustomButtons = database.prepare(`
    SELECT * FROM CFG_FORM_BUTTONS WHERE WINDOW_ID = ? ORDER BY SORT_ORDER, ID
  `).all(windowId).map((row) => {
    const btn = {
      label: row.LABEL || '',
      action: row.ACTION || ''
    };
    if (row.PROPS_JSON) Object.assign(btn, parseJson(row.PROPS_JSON, {}));
    if (row.POSITION) btn.position = row.POSITION;
    if (row.MODES) btn.modes = row.MODES.split(',').map((s) => s.trim()).filter(Boolean);
    if (row.SUCCESS_MSG) btn.successMessage = row.SUCCESS_MSG;
    if (row.ERROR_MSG) btn.errorMessage = row.ERROR_MSG;
    if (row.TEMPLATE_DIR) btn.templateDir = row.TEMPLATE_DIR;
    if (row.TEMPLATE_FILE) btn.templateFile = row.TEMPLATE_FILE;
    if (row.OUTPUT_FILENAME) btn.outputFilename = row.OUTPUT_FILENAME;
    if (row.SAVE_AFTER === 1) btn.saveAfter = true;
    if (row.SHOW_WHEN_SQL) {
      btn.showWhen = {
        type: 'sql',
        sql: row.SHOW_WHEN_SQL,
        paramFields: row.SHOW_WHEN_PARAM_FIELDS
          ? row.SHOW_WHEN_PARAM_FIELDS.split(',').map((s) => s.trim()).filter(Boolean)
          : []
      };
    } else if (row.SHOW_WHEN_FIELD) {
      btn.showWhen = {
        type: 'field',
        field: row.SHOW_WHEN_FIELD,
        operator: row.SHOW_WHEN_OPERATOR || 'notEmpty',
        value: row.SHOW_WHEN_VALUE != null ? row.SHOW_WHEN_VALUE : ''
      };
    }
    if (row.STYLE_BG || row.STYLE_COLOR || row.STYLE_WIDTH || row.STYLE_HEIGHT) {
      btn.style = {};
      if (row.STYLE_BG) btn.style.bg = row.STYLE_BG;
      if (row.STYLE_COLOR) btn.style.color = row.STYLE_COLOR;
      if (row.STYLE_WIDTH) btn.style.width = row.STYLE_WIDTH;
      if (row.STYLE_HEIGHT) btn.style.height = row.STYLE_HEIGHT;
    }
    const cellMap = btnCellMapBySort[row.SORT_ORDER] || {};
    if (Object.keys(cellMap).length) btn.defaultCellMapping = cellMap;

    const setFields = btnSetFieldsBySort[row.SORT_ORDER] || [];
    if (setFields.length) btn.set = setFields;
    return btn;
  });

  const rowFormatting = database.prepare(`
    SELECT * FROM CFG_ROW_FORMAT WHERE WINDOW_ID = ? ORDER BY SORT_ORDER, ID
  `).all(windowId).map((row) => {
    if (row.RULE_JSON && !row.FIELD_NAME) return parseJson(row.RULE_JSON, {});
    const rule = {
      field: row.FIELD_NAME,
      operator: row.OPERATOR || '',
      value: row.VALUE || '',
      enabled: row.ENABLED !== 0
    };
    if (row.CONDITION_TYPE) rule.conditionType = row.CONDITION_TYPE;
    if (row.VARIANTS_JSON) {
      const variants = parseJson(row.VARIANTS_JSON, []);
      if (Array.isArray(variants) && variants.length) rule.variants = variants;
    }
    if (row.STYLE_BORDER || row.STYLE_BG || row.STYLE_COLOR) {
      rule.style = {};
      if (row.STYLE_BORDER) rule.style.border = row.STYLE_BORDER;
      if (row.STYLE_BG) rule.style.backgroundColor = row.STYLE_BG;
      if (row.STYLE_COLOR) rule.style.color = row.STYLE_COLOR;
    }
    if (row.ICON_COLUMN || row.ICON_TEXT) {
      rule.iconColumn = row.ICON_COLUMN || null;
      rule.icon = row.ICON_TEXT || '';
      if (row.ICON_COLOR) rule.iconColor = row.ICON_COLOR;
    }
    return rule;
  }).filter((rule) => rule && rule.field);

  const reportRows = database.prepare(`
    SELECT * FROM CFG_REPORTS WHERE WINDOW_ID = ? ORDER BY SORT_ORDER, ID
  `).all(windowId);

  const reportGridById = {};
  database.prepare(`
    SELECT REPORT_ID, FIELD_NAME, TITLE FROM CFG_REPORT_GRID
    WHERE WINDOW_ID = ? ORDER BY REPORT_ID, SORT_ORDER, ID
  `).all(windowId).forEach((g) => {
    if (!reportGridById[g.REPORT_ID]) reportGridById[g.REPORT_ID] = [];
    reportGridById[g.REPORT_ID].push({ field: g.FIELD_NAME, title: g.TITLE || g.FIELD_NAME });
  });

  const reports = reportRows.map((row) => {
    if (row.REPORT_JSON && !row.QUERY_SQL) return parseJson(row.REPORT_JSON, {});
    const report = {
      id: row.REPORT_ID,
      title: row.TITLE || row.REPORT_ID,
      query: row.QUERY_SQL || ''
    };
    if (row.DESCRIPTION) report.description = row.DESCRIPTION;
    if (row.EXPORT_FILENAME) report.exportFilename = row.EXPORT_FILENAME;
    if (row.PAGE_SIZE) report.pageSize = row.PAGE_SIZE;
    const grid = reportGridById[row.REPORT_ID] || [];
    if (grid.length) report.grid = grid;
    return report;
  });

  const relations = database.prepare(`
    SELECT * FROM CFG_RELATIONS WHERE WINDOW_ID = ? ORDER BY SORT_ORDER, ID
  `).all(windowId).map((row) => {
    if (row.RELATION_JSON && !row.REL_TYPE) return parseJson(row.RELATION_JSON, {});
    const rel = {};
    if (row.REL_TYPE) rel.type = row.REL_TYPE;
    if (row.TARGET_ID) rel.targetId = row.TARGET_ID;
    if (row.TARGET_WINDOW) rel.targetWindow = row.TARGET_WINDOW;
    if (row.FOREIGN_KEY) rel.foreignKey = row.FOREIGN_KEY;
    if (row.CHILD_FOREIGN_KEY) rel.childForeignKey = row.CHILD_FOREIGN_KEY;
    return rel;
  }).filter((rel) => Object.keys(rel).length);

  return { grid, details, filters, fields, formCustomButtons, rowFormatting, reports, relations };
}

function rowToWindow(row, childMaps) {
  const win = {
    id: row.WINDOW_ID,
    title: row.TITLE,
    icon: row.ICON || 'fa-table'
  };

  if (row.WIN_TYPE) win.type = row.WIN_TYPE;
  if (row.DATABASE_PATH) win.database = row.DATABASE_PATH;
  if (row.QUERY_SQL) win.query = row.QUERY_SQL;

  if (row.DS_QUERY || row.DS_TABLE || row.DS_DATABASE || row.DS_PRIMARY_KEY) {
    win.dataSource = {};
    if (row.DS_QUERY) win.dataSource.query = row.DS_QUERY;
    if (row.DS_TABLE) win.dataSource.table = row.DS_TABLE;
    if (row.DS_DATABASE) win.dataSource.database = row.DS_DATABASE;
    if (row.DS_PRIMARY_KEY) win.dataSource.primaryKey = row.DS_PRIMARY_KEY;
  }

  if (row.LU_LABEL || row.LU_QUERY) {
    win.lastUpdate = {
      label: row.LU_LABEL || '',
      query: row.LU_QUERY || ''
    };
  }

  const { grid, details, filters, fields, formCustomButtons, rowFormatting, reports, relations } = childMaps;
  if (grid.length) win.grid = grid;
  if (details.length) win.details = details;
  if (filters.length) win.filters = filters;
  if (fields.length) {
    win.fields = fields;
    const insFields = fields.filter((f) => f.useInInsert !== false);
    const updFields = fields.filter((f) => f.useInUpdate !== false);
    if (row.INS_TABLE && insFields.length) {
      win.insert = { table: row.INS_TABLE, fields: insFields };
    }
    if (row.UPD_TABLE && updFields.length) {
      win.update = {
        table: row.UPD_TABLE,
        keyField: row.UPD_KEY_FIELD || '',
        fields: updFields
      };
    }
  }
  if (row.DEL_TABLE || row.DEL_KEY_FIELD) {
    win.delete = {
      table: row.DEL_TABLE || '',
      keyField: row.DEL_KEY_FIELD || ''
    };
  }
  if (row.FORM_TITLE || row.FORM_TABLE || fields.length) {
    win.form = {
      title: row.FORM_TITLE || row.TITLE,
      table: row.FORM_TABLE || row.INS_TABLE || row.DS_TABLE || '',
      fields: fields.map((f) => ({
        field: f.field,
        title: f.title || f.field,
        type: f.type || 'text',
        required: !!f.required
      }))
    };
  }
  if (formCustomButtons.length) win.formCustomButtons = formCustomButtons;
  if (rowFormatting.length) win.rowFormatting = rowFormatting;
  if (relations.length) win.relations = relations;
  if (row.WIN_TYPE === 'reports' && reports.length) win.reports = reports;

  return win;
}

function loadAppConfigFromDb(database) {
  ensureConfigSchema(database);
  if (!hasStructuredConfig(database)) return null;

  const appRow = database.prepare('SELECT TITLE FROM CFG_APP WHERE ID = ?').get(CFG_APP_ID);
  const windows = database.prepare(`
    SELECT * FROM CFG_WINDOWS ORDER BY SORT_ORDER, WINDOW_ID
  `).all().map((row) => rowToWindow(row, loadWindowChildMaps(database, row.WINDOW_ID)));

  const result = {
    title: (appRow && appRow.TITLE) || 'GTerminalPro',
    windows
  };
  return result;
}

function clearWindowChildren(database, windowId) {
  const tables = [
    'CFG_FILTER_CUSTOM_OPS', 'CFG_FILTER_OPERATORS', 'CFG_FILTERS',
    'CFG_FIELD_VALIDATIONS', 'CFG_FIELD_TRANSFORMS', 'CFG_FIELD_OPTIONS',
    'CFG_FIELD_COND_DEFAULTS', 'CFG_FIELD_EXTRA', 'CFG_FIELDS',
    'CFG_BUTTON_CELL_MAP', 'CFG_BUTTON_SETFIELDS', 'CFG_FORM_BUTTONS',
    'CFG_ROW_FORMAT', 'CFG_REPORT_GRID', 'CFG_REPORTS', 'CFG_RELATIONS',
    'CFG_GRID_COLS', 'CFG_DETAIL_COLS'
  ];
  tables.forEach((table) => {
    database.prepare(`DELETE FROM ${table} WHERE WINDOW_ID = ?`).run(windowId);
  });
}

function saveWindowToDb(database, win, sortOrder, now) {
  const windowId = String(win.id || win.windowId || win.title || `win_${sortOrder}`);
  const ds = win.dataSource || {};
  const lastUpd = win.lastUpdate || {};
  const ins = win.insert || {};
  const upd = win.update || {};
  const del = win.delete || {};
  const form = win.form || {};
  const winType = String(win.type || '').toLowerCase() === 'reports' ? 'reports' : (win.type || '');

  database.prepare(`
    INSERT INTO CFG_WINDOWS (
      WINDOW_ID, TITLE, ICON, WIN_TYPE, DATABASE_PATH, QUERY_SQL, SORT_ORDER,
      DS_QUERY, DS_TABLE, DS_DATABASE, DS_PRIMARY_KEY,
      LU_LABEL, LU_QUERY,
      INS_TABLE, UPD_TABLE, UPD_KEY_FIELD, DEL_TABLE, DEL_KEY_FIELD,
      FORM_TITLE, FORM_TABLE, UPDATED_AT
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(WINDOW_ID) DO UPDATE SET
      TITLE = excluded.TITLE,
      ICON = excluded.ICON,
      WIN_TYPE = excluded.WIN_TYPE,
      DATABASE_PATH = excluded.DATABASE_PATH,
      QUERY_SQL = excluded.QUERY_SQL,
      SORT_ORDER = excluded.SORT_ORDER,
      DS_QUERY = excluded.DS_QUERY,
      DS_TABLE = excluded.DS_TABLE,
      DS_DATABASE = excluded.DS_DATABASE,
      DS_PRIMARY_KEY = excluded.DS_PRIMARY_KEY,
      LU_LABEL = excluded.LU_LABEL,
      LU_QUERY = excluded.LU_QUERY,
      INS_TABLE = excluded.INS_TABLE,
      UPD_TABLE = excluded.UPD_TABLE,
      UPD_KEY_FIELD = excluded.UPD_KEY_FIELD,
      DEL_TABLE = excluded.DEL_TABLE,
      DEL_KEY_FIELD = excluded.DEL_KEY_FIELD,
      FORM_TITLE = excluded.FORM_TITLE,
      FORM_TABLE = excluded.FORM_TABLE,
      UPDATED_AT = excluded.UPDATED_AT
  `).run(
    windowId,
    win.title || windowId,
    win.icon || (winType === 'reports' ? 'fa-chart-bar' : 'fa-table'),
    winType,
    win.database || ds.database || null,
    win.query || ds.query || null,
    sortOrder,
    ds.query || win.query || null,
    ds.table || ins.table || upd.table || del.table || null,
    ds.database || win.database || null,
    ds.primaryKey || upd.keyField || del.keyField || null,
    lastUpd.label || lastUpd.description || null,
    lastUpd.query || lastUpd.sql || null,
    ins.table || form.table || ds.table || null,
    upd.table || ins.table || form.table || ds.table || null,
    upd.keyField || del.keyField || ds.primaryKey || null,
    del.table || upd.table || ins.table || null,
    del.keyField || upd.keyField || null,
    form.title || win.title || null,
    form.table || ins.table || null,
    now
  );

  clearWindowChildren(database, windowId);

  const insertGrid = database.prepare(`
    INSERT INTO CFG_GRID_COLS (WINDOW_ID, SORT_ORDER, FIELD_NAME, TITLE, WIDTH)
    VALUES (?, ?, ?, ?, ?)
  `);
  (win.grid || []).forEach((col, idx) => {
    if (!col || !col.field) return;
    insertGrid.run(windowId, idx, col.field, col.title || col.field, col.width || null);
  });

  const insertDetail = database.prepare(`
    INSERT INTO CFG_DETAIL_COLS (WINDOW_ID, SORT_ORDER, FIELD_NAME, TITLE)
    VALUES (?, ?, ?, ?)
  `);
  (win.details || []).forEach((col, idx) => {
    if (!col || !col.field) return;
    insertDetail.run(windowId, idx, col.field, col.title || col.field);
  });

  const insertFilter = database.prepare(`
    INSERT INTO CFG_FILTERS (WINDOW_ID, SORT_ORDER, FIELD_NAME, TITLE, DEFAULT_OPERATOR, FILTER_TYPE, FILTER_FORMAT, FILTER_PLACEHOLDER)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFilterOp = database.prepare(`
    INSERT INTO CFG_FILTER_OPERATORS (WINDOW_ID, FILTER_SORT, OP_SORT, OPERATOR) VALUES (?, ?, ?, ?)
  `);
  const insertFilterCustom = database.prepare(`
    INSERT INTO CFG_FILTER_CUSTOM_OPS (WINDOW_ID, FILTER_SORT, OP_SORT, LABEL, SQL_TEXT, NEEDS_VALUE) VALUES (?, ?, ?, ?, ?, ?)
  `);
  (win.filters || []).forEach((filter, idx) => {
    if (!filter) return;
    insertFilter.run(
      windowId, idx, filter.field || null, filter.title || filter.field || null,
      filter.defaultOperator || null, filter.type || null, filter.format || null, filter.placeholder || null
    );
    (filter.operators || []).forEach((op, opIdx) => {
      if (!op) return;
      insertFilterOp.run(windowId, idx, opIdx, String(op));
    });
    (filter.customOperators || []).forEach((cop, copIdx) => {
      if (!cop) return;
      const copLabel = cop.label || '';
      const copSql = cop.sql || '';
      if (!copLabel && !copSql) return;
      insertFilterCustom.run(windowId, idx, copIdx, copLabel, copSql, cop.needsValue === false ? 0 : 1);
    });
  });

  const masterFields = Array.isArray(win.fields) && win.fields.length
    ? win.fields
    : (Array.isArray(upd.fields) && upd.fields.length ? upd.fields : (ins.fields || []));

  const insertField = database.prepare(`
    INSERT INTO CFG_FIELDS (
      WINDOW_ID, SORT_ORDER, FIELD_NAME, TITLE, FIELD_TYPE,
      USE_INSERT, USE_UPDATE, REQUIRED, HIDDEN, DISABLED, READONLY,
      DEFAULT_VALUE, PLACEHOLDER, HELP_TEXT, DEPENDS_ON, LOOKUP_QUERY, LOOKUP_WINDOW,
      SYSTEM_VARIABLE, WIDTH, HEIGHT, SEARCHABLE,
      AUTO_TYPE, AUTO_QUERY, AUTO_FORMAT, AUTO_CONSTANT, AUTO_MIN, AUTO_MAX, COPY_FROM_FIELD,
      COND_SHOW_FIELD, COND_SHOW_VALUE, COND_REQUIRED_FIELD
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  masterFields.forEach((field, idx) => {
    if (!field || !field.field) return;
    const autoFlat = flattenAutoValue(field.autoValue);
    const cond = field.conditional || {};
    insertField.run(
      windowId, idx, field.field, field.title || field.field, field.type || 'text',
      field.useInInsert === false ? 0 : 1,
      field.useInUpdate === false ? 0 : 1,
      field.required ? 1 : 0,
      field.hiddenInForm ? 1 : 0,
      field.disabled ? 1 : 0,
      field.readonly ? 1 : 0,
      field.defaultValue != null ? String(field.defaultValue) : null,
      field.placeholder || null,
      field.help || null,
      field.dependsOn || null,
      field.lookupQuery || null,
      field.lookupWindow || null,
      field.systemVariable || null,
      field.width || null,
      field.height || null,
      field.searchable ? 1 : 0,
      autoFlat.AUTO_TYPE || null,
      autoFlat.AUTO_QUERY || null,
      autoFlat.AUTO_FORMAT || null,
      autoFlat.AUTO_CONSTANT || null,
      autoFlat.AUTO_MIN || null,
      autoFlat.AUTO_MAX || null,
      autoFlat.COPY_FROM_FIELD || null,
      cond.showWhen && cond.showWhen.field ? cond.showWhen.field : null,
      cond.showWhen && cond.showWhen.value != null ? String(cond.showWhen.value) : null,
      cond.requiredWhen && cond.requiredWhen.field ? cond.requiredWhen.field : null
    );
    saveFieldChildren(database, windowId, field);
  });

  const insertButton = database.prepare(`
    INSERT INTO CFG_FORM_BUTTONS (
      WINDOW_ID, SORT_ORDER, LABEL, ACTION, POSITION, MODES, SUCCESS_MSG, ERROR_MSG,
      TEMPLATE_DIR, TEMPLATE_FILE, OUTPUT_FILENAME, STYLE_BG, STYLE_COLOR, STYLE_WIDTH, STYLE_HEIGHT, SAVE_AFTER,
      SHOW_WHEN_FIELD, SHOW_WHEN_OPERATOR, SHOW_WHEN_VALUE, SHOW_WHEN_SQL, SHOW_WHEN_PARAM_FIELDS
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCellMap = database.prepare(`
    INSERT INTO CFG_BUTTON_CELL_MAP (WINDOW_ID, BTN_SORT, FIELD_NAME, CELL_REF) VALUES (?, ?, ?, ?)
  `);
  const insertSetField = database.prepare(`
    INSERT INTO CFG_BUTTON_SETFIELDS (WINDOW_ID, BTN_SORT, SET_SORT, FIELD_NAME, VALUE_TYPE, SET_VALUE) VALUES (?, ?, ?, ?, ?, ?)
  `);
  (win.formCustomButtons || []).forEach((btn, idx) => {
    if (!btn) return;
    const style = btn.style || {};
    const showWhen = btn.showWhen || null;
    const showWhenType = showWhen
      ? (showWhen.type || (showWhen.sql ? 'sql' : (showWhen.field ? 'field' : null)))
      : null;
    let swField = null;
    let swOp = null;
    let swVal = null;
    let swSql = null;
    let swParams = null;
    if (showWhenType === 'sql' && showWhen.sql) {
      swSql = showWhen.sql;
      swParams = Array.isArray(showWhen.paramFields)
        ? showWhen.paramFields.join(',')
        : (showWhen.paramFields || null);
    } else if (showWhenType === 'field' && showWhen.field) {
      swField = showWhen.field;
      swOp = showWhen.operator || 'notEmpty';
      swVal = showWhen.value != null && showWhen.value !== '' ? String(showWhen.value) : null;
    }
    insertButton.run(
      windowId, idx, btn.label || '', btn.action || '', btn.position || null,
      Array.isArray(btn.modes) ? btn.modes.join(',') : null,
      btn.successMessage || null, btn.errorMessage || null,
      btn.templateDir || null, btn.templateFile || null, btn.outputFilename || null,
      style.bg || null, style.color || null, style.width || null, style.height || null,
      btn.saveAfter ? 1 : 0,
      swField, swOp, swVal, swSql, swParams
    );
    const mapping = btn.defaultCellMapping || {};
    Object.keys(mapping).forEach((fieldName, mapIdx) => {
      insertCellMap.run(windowId, idx, fieldName, mapping[fieldName]);
    });
    (btn.set || []).forEach((setItem, setIdx) => {
      if (!setItem) return;
      insertSetField.run(windowId, idx, setIdx, setItem.field || null, setItem.valueType || 'constant', setItem.value != null ? String(setItem.value) : null);
    });
  });

  const insertRowFmt = database.prepare(`
    INSERT INTO CFG_ROW_FORMAT (
      WINDOW_ID, SORT_ORDER, FIELD_NAME, OPERATOR, VALUE, ENABLED,
      STYLE_BORDER, STYLE_BG, STYLE_COLOR, CONDITION_TYPE, VARIANTS_JSON,
      ICON_COLUMN, ICON_TEXT, ICON_COLOR
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  (win.rowFormatting || []).forEach((rule, idx) => {
    if (!rule) return;
    const style = rule.style || {};
    const conditionType = rule.conditionType || 'field';
    const variantsJson = (conditionType === 'select' && Array.isArray(rule.variants) && rule.variants.length)
      ? JSON.stringify(rule.variants)
      : null;
    insertRowFmt.run(
      windowId, idx, rule.field || null, rule.operator || null, rule.value != null ? String(rule.value) : null,
      rule.enabled === false ? 0 : 1,
      style.border || null, style.backgroundColor || style.bg || null, style.color || null,
      conditionType === 'select' ? 'select' : null,
      variantsJson,
      rule.iconColumn || null, rule.icon || null, rule.iconColor || null
    );
  });

  const insertReport = database.prepare(`
    INSERT INTO CFG_REPORTS (WINDOW_ID, REPORT_ID, SORT_ORDER, TITLE, DESCRIPTION, QUERY_SQL, EXPORT_FILENAME, PAGE_SIZE)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertReportGrid = database.prepare(`
    INSERT INTO CFG_REPORT_GRID (WINDOW_ID, REPORT_ID, SORT_ORDER, FIELD_NAME, TITLE) VALUES (?, ?, ?, ?, ?)
  `);
  (win.reports || []).forEach((report, idx) => {
    if (!report) return;
    const reportId = report.id || report.reportId || `report_${idx}`;
    insertReport.run(
      windowId, reportId, idx, report.title || reportId, report.description || null,
      report.query || report.sql || null, report.exportFilename || null, report.pageSize || null
    );
    (report.grid || []).forEach((col, colIdx) => {
      if (!col || !col.field) return;
      insertReportGrid.run(windowId, reportId, colIdx, col.field, col.title || col.field);
    });
  });

  const insertRelation = database.prepare(`
    INSERT INTO CFG_RELATIONS (WINDOW_ID, SORT_ORDER, REL_TYPE, TARGET_ID, TARGET_WINDOW, FOREIGN_KEY, CHILD_FOREIGN_KEY)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  (win.relations || []).forEach((rel, idx) => {
    if (!rel) return;
    insertRelation.run(
      windowId, idx, rel.type || null, rel.targetId || rel.targetWindow || null,
      rel.targetWindow || rel.targetId || null, rel.foreignKey || null, rel.childForeignKey || null
    );
  });
}

function saveSingleWindowToDb(database, win, options) {
  ensureConfigSchema(database);
  const opts = options || {};
  const windowId = String(win.id || win.windowId || '').trim();
  const excludeId = opts.excludeWindowId != null
    ? String(opts.excludeWindowId).trim()
    : windowId;
  validateSingleWindowUniqueness(database, win, excludeId);

  const now = new Date().toISOString();
  let sortOrder = opts.sortOrder;
  if (sortOrder == null) {
    const existing = database.prepare('SELECT SORT_ORDER FROM CFG_WINDOWS WHERE WINDOW_ID = ?').get(windowId);
    if (existing) {
      sortOrder = existing.SORT_ORDER;
    } else {
      const maxRow = database.prepare('SELECT COALESCE(MAX(SORT_ORDER), -1) AS m FROM CFG_WINDOWS').get();
      sortOrder = (maxRow && maxRow.m != null ? maxRow.m : -1) + 1;
    }
  }

  const tx = database.transaction(() => {
    database.prepare(`
      INSERT INTO CFG_APP (ID, TITLE, UPDATED_AT)
      VALUES (?, COALESCE((SELECT TITLE FROM CFG_APP WHERE ID = ?), 'GTerminalPro'), ?)
      ON CONFLICT(ID) DO UPDATE SET UPDATED_AT = excluded.UPDATED_AT
    `).run(CFG_APP_ID, CFG_APP_ID, now);
    saveWindowToDb(database, win, sortOrder, now);
  });
  tx();
  return now;
}

function deleteWindowFromDb(database, windowId) {
  ensureConfigSchema(database);
  const id = String(windowId || '').trim();
  if (!id) throw new Error('ID окна не указан');

  const row = database.prepare('SELECT WINDOW_ID, TITLE FROM CFG_WINDOWS WHERE WINDOW_ID = ?').get(id);
  if (!row) throw new Error('Окно не найдено: ' + id);

  const now = new Date().toISOString();
  const tx = database.transaction(() => {
    database.prepare('DELETE FROM CFG_WINDOWS WHERE WINDOW_ID = ?').run(id);
    database.prepare('UPDATE CFG_APP SET UPDATED_AT = ? WHERE ID = ?').run(now, CFG_APP_ID);
  });
  tx();

  return { windowId: row.WINDOW_ID, title: row.TITLE };
}

function saveAppConfigToDb(database, appConfig) {
  ensureConfigSchema(database);
  const payload = { ...(appConfig || {}) };
  delete payload.database;
  delete payload.logo;
  const title = payload.title || 'GTerminalPro';
  const now = new Date().toISOString();
  const windows = Array.isArray(payload.windows) ? payload.windows : [];

  validateWindowsUniqueness(windows);

  const tx = database.transaction(() => {
    database.prepare(`
      INSERT INTO CFG_APP (ID, TITLE, UPDATED_AT)
      VALUES (?, ?, ?)
      ON CONFLICT(ID) DO UPDATE SET TITLE = excluded.TITLE, UPDATED_AT = excluded.UPDATED_AT
    `).run(CFG_APP_ID, title, now);

    const existingIds = new Set(
      database.prepare('SELECT WINDOW_ID FROM CFG_WINDOWS').all().map((row) => row.WINDOW_ID)
    );
    const incomingIds = new Set();

    windows.forEach((win, idx) => {
      const windowId = String(win.id || win.windowId || win.title || `win_${idx}`);
      incomingIds.add(windowId);
      saveWindowToDb(database, win, idx, now);
    });

    existingIds.forEach((windowId) => {
      if (!incomingIds.has(windowId)) {
        database.prepare('DELETE FROM CFG_WINDOWS WHERE WINDOW_ID = ?').run(windowId);
      }
    });
  });

  tx();
  ensureMigrationFlags(database);
  return now;
}

function loadJsonBlobConfig(database) {
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS APP_CONFIG (
        ID INTEGER PRIMARY KEY CHECK (ID = 1),
        CONFIG_JSON TEXT NOT NULL DEFAULT '{}',
        UPDATED_AT TEXT
      )
    `);
    const row = database.prepare('SELECT CONFIG_JSON FROM APP_CONFIG WHERE ID = 1').get();
    if (!row || !row.CONFIG_JSON) return null;
    const parsed = JSON.parse(row.CONFIG_JSON);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function migrateFromJsonBlob(database) {
  if (isMigrationDone(database, META_MIGRATED_JSON_BLOB)) return false;
  if (hasStructuredConfig(database)) {
    setMeta(database, META_MIGRATED_JSON_BLOB, '1');
    return false;
  }
  const parsed = loadJsonBlobConfig(database);
  if (!parsed || !Array.isArray(parsed.windows) || !parsed.windows.length) {
    setMeta(database, META_MIGRATED_JSON_BLOB, '1');
    return false;
  }
  saveAppConfigToDb(database, parsed);
  setMeta(database, META_MIGRATED_JSON_BLOB, '1');
  console.log('[CONFIG] One-time migration: APP_CONFIG JSON → CFG_* (' + parsed.windows.length + ' windows)');
  return true;
}

function migrateLegacyPayload(database, legacyRaw) {
  if (isMigrationDone(database, META_MIGRATED_LEGACY_CONFIG)) return false;
  if (!legacyRaw) return false;
  if (hasStructuredConfig(database)) {
    setMeta(database, META_MIGRATED_LEGACY_CONFIG, '1');
    return false;
  }

  const legacyWindows = Array.isArray(legacyRaw.windows) ? legacyRaw.windows : [];
  const hasLegacyPayload = legacyWindows.length > 0 ||
    (legacyRaw.title && legacyRaw.title !== 'GTerminalPro') ||
    Object.keys(legacyRaw).some((k) => k !== 'database' && k !== 'logo' && k !== 'title' && k !== 'windows');
  if (!hasLegacyPayload) {
    setMeta(database, META_MIGRATED_LEGACY_CONFIG, '1');
    return false;
  }

  const toStore = { ...legacyRaw };
  delete toStore.database;
  delete toStore.logo;
  if (!toStore.title) toStore.title = 'GTerminalPro';
  if (!Array.isArray(toStore.windows)) toStore.windows = legacyWindows;
  saveAppConfigToDb(database, toStore);
  setMeta(database, META_MIGRATED_LEGACY_CONFIG, '1');
  console.log('[CONFIG] One-time migration: legacy config.json → CFG_* (' + legacyWindows.length + ' windows)');
  return true;
}

function migrateNoJsonColumns(database) {
  if (isMigrationDone(database, META_MIGRATED_V2_NO_JSON)) return false;
  if (!hasStructuredConfig(database)) {
    setMeta(database, META_MIGRATED_V2_NO_JSON, '1');
    return false;
  }
  const config = loadAppConfigFromDb(database);
  if (!config) return false;
  saveAppConfigToDb(database, config);
  setMeta(database, META_MIGRATED_V2_NO_JSON, '1');
  console.log('[CONFIG] One-time migration: JSON columns → relational columns');
  return true;
}

function runStartupMigrations(database, legacyRaw) {
  ensureConfigSchema(database);
  let migrated = false;
  const legacyHasWindows = !!(legacyRaw && Array.isArray(legacyRaw.windows) && legacyRaw.windows.length);

  if (hasStructuredConfig(database)) {
    ensureMigrationFlags(database);
    if (migrateNoJsonColumns(database)) migrated = true;
    return { migrated, trimBootstrap: legacyHasWindows };
  }

  if (migrateFromJsonBlob(database)) migrated = true;
  if (migrateLegacyPayload(database, legacyRaw)) migrated = true;
  if (hasStructuredConfig(database)) migrateNoJsonColumns(database);
  return { migrated, trimBootstrap: migrated && legacyHasWindows };
}

module.exports = {
  ensureConfigSchema,
  hasStructuredConfig,
  getConfigStamp,
  loadAppConfigFromDb,
  saveAppConfigToDb,
  saveSingleWindowToDb,
  deleteWindowFromDb,
  validateWindowsUniqueness,
  migrateFromJsonBlob,
  migrateLegacyPayload,
  runStartupMigrations,
  ensureMigrationFlags,
  loadJsonBlobConfig
};