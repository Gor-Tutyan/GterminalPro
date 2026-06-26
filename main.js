const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const bcrypt = require('bcryptjs');

const isPackaged = app.isPackaged;

// Suppress Chromium cache errors on Windows (common in portable builds / restricted folders)
// and force cache/userData next to the forced C:\GTerminalPro config for consistency
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disk-cache-size', '0');
app.commandLine.appendSwitch('media-cache-size', '0');
app.commandLine.appendSwitch('disable-http-cache');

// Suppress common DevTools protocol noise ("Autofill.enable" not found).
// Harmless warning that appears when DevTools is open in many Electron apps.
app.commandLine.appendSwitch('disable-features', 'Autofill,AutofillServerCommunication');
app.commandLine.appendSwitch('disable-blink-features', 'Autofill');

// More attempts to kill autofill protocol noise in DevTools
app.commandLine.appendSwitch('disable-features', 'Autofill,AutofillServerCommunication,AutofillAssistant');
app.commandLine.appendSwitch('disable-blink-features', 'Autofill,AutofillAssistant');

const portableUserData = 'C:\\GTerminalPro\\data';
const portableCacheDir = path.join(portableUserData, 'cache');
const portableLogsDir = path.join(portableUserData, 'logs');

try {
  if (!fs.existsSync(portableUserData)) {
    fs.mkdirSync(portableUserData, { recursive: true });
  }
  if (!fs.existsSync(portableCacheDir)) {
    fs.mkdirSync(portableCacheDir, { recursive: true });
  }
  if (!fs.existsSync(portableLogsDir)) {
    fs.mkdirSync(portableLogsDir, { recursive: true });
  }
  app.setPath('userData', portableUserData);
  app.setPath('cache', portableCacheDir);
  app.setPath('logs', portableLogsDir);
} catch (e) {
  console.error('Failed to set portable userData/cache:', e);
}

let currentUser = null;
let mainWindow;
let db = null;
let cachedConfig = null;
let cachedConfigPath = null;
let cachedConfigMtime = 0;

function openDatabase(dbPath) {
  if (db) {
    try { db.close(); } catch (_) {}
    db = null;
  }
  db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000');
    db.pragma('temp_store = MEMORY');
  } catch (_) {}
  return db;
}

ipcMain.handle('login', async (event, login, password) => {
  try {
    let configPath;
    let config;

    // если БД ещё не открыта
    if (!db) {
      configPath = resolveConfigPath();
      config = getConfig();

      if (!fs.existsSync(config.database)) {
        return {
          success: false,
          error: 'База не найдена (использован конфиг: ' + configPath + ')'
        };
      }

      openDatabase(config.database);
    } else {
      configPath = resolveConfigPath();
    }

    const user = db.prepare(`
      SELECT *
      FROM USERS
      WHERE LOGIN = ?
      AND IS_ACTIVE = 1
    `).get(login);

    if (!user) {
      return { success: false, error: 'Пользователь не найден (config: ' + configPath + ')' };
    }

    const valid = await bcrypt.compare(
      password,
      user.PASSWORD_HASH
    );

    if (!valid) {
      return { success: false, error: 'Неверный пароль (config: ' + configPath + ')' };
    }

    currentUser = {
        id: user.ID,
        login: user.LOGIN,
        role: user.ROLE,

        windowsAccess: user.WINDOWS_ACCESS,

        insertAccess: user.INSERT_ACCESS,
        updateAccess: user.UPDATE_ACCESS,
        deleteAccess: user.DELETE_ACCESS
    };

    return {
      success: true,
      user: currentUser
    };

  } catch (err) {

    console.error(err);

    const configPath = resolveConfigPath ? resolveConfigPath() : 'unknown';
    return {
      success: false,
      error: err.message + ' (config: ' + configPath + ')'
    };
  }
});

ipcMain.handle('get-current-user', () => {
    return currentUser;
});


// ==================== PATHS ====================

const isDev = !isPackaged;

// For portable exe: prefer directory next to the .exe
// For dev: use __dirname
const APP_DIR = isPackaged 
  ? path.dirname(process.execPath)   // the folder containing the portable .exe
  : 'C:/GTerminalPro';               // legacy installed path for config/db fallback

// Force export path for Excel/CSV to always be C:\GTerminalPro\exports
// (as per requirement, independent of where the portable EXE is located or run from)
const EXPORT_DIR = 'C:\\GTerminalPro\\exports';
const TEMPLATE_DIR = 'C:\\GTerminalPro\\templates';



function resolveConfigPath() {
  const canonical = 'C:\\GTerminalPro\\config.json';

  // Always prefer C:\GTerminalPro as user requires (for portable build and run)
  // even if exe is run from other location
  if (fs.existsSync(canonical)) {
    return canonical;
  }

  // Fallbacks
  const candidates = [];

  if (isPackaged) {
    candidates.push(path.join(APP_DIR, 'config.json'));
  }

  const installed = path.join(APP_DIR, 'config.json');
  candidates.push(installed);

  candidates.push(path.join(__dirname, 'config', 'config.json'));
  candidates.push(path.join(__dirname, 'config.json'));

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // If still not, try to use canonical anyway (will fail later with clear error)
  return canonical;
}

function getConfig() {
  const configPath = resolveConfigPath();
  try {
    const stat = fs.statSync(configPath);
    if (cachedConfig && cachedConfigPath === configPath && cachedConfigMtime === stat.mtimeMs) {
      return cachedConfig;
    }
    cachedConfigMtime = stat.mtimeMs;
  } catch (_) {}

  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // Resolve relative DB paths relative to project root (not the config file itself),
  // so both config/config.json and root config.json work.
  if (raw.database && !path.isAbsolute(raw.database)) {
    // Resolve relative DB paths relative to the directory of the chosen config.json
    // This works for portable (config next to exe), dev, and C:\ installs.
    let root = path.dirname(configPath);
    if (path.basename(root) === 'config') {
      root = path.dirname(root);  // if config was in subfolder, go to its parent
    }
    raw.database = path.resolve(root, raw.database);
  }

  // Resolve logo path if relative (for custom logo in config)
  if (raw.logo && !path.isAbsolute(raw.logo)) {
    let root = path.dirname(configPath);
    if (path.basename(root) === 'config') {
      root = path.dirname(root);
    }
    raw.logo = path.resolve(root, raw.logo);
  }

  cachedConfig = raw;
  cachedConfigPath = configPath;
  return raw;
}

function ensureExportDir() {
  if (!fs.existsSync(EXPORT_DIR)) {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
  }
}

function ensureTemplateDir() {
  if (!fs.existsSync(TEMPLATE_DIR)) {
    fs.mkdirSync(TEMPLATE_DIR, { recursive: true });
  }
}

function resolveTemplatePath(templateDir, templateFile) {
  const file = String(templateFile || '').trim();
  if (!file) return null;
  if (path.isAbsolute(file) && fs.existsSync(file)) return file;
  const dir = String(templateDir || TEMPLATE_DIR).trim() || TEMPLATE_DIR;
  const joined = path.join(dir, file);
  if (fs.existsSync(joined)) return joined;
  if (fs.existsSync(file)) return path.resolve(file);
  return joined;
}

function buildOutputFilename(pattern, data, fallback) {
  let name = String(pattern || fallback || ('export_' + Date.now() + '.xlsx')).trim();
  if (!/\.xlsx?$/i.test(name)) name += '.xlsx';
  name = name.replace(/\{(\w+)\}/g, (_, key) => {
    const val = data && data[key];
    return val != null ? String(val).replace(/[\\/:*?"<>|]/g, '_') : '';
  });
  return path.basename(name) || ('export_' + Date.now() + '.xlsx');
}

function sanitizeExportRows(data) {
  if (!Array.isArray(data)) return [];
  return data.map(row => {
    const out = {};
    for (const [key, val] of Object.entries(row || {})) {
      if (val == null) {
        out[key] = '';
      } else if (Buffer.isBuffer(val)) {
        out[key] = val.toString('utf8');
      } else if (typeof val === 'bigint') {
        out[key] = val.toString();
      } else if (val instanceof Date) {
        out[key] = val.toISOString();
      } else if (typeof val === 'object') {
        out[key] = JSON.stringify(val);
      } else {
        out[key] = val;
      }
    }
    return out;
  });
}

if (!fs.existsSync(EXPORT_DIR)) {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
}
ensureTemplateDir();

// ==================== WINDOW ====================

function createWindow() {
  console.log('[MAIN] createWindow called, isPackaged=', isPackaged);
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      devTools: true,
      disableBlinkFeatures: 'Autofill'
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'login.html'));
  console.log('[MAIN] loadFile login.html called');

  // Restore Ctrl+Shift+I and F12 for DevTools (menu was removed)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.control && input.shift && input.key.toLowerCase() === 'i') || input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // Suppress harmless DevTools protocol errors like "Autofill.enable" that
  // appear in the console when DevTools is open. These do not affect the app.
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    if (sourceId && sourceId.includes('devtools')) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    // Force the db-label from main process using the real config.
    // This ensures it shows the correct name (e.g. database_BPC.db) even if renderer has timing/JS issues.
    try {
      const cfg = getConfig();
      if (cfg && cfg.database) {
        const display = cfg.database.split(/[/\\]/).pop();
        const fullPath = cfg.database.replace(/\\/g, '\\\\'); // escape for JS string
        mainWindow.webContents.executeJavaScript(`
          (function() {
            const lbl = document.getElementById('db-label');
            if (lbl) {
              lbl.textContent = '${display}';
              lbl.title = '${fullPath}';
            }
            // Force sidebar expanded so window list is visible
            const sb = document.querySelector('.sidebar');
            if (sb) sb.classList.remove('collapsed');
            const chev = document.querySelector('.chevron-top');
            if (chev) {
              chev.classList.remove('fa-chevron-right');
              chev.classList.add('fa-chevron-left');
            }
          })();
        `).catch(() => {});
      }
    } catch (e) {}
    console.log('[MAIN] did-finish-load for main window, forced label and sidebar');
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // убрали стандартное меню File/Edit/View

  // Extra safety: ensure dirs (already done at top level)


  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ==================== CONFIG ====================

ipcMain.handle('get-config', () => {
  return getConfig();
});

ipcMain.handle('navigate-to', (event, page) => {
  console.log('[MAIN] navigate-to called with page=', page);
  if (mainWindow && !mainWindow.isDestroyed()) {
    const target = (page === 'index' || page === 'main' || page === 'app') ? 'index.html' : 'login.html';
    mainWindow.loadFile(path.join(__dirname, target));
    console.log('[MAIN] loading', target);
  }
  return true;
});

// ==================== DATABASE ====================

ipcMain.handle('open-db', () => {
  try {
    const config = getConfig();
    const dbPath = config.database;

    if (!dbPath) {
      return { success: false, error: 'Поле database не указано' };
    }

    if (!fs.existsSync(dbPath)) {
      return { success: false, error: `База не найдена:\n${dbPath}` };
    }

    if (db) {
      return { success: true, reused: true };
    }

    openDatabase(dbPath);
    return { success: true };

  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ==================== QUERY ====================

ipcMain.handle('execute-query', (event, sql, params = []) => {
  try {
    if (!db) {
      return {
        success: false,
        error: 'DB not opened'
      };
    }

    const stmt = db.prepare(sql);
    const isSelect = sql.trim().toLowerCase().startsWith('select');
    const bindParams = Array.isArray(params) ? params : (params != null ? [params] : []);
    const placeholderCount = (sql.match(/\?/g) || []).length;
    if (placeholderCount > bindParams.length) {
      console.warn('[execute-query] too few params for sql, returning empty/error. sql snippet:', sql.substring(0,100), 'provided:', bindParams.length);
      if (isSelect) {
        return { success: true, rows: [] };
      }
      return { success: false, error: 'Too few parameter values' };
    }

    if (isSelect) {
      const rows = bindParams.length ? stmt.all(...bindParams) : stmt.all();
      return {
        success: true,
        rows
      };
    }

    const result = bindParams.length ? stmt.run(...bindParams) : stmt.run();

    return {
      success: true,
      result
    };

  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
});
// ==================== LOOKUP ====================

ipcMain.handle('get-lookup-data', (event, sql, params) => {

  try {

    if (!db) {
      return [];
    }

    const stmt = db.prepare(sql);
    const args = Array.isArray(params) ? params : (params != null ? [params] : []);
    // Defensive against "Too few parameter values were provided"
    const placeholderCount = (sql.match(/\?/g) || []).length;
    if (placeholderCount > args.length) {
      console.warn('[get-lookup] too few params provided for query, returning empty. sql:', sql, 'provided:', args.length, 'needed:', placeholderCount);
      return [];
    }
    return stmt.all(...args);

  } catch (err) {

    console.error(err);

    return [];

  }

});
// ==================== CSV EXPORT ====================

ipcMain.handle('export-csv', (event, data, filename) => {
  try {
    const Papa = require('papaparse');
    ensureExportDir();
    const safeName = path.basename(filename || 'export.csv');
    const rows = sanitizeExportRows(data);
    if (!rows.length) {
      return { success: false, error: 'Нет данных для экспорта' };
    }
    const csv = Papa.unparse(rows);
    const exportPath = path.join(EXPORT_DIR, safeName);
    fs.writeFileSync(exportPath, csv, 'utf8');
    return { success: true, path: exportPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ==================== XLSX EXPORT ====================

ipcMain.handle('export-xlsx', (event, data, filename) => {
  try {
    const XLSX = require('xlsx');
    ensureExportDir();
    const safeName = path.basename(filename || 'export.xlsx');
    const rows = sanitizeExportRows(data);
    if (!rows.length) {
      return { success: false, error: 'Нет данных для экспорта' };
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    const cols = Object.keys(rows[0] || {}).map(key => ({
      wch: Math.min(Math.max(String(key).length, 10), 50)
    }));
    ws['!cols'] = cols;
    XLSX.utils.book_append_sheet(wb, ws, 'Data');

    const exportPath = path.join(EXPORT_DIR, safeName);
    XLSX.writeFile(wb, exportPath);
    return { success: true, path: exportPath };
  } catch (err) {
    console.error('[export-xlsx]', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('select-file', async (event, options = {}) => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    defaultPath: options.defaultPath || undefined,
    filters: options.filters || [{ name: 'All Files', extensions: ['*'] }]
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('export-xlsx-template', (event, options = {}) => {
  try {
    const XLSX = require('xlsx');
    const {
      templateDir,
      templateFile,
      templatePath,
      cellMapping = {},
      data = {},
      outputFilename
    } = options;

    const tplPath = templatePath || resolveTemplatePath(templateDir, templateFile);
    if (!tplPath || !fs.existsSync(tplPath)) {
      return { success: false, error: 'Шаблон Excel не найден: ' + (tplPath || templateFile || '(не указан)') };
    }

    const mapKeys = Object.keys(cellMapping || {});
    if (!mapKeys.length) {
      return { success: false, error: 'Не задан маппинг полей → ячеек Excel' };
    }

    const wb = XLSX.readFile(tplPath);
    const sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    if (!ws) {
      return { success: false, error: 'Лист не найден в шаблоне Excel' };
    }

    mapKeys.forEach(field => {
      const cellRef = String(cellMapping[field] || '').trim().toUpperCase();
      if (!cellRef) return;
      const raw = data[field];
      if (raw == null || raw === '') {
        ws[cellRef] = { t: 's', v: '' };
        return;
      }
      const num = Number(raw);
      if (!Number.isNaN(num) && String(raw).trim() !== '' && /^-?\d+(\.\d+)?$/.test(String(raw).trim())) {
        ws[cellRef] = { t: 'n', v: num };
      } else {
        ws[cellRef] = { t: 's', v: String(raw) };
      }
    });

    ensureExportDir();
    const outName = buildOutputFilename(outputFilename, data, 'export_' + Date.now() + '.xlsx');
    const outPath = path.join(EXPORT_DIR, outName);
    XLSX.writeFile(wb, outPath);
    return { success: true, path: outPath, filename: outName };
  } catch (err) {
    console.error('[export-xlsx-template]', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('read-excel', async (event, filePath) => {
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws);
});

ipcMain.handle('read-excel-cell', async (event, filePath, cellRef) => {
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const cell = ws[cellRef];
  if (!cell) return '';
  return cell.v != null ? cell.v : (cell.w || '');
});

// ==================== DETAILS WINDOW ====================

ipcMain.handle('show-details', (event, title, row, config) => {
  const detailWindow = new BrowserWindow({
    width: 820,
    height: 680,
    parent: mainWindow,
    modal: true,
    resizable: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      disableBlinkFeatures: 'Autofill'
    }
  });

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>${title}</title>
    <style>
      body {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        background: #0f172a;
        color: #e2e8f0;
        padding: 20px;
        margin: 0;
        font-size: 14px;
        line-height: 1.5;
      }

      h2 {
        color: #3b82f6;
        font-size: 17px;
        font-weight: 600;
        margin: 0 0 14px 0;
        padding-bottom: 10px;
        border-bottom: 1px solid #1e2937;
        letter-spacing: -0.25px;
      }

      .detail {
        background: #1e2937;
        margin-bottom: 8px;
        padding: 10px 14px;
        border-radius: 10px;
        border: 1px solid #334155;
        display: flex;
        gap: 14px;
        align-items: flex-start;
      }

      .label {
        min-width: 170px;
        color: #64748b;
        font-size: 13px;
        font-weight: 500;
        flex-shrink: 0;
        padding-top: 1px;
      }

      .value {
        color: #f1f5f9;
        word-break: break-word;
        font-size: 14.5px;
        line-height: 1.45;
      }

      .detail:hover {
        border-color: #3b82f6;
        background: #1e3a5f;
      }

      .mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        font-size: 13px;
      }
    </style>
  </head>

  <body>
    <h2>${title}</h2>
    <div id="content"></div>

    <script>
      const row = ${JSON.stringify(row)};
      const config = ${JSON.stringify(config)};
      const container = document.getElementById('content');

      if (config && config.details) {
        config.details.forEach(item => {
          const div = document.createElement('div');
          div.className = 'detail';

          const value =
            row[item.field] ??
            row[item.field?.toUpperCase()] ??
            '—';

          div.innerHTML =
            '<span class="label">' + item.title + '</span>' +
            '<span class="value mono">' + value + '</span>';

          container.appendChild(div);
        });
      } else {
        Object.keys(row).forEach(key => {
          const div = document.createElement('div');
          div.className = 'detail';

          div.innerHTML =
            '<span class="label">' + key + '</span>' +
            '<span class="value mono">' + (row[key] ?? '—') + '</span>';

          container.appendChild(div);
        });
      }
    </script>
  </body>
  </html>
  `;

  detailWindow.loadURL(
    'data:text/html;charset=utf-8,' +
    encodeURIComponent(html)
  );
});
ipcMain.handle(
    'load-config',
    () => getConfig()
);

ipcMain.handle(
    'save-config',
    (event, config) => {
        let configPath;
        try {
            configPath = resolveConfigPath();
        } catch (e) {
            // Fallback to primary installed path if no config existed yet
            configPath = path.join(APP_DIR, 'config.json');
        }

        // Ensure directory exists
        const dir = path.dirname(configPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(
            configPath,
            JSON.stringify(config, null, 2)
        );
        cachedConfig = null;
        cachedConfigMtime = 0;

        return true;
    }
);

ipcMain.handle('get-users', () => {
    if (!db) return [];
    try {
        return db.prepare(`
            SELECT ID, LOGIN, ROLE, IS_ACTIVE, CREATED_AT, 
                   WINDOWS_ACCESS, INSERT_ACCESS, UPDATE_ACCESS, DELETE_ACCESS 
            FROM USERS
            ORDER BY ID
        `).all();
    } catch (e) {
        console.error(e);
        return [];
    }
});

ipcMain.handle('save-user', async (event, userData) => {
    if (!db) return { success: false, error: 'DB not ready' };
    try {
        const now = new Date().toISOString();
        if (userData.ID) {
            // update
            let sql = `UPDATE USERS SET LOGIN=?, ROLE=?, IS_ACTIVE=?,
                       WINDOWS_ACCESS=?, INSERT_ACCESS=?, UPDATE_ACCESS=?, DELETE_ACCESS=?`;
            const params = [
                userData.LOGIN,
                userData.ROLE || 'USER',
                userData.IS_ACTIVE ? 1 : 0,
                userData.WINDOWS_ACCESS || '',
                userData.INSERT_ACCESS || '',
                userData.UPDATE_ACCESS || '',
                userData.DELETE_ACCESS || ''
            ];
            if (userData.PASSWORD && userData.PASSWORD.trim() !== '') {
                const hash = await bcrypt.hash(userData.PASSWORD, 12);
                sql += `, PASSWORD_HASH=?`;
                params.push(hash);
            }
            sql += ` WHERE ID=?`;
            params.push(userData.ID);
            db.prepare(sql).run(...params);
        } else {
            // insert
            const hash = await bcrypt.hash(userData.PASSWORD, 12);
            db.prepare(`
                INSERT INTO USERS (LOGIN, PASSWORD_HASH, ROLE, IS_ACTIVE, CREATED_AT,
                                   WINDOWS_ACCESS, INSERT_ACCESS, UPDATE_ACCESS, DELETE_ACCESS)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                userData.LOGIN,
                hash,
                userData.ROLE || 'USER',
                userData.IS_ACTIVE ? 1 : 0,
                now,
                userData.WINDOWS_ACCESS || '',
                userData.INSERT_ACCESS || '',
                userData.UPDATE_ACCESS || '',
                userData.DELETE_ACCESS || ''
            );
        }
        return { success: true };
    } catch (e) {
        console.error(e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('delete-user', (event, id) => {
    if (!db) return { success: false };
    try {
        db.prepare('DELETE FROM USERS WHERE ID = ?').run(id);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});
