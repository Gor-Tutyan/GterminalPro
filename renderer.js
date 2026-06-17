let currentWindowConfig = null;
let currentResults = [];
let dbReady = false;
let currentPage = 1;
let filtersVisible = false;
let currentUser = null;
const ROWS_PER_PAGE = 21;
let selectedRow = null;
let selectedTr = null;

async function init() {

const user = JSON.parse(
    localStorage.getItem('currentUser')
);

if (!user) {
    window.location.href = 'login.html';
    return;
}
currentUser = user;
  try {
    const config = await window.electronAPI.getConfig();
    document.getElementById('window-title').textContent = config.title;

    const list = document.getElementById('window-list');
    list.innerHTML = '';

const allowedWindows =
    (user.windowsAccess || '')
      .split(',')
      .map(x => parseInt(x))
      .filter(x => !isNaN(x));

config.windows.forEach((win, index) => {

    const windowNumber = index + 1;

    if (!allowedWindows.includes(windowNumber))
        return;
  const btn = document.createElement('button');

  btn.className =
    `window-item w-full text-left px-4 py-3 rounded-xl flex items-center gap-3 transition-all ${
      index === 0 ? 'active' : ''
    }`;

  const icon =
    win.id === 'merchants'
      ? 'fa-store'
      : win.id === 'transactions'
      ? 'fa-credit-card'
      : 'fa-table';

  btn.innerHTML = `
    <i class="fas ${icon} text-cyan-400"></i>
    <span class="font-medium">${win.title}</span>
  `;

  btn.onclick = () => {
    document.querySelectorAll('.window-item')
      .forEach(b => b.classList.remove('active'));

    btn.classList.add('active');
    loadWindow(win);
  };

  list.appendChild(btn);
});

    const visibleWindows = config.windows.filter(
    (win, index) =>
        allowedWindows.includes(index + 1)
);

if (visibleWindows.length > 0)
    loadWindow(visibleWindows[0]);

  const dbResult = await window.electronAPI.openDb();
  dbReady = dbResult.success;

const status = document.getElementById('db-status');

    if (status) {
      status.innerHTML = dbReady
        ? '🟢 База подключена'
        : '🔴 База не подключена';
    }

    } catch (e) {
      console.error(e);
    }
    }


// Переключение фильтров
function toggleFilters() {
  filtersVisible = !filtersVisible;
  const container = document.getElementById('filters-container');
  const btn = document.getElementById('filter-toggle-btn');

  if (filtersVisible) {
    container.classList.remove('hidden');
    btn.classList.add('bg-cyan-600', 'text-white');
    btn.innerHTML = `<i class="fas fa-filter"></i> Скрыть фильтры`;
  } else {
    container.classList.add('hidden');
    btn.classList.remove('bg-cyan-600', 'text-white');
    btn.innerHTML = `<i class="fas fa-filter"></i> Фильтрация`;
  }
}

async function loadWindow(winConfig) {

  currentWindowConfig = winConfig;

  const windowId = winConfig.windowId;

const canInsert =
    (currentUser.insertAccess || '')
        .split(',')
        .includes(String(windowId));

const canUpdate =
    (currentUser.updateAccess || '')
        .split(',')
        .includes(String(windowId));

const canDelete =
    (currentUser.deleteAccess || '')
        .split(',')
        .includes(String(windowId));

  currentPage = 1;
  currentResults = [];
  filtersVisible = false;

  const container = document.getElementById('current-window');
  container.innerHTML = `
      <div class="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 mb-6">
        <h2 class="text-xl font-semibold text-white">${winConfig.title}</h2>
        
        <div class="flex flex-wrap gap-3">
          <button onclick="performSearch()" class="bg-cyan-500 hover:bg-cyan-600 px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-2 whitespace-nowrap">
            <i class="fas fa-search"></i> Поиск
          </button>
          ${canInsert ? `
          <button
          onclick="showInsertForm()"
          class="bg-emerald-600 hover:bg-emerald-500 px-4 py-2 rounded-xl text-sm">
          Добавить
          </button>
          ` : ''}

          ${canUpdate ? `
          <button
          id="btn-update"
          disabled
          onclick="showUpdateForm()"
          class="bg-yellow-600 px-4 py-2 rounded-xl disabled:opacity-40">

          Изменить

          </button>
          ` : ''}

          ${canDelete ? `
          <button
          id="btn-delete"
          disabled
          onclick="deleteSelectedRow()"
          class="bg-red-600 px-4 py-2 rounded-xl disabled:opacity-40">

          Удалить

          </button>
          ` : ''}
          <button onclick="toggleFilters()" id="filter-toggle-btn"
                  class="bg-slate-700 hover:bg-slate-600 px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-2 whitespace-nowrap">
            <i class="fas fa-filter"></i> Фильтрация
          </button>
          
          <button onclick="clearFilters()" class="bg-slate-700 hover:bg-slate-600 px-4 py-2 rounded-xl text-sm whitespace-nowrap">Очистить</button>
          <button onclick="exportResults('csv')" class="bg-slate-700 hover:bg-slate-600 px-4 py-2 rounded-xl text-sm flex items-center gap-2 whitespace-nowrap">
            <i class="fas fa-file-csv"></i> CSV
          </button>
          <button onclick="exportResults('xlsx')" class="bg-emerald-600 hover:bg-emerald-500 px-4 py-2 rounded-xl text-sm flex items-center gap-2 whitespace-nowrap">
            <i class="fas fa-file-excel"></i> XLSX
          </button>
        </div>
      </div>

      <div id="filters-container" class="hidden glass p-4 rounded-2xl mb-4">
        <div id="filters"></div>
      </div>

      <div class="bg-slate-900/70 rounded-3xl overflow-hidden border border-slate-700 flex flex-col h-[70vh]">
        <div class="px-4 py-3 border-b border-slate-700 bg-slate-800/80 flex-shrink-0">
          <h3 class="text-sm font-semibold uppercase tracking-wide">Результаты <span id="row-count" class="text-cyan-400">(0)</span></h3>
        </div>
        
        <div
            id="table-scroll-container"
            class="flex-1 overflow-auto overflow-x-auto"
            style="scrollbar-width: thin; scrollbar-color: #22d3ee #1e2937;"
          >
          <table id="results-table" class="w-max min-w-full border-collapse hidden">
            <thead><tr id="table-header" class="bg-slate-800 sticky top-0 z-10"></tr></thead>
            <tbody id="table-body" class="text-slate-300"></tbody>
          </table>

          <div id="empty-state" class="h-full flex items-center justify-center py-20">
            <div class="text-center">
              <i class="fas fa-database text-6xl text-slate-600 mb-4"></i>
              <p class="text-slate-500 text-sm">Нажмите кнопку «Поиск», чтобы загрузить данные</p>
            </div>
          </div>
        </div>
      </div>

      <div id="pagination" class="mt-4 flex justify-center flex-shrink-0"></div>
    </div>
  `;

  renderFilters(winConfig);
}

function renderFilters(winConfig) {
  const filtersDiv = document.getElementById('filters');
  if (!winConfig.filters || winConfig.filters.length === 0) {
    filtersDiv.innerHTML = `<p class="text-slate-400">Фильтры не настроены для этого окна.</p>`;
    return;
  }

  let html = `
    <div class="mb-4">
      <h3 class="text-lg font-semibold text-cyan-400 flex items-center gap-2">
        <i class="fas fa-filter"></i> Фильтрация
      </h3>
    </div>
    <div class="flex flex-wrap gap-4">`;

  winConfig.filters.forEach(filter => {
    html += `
      <div class="flex flex-col">
        <label class="block text-sm text-slate-400 mb-1">${filter.title}</label>
        <div class="flex gap-2">
          <select id="op-${filter.field}" class="bg-slate-800 border border-slate-600 rounded-xl px-3 py-2 text-sm text-white focus:border-cyan-400 outline-none font-mono">
            <option value="LIKE">LIKE</option>
            <option value="=">= </option>
            <option value="!=">!= </option>
            <option value=">"> > </option>
            <option value=">=">>= </option>
            <option value="<"> < </option>
            <option value="<="><= </option>
          </select>
          <input type="text" id="filter-${filter.field}" 
                 class="bg-slate-800 border border-slate-600 focus:border-cyan-400 rounded-xl px-3 py-2 w-60 text-sm outline-none transition-all"
                 placeholder="Значение...">
        </div>
      </div>`;
  });

  html += `</div>`;
  filtersDiv.innerHTML = html;
}

async function performSearch() {
  if (!currentWindowConfig || !dbReady) return;

  let sql = currentWindowConfig.query;
  const params = [];
  let whereConditions = [];

  if (currentWindowConfig.filters?.length > 0) {
    currentWindowConfig.filters.forEach(filter => {
      const input = document.getElementById(`filter-${filter.field}`);
      const opSelect = document.getElementById(`op-${filter.field}`);
      if (!input || !opSelect) return;

      const value = input.value.trim();
      if (value === '') return;

      const operator = opSelect.value;

      if (operator === "LIKE") {
        whereConditions.push(`${filter.field} LIKE ?`);
        params.push(`%${value}%`);
      } else {
        whereConditions.push(`${filter.field} ${operator} ?`);
        params.push(value);
      }
    });
  }

  if (whereConditions.length > 0) {
    const upperQuery = sql.toUpperCase();
    if (upperQuery.includes(' WHERE ')) {
      sql += " AND " + whereConditions.join(" AND ");
    } else {
      sql += " WHERE " + whereConditions.join(" AND ");
    }
  }

  try {
    const result = await window.electronAPI.executeQuery(sql, params);
    if (result.success) {
      currentResults = result.rows || [];
      currentPage = 1;
      renderTable();
    } else {
      alert("Ошибка SQL:\n" + result.error);
    }
  } catch (e) {
    console.error(e);
    alert("Ошибка выполнения запроса");
  }
}

function renderTable() {
  const table = document.getElementById('results-table');
  const emptyState = document.getElementById('empty-state');
  
  emptyState.classList.add('hidden');
  table.classList.remove('hidden');

  const headerRow = document.getElementById('table-header');
  const tbody = document.getElementById('table-body');
  const countSpan = document.getElementById('row-count');

  headerRow.innerHTML = '';
  tbody.innerHTML = '';
  countSpan.textContent = `(${currentResults.length})`;

  if (currentResults.length === 0) {
    tbody.innerHTML = `<tr><td colspan="20" class="text-center py-16 text-slate-500">Нет данных</td></tr>`;
    return;
  }

  currentWindowConfig.grid.forEach(col => {
    const th = document.createElement('th');
    th.className = "px-4 py-3 text-left text-xs font-semibold text-cyan-300 border-b border-slate-700 uppercase";
    th.textContent = col.title;
    headerRow.appendChild(th);
  });

  const start = (currentPage - 1) * ROWS_PER_PAGE;
  const end = Math.min(start + ROWS_PER_PAGE, currentResults.length);
  const pageRows = currentResults.slice(start, end);

  pageRows.forEach(row => {
    const tr = document.createElement('tr');
    tr.className ="border-b border-slate-800 hover:bg-cyan-500/5 transition-all duration-150 cursor-pointer";
    tr.onclick = () => {

    document
        .querySelectorAll('#table-body tr')
        .forEach(r => {
            r.classList.remove(
                'bg-cyan-500/20'
            );
        });

    tr.classList.add(
        'bg-cyan-500/20'
    );

    selectedRow = row;
    selectedTr = tr;

    const btnDelete =
        document.getElementById(
            'btn-delete'
        );

    const btnUpdate =
        document.getElementById(
            'btn-update'
        );

    if (btnDelete)
        btnDelete.disabled = false;

    if (btnUpdate)
        btnUpdate.disabled = false;
};
tr.ondblclick = () => {
    showDetails(row);
};

    currentWindowConfig.grid.forEach(col => {
      const td = document.createElement('td');
      td.className = "px-3 py-2 text-xs whitespace-nowrap";
      let value = row[col.field] ?? row[col.field?.toUpperCase()] ?? row[col.field?.toLowerCase()] ?? '';
      td.textContent = value;
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  renderPagination();
}

function renderPagination() {
  const totalPages = Math.ceil(currentResults.length / ROWS_PER_PAGE);
  const paginationDiv = document.getElementById('pagination');
  paginationDiv.innerHTML = '';

  if (totalPages <= 1) return;

  const nav = document.createElement('div');
  nav.className = "flex items-center gap-2 text-sm";

  const prev = document.createElement('button');
  prev.className = "px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 rounded-xl disabled:opacity-50 transition-colors";
  prev.textContent = "← Назад";
  prev.disabled = currentPage === 1;
  prev.onclick = () => { if (currentPage > 1) { currentPage--; renderTable(); } };
  nav.appendChild(prev);

  const maxVisible = 7;
  let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
  let endPage = Math.min(totalPages, startPage + maxVisible - 1);

  if (endPage - startPage + 1 < maxVisible) {
    startPage = Math.max(1, endPage - maxVisible + 1);
  }

  if (startPage > 1) {
    nav.appendChild(createPageButton(1));
    if (startPage > 2) {
      const dots = document.createElement('span');
      dots.className = "px-3 py-2 text-slate-500";
      dots.textContent = "...";
      nav.appendChild(dots);
    }
  }

  for (let i = startPage; i <= endPage; i++) {
    nav.appendChild(createPageButton(i));
  }

  if (endPage < totalPages) {
    if (endPage < totalPages - 1) {
      const dots = document.createElement('span');
      dots.className = "px-3 py-2 text-slate-500";
      dots.textContent = "...";
      nav.appendChild(dots);
    }
    nav.appendChild(createPageButton(totalPages));
  }

  const next = document.createElement('button');
  next.className = "px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 rounded-xl disabled:opacity-50 transition-colors";
  next.textContent = "Вперёд →";
  next.disabled = currentPage === totalPages;
  next.onclick = () => { if (currentPage < totalPages) { currentPage++; renderTable(); } };
  nav.appendChild(next);

  paginationDiv.appendChild(nav);
}

function createPageButton(pageNum) {
  const btn = document.createElement('button');

  btn.className = `
    px-3 py-1.5 text-xs rounded-lg transition-colors min-w-[32px]
    ${
      pageNum === currentPage
        ? 'bg-cyan-500 text-black font-bold'
        : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
    }
  `;

  btn.textContent = pageNum;
  btn.onclick = () => {
    currentPage = pageNum;
    renderTable();
  };

  return btn;
}

function clearFilters() {
  currentResults = [];
  currentPage = 1;

  if (currentWindowConfig?.filters) {
    currentWindowConfig.filters.forEach(filter => {
      const input = document.getElementById(`filter-${filter.field}`);
      if (input) input.value = '';
    });
  }

  const table = document.getElementById('results-table');
  const emptyState = document.getElementById('empty-state');
  if (table && emptyState) {
    table.classList.add('hidden');
    emptyState.classList.remove('hidden');
  }

  const countSpan = document.getElementById('row-count');
  if (countSpan) countSpan.textContent = '(0)';

  const paginationDiv = document.getElementById('pagination');
  if (paginationDiv) paginationDiv.innerHTML = '';
}

function showDetails(row) {
  const detailsInfo = getDetailsData(row);
  window.electronAPI.showDetails(
    `${currentWindowConfig.title} — Детали`,
    detailsInfo.data || row,
    currentWindowConfig
  );
}

function getDetailsData(row) {
  if (!currentWindowConfig?.details?.length) return { data: row };
  const data = {};
  currentWindowConfig.details.forEach(d => {
    const f = d.field;
    data[f] = row[f] ?? row[f.toUpperCase()] ?? row[f.toLowerCase()] ?? '';
  });
  return { data };
}

async function exportResults(type) {
  if (currentResults.length === 0) return alert('Сначала выполните поиск');
  const timestamp = new Date().toISOString().slice(0,19).replace(/[:.]/g, '-');
  const filename = `${currentWindowConfig.id}_${timestamp}`;

  try {
    if (type === 'csv') {
      await window.electronAPI.exportCsv(currentResults, filename + '.csv');
    } else {
      await window.electronAPI.exportXlsx(currentResults, filename + '.xlsx');
    }
    alert('✅ Файл успешно сохранён!');
  } catch (e) {
    alert('Ошибка экспорта');
  }
}
async function deleteSelectedRow() {
    console.log('SELECTED ROW:', selectedRow);
    console.log('DELETE CFG:', currentWindowConfig.delete);
    if (!selectedRow) {
        alert('Выберите строку');
        return;
    }

    if (!confirm('Удалить запись?')) {
        return;
    }

    const cfg = currentWindowConfig.delete;

    
    const keyValue =
    selectedRow[cfg.keyField] ??
    selectedRow[cfg.keyField.toUpperCase()] ??
    selectedRow[cfg.keyField.toLowerCase()];

    console.log('KEY VALUE:', keyValue);
    const sql =
      `DELETE FROM ${cfg.table}
       WHERE ${cfg.keyField} = ?`;

    const result =
  await window.electronAPI.executeQuery(
    sql,
    [keyValue]
  );
    if (result.success) {

        alert('Запись удалена');

        performSearch();

    }
}


async function showUpdateForm() {

    if (!selectedRow) {
        return alert('Выберите запись');
    }

    const cfg = currentWindowConfig.update;

    if (!cfg) {
        return alert('Update не настроен');
    }

    let html = '';

    cfg.fields.forEach(field => {

        const value =
            selectedRow[field.field] ??
            selectedRow[field.field?.toUpperCase()] ??
            selectedRow[field.field?.toLowerCase()] ??
            '';

        html += `
            <div style="margin-bottom:10px">
                <label>${field.title}</label><br>
                <input
                    id="upd_${field.field}"
                    value="${value}"
                    style="
                        width:100%;
                        padding:8px;
                        background:#1e293b;
                        color:white;
                        border:1px solid #334155;
                    "
                >
            </div>
        `;
    });

    const win = window.open(
        '',
        'update',
        'width=600,height=500'
    );

    win.document.write(`
        <html>
        <body
            style="
                background:#0f172a;
                color:white;
                padding:20px;
                font-family:Segoe UI;
            "
        >
            <h2>Редактирование</h2>

            ${html}

            <button id="saveBtn">
                Сохранить
            </button>
        </body>
        </html>
    `);

    win.document.close();

    win.document
        .getElementById('saveBtn')
        .onclick = async () => {

            await saveUpdate(win);

        };
}

async function saveUpdate(win) {

    const cfg = currentWindowConfig.update;

    const values = [];
    const sets = [];

    cfg.fields.forEach(field => {

        const value =
            win.document
               .getElementById(
                    `upd_${field.field}`
                )
               .value;

        sets.push(
            `${field.field} = ?`
        );

        values.push(value);
    });

    const keyValue =
        selectedRow[cfg.keyField] ??
        selectedRow[cfg.keyField?.toUpperCase()] ??
        selectedRow[cfg.keyField?.toLowerCase()];

    values.push(keyValue);

    const sql = `
        UPDATE ${cfg.table}
        SET ${sets.join(',')}
        WHERE ${cfg.keyField} = ?
    `;

    console.log(sql);
    console.log(values);

    const result =
        await window.electronAPI.executeQuery(
            sql,
            values
        );

    if (result.success) {

        alert('Изменения сохранены');

        win.close();

        performSearch();

    } else {

        alert(result.error);

    }
}

async function showInsertForm() {

    const cfg = currentWindowConfig.insert;

    if (!cfg) {
        return alert('Insert не настроен');
    }

    let html = '';

    for (const field of cfg.fields) {

        if (field.type === 'select') {

            const rows =
                await window.electronAPI.getLookupData(
                    field.lookupQuery
                );

            let options = '';

            rows.forEach(r => {

                const cols =
                    Object.values(r);

                const value = cols[0];

                const text =
                    cols.length > 1
                        ? cols[1]
                        : cols[0];

                options += `
                    <option value="${value}">
                        ${text}
                    </option>
                `;
            });

            html += `
                <div style="margin-bottom:10px">
                    <label>${field.title}</label><br>

                    <select
                        id="ins_${field.field}"
                        style="
                            width:100%;
                            padding:8px;
                            background:#1e293b;
                            color:white;
                            border:1px solid #334155;
                        "
                    >
                        ${options}
                    </select>
                </div>
            `;

        } else {

            html += `
                <div style="margin-bottom:10px">
                    <label>${field.title}</label><br>

                    <input
                        id="ins_${field.field}"
                        style="
                            width:100%;
                            padding:8px;
                            background:#1e293b;
                            color:white;
                            border:1px solid #334155;
                        "
                    >
                </div>
            `;
        }
    }

    const win = window.open(
        '',
        'insert',
        'width=600,height=500'
    );

    win.document.write(`
        <html>
        <body
            style="
                background:#0f172a;
                color:white;
                padding:20px;
                font-family:Segoe UI;
            "
        >

            <h2>Добавление записи</h2>

            ${html}

            <button id="saveInsertBtn">
                Добавить
            </button>

        </body>
        </html>
    `);

    win.document.close();

    win.document
        .getElementById('saveInsertBtn')
        .onclick = async () => {

            await saveInsert(win);

        };
}
async function saveInsert(win) {

    const cfg = currentWindowConfig.insert;

    const fields = [];
    const placeholders = [];
    const values = [];

    cfg.fields.forEach(field => {

        const value =
            win.document
               .getElementById(
                    `ins_${field.field}`
               )
               .value;

        fields.push(field.field);

        placeholders.push('?');

        values.push(value);
    });

    const sql = `
        INSERT INTO ${cfg.table}
        (
            ${fields.join(',')}
        )
        VALUES
        (
            ${placeholders.join(',')}
        )
    `;

    console.log(sql);
    console.log(values);

    const result =
        await window.electronAPI.executeQuery(
            sql,
            values
        );

    if (result.success) {

        alert('Запись добавлена');

        win.close();

        performSearch();

    } else {

        alert(result.error);

    }
}
window.onload = init;