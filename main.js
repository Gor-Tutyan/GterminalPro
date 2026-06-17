const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

let mainWindow;
let db = null;

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
  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ==================== IPC ====================

ipcMain.handle('get-config', () => {
  const configPath = path.join(__dirname, 'config/config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
});

// Открытие базы
ipcMain.handle('open-db', () => {
  return new Promise((resolve) => {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config/config.json'), 'utf8'));
    const dbPath = path.join(__dirname, config.database);
    db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        resolve({ success: false, error: err.message });
      } else {
        resolve({ success: true });
      }
    });
  });
});

// Выполнение запроса
ipcMain.handle('execute-query', (event, sql, params) => {
  return new Promise((resolve) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        resolve({ success: false, error: err.message });
      } else {
        resolve({ success: true, rows });
      }
    });
  });
});

// Экспорт
ipcMain.handle('export-csv', async (event, data, filename) => {
  const Papa = require('papaparse');
  const csv = Papa.unparse(data);
  const exportPath = path.join(__dirname, 'exports', filename);
  fs.writeFileSync(exportPath, csv);
  return exportPath;
});

// Экспорт XLSX — Красивый
ipcMain.handle('export-xlsx', async (event, data, filename) => {
  const exportDir = path.join(__dirname, 'exports');
  
  if (!fs.existsSync(exportDir)) {
    fs.mkdirSync(exportDir, { recursive: true });
  }

  const XLSX = require('xlsx');
  
  // Создаём книгу и лист
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);

  // === Красивое форматирование ===
  
  // Делаем заголовки жирными и с цветом
  const range = XLSX.utils.decode_range(ws['!ref']);
  
  for (let C = range.s.c; C <= range.e.c; ++C) {
    const address = XLSX.utils.encode_cell({ r: 0, c: C });
    if (!ws[address]) continue;
    
    ws[address].s = {
      font: { bold: true, color: { rgb: "FFFFFF" } },
      fill: { fgColor: { rgb: "1E40AF" } },   // синий фон
      alignment: { horizontal: "center", vertical: "center" }
    };
  }

  // Автоматическая ширина колонок
  const colWidths = [];
  const headers = Object.keys(data[0] || {});
  
  headers.forEach((header, i) => {
    let maxWidth = header.length;
    
    data.forEach(row => {
      const value = row[header] ? String(row[header]).length : 0;
      if (value > maxWidth) maxWidth = value;
    });
    
    colWidths.push({ wch: Math.min(maxWidth + 4, 50) }); // максимум 50 символов
  });
  
  ws['!cols'] = colWidths;

  // Добавляем лист
  XLSX.utils.book_append_sheet(wb, ws, "Данные");

  const exportPath = path.join(exportDir, filename);
  XLSX.writeFile(wb, exportPath);
  
  console.log(`✅ Красивый XLSX сохранён: ${exportPath}`);
  return exportPath;
});

// === ОТДЕЛЬНОЕ ОКНО ДЕТАЛЕЙ ===
ipcMain.handle('show-details', (event, title, data, windowConfig) => {
  const detailWindow = new BrowserWindow({
    width: 820,
    height: 680,
    parent: mainWindow,
    modal: true,
    resizable: true,
    backgroundColor: '#0f172a',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  const html = `
    <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { 
            font-family: 'Segoe UI', system-ui, sans-serif; 
            background: #0f172a; 
            color: #e2e8f0; 
            padding: 30px; 
            margin: 0;
          }
          h2 { color: #67e8f9; border-bottom: 2px solid #22d3ee; padding-bottom: 15px; }
          .detail { 
            background: #1e2937; 
            margin: 12px 0; 
            padding: 16px 20px; 
            border-radius: 12px; 
            border: 1px solid #334155;
          }
          .label { 
            display: inline-block; 
            width: 280px; 
            color: #94a3b8; 
            font-weight: 500;
          }
        </style>
      </head>
      <body>
        <h2>${title}</h2>
        <div id="content"></div>

        <script>
          const row = ${JSON.stringify(data)};
          const config = ${JSON.stringify(windowConfig)};
          const container = document.getElementById('content');

          if (config && config.details) {
            config.details.forEach(item => {
              const div = document.createElement('div');
              div.className = 'detail';
              const value = row[item.field] !== undefined ? row[item.field] : 
                           row[item.field.toUpperCase()] || '—';
              div.innerHTML = '<span class="label">' + item.title + ':</span> ' + value;
              container.appendChild(div);
            });
          } else {
            Object.keys(row).forEach(key => {
              const div = document.createElement('div');
              div.className = 'detail';
              div.innerHTML = '<span class="label">' + key + ':</span> ' + (row[key] || '—');
              container.appendChild(div);
            });
          }
        </script>
      </body>
    </html>`;

  detailWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
});