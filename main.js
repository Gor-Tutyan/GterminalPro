const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');
const Papa = require('papaparse');

let mainWindow;
let db;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false
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

// Получить конфиг
ipcMain.handle('get-config', () => {
  const configPath = path.join(__dirname, 'config/config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
});

// Открыть БД
ipcMain.handle('open-db', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config/config.json'), 'utf8'));
  const dbPath = path.join(__dirname, config.database);
  if (db) db.close();
  db = new Database(dbPath);
  return { success: true };
});

// Выполнить запрос
ipcMain.handle('execute-query', async (event, sql, params) => {
  try {
    const stmt = db.prepare(sql);
    const rows = stmt.all(...params);
    return { success: true, rows };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Экспорт
ipcMain.handle('export-csv', async (event, data, filename) => {
  const csv = Papa.unparse(data);
  const exportPath = path.join(__dirname, 'exports', filename);
  fs.writeFileSync(exportPath, csv);
  return exportPath;
});

ipcMain.handle('export-xlsx', async (event, data, filename) => {
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Results");
  const exportPath = path.join(__dirname, 'exports', filename);
  XLSX.writeFile(wb, exportPath);
  return exportPath;
});