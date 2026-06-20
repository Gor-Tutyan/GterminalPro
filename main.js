const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const bcrypt = require('bcryptjs');

let currentUser = null;
let mainWindow;
let db = null;

ipcMain.handle('login', async (event, login, password) => {
  try {

    // если БД ещё не открыта
    if (!db) {

      const config = getConfig();

      if (!fs.existsSync(config.database)) {
        return {
          success: false,
          error: 'База не найдена'
        };
      }

      db = new Database(config.database);
    }

    console.log('LOGIN:', login);

    const user = db.prepare(`
      SELECT *
      FROM USERS
      WHERE LOGIN = ?
      AND IS_ACTIVE = 1
    `).get(login);

    console.log('USER:', user);

    if (!user) {
      return { success: false };
    }

    const valid = await bcrypt.compare(
      password,
      user.PASSWORD_HASH
    );

    console.log('VALID:', valid);

    if (!valid) {
      return { success: false };
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

    return {
      success: false,
      error: err.message
    };
  }
});

ipcMain.handle('get-current-user', () => {
    return currentUser;
});


// ==================== PATHS ====================

const APP_DIR = 'C:/GTerminalPro';
const isDev = !app.isPackaged;

function resolveConfigPath() {
  // Primary: config from C:\GTerminalPro (as specified)
  const installed = path.join(APP_DIR, 'config.json');
  if (fs.existsSync(installed)) {
    return installed;
  }

  // Dev fallbacks
  const subConfig = path.join(__dirname, 'config', 'config.json');
  if (fs.existsSync(subConfig)) {
    return subConfig;
  }
  const localConfig = path.join(__dirname, 'config.json');
  if (fs.existsSync(localConfig)) {
    return localConfig;
  }

  throw new Error(`Файл конфигурации не найден. Искомые пути:\n${installed}\n${subConfig}\n${localConfig}`);
}

function getConfig() {
  const configPath = resolveConfigPath();
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // Resolve relative DB paths relative to project root (not the config file itself),
  // so both config/config.json and root config.json work.
  if (raw.database && !path.isAbsolute(raw.database)) {
    // Project root = parent of __dirname or parent of "config/" if config lives inside it
    let root = __dirname;
    if (path.basename(path.dirname(configPath)) === 'config') {
      root = path.dirname(path.dirname(configPath));  // go up from config/
    }
    raw.database = path.resolve(root, raw.database);
  }
  return raw;
}

const EXPORT_DIR = isDev
  ? path.join(__dirname, 'exports')
  : path.join(APP_DIR, 'exports');

if (!fs.existsSync(EXPORT_DIR)) {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
}

// ==================== WINDOW ====================

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile('login.html');
}

app.whenReady().then(() => {
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

// ==================== DATABASE ====================

ipcMain.handle('open-db', () => {
  try {

    const config = getConfig();

    const dbPath = config.database;

    if (!dbPath) {
      return {
        success: false,
        error: 'Поле database не указано'
      };
    }

    if (!fs.existsSync(dbPath)) {
      return {
        success: false,
        error: `База не найдена:\n${dbPath}`
      };
    }

    db = new Database(dbPath);

    return {
      success: true
    };

  } catch (err) {
    return {
      success: false,
      error: err.message
    };
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
    const bindParams = Array.isArray(params) ? params : [params];

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
    return stmt.all(...args);

  } catch (err) {

    console.error(err);

    return [];

  }

});
// ==================== CSV EXPORT ====================

ipcMain.handle('export-csv', (event, data, filename) => {
  const Papa = require('papaparse');

  const csv = Papa.unparse(data);

  const exportPath = path.join(EXPORT_DIR, filename);

  fs.writeFileSync(exportPath, csv);

  return exportPath;
});

// ==================== XLSX EXPORT ====================

ipcMain.handle('export-xlsx', (event, data, filename) => {
  const XLSX = require('xlsx');

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);

  const cols = Object.keys(data[0] || {}).map(key => ({
    wch: Math.min(Math.max(key.length, 10), 50)
  }));

  ws['!cols'] = cols;

  XLSX.utils.book_append_sheet(wb, ws, 'Data');

  const exportPath = path.join(EXPORT_DIR, filename);

  XLSX.writeFile(wb, exportPath);

  return exportPath;
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
      contextIsolation: true
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
        font-family: Segoe UI, sans-serif;
        background: #0f172a;
        color: #e2e8f0;
        padding: 30px;
        margin: 0;
      }

      h2 {
        color: #67e8f9;
        border-bottom: 2px solid #22d3ee;
        padding-bottom: 10px;
      }

      .detail {
        background: #1e2937;
        margin: 10px 0;
        padding: 12px 16px;
        border-radius: 10px;
        border: 1px solid #334155;
      }

      .label {
        display: inline-block;
        width: 260px;
        color: #94a3b8;
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
            '<span class="label">' +
            item.title +
            ':</span>' +
            value;

          container.appendChild(div);
        });
      } else {
        Object.keys(row).forEach(key => {
          const div = document.createElement('div');
          div.className = 'detail';

          div.innerHTML =
            '<span class="label">' +
            key +
            ':</span>' +
            (row[key] ?? '—');

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

        return true;
    }
);
