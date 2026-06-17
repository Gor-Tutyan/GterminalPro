let currentWindowConfig = null;
let currentResults = [];
let dbReady = false;

async function init() {
  const config = await window.electronAPI.getConfig();
  document.getElementById('window-title').textContent = config.title;

  const list = document.getElementById('window-list');
  config.windows.forEach(win => {
    const btn = document.createElement('button');
    btn.textContent = win.title;
    btn.onclick = () => loadWindow(win);
    list.appendChild(btn);
  });

  if (config.windows.length > 0) {
    loadWindow(config.windows[0]);
  }

  await window.electronAPI.openDb();
  dbReady = true;
}

async function loadWindow(winConfig) {
  currentWindowConfig = winConfig;
  const container = document.getElementById('current-window');
  container.innerHTML = `
    <h2>${winConfig.title}</h2>
    <div class="filters" id="filters"></div>
    <button onclick="performSearch()">🔍 Поиск</button>
    <button onclick="exportResults('csv')">📥 CSV</button>
    <button onclick="exportResults('xlsx')">📥 XLSX</button>
    
    <div style="margin-top: 20px;">
      <h3>Результаты</h3>
      <table id="results-table">
        <thead><tr id="table-header"></tr></thead>
        <tbody id="table-body"></tbody>
      </table>
    </div>
    
    <div class="details" id="details-panel" style="display:none;">
      <h3>Детали записи</h3>
      <div class="details-grid" id="details-content"></div>
    </div>
  `;

  renderFilters(winConfig);
}

function renderFilters(winConfig) {
  const filtersDiv = document.getElementById('filters');
  filtersDiv.innerHTML = '';
  winConfig.filters.forEach(filter => {
    const div = document.createElement('div');
    div.innerHTML = `
      <label>${filter.label}:</label><br>
      <input type="text" id="filter-${filter.name}" placeholder="${filter.label}" style="width:200px;padding:6px;">
    `;
    filtersDiv.appendChild(div);
  });
}

async function performSearch() {
  if (!currentWindowConfig || !dbReady) return;

  let sql = currentWindowConfig.query;
  const params = [];

  currentWindowConfig.filters.forEach(filter => {
    const value = document.getElementById(`filter-${filter.name}`).value.trim();
    const placeholder = `{${filter.name}}`;

    if (value === '') {
      const regex = new RegExp(`\\[\\[.*?${placeholder}.*?\\]\\]`, 'gs');
      sql = sql.replace(regex, '');
    } else {
      params.push(value);
    }
  });

  sql = sql.replace(/\n\s*\n/g, '\n').trim();

  try {
    const result = await window.electronAPI.executeQuery(sql, params);
    if (result.success) {
      currentResults = result.rows;
      renderTable(result.rows);
    } else {
      alert('Ошибка: ' + result.error);
    }
  } catch (e) {
    alert('Ошибка: ' + e.message);
  }
}

function renderTable(rows) {
  const headerRow = document.getElementById('table-header');
  const tbody = document.getElementById('table-body');
  headerRow.innerHTML = '';
  tbody.innerHTML = '';

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="20">Нет данных</td></tr>';
    return;
  }

  currentWindowConfig.grid.forEach(col => {
    const th = document.createElement('th');
    th.textContent = col.title;
    headerRow.appendChild(th);
  });

  rows.forEach(row => {
    const tr = document.createElement('tr');
    tr.onclick = () => showDetails(row);
    currentWindowConfig.grid.forEach(col => {
      const td = document.createElement('td');
      td.textContent = row[col.field] !== undefined ? row[col.field] : '';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

function showDetails(row) {
  const panel = document.getElementById('details-panel');
  const content = document.getElementById('details-content');
  content.innerHTML = '';

  currentWindowConfig.details.forEach(d => {
    const div = document.createElement('div');
    div.innerHTML = `<strong>${d.title}:</strong> ${row[d.field] || '—'}`;
    content.appendChild(div);
  });

  panel.style.display = 'block';
}

async function exportResults(type) {
  if (currentResults.length === 0) return alert('Нет данных для экспорта');

  const timestamp = new Date().toISOString().slice(0,19).replace(/[:.]/g, '-');
  const filename = `${currentWindowConfig.id}_${timestamp}`;

  let filePath;
  if (type === 'csv') {
    filePath = await window.electronAPI.exportCsv(currentResults, filename + '.csv');
  } else {
    filePath = await window.electronAPI.exportXlsx(currentResults, filename + '.xlsx');
  }
  alert('Экспортировано в: ' + filePath);
}

window.onload = init;