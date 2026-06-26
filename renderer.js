let currentWindowConfig = null;
let currentResults = [];
let currentWindowSearched = false;
let dbReady = false;
let currentPage = 1;
let currentUser = null;
let inactivityTimeout = null;
const ROWS_PER_PAGE = 21;
let selectedRow = null;
let fullConfig = null;

// Global error logging to catch everything
window.addEventListener('error', (e) => {
  console.error('[GLOBAL ERROR]', e.message, e.error ? e.error.stack : '', 'at', e.filename, e.lineno);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[UNHANDLED PROMISE REJECTION]', e.reason);
});
console.log('[RENDERER] renderer.js loaded, global error handlers installed');

function forceUpdateDbLabel() {
  const dbLabel = document.getElementById('db-label');
  if (!dbLabel) return;
  const dbPath = (fullConfig && fullConfig.database) ? String(fullConfig.database) : '';
  const display = dbPath ? String(dbPath).split(/[/\\]/).pop() : '';
  dbLabel.textContent = display;
  dbLabel.title = dbPath || 'database from C:\\GTerminalPro\\config.json';
  console.log('[FORCE] db-label updated to:', display || '(empty)', 'from', dbPath);
}

let masterContext = null;        // { windowId, keyField, value }

let sidebarCollapsed = localStorage.getItem('sidebarCollapsed') === 'true';

function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  localStorage.setItem('sidebarCollapsed', sidebarCollapsed);
  updateSidebarState();
}

// Make sure it is available globally immediately (for any early clicks and old inline handlers)
window.toggleSidebar = toggleSidebar;

// Super early attachment for the top bar buttons (runs as soon as DOM is ready)
(function wireTopBarEarly(){
  function attach() {
    const t = document.getElementById('top-toggle-btn');
    if (t && !t.__gtermWired) {
      t.__gtermWired = true;
      t.onclick = function(e){ e.preventDefault(); if (typeof toggleSidebar === 'function') toggleSidebar(); };
    }
    const r = document.getElementById('reload-btn');
    if (r && !r.__gtermWired) {
      r.__gtermWired = true;
      r.onclick = function(e){ e.preventDefault(); if (typeof reloadCurrentWindow === 'function') reloadCurrentWindow(); };
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach, { once: true });
  } else {
    attach();
  }
  // safety retries
  setTimeout(attach, 50);
  setTimeout(attach, 300);
})();

function updateSidebarState() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;

  // Only one toggle button now (in top bar) — keep its chevron in sync
  const topChevron = document.querySelector('.chevron-top');
  if (topChevron) {
    topChevron.classList.toggle('fa-chevron-left', !sidebarCollapsed);
    topChevron.classList.toggle('fa-chevron-right', sidebarCollapsed);
  }

  if (sidebarCollapsed) {
    sidebar.classList.add('collapsed');
  } else {
    sidebar.classList.remove('collapsed');
  }

  // Rebuild lists to adjust for collapsed state (icons only etc)
  if (typeof refreshWindowList === 'function') {
    refreshWindowList();
  }
}
let pendingFormPrefill = null;   // { fieldName: value, ... } for pre-filling inserts from master selection
let filtersVisible = false;

const FILTER_OPERATOR_CATALOG = {
    LIKE: { label: 'содержит', needsValue: true },
    '=': { label: '= равно', needsValue: true },
    '!=': { label: '!= не равно', needsValue: true },
    '>': { label: '> больше', needsValue: true },
    '>=': { label: '>= больше/равно', needsValue: true },
    '<': { label: '< меньше', needsValue: true },
    '<=': { label: '<= меньше/равно', needsValue: true },
    IN: { label: 'IN список', needsValue: true },
    'NOT LIKE': { label: 'не содержит', needsValue: true },
    'IS NULL': { label: 'пусто (IS NULL)', needsValue: false },
    'IS NOT NULL': { label: 'не пусто (IS NOT NULL)', needsValue: false }
};

const DEFAULT_FILTER_OPERATORS = ['LIKE', '=', '!=', '>', '>=', '<', '<=', 'IN', 'NOT LIKE'];

function getFilterOperatorOptions(filter) {
    const options = [];
    const enabledStd = Array.isArray(filter.operators)
        ? filter.operators
        : DEFAULT_FILTER_OPERATORS;

    enabledStd.forEach(opKey => {
        const def = FILTER_OPERATOR_CATALOG[opKey];
        if (def) {
            options.push({
                value: opKey,
                label: def.label,
                needsValue: def.needsValue !== false,
                type: 'standard'
            });
        }
    });

    (filter.customOperators || []).forEach((custom, index) => {
        if (!custom || !custom.label) return;
        options.push({
            value: '__custom__:' + index,
            label: custom.label,
            needsValue: !!custom.needsValue,
            type: 'custom',
            sql: custom.sql || '',
            customIndex: index
        });
    });

    return options;
}

function resolveFilterDefaultOperatorValue(filter, options) {
    const desired = filter.defaultOperator;
    if (!desired) return options[0] ? options[0].value : 'LIKE';
    const byValue = options.find(o => o.value === desired);
    if (byValue) return byValue.value;
    const byLabel = options.find(o => String(o.label).toLowerCase() === String(desired).toLowerCase());
    if (byLabel) return byLabel.value;
    const customIdx = (filter.customOperators || []).findIndex(c => c && String(c.label).toLowerCase() === String(desired).toLowerCase());
    if (customIdx >= 0) return '__custom__:' + customIdx;
    return options[0] ? options[0].value : 'LIKE';
}

function syncFilterValueInput(filter, opEl, valEl) {
    if (!opEl || !valEl) return;
    const selected = getFilterOperatorOptions(filter).find(o => o.value === opEl.value);
    const needsValue = selected ? !!selected.needsValue : true;
    valEl.disabled = !needsValue;
    valEl.style.opacity = needsValue ? '1' : '0.45';
    valEl.placeholder = needsValue ? 'значение...' : 'не требуется';
    if (!needsValue) valEl.value = '';
}

function applyCustomFilterSql(sql, fieldName, rawVal) {
    let clause = String(sql || '').trim();
    if (!clause) return { clause: '', params: [] };
    clause = clause.replace(/\{field\}/gi, fieldName);
    const params = [];
    const placeholderCount = (clause.match(/\?/g) || []).length;
    if (placeholderCount > 0) {
        if (!rawVal) return { clause: '', params: [] };
        params.push(...new Array(placeholderCount).fill(rawVal));
    } else if (/\{value\}/i.test(clause)) {
        if (!rawVal) return { clause: '', params: [] };
        clause = clause.replace(/\{value\}/gi, rawVal);
    }
    return { clause: '(' + clause + ')', params };
}
let currentDrop = null;
let currentInputEl = null;

// Permanent single listener for closing dropdowns (more reliable across form switches and modals)
let globalDropdownCloserInstalled = false;

function installGlobalDropdownCloser() {
  if (globalDropdownCloserInstalled) return;
  globalDropdownCloserInstalled = true;

  document.addEventListener('mousedown', (e) => {
    if (currentDrop && !currentDrop.contains(e.target) && e.target !== currentInputEl) {
      if (currentDrop) currentDrop.remove();
      currentDrop = null;
      currentInputEl = null;
    }
  }, true);
}

function closeCurrentDropdown() {
  if (currentDrop) {
    currentDrop.remove();
    currentDrop = null;
  }
  currentInputEl = null;
}

function cleanupAllDropdowns() {
  closeCurrentDropdown();
  document.querySelectorAll('div.fixed.z-\\[99999\\]').forEach(d => d.remove());
}

function normalizeWindowConfig(win) {
    const normalized = { ...win };

    // dataSource / query
    if (!normalized.dataSource) {
        normalized.dataSource = {};
    }
    if (win.query && !normalized.dataSource.query) {
        normalized.dataSource.query = win.query;
    }
    const tbl = win.table || (win.insert && win.insert.table) || (win.update && win.update.table) || (win.delete && win.delete.table);
    if (tbl && !normalized.dataSource.table) {
        normalized.dataSource.table = tbl;
    }
    // Also try to extract table from query for windows that only define query (helps window links)
    if (!normalized.dataSource.table && normalized.dataSource.query) {
        const m = normalized.dataSource.query.match(/FROM\s+([A-Za-z0-9_]+)/i);
        if (m) normalized.dataSource.table = m[1];
    }
    const pk = win.primaryKey || (win.update && win.update.keyField) || (win.delete && win.delete.keyField);
    if (pk && !normalized.dataSource.primaryKey) {
        normalized.dataSource.primaryKey = pk;
    }

    // grid: ensure array of {field,title}
    if (normalized.grid && !Array.isArray(normalized.grid) && normalized.grid.columns) {
        normalized.grid = normalized.grid.columns;
    }

    // form: support legacy insert/update structure from config
    if (!normalized.form && (win.insert || win.update)) {
        const ins = win.insert || win.update || {};
        const fields = ins.fields || [];
        normalized.form = {
            title: win.title,
            table: ins.table,
            fields: fields.map(f => ({
                field: f.field,
                title: f.title || f.field,
                type: f.type || 'text',
                lookupQuery: f.lookupQuery || (f.lookup && f.lookup.sql),

                required: !!f.required,
                disabled: !!f.disabled,
                readonly: !!f.readonly
            }))
        };
    }

    // Ensure form always knows the target insert table (even if form was pre-defined in config)
    if (normalized.form) {
        const insTable = (win.insert && win.insert.table) || normalized.dataSource.table || win.table || normalized.form.table;
        if (insTable && !normalized.form.table) {
            normalized.form.table = insTable;
        }
    }

    // ensure primaryKey from update/delete if needed
    if (!normalized.dataSource.primaryKey) {
        const key = (win.update && win.update.keyField) || (win.delete && win.delete.keyField);
        if (key) normalized.dataSource.primaryKey = key;
    }

    // Relations (master-detail and other links between windows)
    if (!normalized.relations) {
        normalized.relations = Array.isArray(win.relations) ? win.relations : (win.relations || []);
    }

    if (Array.isArray(normalized.filters)) {
        normalized.filters = normalized.filters.map(f => {
            const out = {
                field: f.field,
                title: f.title || f.field
            };
            if (Array.isArray(f.operators) && f.operators.length) out.operators = f.operators.slice();
            if (Array.isArray(f.customOperators) && f.customOperators.length) {
                out.customOperators = f.customOperators.map(c => ({
                    label: c.label || '',
                    sql: c.sql || '',
                    needsValue: !!c.needsValue
                }));
            }
            if (f.defaultOperator) out.defaultOperator = f.defaultOperator;
            return out;
        });
    }

    // details for detail window (same shape as grid: [{field, title}])
    if (!normalized.details) {
        normalized.details = Array.isArray(win.details) ? win.details : [];
    }

    if (!Array.isArray(normalized.rowFormatting)) {
        normalized.rowFormatting = Array.isArray(win.rowFormatting) ? win.rowFormatting : [];
    }

    return normalized;
}

// ==================== CUSTOM PROMPT / CONFIRM (все нативные alert/confirm заменены на showToast / customConfirm чтобы не ломать фокус селекторов) ====================
function _createInputModal(title, message, defaultValue = '', isConfirm = false) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-[999]';
    const isPrompt = !isConfirm;
    overlay.innerHTML = `
      <div class="bg-slate-800 border border-slate-600 rounded-2xl w-full max-w-md mx-4 shadow-2xl">
        <div class="px-5 pt-5 pb-4">
          ${title ? `<div class="text-lg font-semibold text-slate-100 mb-2">${title}</div>` : ''}
          <div class="text-sm text-slate-300 mb-4">${message}</div>
          ${isPrompt ? `
          <input id="custom-prompt-input" type="text" value="${(defaultValue || '').replace(/"/g, '&quot;')}" 
                 class="w-full bg-slate-900 border border-slate-600 focus:border-blue-500 rounded-xl px-4 py-2.5 text-sm outline-none">
          ` : ''}
        </div>
        <div class="px-5 py-4 bg-slate-900/60 rounded-b-2xl flex justify-end gap-2">
          <button id="custom-modal-cancel" class="px-5 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 text-sm">${isConfirm ? 'Нет' : 'Отмена'}</button>
          <button id="custom-modal-ok" class="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-sm font-medium">${isConfirm ? 'Да' : 'OK'}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('#custom-prompt-input');
    const okBtn = overlay.querySelector('#custom-modal-ok');
    const cancelBtn = overlay.querySelector('#custom-modal-cancel');

    function cleanup(result) {
      overlay.remove();
      resolve(result);
    }

    if (input) {
      setTimeout(() => { input.focus(); input.select(); }, 10);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') cleanup(input.value);
        if (e.key === 'Escape') cleanup(null);
      });
    }

    okBtn.onclick = () => {
      if (isPrompt) {
        cleanup(input ? input.value : '');
      } else {
        cleanup(true);
      }
    };
    cancelBtn.onclick = () => cleanup(isConfirm ? false : null);

    overlay.onclick = (e) => {
      if (e.target === overlay) cleanup(isConfirm ? false : null);
    };
  });
}

async function customPrompt(message, defaultValue = '') {
  return _createInputModal('', message, defaultValue, false);
}

async function customConfirm(message) {
  return _createInputModal('Подтверждение', message, '', true);
}

function updateLogo() {
    if (!fullConfig || !fullConfig.logo) return;
    const icon = document.getElementById('app-icon');
    const logo = document.getElementById('app-logo');
    const container = document.getElementById('logo-container');
    if (logo && icon && container) {
        let logoPath = fullConfig.logo;
        if (logoPath && !logoPath.startsWith('file:') && !logoPath.startsWith('data:')) {
            if (logoPath.includes('/') || logoPath.includes('\\')) {
                // absolute or relative path -> file URL
                logoPath = 'file:///' + logoPath.replace(/\\/g, '/');
            } else {
                // bare filename like "logo.png" -> bundled in asar, use as-is
                // (will resolve relative to the loaded html in asar)
            }
        }
        logo.src = logoPath;
        logo.style.display = 'block';
        icon.style.display = 'none';
        container.style.background = 'transparent';
        container.style.boxShadow = 'none';
    }
}

async function init() {
    console.log('[INIT] === INIT BODY START (will run fully now) ===');

    const user = JSON.parse(localStorage.getItem('currentUser'));
    console.log('[INIT] localStorage currentUser:', user);
    if (!user) {
        console.log('[INIT] no user in localStorage, redirecting to login');
        if (window.electronAPI && window.electronAPI.navigateTo) {
          window.electronAPI.navigateTo('login');
        } else {
          window.location.href = 'login.html';
        }
        return;
    }
    currentUser = user;
    console.log('[INIT] currentUser set:', { login: currentUser.login || currentUser.LOGIN, role: currentUser.role || currentUser.ROLE, windowsAccess: currentUser.windowsAccess });

    // Force expanded sidebar (user reports not seeing windows list)
    sidebarCollapsed = false;
    localStorage.setItem('sidebarCollapsed', 'false');

    // Set dynamic login display early
    const userSpan = document.getElementById('current-user');
    if (userSpan) {
        userSpan.textContent = user.login || user.LOGIN || 'user';
    }

    // Logout functionality
    window.logout = function() {
      if (inactivityTimeout) clearTimeout(inactivityTimeout);
      localStorage.removeItem('currentUser');
      currentUser = null;
      // Use main-process navigation for reliable switch back to login in packaged build
      if (window.electronAPI && window.electronAPI.navigateTo) {
        window.electronAPI.navigateTo('login');
      } else {
        window.location.href = 'login.html';
      }
    };

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.onclick = window.logout;
    };

    // Attach top bar handlers (avoids inline onclick + "not defined" + makes CSP easier later)
    const topToggle = document.getElementById('top-toggle-btn');
    if (topToggle) {
      topToggle.onclick = () => { if (typeof toggleSidebar === 'function') toggleSidebar(); };
    }
    const reloadBtn = document.getElementById('reload-btn');
    if (reloadBtn) {
      reloadBtn.onclick = () => { if (typeof reloadCurrentWindow === 'function') reloadCurrentWindow(); };
    }

    // Inactivity auto-logout after ~1 hour of no clicks/mouse/key
    function resetInactivity() {
      if (inactivityTimeout) clearTimeout(inactivityTimeout);
      inactivityTimeout = setTimeout(async () => {
        const ok = await customConfirm('Вы были неактивны более 1 часа. Автоматический выход из системы?');
        if (ok) {
          window.logout();
        } else {
          // reset again
          resetInactivity();
        }
      }, 60 * 60 * 1000); // 1 hour
    }

    document.addEventListener('click', resetInactivity);
    document.addEventListener('mousemove', resetInactivity, { passive: true });
    document.addEventListener('keypress', resetInactivity);
    // initial
    resetInactivity();

    try {
        fullConfig = await window.electronAPI.getConfig();
        const receivedDb = fullConfig && fullConfig.database;
        console.log('[INIT] getConfig result - database:', receivedDb, 'windows count:', Array.isArray(fullConfig && fullConfig.windows) ? fullConfig.windows.length : 0);
        console.log('[INIT] fullConfig.windows raw:', fullConfig && fullConfig.windows ? fullConfig.windows.map(w => ({id: w.id, title: w.title})) : 'none');
        if (!fullConfig) fullConfig = {};
        if (!Array.isArray(fullConfig.windows)) fullConfig.windows = [];

        // Force the db-label right away using the value we just received.
        // This guarantees it overrides the HTML default "main.db".
        const dbLabel = document.getElementById('db-label');
        if (dbLabel) {
            const dbPath = receivedDb || '';
            const display = dbPath ? String(dbPath).split(/[/\\]/).pop() : '';
            dbLabel.textContent = display;
            dbLabel.title = dbPath || 'database not in config';
            console.log('[INIT] db-label set to:', display || '(empty)', 'full path:', dbPath);
        }

        // Fallback to bundled logo.png (included at build time via package.json "files")
        // if no logo is set in the C:\GTerminalPro config
        if (!fullConfig.logo) {
            fullConfig.logo = 'logo.png';
        }
        const titleEl = document.getElementById('window-title');
        if (titleEl) titleEl.textContent = fullConfig.title || "GTerminalPro";

        // Support custom logo from config (e.g. "logo.png" or data URL)
        updateLogo();

        if (!fullConfig.windows) fullConfig.windows = [];
        console.log('[INIT] before refresh: windows in fullConfig =', fullConfig.windows.length, 'currentUser =', currentUser ? currentUser.login : null);

        // Use the proper refresh that respects collapsed state + datasets + active highlight
        refreshWindowList();

        updateSidebarState();

        // Main sidebar + button for new windows removed.
        // Proper window creation (with ID + per-window INSERT/UPDATE/DELETE) is done only from Admin.

        let dbResult = { success: false };
        try {
          dbResult = await window.electronAPI.openDb();
        } catch (_) {}
        dbReady = !!dbResult.success;
        console.log('[INIT] openDb result:', dbResult, 'dbReady=', dbReady);
        forceUpdateDbLabel();
        // update any status indicators
        document.querySelectorAll('.text-emerald-400').forEach(el => {
            if (el.textContent.includes('Подключено') || el.textContent.includes('баз')) {
                el.textContent = dbReady ? 'Подключено к базе' : 'База не подключена';
            }
        });

        if (fullConfig.windows && fullConfig.windows.length > 0) {
            const allowed = (currentUser && currentUser.windowsAccess) ? String(currentUser.windowsAccess).split(',').map(s=>s.trim()).filter(Boolean) : null;
            let candidates = fullConfig.windows;
            const roleStr = String(currentUser && (currentUser.role || currentUser.ROLE) || '').toUpperCase();
            const isAdmin = currentUser && (roleStr === 'ADMIN' || (currentUser.login || currentUser.LOGIN || '').toLowerCase() === 'admin');
            console.log('[INIT] load first window: isAdmin=', isAdmin, 'allowed=', allowed, 'total windows=', fullConfig.windows.length);
            if (allowed && allowed.length > 0 && !isAdmin) {
                candidates = fullConfig.windows.filter(w => allowed.includes(String(w.id || w.windowId || w.title)));
            }
            const firstWin = candidates[0] || fullConfig.windows[0];
            console.log('[INIT] firstWin to load:', firstWin ? {id: firstWin.id, title: firstWin.title} : null);
            const lw = window.loadWindow || (typeof loadWindow !== 'undefined' ? loadWindow : null);
            if (lw && firstWin) {
              console.log('[INIT] calling loadWindow for firstWin');
              lw(firstWin);
            } else {
              console.error('loadWindow not available');
              // ensure at least skeleton if first load failed
              ensureBasicWindowUI();
            }
        } else {
          // no windows configured -> at least show empty but usable main area
          console.log('[INIT] no windows in config, calling ensureBasic');
          ensureBasicWindowUI();
        }
        console.log('[INIT] finished, should have tried to display first window. visible windows should be in sidebar now.');
        setTimeout(forceUpdateDbLabel, 50);

    } catch (e) {
        console.error(e);
        // still try to show sidebar if possible + a message so UI is never completely blank
        try { refreshWindowList(); } catch(_) {}
        try { updateSidebarState(); } catch(_) {}
        forceUpdateDbLabel();
        const container = document.getElementById('current-window');
        if (container) {
          container.innerHTML = '<div class="p-6 text-slate-400">Не удалось загрузить конфигурацию окон. Проверьте config.json в C:\\GTerminalPro.<br>Ошибка: ' + (e && e.message || e) + '</div>';
        }
        showToast('Ошибка загрузки: ' + e.message, 'error');
    }
}

function ensureBasicWindowUI() {
  // Called when there are no windows or load skipped: put a neutral non-empty state so "окна не пустые"
  const container = document.getElementById('current-window');
  if (!container) return;
  if (container.querySelector('#results-table') || container.querySelector('h2')) return; // already has window UI
  container.innerHTML = `
    <div class="h-full flex flex-col">
      <div class="flex justify-between items-center mb-3 pb-3 border-b border-slate-700">
        <h2 class="text-xl font-semibold text-slate-100">${(fullConfig && fullConfig.title) || 'GTerminalPro'}</h2>
        <div class="flex gap-2">
          <button onclick="performSearch && performSearch()" class="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded-xl text-sm flex items-center gap-2">
            <i class="fas fa-search"></i> Поиск
          </button>
        </div>
      </div>
      <div class="bg-slate-800 border border-slate-700 flex flex-col flex-1 min-h-0 overflow-hidden">
        <div class="px-4 py-2 border-b border-slate-700 bg-slate-800 text-xs font-medium text-slate-400">Результаты <span id="row-count" class="text-blue-400 font-semibold">(0)</span></div>
        <div class="flex-1 overflow-auto custom-scroll flex items-center justify-center text-slate-500" id="table-scroll-container">
          <div class="text-center">
            <i class="fas fa-database text-6xl mb-6 opacity-40"></i>
            <p class="text-lg">Нет окон в конфиге или нажмите «Поиск»</p>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ==================== ОСНОВНЫЕ ФУНКЦИИ ====================

async function loadWindow(winConfig) {
    console.log('[LOAD] loadWindow called with:', winConfig ? {id: winConfig.id, title: winConfig.title} : null);
    // Clean up floating admin guide button when leaving admin
    document.querySelectorAll('#admin-floating-guide').forEach(el => el.remove());

    try {
        // Normalize config shape to support different config variants (dataSource vs top-level, grid array vs obj, form vs insert/update)
        currentWindowConfig = (window.normalizeWindowConfig || normalizeWindowConfig)(winConfig);
        console.log('[LOAD] after normalize, currentWindowConfig title=', currentWindowConfig.title);

        // Defensive clean: if insert/update/form have no actual fields, remove them so has* logic and future saves stay clean.
        // This helps when user manually removes or when old configs have empty objects.
        if (currentWindowConfig.insert && (!Array.isArray(currentWindowConfig.insert.fields) || currentWindowConfig.insert.fields.length === 0)) {
          delete currentWindowConfig.insert;
        }
        if (currentWindowConfig.update && (!Array.isArray(currentWindowConfig.update.fields) || currentWindowConfig.update.fields.length === 0)) {
          delete currentWindowConfig.update;
        }
        if (currentWindowConfig.form && (!Array.isArray(currentWindowConfig.form.fields) || currentWindowConfig.form.fields.length === 0)) {
          delete currentWindowConfig.form;
        }

        // DYNAMIC: update top title so user always sees which window is active
        const topTitle = document.getElementById('window-title');
        if (topTitle) {
            topTitle.textContent = currentWindowConfig.title || fullConfig?.title || 'GTerminalPro';
        }
        forceUpdateDbLabel();

        // Rebuild sidebar list with correct active highlight (makes slide/selection feel dynamic and correct)
        if (typeof refreshWindowList === 'function') {
            refreshWindowList();
        }
        currentResults = [];
        currentWindowSearched = false;
        selectedRow = null;

        const container = document.getElementById('current-window');
        const winIdStr = String(currentWindowConfig.id || currentWindowConfig.windowId || currentWindowConfig.title || '');
        const roleStr = String(currentUser && (currentUser.role || currentUser.ROLE) || '').toUpperCase();
        const isAdmin = currentUser && (roleStr === 'ADMIN' || (currentUser.login || currentUser.LOGIN || '').toLowerCase() === 'admin');
        const userInsert = !currentUser || isAdmin || (currentUser.insertAccess || '').split(',').map(s => s.trim()).includes(winIdStr);
        const userUpdate = !currentUser || isAdmin || (currentUser.updateAccess || '').split(',').map(s => s.trim()).includes(winIdStr);
        const userDelete = !currentUser || isAdmin || (currentUser.deleteAccess || '').split(',').map(s => s.trim()).includes(winIdStr);

        // Determine CRUD capability strictly from explicit sections (insert/update/delete)
        // Do NOT fall back to normalized .form here, because normalize creates .form from insert/update
        // and that was causing false-positive buttons (e.g. only insert defined → "Изменить" wrongly appeared).
        const insertFields = (currentWindowConfig.insert && Array.isArray(currentWindowConfig.insert.fields)) ? currentWindowConfig.insert.fields : [];
        const updateFields = (currentWindowConfig.update && Array.isArray(currentWindowConfig.update.fields)) ? currentWindowConfig.update.fields : [];
        let hasInsert = insertFields.length > 0;
        let hasUpdate = updateFields.length > 0;

        // Pure "form" style (no insert/update keys) as fallback
        if (!hasInsert && !hasUpdate) {
          const formFields = (currentWindowConfig.form && Array.isArray(currentWindowConfig.form.fields)) ? currentWindowConfig.form.fields : [];
          if (formFields.length > 0) {
            hasInsert = true;
            hasUpdate = true;
          }
        }

        const delObj = currentWindowConfig.delete || {};
        const dsPk = currentWindowConfig.dataSource ? currentWindowConfig.dataSource.primaryKey : null;
        const hasDelete = !!((delObj.keyField && String(delObj.keyField).trim()) || (dsPk && String(dsPk).trim()));

        const canInsert = hasInsert && userInsert;
        const canUpdate = hasUpdate && userUpdate;
        const canDelete = hasDelete && userDelete;

        currentWindowConfig._canInsert = canInsert;
        currentWindowConfig._canUpdate = canUpdate;
        currentWindowConfig._canDelete = canDelete;

        let toolbarButtons = `
                    <button onclick="performSearch()" class="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded-xl text-sm flex items-center gap-2">
                        <i class="fas fa-search"></i> Поиск
                    </button>`;

        if (hasInsert) {
            toolbarButtons += `
                    <button onclick="showInsertForm()" class="bg-emerald-700 hover:bg-emerald-600 px-4 py-2 rounded-xl text-sm"` + (canInsert ? '' : ' disabled style="opacity:0.5" title="Функционал добавления не настроен или нет прав"') + '>Добавить</button>';
        }

        if (hasUpdate) {
            toolbarButtons += `
                    <button id="btn-update" disabled onclick="showUpdateForm()" class="bg-amber-700 hover:bg-amber-600 px-4 py-2 rounded-xl text-sm"` + (canUpdate ? '' : ' disabled style="opacity:0.5" title="Функционал изменения не настроен или нет прав"') + '>Изменить</button>';
        }

        if (hasDelete) {
            toolbarButtons += `
                    <button id="btn-delete" disabled onclick="deleteSelectedRow()" class="bg-red-600 hover:bg-red-500 px-4 py-2 rounded-xl text-sm"` + (canDelete ? '' : ' disabled style="opacity:0.5" title="Функционал удаления не настроен или нет прав"') + '>Удалить</button>';
        }

        toolbarButtons += `
                    <button onclick="exportCurrentCsv()" class="bg-slate-700 hover:bg-slate-600 px-3 py-2 rounded-lg text-xs">CSV</button>
                    <button onclick="exportCurrentXlsx()" class="bg-slate-700 hover:bg-slate-600 px-3 py-2 rounded-lg text-xs">XLSX</button>
                    <button id="btn-filters" onclick="toggleFilters()" class="bg-purple-700 hover:bg-purple-600 px-3 py-2 rounded-lg text-xs flex items-center gap-1" style="display:none">
                        <i class="fas fa-filter"></i> Фильтры
                    </button>
                    <span id="grid-custom-buttons" class="flex gap-2 ml-1"></span>
                    <span id="relation-buttons" class="flex gap-2 ml-1"></span>`;

        container.innerHTML = 
            '<div class="h-full flex flex-col">' +
            '<div class="flex justify-between items-center mb-3 pb-3 border-b border-slate-700">' +
                '<h2 class="text-xl font-semibold text-slate-100">' + currentWindowConfig.title + '</h2>' +
                '<div class="flex gap-2">' +
                    toolbarButtons +
                '</div>' +
            '</div>' +
            '<div id="filters-container" class="hidden bg-slate-800 p-5 rounded-3xl mb-6">' +
                '<div class="flex items-center justify-between mb-2">' +
                    '<span class="text-xs text-violet-300 font-medium">Фильтры: выбери оператор + значение → нажми «Поиск»</span>' +
                '</div>' +
                '<div id="filters" class="flex flex-wrap gap-3"></div>' +
            '</div>' +

            '<div class="bg-slate-800 border border-slate-700 flex flex-col flex-1 min-h-0 overflow-hidden">' +
                '<div class="px-4 py-2 border-b border-slate-700 bg-slate-800 text-xs font-medium text-slate-400 flex items-center justify-between">' +
                    '<div>Результаты <span id="row-count" class="text-blue-400 font-semibold">(0)</span></div>' +
                '</div>' +
                '<div class="flex-1 overflow-auto custom-scroll" id="table-scroll-container" style="scrollbar-gutter: stable;">' +
                    '<table id="results-table" class="w-full border-collapse hidden min-w-full">' +
                        '<thead><tr id="table-header" class="bg-slate-800"></tr></thead>' +
                        '<tbody id="table-body" class="text-slate-300"></tbody>' +
                    '</table>' +
                    '<div id="empty-state" class="h-full flex items-center justify-center text-slate-500 py-20">' +
                        '<div class="text-center">' +
                            '<i class="fas fa-database text-6xl mb-6 opacity-40"></i>' +
                            '<p class="text-lg">Нажмите «Поиск» для загрузки данных</p>' +
                        '</div>' +
                    '</div>' +
                '</div>' +

                '<div id="pager-container" class="flex items-center gap-1 px-3 py-1.5 border-t border-slate-700 bg-slate-900 text-xs flex-shrink-0 min-h-[32px]"></div>' +
            '</div>' +
        '</div>';

        console.log('[LOAD] after innerHTML set for', currentWindowConfig.title, 'container now has', container.children.length, 'direct children');

        const hasFilters = (currentWindowConfig.filters || []).length > 0;
        const filtersCont = document.getElementById('filters-container');
        const filtersBtn = document.getElementById('btn-filters');

        if (filtersCont) {
            filtersCont.classList.add('hidden');
        }
        if (filtersBtn) {
            filtersBtn.style.display = hasFilters ? '' : 'none';
            filtersBtn.innerHTML = '<i class="fas fa-filter"></i> Фильтры';
        }
        filtersVisible = false;

        renderFilters(currentWindowConfig);
        renderRelationButtons();
        if (typeof renderGridCustomButtons === 'function') renderGridCustomButtons();

        // Initially disable update/delete until a row is selected (only if buttons exist)
        const btnUpdate = document.getElementById('btn-update');
        const btnDelete = document.getElementById('btn-delete');
        if (btnUpdate) btnUpdate.disabled = true;
        if (btnDelete) btnDelete.disabled = true;

        // Show empty grid headers without loading data — user must click «Поиск».
        setTimeout(() => {
            try {
                if (typeof renderTable === 'function') renderTable();
            } catch (e) { /* ignore if db not ready yet */ }
        }, 0);
    } catch (e) {
        console.error('Error in loadWindow:', e);
        const container = document.getElementById('current-window');
        if (container) container.innerHTML = '<div class="p-4 text-red-400">Ошибка загрузки окна: ' + e.message + '</div>';
    }
}

function renderFilters(winConfig) {
    const div = document.getElementById('filters');
    if (!div) return;
    const filters = winConfig.filters || [];
    let html = '';
    filters.forEach(f => {
        const title = f.title || f.field;
        const options = getFilterOperatorOptions(f);
        const defaultOp = resolveFilterDefaultOperatorValue(f, options);
        html += '<div class="flex flex-col min-w-[170px]"><label class="text-[10px] text-slate-400 mb-0.5">' + title + '</label><div class="flex gap-1 items-center">';
        html += '<select id="fop-' + f.field + '" class="bg-slate-900 border border-slate-600 rounded-lg px-1 py-1 text-[10px] min-w-[88px]">';
        options.forEach(op => {
            const selected = op.value === defaultOp ? ' selected' : '';
            html += '<option value="' + op.value + '"' + selected + '>' + op.label + '</option>';
        });
        html += '</select>';
        html += '<input type="text" id="fval-' + f.field + '" class="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-2 py-1 text-sm focus:border-blue-500" placeholder="значение...">';
        html += '</div></div>';
    });
    div.innerHTML = html;

    filters.forEach(f => {
        const opEl = document.getElementById('fop-' + f.field);
        const valEl = document.getElementById('fval-' + f.field);
        if (!opEl || !valEl) return;
        const sync = () => syncFilterValueInput(f, opEl, valEl);
        opEl.addEventListener('change', sync);
        sync();
    });
}

function toggleFilters() {
    const cont = document.getElementById('filters-container');
    const btn = document.getElementById('btn-filters');
    if (!cont) return;
    filtersVisible = !filtersVisible;
    if (filtersVisible) {
        cont.classList.remove('hidden');
        if (btn) btn.innerHTML = '<i class="fas fa-filter"></i> Скрыть';
    } else {
        cont.classList.add('hidden');
        if (btn) btn.innerHTML = '<i class="fas fa-filter"></i> Фильтры';
    }
}

function injectWhere(baseSql, whereStr) {
    if (!whereStr) return baseSql;
    let sql = baseSql.trim().replace(/;\s*$/, ''); // remove trailing ;
    // Find the first position of post-WHERE clauses (ORDER/GROUP/HAVING/LIMIT)
    const clauseRegex = /\s(ORDER BY|GROUP BY|HAVING|LIMIT)\b/i;
    const match = clauseRegex.exec(sql);
    let insertPos = sql.length;
    if (match) insertPos = match.index;
    const hasWhere = /\bWHERE\b/i.test(sql);
    const connector = hasWhere ? ' AND ' : ' WHERE ';
    return sql.slice(0, insertPos) + connector + whereStr + sql.slice(insertPos);
}

async function performSearch() {
    console.log('[SEARCH] performSearch called, dbReady=', dbReady, 'currentWindowConfig=', currentWindowConfig ? currentWindowConfig.title : null);
    if (!currentWindowConfig) return;

    if (!dbReady) {
        const container = document.getElementById('table-scroll-container') || document.getElementById('current-window');
        if (container) {
            container.innerHTML = `
                <div class="flex items-center justify-center h-full p-8">
                    <div class="text-center text-red-400">
                        <i class="fas fa-exclamation-triangle text-4xl mb-4"></i>
                        <p class="text-lg">База данных не открыта</p>
                        <p class="text-sm mt-2 text-slate-400">Проверьте поле "database" в C:\\GTerminalPro\\config.json<br>и что файл БД существует.</p>
                        <button onclick="location.reload()" class="mt-4 px-3 py-1 bg-red-600 rounded text-xs">Перезагрузить</button>
                    </div>
                </div>
            `;
        }
        console.warn('DB not ready for search. fullConfig.database =', fullConfig && fullConfig.database);
        return;
    }

    let sql = currentWindowConfig.query ||
              currentWindowConfig.dataSource?.query ||
              (currentWindowConfig.dataSource?.table ? 'SELECT * FROM ' + currentWindowConfig.dataSource.table : null);

    if (!sql) {
        // fallback from top level table or dataSource table
        const tbl = currentWindowConfig.table || currentWindowConfig.dataSource?.table;
        if (tbl) sql = 'SELECT * FROM ' + tbl;
    }
    if (!sql) { showToast('Нет SQL запроса в конфиге окна', 'error'); return; }

    const params = [];
    let where = [];

    (currentWindowConfig.filters || []).forEach(filter => {
        const opEl = document.getElementById('fop-' + filter.field);
        const valEl = document.getElementById('fval-' + filter.field);
        if (!valEl) return;

        const fieldName = filter.field;
        const options = getFilterOperatorOptions(filter);
        const selectedOp = options.find(o => o.value === (opEl ? opEl.value : ''))
            || options[0]
            || { value: 'LIKE', type: 'standard', needsValue: true };

        const rawVal = valEl.value.trim();
        if (selectedOp.needsValue && !rawVal) return;

        if (selectedOp.type === 'custom') {
            const custom = (filter.customOperators || [])[selectedOp.customIndex];
            if (!custom || !custom.sql) return;
            const applied = applyCustomFilterSql(custom.sql, fieldName, rawVal);
            if (applied.clause) {
                where.push(applied.clause);
                params.push(...applied.params);
            }
            return;
        }

        let opRaw = String(selectedOp.value || 'LIKE').trim().toUpperCase();
        if (opRaw === '==') opRaw = '=';
        if (opRaw === '<>') opRaw = '!=';
        if (opRaw === 'CONTAINS') opRaw = 'LIKE';

        let clause = '';
        let pval = rawVal;

        if (opRaw === 'IS NULL') {
            where.push(fieldName + ' IS NULL');
            return;
        }
        if (opRaw === 'IS NOT NULL') {
            where.push(fieldName + ' IS NOT NULL');
            return;
        }

        if (opRaw === 'LIKE') {
            clause = fieldName + ' LIKE ?';
            pval = '%' + rawVal + '%';
        } else if (opRaw === 'NOT LIKE') {
            clause = fieldName + ' NOT LIKE ?';
            pval = '%' + rawVal + '%';
        } else if (opRaw === 'IN') {
            const vals = rawVal.split(',').map(v => v.trim()).filter(Boolean);
            if (vals.length > 0) {
                const ph = vals.map(() => '?').join(', ');
                clause = fieldName + ' IN (' + ph + ')';
                params.push(...vals);
                where.push(clause);
                return;
            }
        } else if (['=', '!=', '>', '>=', '<', '<='].includes(opRaw)) {
            clause = fieldName + ' ' + opRaw + ' ?';
            pval = rawVal;
        } else {
            clause = fieldName + ' LIKE ?';
            pval = '%' + rawVal + '%';
        }

        if (clause) {
            where.push(clause);
            params.push(pval);
        }
    });

    // Master-detail auto filter from selected context
    if (masterContext && masterContext.value !== undefined) {
        const rels = currentWindowConfig.relations || [];
        const matchingRel = rels.find(r => 
            r.type === 'master-detail' && 
            (r.targetId || r.targetWindow) == masterContext.windowId
        );
        if (matchingRel) {
            const fk = matchingRel.childForeignKey || matchingRel.foreignKey;
            if (fk) {
                // Use param for safety
                where.push(fk + ' = ?');
                params.push(masterContext.value);
            }
        }
    }

    if (where.length > 0) {
        const whereStr = where.join(' AND ');
        sql = injectWhere(sql, whereStr);
    }

    // respect optional limit if present (append at very end)
    const lim = currentWindowConfig.dataSource?.limit || currentWindowConfig.limit;
    if (lim && !/limit\s+\d+/i.test(sql)) sql += ' LIMIT ' + lim;

    currentWindowSearched = true;
    const result = await window.electronAPI.executeQuery(sql, params);
    if (result.success) {
        currentResults = result.rows || [];
        currentPage = 1;
        renderTable();
        renderRelationButtons();
        if (typeof renderGridCustomButtons === 'function') renderGridCustomButtons();
    } else {
        showToast('Ошибка:\n' + result.error, 'error');
    }
}

function renderTable() {
    console.log('[RENDER] renderTable called with', currentResults ? currentResults.length : 0, 'rows');
    const table = document.getElementById('results-table');
    const empty = document.getElementById('empty-state');
    const header = document.getElementById('table-header');
    const tbody = document.getElementById('table-body');
    const count = document.getElementById('row-count');

    const btnUpdate = document.getElementById('btn-update');
    const btnDelete = document.getElementById('btn-delete');
    if (btnUpdate) btnUpdate.disabled = true;
    if (btnDelete) btnDelete.disabled = true;

    count.textContent = '(' + currentResults.length + ')';

    let gridDef = currentWindowConfig.grid || [];
    let columns = Array.isArray(gridDef) ? gridDef : (gridDef.columns || []);

    // Auto columns from data if none defined in config (первые 10)
    if ((!columns || columns.length === 0) && currentResults.length > 0) {
        const keys = Object.keys(currentResults[0]);
        columns = keys.slice(0, 10).map(k => ({ field: k, title: k }));
    }

    // Always render headers for the window to "open" visually
    header.innerHTML = '';
    tbody.innerHTML = '';

    columns.forEach(col => {
        const th = document.createElement('th');
        th.className = "px-4 py-3 text-left text-xs font-medium text-blue-300 border-b border-slate-700";
        th.textContent = (col && (col.title || col.field)) || '';
        header.appendChild(th);
    });

    if (currentResults.length === 0) {
        table.classList.remove('hidden');
        empty.classList.add('hidden');

        // no data row
        const tr = document.createElement('tr');
        tr.className = "border-b border-slate-700";
        const td = document.createElement('td');
        td.colSpan = Math.max(1, columns.length);
        td.className = "px-4 py-2 text-sm text-center text-slate-500";
        td.textContent = currentWindowSearched ? 'Нет записей' : 'Нажмите «Поиск» для загрузки данных';
        tr.appendChild(td);
        tbody.appendChild(tr);

        renderPagination(0, ROWS_PER_PAGE || 21);
        return;
    }

    table.classList.remove('hidden');
    empty.classList.add('hidden');

    const pageSize = ROWS_PER_PAGE || 21;
    const start = (currentPage - 1) * pageSize;
    const pageRows = currentResults.slice(start, start + pageSize);

    pageRows.forEach(row => {
        const tr = document.createElement('tr');
        tr.className = "border-b border-slate-700 hover:bg-slate-800 cursor-pointer";
        tr.onclick = () => selectRow(tr, row);
        tr.ondblclick = () => showDetails(row);

        // NEW: configurable row formatting (constructive, per-window)
        applyRowFormatting(tr, row);

        columns.forEach(col => {
            const td = document.createElement('td');
            td.className = "px-4 py-2 text-sm";
            const f = col && col.field;
            td.textContent = f ? (row[f] ?? '') : '';
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });

    // Pagination
    renderPagination(currentResults.length, pageSize);
}

function applyRowFormatting(tr, row) {
    if (!tr || !row || !currentWindowConfig) return;

    const rules = currentWindowConfig.rowFormatting || [];
    if (!Array.isArray(rules) || rules.length === 0) return;

    rules.forEach(rule => {
        if (!rule || rule.enabled === false) return;
        const field = rule.field;
        if (!field) return;

        const val = row[field];
        const op = rule.operator || 'notEmpty';
        const compareVal = rule.value;

        let matches = false;

        if (op === 'notEmpty' || op === 'isNotNull') {
            matches = val != null && String(val).trim() !== '';
        } else if (op === 'empty' || op === 'isNull') {
            matches = val == null || String(val).trim() === '';
        } else if (op === 'equals') {
            matches = String(val) === String(compareVal || '');
        } else if (op === 'notEquals') {
            matches = String(val) !== String(compareVal || '');
        } else if (op === 'contains') {
            matches = String(val || '').toLowerCase().includes(String(compareVal || '').toLowerCase());
        } else if (op === 'notContains') {
            matches = !String(val || '').toLowerCase().includes(String(compareVal || '').toLowerCase());
        } else if (op === 'gt' || op === 'greaterThan') {
            matches = parseFloat(val) > parseFloat(compareVal);
        } else if (op === 'lt' || op === 'lessThan') {
            matches = parseFloat(val) < parseFloat(compareVal);
        }

        if (matches && rule.style && typeof rule.style === 'object') {
            if (rule.style.border) tr.style.border = rule.style.border;
            if (rule.style.backgroundColor || rule.style.background) tr.style.backgroundColor = rule.style.backgroundColor || rule.style.background;
            if (rule.style.color) tr.style.color = rule.style.color;
            if (rule.style.fontWeight) tr.style.fontWeight = rule.style.fontWeight;
            // add class if provided for further CSS
            if (rule.className) tr.classList.add(rule.className);
        }
    });
}

function renderPagination(total, pageSize) {
    const pager = document.getElementById('pager-container');
    if (!pager) return;
    pager.innerHTML = '';
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    // Always show a small status + pager when >1 page
    const status = document.createElement('span');
    status.className = 'text-slate-400 mr-2';
    status.textContent = 'Всего: ' + total + ' • стр. ' + currentPage + '/' + totalPages;
    pager.appendChild(status);

    if (totalPages <= 1) return;

    const maxVisible = 7;
    let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
    let endPage = startPage + maxVisible - 1;
    if (endPage > totalPages) {
        endPage = totalPages;
        startPage = Math.max(1, endPage - maxVisible + 1);
    }

    if (startPage > 1) {
        addPageBtn(pager, 1);
        if (startPage > 2) addEllipsis(pager);
    }

    for (let p = startPage; p <= endPage; p++) {
        addPageBtn(pager, p);
    }

    if (endPage < totalPages) {
        if (endPage < totalPages - 1) addEllipsis(pager);
        addPageBtn(pager, totalPages);
    }
}

function addPageBtn(pager, p) {
    const b = document.createElement('button');
    b.textContent = p;
    b.className = 'px-2 py-0.5 rounded text-xs ' + (p === currentPage ? 'bg-blue-600 text-white' : 'bg-slate-700 hover:bg-slate-600');
    b.onclick = () => {
        currentPage = p;
        renderTable();
    };
    pager.appendChild(b);
}

function addEllipsis(pager) {
    const span = document.createElement('span');
    span.textContent = '...';
    span.className = 'px-1 text-slate-500';
    pager.appendChild(span);
}

function selectRow(tr, row) {
    document.querySelectorAll('#table-body tr').forEach(r => r.classList.remove('bg-blue-900/30'));
    tr.classList.add('bg-blue-900/30');
    selectedRow = row;
    const btnUpdate = document.getElementById('btn-update');
    const btnDelete = document.getElementById('btn-delete');
    if (btnUpdate) btnUpdate.disabled = !currentWindowConfig._canUpdate;
    if (btnDelete) btnDelete.disabled = !currentWindowConfig._canDelete;

    // Set master context for master-detail relations
    const pk = currentWindowConfig.dataSource?.primaryKey ||
               (currentWindowConfig.update && currentWindowConfig.update.keyField) ||
               (currentWindowConfig.delete && currentWindowConfig.delete.keyField) ||
               (currentWindowConfig.grid && currentWindowConfig.grid[0] && currentWindowConfig.grid[0].field);
    if (pk && row[pk] !== undefined) {
        masterContext = {
            windowId: currentWindowConfig.id || currentWindowConfig.windowId,
            keyField: pk,
            value: row[pk]
        };
        renderRelationButtons();
        // master context banner removed per user request
    }
    if (typeof renderGridCustomButtons === 'function') renderGridCustomButtons();
}

function showDetails(row) {
    window.electronAPI.showDetails(currentWindowConfig.title + " — Детали", row, currentWindowConfig);
}

// ==================== ФОРМА ====================

async function showInsertForm() {
    const ins = currentWindowConfig?.insert || currentWindowConfig?.form;
    if (!ins || !Array.isArray(ins.fields) || ins.fields.length === 0) {
        showToast('Форма добавления не настроена для этого окна', 'error'); return;
    }
    showFormModal('insert');
}

async function showUpdateForm() {
    if (!selectedRow) { showToast('Выберите строку', 'error'); return; }
    const upd = currentWindowConfig?.update || currentWindowConfig?.form;
    if (!upd || !Array.isArray(upd.fields) || upd.fields.length === 0) {
        showToast('Форма редактирования не настроена для этого окна', 'error'); return;
    }
    showFormModal('update', selectedRow);
}

function showFormModal(mode, rowData = null) {
    let formConfig;
    if (mode === 'insert' && currentWindowConfig.insert) {
        formConfig = { fields: currentWindowConfig.insert.fields || [] };
    } else if (mode === 'update' && currentWindowConfig.update) {
        formConfig = { fields: currentWindowConfig.update.fields || [] };
    } else {
        formConfig = currentWindowConfig.form;
    }
    if (!formConfig || !Array.isArray(formConfig.fields) || formConfig.fields.length === 0) {
        showToast('Форма не настроена для этого окна (нет полей)', 'error');
        const existing = document.getElementById('form-modal');
        if (existing) existing.remove();
        return;
    }

    const isInsert = mode === 'insert';
    const title = isInsert ? 'Создание записи' : 'Редактирование записи';
    const currentMode = isInsert ? 'insert' : 'update';

    let html = '<div class="fixed inset-0 bg-black/60 flex items-center justify-center z-50" id="form-modal">' +
        '<div class="bg-slate-900 rounded-2xl w-full max-w-[720px] mx-4 max-h-[90vh] border border-slate-700 shadow-2xl flex flex-col overflow-hidden">' +
        '<div class="px-5 py-3 border-b border-slate-700 flex items-center justify-between bg-slate-950/90 flex-shrink-0">' +
        '<div class="flex items-center gap-2">' +
        '<i class="fas ' + (isInsert ? 'fa-plus-circle text-emerald-400' : 'fa-edit text-amber-400') + '"></i>' +
        '<h2 class="text-[15px] font-semibold text-slate-100 tracking-[-0.2px]">' + title + '</h2>' +
        '</div>' +
        '<button onclick="closeFormModal()" class="w-8 h-8 flex items-center justify-center text-xl leading-none text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors">×</button>' +
        '</div>' +
        '<div class="p-5 flex-1 min-h-0 overflow-auto custom-scroll" id="form-scroll-area" style="scrollbar-gutter: stable;">' +
        '<div class="grid grid-cols-1 gap-y-4" id="form-fields"></div>' +
        '</div>' +
        '<div class="px-5 py-3 border-t border-slate-700 bg-slate-950 flex justify-end gap-2 flex-shrink-0">' +
        '<button onclick="closeFormModal()" class="px-4 py-1.5 text-sm font-medium text-slate-300 hover:text-white hover:bg-slate-800 border border-slate-700 rounded-xl transition-colors">Отмена</button>' +
        '<button id="form-save-btn" onclick="' + (isInsert ? 'saveNewRecord()' : 'saveUpdatedRecord()') + '" class="px-5 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-xl flex items-center gap-2 shadow-sm disabled:opacity-60 disabled:cursor-not-allowed transition-all">' +
        '<i class="fas fa-save text-sm"></i> ' + (isInsert ? 'Создать' : 'Сохранить') +
        '</button>' +
        '</div>' +
        '</div></div>';

    document.body.insertAdjacentHTML('beforeend', html);

    cleanupAllDropdowns();

    console.log('[form modal] opened for mode=', mode, 'formConfig fields with auto:', formConfig.fields.filter(f => f.systemVariable || f.autoValue).map(f => f.field));

    setTimeout(async () => {
        console.log('[form] starting form fields build, mode=', mode, 'rowData=', !!rowData, 'fields count=', formConfig.fields.length);
        const container = document.getElementById('form-fields');

        // Precompute ALL auto values for insert (to handle sql and other autos reliably)
        const autoComputed = {};
        if (mode === 'insert' && !rowData) {
            for (const f of formConfig.fields) {
                const isAutoField = !!(f.systemVariable || f.autoValue || (f.defaultValue && typeof f.defaultValue === 'string' && f.defaultValue.trim().toLowerCase().startsWith('select ')));
                if (isAutoField) {
                    const v = await computeAutoValue(f);
                    if (v != null) autoComputed[f.field] = v;
                }
            }
        }

        for (const field of formConfig.fields) {
            let isAuto = !!(field.systemVariable || field.autoValue);
            if (isAuto && field.hiddenInForm) continue;

            let value = rowData ? (rowData[field.field] ?? '') : (field.defaultValue || '');
            if (!rowData && pendingFormPrefill && pendingFormPrefill[field.field] !== undefined) {
                value = pendingFormPrefill[field.field];
            }

            // Use precomputed dynamic value if available
            if (mode === 'insert' && !rowData && autoComputed[field.field] != null) {
                console.log('[form auto] using precomputed for', field.field, '=', autoComputed[field.field]);
                value = autoComputed[field.field];
                isAuto = true;
            } else if (isAuto && mode === 'insert' && !rowData) {
                console.log('[form auto] computing for isAuto field', field.field);
                let autoVal = await computeAutoValue(field);
                if (autoVal != null) {
                    value = autoVal;
                } else if (field.autoValue && field.autoValue.type === 'CONSTANT') {
                    value = field.autoValue.value || '';
                } else if (field.defaultValue) {
                    value = field.defaultValue;
                }
            }

            const readonlyAttr = field.readonly ? 'readonly' : '';
            const disabledAttr = field.disabled ? 'disabled' : '';
            const ph = field.placeholder ? ` placeholder="${field.placeholder}"` : '';
            const help = field.help ? ` title="${field.help}"` : '';

            let wrapperClass = 'flex flex-col form-field';
            let controlStyle = '';
            if (field.width && field.width !== 'full') {
                controlStyle += `width:${field.width};`;
            }
            if (field.height) {
                controlStyle += `height:${field.height};`;
            }
            const styleAttr = controlStyle ? ` style="${controlStyle}"` : '';
            let dataAttrs = '';
            if (field.conditional && field.conditional.field) {
                dataAttrs = ` data-conditional-field="${field.conditional.field}" data-conditional-op="${field.conditional.op || '=='}" data-conditional-value="${(field.conditional.value || '').replace(/"/g,'&quot;')}" `;
            }

            const showOuterLabel = field.type !== 'checkbox';
            let fieldHtml = `<div class="${wrapperClass}" ${dataAttrs}>`;
            if (showOuterLabel) {
                fieldHtml += `<label class="text-[13px] font-medium text-slate-300" ${help}>${field.title}${isAuto ? ' <span class="text-[10px] text-blue-400 font-normal">(авто)</span>' : ''}</label>`;
            }

            // Pure auto fields
            if (isAuto) {
                fieldHtml += `<input type="text" id="f-${field.field}" value="${value || ''}" ${readonlyAttr}${ph}${styleAttr} class="bg-slate-800 border border-slate-600 rounded-xl px-3 py-1.5 text-[13.5px] focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-all" ${disabledAttr}>`;
            } else if (field.type === 'textarea') {
                fieldHtml += `<textarea id="f-${field.field}" ${readonlyAttr}${ph}${styleAttr} class="bg-slate-800 border border-slate-600 rounded-xl px-3 py-2 text-[13.5px] min-h-[68px] focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-all" ${disabledAttr}>${value}</textarea>`;
            } else if (field.type === 'checkbox') {
                const checked = isCheckboxCheckedFromValue(field, value) ? 'checked' : '';
                fieldHtml += `<label class="flex items-center gap-2 cursor-pointer text-sm"><input type="checkbox" id="f-${field.field}" ${checked} class="w-4 h-4 accent-blue-500" ${readonlyAttr} ${disabledAttr}><span class="text-slate-300">${field.title}</span></label>`;
            } else if (field.type === 'select' && !field.searchable) {
                let selectContent = '';
                if (value != null && value !== '') {
                    selectContent = `<option value="${value}">${value}</option>`;
                }
                fieldHtml += `<select id="f-${field.field}"${styleAttr} class="bg-slate-800 border border-slate-600 rounded-xl px-3 py-1.5 text-[13.5px] focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-all"${ph} ${readonlyAttr} ${disabledAttr}>${selectContent}</select>`;
            } else if (field.type === 'lookup' || (field.type === 'select' && field.searchable)) {
                const dlId = 'dl-' + field.field;
                let dlContent = '';
                if (value != null && value !== '') {
                    dlContent = `<option value="${value}"></option>`;
                }
                const searchableClass = (field.type === 'select' && field.searchable) ? ' searchable-select' : '';
                const searchablePh = (field.type === 'select' && field.searchable && !field.placeholder) ? ` placeholder="Поиск..."` : ph;
                fieldHtml += `<input type="text" id="f-${field.field}" list="${dlId}" class="bg-slate-800 border border-slate-600 rounded-xl px-3 py-1.5 text-[13.5px]${searchableClass} focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-all"${styleAttr}${searchablePh} value="${value || ''}" ${readonlyAttr} ${disabledAttr}><datalist id="${dlId}">${dlContent}</datalist>`;
            } else {
                fieldHtml += `<input type="text" id="f-${field.field}" value="${value}" ${readonlyAttr}${ph}${styleAttr} class="bg-slate-800 border border-slate-600 rounded-xl px-3 py-1.5 text-[13.5px] focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-all" ${disabledAttr}>`;
            }

            // Error message inside the same grid item (fixes broken grid layout)
            fieldHtml += `<div id="err-${field.field}" class="text-red-400 text-[10.5px] mt-0.5 min-h-[14px] font-medium"></div>`;
            fieldHtml += `</div>`;

            container.insertAdjacentHTML('beforeend', fieldHtml);
        }

        // Attach searchable dropdown listeners as early as possible so selector works
        // even when opening form and interacting quickly (before full lookups)
        setupAllCustomDropdowns(formConfig ? formConfig.fields : []);

        // Custom form buttons — placed cleanly above/below the field grid
        const buttonsForThisMode = (currentWindowConfig.formCustomButtons || []).filter(btn => {
          const modes = Array.isArray(btn.modes) && btn.modes.length > 0 ? btn.modes : ['insert', 'update'];
          return modes.includes(currentMode);
        });

        if (buttonsForThisMode.length > 0) {
          const topContainer = document.createElement('div');
          topContainer.className = 'mb-3 flex gap-2 flex-wrap';
          const bottomContainer = document.createElement('div');
          bottomContainer.className = 'mt-3 flex gap-2 flex-wrap';

          buttonsForThisMode.forEach(btn => {
            const b = document.createElement('button');
            b.textContent = btn.label;
            let styleStr = 'text-xs px-3 py-1 rounded-lg font-medium transition-all active:scale-[0.985]';
            if (btn.style) {
              if (btn.style.bg) b.style.backgroundColor = btn.style.bg;
              if (btn.style.color) b.style.color = btn.style.color;
              if (btn.style.width && btn.style.width !== 'auto') b.style.width = btn.style.width;
              if (btn.style.height && btn.style.height !== 'auto') b.style.height = btn.style.height;
            } else {
              styleStr += ' bg-blue-600 hover:bg-blue-500 text-white';
            }
            b.className = styleStr;
            b.onclick = () => handleCustomFormButton(btn, isInsert, formConfig);

            const pos = btn.position || 'top';
            if (pos === 'bottom') {
              bottomContainer.appendChild(b);
            } else {
              topContainer.appendChild(b);
            }
          });

          const formScroll = document.getElementById('form-scroll-area') || container.parentNode;
          if (topContainer.children.length > 0) {
            formScroll.insertBefore(topContainer, container);
          }
          if (bottomContainer.children.length > 0) {
            formScroll.appendChild(bottomContainer);
          }
        }

        // Simple conditional visibility support (super config)
        setTimeout(() => {
            const condFields = container.querySelectorAll('[data-conditional-field]');
            condFields.forEach(wrapper => {
                const cfield = wrapper.getAttribute('data-conditional-field');
                const cop = wrapper.getAttribute('data-conditional-op') || '==';
                const cval = wrapper.getAttribute('data-conditional-value');
                const source = document.getElementById('f-' + cfield);
                const targetInput = wrapper.querySelector('input,select,textarea');
                if (!source || !targetInput) return;

                const check = () => {
                    const sv = source.value || '';
                    let show = false;
                    if (cop === '==') show = sv == cval;
                    else if (cop === '!=') show = sv != cval;
                    else if (cop === 'contains') show = sv.toLowerCase().includes((cval||'').toLowerCase());
                    wrapper.style.display = show ? '' : 'none';
                    if (!show && targetInput) {
                        // optionally clear when hidden
                    }
                };
                source.addEventListener('change', check);
                source.addEventListener('input', check);
                check(); // initial
            });
        }, 150);

        await loadAllLookups();
        setupDependentLookups();

        // Apply computed auto values to selects / inputs (for sql etc.)
        Object.keys(autoComputed).forEach(fieldName => {
            const el = document.getElementById('f-' + fieldName);
            const v = autoComputed[fieldName];
            const fieldDef = (formConfig && formConfig.fields) ? formConfig.fields.find(f => f.field === fieldName) : null;
            if (el && v != null) {
                if (el.tagName === 'SELECT') {
                    let hasOption = false;
                    for (let i = 0; i < el.options.length; i++) {
                        if (el.options[i].value == v) {
                            hasOption = true;
                            break;
                        }
                    }
                    if (!hasOption) {
                        const opt = document.createElement('option');
                        opt.value = v;
                        opt.textContent = v;
                        el.appendChild(opt);
                    }
                    setFormInputValue(el, v, false);
                    if (fieldDef && fieldDef.disabled) el.disabled = true;
                } else {
                    setFormInputValue(el, v, true);
                    if (fieldDef && fieldDef.disabled) el.disabled = true;
                }
            }
        });

        // Force set computed value for ANY auto fields (sql or other) to ensure prefill works reliably
        for (const field of formConfig.fields) {
            if (field.systemVariable || field.autoValue) {
                const el = document.getElementById('f-' + field.field);
                if (el) {
                    const val = await computeAutoValue(field);
                    if (val != null) {
                        setFormInputValue(el, val, document.activeElement === el);
                        if (field.disabled) el.disabled = true;
                        if (field.readonly) el.readOnly = true;
                        console.log('[form force set auto] ', field.field, '=', val);
                    }
                }
            }
        }

        // Apply pending prefill from master context (e.g. when adding related record)
        if (pendingFormPrefill) {
            Object.keys(pendingFormPrefill).forEach(function(fld) {
                const el = document.getElementById('f-' + fld);
                if (el) {
                    setFormInputValue(el, pendingFormPrefill[fld], document.activeElement === el);
                    el.dispatchEvent(new Event('change'));
                }
            });
        }

        setupLiveValidation(formConfig ? formConfig.fields : []);

        // Do NOT auto-focus first input on form open (as requested)
        // setTimeout(() => { ... }) removed to avoid setting cursor on first field

        // Global focusin handler to force caret on any input in this modal (after adding param, switching fields, etc.)
        const modalEl = document.getElementById('form-modal');
        if (modalEl) {
          modalEl.addEventListener('focusin', (e) => {
            const t = e.target;
            if ((t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && !t.disabled) {
              setTimeout(() => {
                if (document.getElementById('form-modal') && document.activeElement === t) {
                  try {
                    const l = t.value ? t.value.length : 0;
                    t.setSelectionRange(l, l);
                  } catch(e){}
                }
              }, 0);
            }
          }, true);
        }

        // On regaining window focus (e.g. after switching apps), re-ensure caret and dropdown readiness.
        const handleWindowFocus = () => {
            const modal = document.getElementById('form-modal');
            if (!modal) {
                window.removeEventListener('focus', handleWindowFocus);
                return;
            }
            const active = document.activeElement;
            if (active && modal.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
                setTimeout(() => {
                    if (document.getElementById('form-modal')) {
                        // force body first to reset any dirty focus state from previous modals
                        document.body.focus();
                        setTimeout(() => {
                            if (document.getElementById('form-modal')) {
                                active.focus();
                                try {
                                    const len = active.value ? active.value.length : 0;
                                    active.setSelectionRange(len, len);
                                } catch(e){}
                                // also make sure dropdown is ready if this is a searchable input
                                if (active.classList.contains('searchable-select') || active.hasAttribute('list')) {
                                    // the mousedown/focus listeners will handle showing
                                }
                            }
                        }, 0);
                    }
                }, 0);
            }
        };
        window.addEventListener('focus', handleWindowFocus);

        // Force reset after modals/toasts or form switches so dropdowns work reliably (no need for alt-tab)
        setTimeout(() => {
          if (document.getElementById('form-modal')) {
            document.body.focus();
            const activeNow = document.activeElement;
            if (activeNow && activeNow.tagName === 'INPUT' && document.getElementById('form-modal')) {
              activeNow.focus();
              try {
                const l = activeNow.value ? activeNow.value.length : 0;
                activeNow.setSelectionRange(l, l);
              } catch(e){}
            }
          }
        }, 30);
    }, 80);
}

async function loadAllLookups() {
    const formF = currentWindowConfig.form ? currentWindowConfig.form.fields : [];
    const insF = currentWindowConfig.insert ? currentWindowConfig.insert.fields || [] : [];
    const selectFields = [...formF, ...insF].filter(f => {
      const hasLookupDef = !!(f.lookup?.sql || f.lookupQuery || f.lookupWindow || f.lookup?.window || (f.options && f.options.length) || (f.lookupConditions && f.lookupConditions.length));
      const hasDefaultSql = f.type === 'lookup' && typeof f.defaultValue === 'string' && f.defaultValue.trim().toLowerCase().startsWith('select ');
      const isPureAutoSql = !!(f.systemVariable || f.autoValue) && (
        (f.autoValue && (f.autoValue.type === 'sql' || String(f.autoValue.query||'').trim())) ||
        String(f.systemVariable || '').toLowerCase().includes('sql')
      );
      // skip lookup population for pure auto-sql fields (user puts lookupQuery by mistake for MAX+1 etc)
      if (isPureAutoSql) return false;
      return (f.type === 'select' || f.type === 'lookup') && (hasLookupDef || hasDefaultSql || (f.options && f.options.length) || (f.lookupConditions && f.lookupConditions.length));
    });
    for (const field of selectFields) {
        let sql = field.lookup?.sql || field.lookupQuery;

        // Fallback: if user put SELECT into defaultValue for a lookup (common mixup)
        if (!sql && field.type === 'lookup' && typeof field.defaultValue === 'string' && field.defaultValue.trim().toLowerCase().startsWith('select ')) {
            sql = field.defaultValue.trim();
            console.log('[lookup] using defaultValue as lookupQuery for', field.field);
        }

        // Support links between windows (связи между окнами в форме)
        if (!sql && (field.lookupWindow || field.lookup?.window)) {
            const winId = field.lookupWindow || field.lookup?.window;
            const targetWin = (fullConfig && fullConfig.windows ? fullConfig.windows : []).find(w =>
                w.id === winId || String(w.windowId || '') === String(winId) || w.id === winId
            );
            if (targetWin) {
                const tds = targetWin.dataSource || targetWin;
                let tbl = tds.table || targetWin.table || (targetWin.insert && targetWin.insert.table);
                // Fallback: extract table name from the window's query if needed
                if (!tbl && (tds.query || targetWin.query)) {
                    const q = tds.query || targetWin.query || '';
                    const m = q.match(/FROM\s+([A-Za-z0-9_]+)/i);
                    if (m) tbl = m[1];
                }
                const valF = field.lookupValueField || field.lookupValue || field.lookup?.valueField || 'TID';
                const dispF = field.lookupDisplayField || field.lookupDisplay || field.lookup?.displayField || valF;
                if (tbl) {
                    const isSame = valF === dispF;
                    const distinct = isSame ? 'DISTINCT ' : '';
                    const dispExpr = isSame ? valF : 'COALESCE(' + dispF + ', ' + valF + ')';
                    sql = 'SELECT ' + distinct + valF + ' as value, ' + dispExpr + ' as display FROM ' + tbl + ' LIMIT 1000';
                }
            }
        }

        const el = document.getElementById('f-' + field.field);
        if (!el) continue;

        // === РУЧНОЙ СПИСОК (static options) без базы ===
        if (Array.isArray(field.options) && field.options.length > 0) {
            const isLookupLike = field.type === 'lookup' || (field.type === 'select' && field.searchable);
            if (isLookupLike) {
                const dl = document.getElementById('dl-' + field.field);
                if (dl) {
                    dl.innerHTML = '';
                    field.options.forEach(opt => {
                        const v = (typeof opt === 'string') ? opt : (opt.value || '');
                        const d = (typeof opt === 'string') ? opt : (opt.display || v);
                        const o = document.createElement('option');
                        o.value = v;
                        if (d !== v) o.label = d;
                        dl.appendChild(o);
                    });
                }
            } else if (el.tagName === 'SELECT') {
                el.innerHTML = '<option value="">— Выберите —</option>';
                field.options.forEach(opt => {
                    const v = (typeof opt === 'string') ? opt : (opt.value || '');
                    const d = (typeof opt === 'string') ? opt : (opt.display || v);
                    el.innerHTML += `<option value="${v}">${d}</option>`;
                });
            }
            console.log('[lookup-static] populated', field.field, 'count=', field.options.length);

            if (field.options.length === 1) {
                const single = (typeof field.options[0]==='string') ? field.options[0] : field.options[0].value;
                if (single && (!el.value || el.value === '')) el.value = String(single);
                const dl2 = document.getElementById('dl-' + field.field);
                if (dl2) dl2.innerHTML = '';
                if (el.tagName === 'INPUT') el.removeAttribute('list');
            }
            continue; // static done, skip sql
        }

        if (!sql) continue;

        // Prevent "Too few parameter values" errors:
        // If the lookupQuery contains ? placeholders, it is almost always meant for cascading/dependsOn.
        // On initial load (no parent value yet) we skip it to avoid crash; the dependent logic will populate when value arrives.
        const paramCount = (sql.match(/\?/g) || []).length;
        if (paramCount > 0) {
            console.log('[lookup] skipping initial populate for parameterized query (dependsOn expected):', field.field);
            const el = document.getElementById('f-' + field.field);
            if (el && el.tagName === 'SELECT') {
                el.innerHTML = '<option value="">— Выберите —</option>';
            }
            continue;
        }

        // Prevent hang/freeze on large lookup tables for searchable selects:
        // Limit results for full-list loads (focus shows dropdown with custom rows)
        if (!/LIMIT\s+\d+/i.test(sql)) {
            sql += ' LIMIT 500';
        }

        try {
            const result = await window.electronAPI.getLookupData(sql);
            if (field.type === 'lookup' || (field.type === 'select' && field.searchable)) {
                const dl = document.getElementById('dl-' + field.field);
                if (dl) {
                    dl.innerHTML = '';
                    // cap even after query limit (safety)
                    const capped = result.slice(0, 500);
                    capped.forEach(row => {
                        const keys = Object.keys(row);
                        const value = row.value ?? row.val ?? row[keys[0]];
                        const display = row.display ?? row.disp ?? (row[keys[1]] !== undefined ? row[keys[1]] : value);
                        const opt = document.createElement('option');
                        opt.value = value;
                        if (display !== value) opt.label = display;
                        dl.appendChild(opt);
                    });
                    console.log('[lookup] populated datalist for', field.field, 'options=', capped.length);
                }
            } else {
                el.innerHTML = '<option value="">— Выберите —</option>';
                result.forEach(row => {
                    const keys = Object.keys(row);
                    const value = row.value ?? row.val ?? row[keys[0]];
                    const display = row.display ?? row.disp ?? (row[keys[1]] !== undefined ? row[keys[1]] : value);
                    el.innerHTML += '<option value="' + value + '">' + display + '</option>';
                });
            }

            // если 1 значение — авто + подавить список (оставляем для совместимости)
            if (result && result.length === 1) {
                try {
                    const row0 = result[0];
                    const k0 = Object.keys(row0);
                    const singleVal = row0.value ?? row0.val ?? row0[k0[0]];
                    if (singleVal != null && singleVal !== '') {
                        if (!el.value || el.value === '') {
                            setFormInputValue(el, String(singleVal), document.activeElement === el);
                        }
                        if (field.disabled) el.disabled = true;
                        if (field.readonly) el.readOnly = true;
                        const dl2 = document.getElementById('dl-' + field.field);
                        if (dl2) dl2.innerHTML = '';
                        if (el && el.tagName === 'INPUT') el.removeAttribute('list');
                    }
                } catch (_) {}
            }
        } catch (e) {
            console.error('Lookup error', e);
        }
    }
}

// Поддержка cascading / master-detail зависимостей в форме
function setupDependentLookups() {
    const formFields = (currentWindowConfig.form && currentWindowConfig.form.fields) || [];
    const insFields = (currentWindowConfig.insert && currentWindowConfig.insert.fields) || [];
    const allFormFields = [...formFields, ...insFields];

    const dependentFields = allFormFields.filter(f => f.dependsOn && (f.type === 'select' || f.type === 'lookup'));
    if (!dependentFields.length) return;

    const childrenOf = {};
    dependentFields.forEach(f => {
        const parent = f.dependsOn;
        if (!childrenOf[parent]) childrenOf[parent] = [];
        childrenOf[parent].push(f);
    });

    function buildLookupParams(query, val) {
        if (!val) return [];
        const count = (query.match(/\?/g) || []).length;
        return count > 0 ? new Array(count).fill(val) : [];
    }

    function clearFieldOptions(fieldName) {
        const fieldDef = allFormFields.find(f => f.field === fieldName);
        const el = document.getElementById('f-' + fieldName);
        if (!el) return;
        el.value = '';
        const isLookupLike = fieldDef && (fieldDef.type === 'lookup' || (fieldDef.type === 'select' && fieldDef.searchable));
        if (isLookupLike) {
            const dl = document.getElementById('dl-' + fieldName);
            if (dl) dl.innerHTML = '';
        } else if (el.tagName === 'SELECT') {
            el.innerHTML = '<option value="">— Выберите —</option>';
        }
    }

    function clearFieldTree(fieldName) {
        clearFieldOptions(fieldName);
        (childrenOf[fieldName] || []).forEach(child => clearFieldTree(child.field));
    }

    function populateLookupList(listEl, targetEl, depField, rows) {
        if (!listEl) return;
        listEl.innerHTML = '';
        (rows || []).forEach(row => {
            const keys = Object.keys(row);
            const value = row.value ?? row.val ?? row[keys[0]];
            const display = row.display ?? row.disp ?? (row[keys[1]] !== undefined ? row[keys[1]] : value);
            const opt = document.createElement('option');
            opt.value = value != null ? value : '';
            if (display !== value && display != null) opt.label = display;
            listEl.appendChild(opt);
        });

        if (rows && rows.length === 1 && targetEl) {
            try {
                const r0 = rows[0];
                const kk = Object.keys(r0);
                const sv = r0.value ?? r0.val ?? r0[kk[0]];
                if (sv != null && sv !== '') {
                    setFormInputValue(targetEl, String(sv), false);
                    if (depField.disabled) targetEl.disabled = true;
                    if (depField.readonly) targetEl.readOnly = true;
                    listEl.innerHTML = '';
                    if (targetEl.tagName === 'INPUT') targetEl.removeAttribute('list');
                }
            } catch (_) {}
        }
    }

    function populateSelect(selEl, rows, withPlaceholder = true) {
        if (!selEl) return;
        selEl.innerHTML = withPlaceholder ? '<option value="">— Выберите —</option>' : '';
        (rows || []).forEach(row => {
            const keys = Object.keys(row);
            const value = row.value ?? row.val ?? row[keys[0]];
            const display = row.display ?? row.disp ?? (row[keys[1]] !== undefined ? row[keys[1]] : value);
            selEl.innerHTML += `<option value="${value}">${display}</option>`;
        });
    }

    async function refreshDependentField(depField, sourceVal) {
        const targetEl = document.getElementById('f-' + depField.field);
        if (!targetEl) return;

        const isLookupTarget = depField.type === 'lookup' || (depField.type === 'select' && depField.searchable);
        const targetListEl = isLookupTarget ? document.getElementById('dl-' + depField.field) : null;

        if (!sourceVal) {
            clearFieldTree(depField.field);
            return;
        }

        let sql = depField.lookupQuery || (depField.lookup && depField.lookup.sql);
        if (!sql && depField.type === 'lookup' && typeof depField.defaultValue === 'string' && depField.defaultValue.trim().toLowerCase().startsWith('select ')) {
            sql = depField.defaultValue.trim();
        }

        if (Array.isArray(depField.lookupConditions)) {
            const match = depField.lookupConditions.find(c => String(c.value || '').trim() === String(sourceVal).trim());
            if (match && match.query) sql = match.query;
        }

        if (!sql && (depField.lookupWindow || (depField.lookup && depField.lookup.window))) {
            const winId = depField.lookupWindow || depField.lookup?.window;
            const targetWin = (fullConfig && fullConfig.windows || []).find(w => (w.id || w.windowId) == winId);
            if (targetWin) {
                const tds = targetWin.dataSource || targetWin;
                let tbl = tds.table || targetWin.table;
                if (!tbl && (tds.query || targetWin.query)) {
                    const m = (tds.query || targetWin.query).match(/FROM\s+([A-Za-z0-9_]+)/i);
                    if (m) tbl = m[1];
                }
                const valF = depField.lookupValueField || 'value';
                const dispF = depField.lookupDisplayField || valF;
                if (tbl) {
                    sql = `SELECT ${valF} as value, COALESCE(${dispF}, ${valF}) as display FROM ${tbl} WHERE ${depField.dependsOn} = ? LIMIT 2000`;
                }
            }
        }

        if (!sql) return;

        const params = buildLookupParams(sql, sourceVal);
        const result = await window.electronAPI.getLookupData(sql, params);
        if (isLookupTarget) {
            populateLookupList(targetListEl, targetEl, depField, result);
            setTimeout(() => setupCustomSearchableDropdown(targetEl, depField), 40);
        } else {
            populateSelect(targetEl, result, true);
        }

        if (targetEl.value) {
            setTimeout(() => targetEl.dispatchEvent(new Event('change', { bubbles: true })), 20);
        }
    }

    dependentFields.forEach(depField => {
        const sourceEl = document.getElementById('f-' + depField.dependsOn);
        if (!sourceEl) return;

        const onParentChange = () => {
            clearFieldTree(depField.field);
            const sourceVal = (sourceEl.value || '').trim();
            refreshDependentField(depField, sourceVal);
        };

        if (!sourceEl._dependsOnRefreshers) sourceEl._dependsOnRefreshers = [];
        sourceEl._dependsOnRefreshers.push(onParentChange);
        if (!sourceEl._dependsOnMasterWired) {
            sourceEl._dependsOnMasterWired = true;
            sourceEl.addEventListener('change', () => {
                (sourceEl._dependsOnRefreshers || []).forEach(fn => fn());
            });
        }

        if ((sourceEl.value || '').trim()) {
            setTimeout(onParentChange, 50);
        }
    });
}

/**
 * Красивый кастомный выпадающий список с ПОИСКОМ и СКРОЛЛОМ (заменяет убогий datalist)
 * Поддерживает ручные варианты и из БД.
 */
function setupCustomSearchableDropdown(inputEl, fieldCfg) {
  if (!inputEl || inputEl.tagName !== 'INPUT') return;
  if (inputEl.disabled || inputEl.readOnly) return;

  // Clean previous handlers
  if (inputEl._searchableHandlers) {
    const h = inputEl._searchableHandlers;
    inputEl.removeEventListener('focus', h.focus);
    inputEl.removeEventListener('click', h.click);
    inputEl.removeEventListener('input', h.input);
    inputEl.removeEventListener('keydown', h.keydown);
    if (inputEl._mousedownHandler) inputEl.removeEventListener('mousedown', inputEl._mousedownHandler);
  }

  inputEl.removeAttribute('list');

  let drop = null;
  let allOpts = [];

  function getAllOptions() {
    allOpts = [];
    const dl = document.getElementById('dl-' + fieldCfg.field);
    if (dl && dl.options.length) {
      Array.from(dl.options).forEach(o => {
        if (o.value) allOpts.push({ value: o.value, display: o.label || o.value });
      });
    }
    if (!allOpts.length && Array.isArray(fieldCfg.options)) {
      allOpts = fieldCfg.options.map(o => 
        typeof o === 'string' ? {value: o, display: o} : {value: o.value || '', display: o.display || o.value || ''}
      );
    }
    return allOpts;
  }

  function renderDrop(filtered) {
    closeCurrentDropdown();
    document.querySelectorAll('div.fixed.z-\\[99999\\]').forEach(d => d.remove());

    if (!filtered || !filtered.length) return;

    drop = document.createElement('div');
    drop.className = 'fixed z-[99999] bg-slate-900 border border-slate-600 rounded-2xl shadow-2xl text-sm overflow-hidden';
    drop.style.maxHeight = '260px';
    drop.style.overflowY = 'auto';
    drop.style.minWidth = Math.max(inputEl.offsetWidth, 220) + 'px';

    const listWrap = document.createElement('div');
    listWrap.className = 'py-1 custom-scroll';

    filtered.forEach(item => {
      const row = document.createElement('div');
      row.className = 'px-3 py-[5px] hover:bg-slate-700 cursor-pointer flex items-center justify-between gap-3 text-slate-200';
      row.innerHTML = `
        <span class="font-medium">${item.display}</span>
        ${item.display !== item.value ? `<span class="text-[10px] text-slate-500 font-mono">${item.value}</span>` : ''}
      `;
      row.onmousedown = (ev) => {
        ev.preventDefault();
        inputEl.value = item.value;
        inputEl.dispatchEvent(new Event('input', {bubbles: true}));
        inputEl.dispatchEvent(new Event('change', {bubbles: true}));
        closeCurrentDropdown();
        setTimeout(() => inputEl.blur(), 0);
      };
      listWrap.appendChild(row);
    });

    drop.appendChild(listWrap);

    const r = inputEl.getBoundingClientRect();
    drop.style.left = r.left + 'px';
    drop.style.top = (r.bottom + 3) + 'px';
    drop.style.width = r.width + 'px';

    document.body.appendChild(drop);
    currentDrop = drop;
    currentInputEl = inputEl;

    inputEl.focus();
    setTimeout(() => {
      if (document.activeElement === inputEl) {
        try {
          const len = inputEl.value ? inputEl.value.length : 0;
          inputEl.setSelectionRange(len, len);
        } catch(e){}
      }
    }, 0);

    installGlobalDropdownCloser();
  }

  function hideDrop() {
    closeCurrentDropdown();
  }

  function doFilterAndShow() {
    const q = (inputEl.value || '').toLowerCase().trim();
    const opts = getAllOptions();
    let f = opts;
    if (q) {
      f = opts.filter(op =>
        (op.value || '').toLowerCase().includes(q) ||
        (op.display || '').toLowerCase().includes(q)
      );
    }
    f = f.slice(0, 100);
    if (f.length > 0) renderDrop(f);
    else hideDrop();
  }

  const showAll = () => {
    const opts = getAllOptions();
    renderDrop(opts.slice(0, 100));

    setTimeout(() => {
      if (document.activeElement === inputEl) {
        try {
          const len = inputEl.value ? inputEl.value.length : 0;
          inputEl.setSelectionRange(len, len);
        } catch (e) {}
      }
    }, 0);
  };

  // Store handlers for cleanup
  inputEl._searchableHandlers = {
    focus: showAll,
    click: showAll,
    input: doFilterAndShow,
    keydown: (e) => { if (e.key === 'Escape') hideDrop(); }
  };

  inputEl.addEventListener('focus', showAll);
  inputEl.addEventListener('click', showAll);
  inputEl.addEventListener('input', doFilterAndShow);
  inputEl.addEventListener('keydown', inputEl._searchableHandlers.keydown);

  // mousedown safety
  inputEl._mousedownHandler = () => {
    setTimeout(() => {
      const opts = getAllOptions();
      renderDrop(opts);
    }, 0);
  };
  inputEl.addEventListener('mousedown', inputEl._mousedownHandler);

  // Extra caret safety
  inputEl.addEventListener('focus', () => {
    setTimeout(() => {
      if (document.activeElement === inputEl && document.getElementById('form-modal')) {
        try {
          const len = inputEl.value ? inputEl.value.length : 0;
          inputEl.setSelectionRange(len, len);
        } catch(e){}
      }
    }, 0);
  });
}


// Вызываем после заполнения списков
function setupAllCustomDropdowns(formFields) {
  (formFields || []).forEach(f => {
    if (f.type !== 'lookup' && !(f.type === 'select' && f.searchable)) return;
    const el = document.getElementById('f-' + f.field);
    if (el) setupCustomSearchableDropdown(el, f);
  });
}

function closeFormModal() {
    const modal = document.getElementById('form-modal');
    if (modal) modal.remove();
    // Clear prefill context after form use (for master-detail inserts)
    if (pendingFormPrefill) {
        pendingFormPrefill = null;
    }
    cleanupAllDropdowns();
}

function showToast(message, type = 'success', duration = 2500) {
  const toast = document.createElement('div');
  toast.className = `fixed bottom-4 right-4 px-4 py-3 rounded-xl shadow-xl z-[100000] text-sm font-medium flex items-center gap-2 transition-all ${
    type === 'success' ? 'bg-emerald-600 text-white' : 
    type === 'error' ? 'bg-red-600 text-white' : 
    'bg-slate-700 text-white'
  }`;
  toast.innerHTML = `
    <span>${message}</span>
  `;
  document.body.appendChild(toast);

  // auto hide
  setTimeout(() => {
    toast.style.transition = 'all 0.3s ease';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, duration);

  // click to dismiss
  toast.onclick = () => toast.remove();
}

function setFormInputValue(el, val, preserveCaret = true) {
  if (!el) return;
  const wasFocused = document.activeElement === el;
  const start = (wasFocused && preserveCaret) ? (el.selectionStart || 0) : 0;
  el.value = (val != null ? String(val) : '');
  if (wasFocused && preserveCaret) {
    setTimeout(() => {
      if (document.activeElement !== el) {
        el.focus();
      }
      const len = el.value.length;
      try {
        el.setSelectionRange(Math.min(start, len), len);
      } catch (e) {}
    }, 0);
  }
}

async function computeSetValueForSpec(spec) {
  if (!spec) return '';
  const type = (spec.valueType || spec.type || 'constant').toString();
  if (type === 'empty' || type === 'null') return '';

  if (type === 'constant') {
    return spec.value != null ? String(spec.value) : '';
  }

  if (type === 'now' || type === 'NOW' || type === 'CURRENT_DATETIME') {
    const now = new Date();
    const fmt = spec.format || 'DD/MM/YYYY HH:mm:ss';
    return formatDate(now, fmt);
  }
  if (type === 'today' || type === 'TODAY' || type === 'CURRENT_DATE') {
    const now = new Date();
    const fmt = spec.format || 'DD/MM/YYYY';
    return formatDate(now, fmt);
  }

  if (type === 'fromForm' || type === 'copy' || type === 'field') {
    const src = spec.sourceField || spec.source || spec.fieldSource;
    if (!src) return '';
    const el = document.getElementById('f-' + src);
    return el ? (el.value || '') : '';
  }

  if (type === 'currentUser' || type === 'CURRENT_USER' || type === 'user') {
    return (currentUser && currentUser.login) || (localStorage.getItem('currentUser') ? (JSON.parse(localStorage.getItem('currentUser')).login || 'system') : 'system');
  }
  if (type === 'currentUserId' || type === 'CURRENT_USER_ID' || type === 'userId') {
    const u = (currentUser && currentUser.id) || (localStorage.getItem('currentUser') ? JSON.parse(localStorage.getItem('currentUser')).id : null);
    return u != null ? String(u) : '';
  }
  if (type === 'uuid' || type === 'UUID') {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  if (type === 'sql' || type === 'fromDB' || type === 'query') {
    let q = (spec.query || '').trim();
    if (!q) return '';
    // resolve params
    const params = [];
    const pms = spec.paramSources || spec.params || spec.paramMappings || [];
    for (const p of (Array.isArray(pms) ? pms : [])) {
      if (!p) continue;
      const kind = p.kind || p.type || 'field';
      let v;
      if (kind === 'literal' || kind === 'const' || kind === 'constant') {
        v = (p.val != null ? p.val : (p.value != null ? p.value : ''));
      } else {
        const fname = p.name || p.field || p.val || p.value;
        if (fname) {
          const el = document.getElementById('f-' + fname);
          v = el ? (el.value || '') : '';
        }
      }
      params.push(v);
    }
    try {
      const res = await window.electronAPI.executeQuery(q, params);
      if (res && res.success && res.rows && res.rows.length > 0) {
        const row = res.rows[0];
        const firstVal = Object.values(row)[0];
        return firstVal != null ? String(firstVal) : '';
      }
      return '';
    } catch (e) {
      console.error('[setFields sql] error', q, e);
      throw e;  // let caller (handleCustomFormButton) decide the message (customError if provided)
    }
  }

  // fallback legacy string value in spec
  if (spec.value != null) {
    if (spec.value === 'NOW' || spec.value === 'now') {
      const now = new Date();
      return formatDate(now, 'DD/MM/YYYY HH:mm:ss');
    }
    return String(spec.value);
  }
  return '';
}

function collectFormFieldData(formConfig) {
    const formData = {};
    const fieldsToUse = (formConfig && formConfig.fields) || [];
    fieldsToUse.forEach(f => {
        const el = document.getElementById('f-' + f.field);
        if (!el) return;
        if (f.type === 'checkbox') {
            formData[f.field] = el.checked ? (f.checkedValue || 'Y') : (f.uncheckedValue || '');
        } else {
            formData[f.field] = el.value || '';
        }
    });
    return formData;
}

function resolveExportOutputFilename(btn, data) {
    if (btn.outputFilename && String(btn.outputFilename).trim()) {
        return String(btn.outputFilename).trim();
    }
    const ts = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '');
    return 'export_' + ts + '.xlsx';
}

async function handleExportExcelAction(btn, context) {
    const customError = btn.errorMessage || btn.error || '';
    const customSuccess = btn.successMessage || '';
    const cellMap = btn.defaultCellMapping || btn.mapping || {};
    const mapKeys = Object.keys(cellMap || {});

    if (!mapKeys.length) {
        showToast(customError || 'Не настроен маппинг полей → ячеек Excel', 'error');
        return;
    }

    let data = {};
    if (context && context.source === 'form') {
        data = collectFormFieldData(context.formConfig);
    } else {
        data = { ...((context && context.row) || selectedRow || {}) };
    }

    const hasTemplate = !!(btn.templateFile || btn.templatePath || btn.template);
    let exportRes;

    try {
        if (hasTemplate) {
            exportRes = parseExportResult(await window.electronAPI.exportXlsxTemplate({
                templateDir: btn.templateDir || 'C:\\GTerminalPro\\templates',
                templateFile: btn.templateFile || btn.template || '',
                templatePath: btn.templatePath || '',
                cellMapping: cellMap,
                data,
                outputFilename: resolveExportOutputFilename(btn, data)
            }));
        } else {
            const exportRow = {};
            mapKeys.forEach(field => {
                exportRow[cellMap[field]] = data[field] != null ? data[field] : '';
            });
            const fname = resolveExportOutputFilename(btn, data);
            exportRes = parseExportResult(await window.electronAPI.exportXlsx([exportRow], fname));
        }

        if (exportRes.success) {
            showToast(customSuccess || ('Экспорт в Excel выполнен: ' + (exportRes.path || exportRes.filename || '')));
        } else {
            showToast(customError || ('Ошибка экспорта: ' + (exportRes.error || 'неизвестная ошибка')), 'error');
        }
    } catch (e) {
        showToast(customError || ('Ошибка экспорта в Excel: ' + e.message), 'error');
    }
}

function renderGridCustomButtons() {
    const container = document.getElementById('grid-custom-buttons');
    if (!container || !currentWindowConfig) return;
    container.innerHTML = '';

    const buttons = (currentWindowConfig.formCustomButtons || []).filter(btn => {
        const modes = Array.isArray(btn.modes) && btn.modes.length > 0 ? btn.modes : ['insert', 'update'];
        return btn.action === 'exportExcel' && modes.includes('select');
    });

    if (!selectedRow || !buttons.length) return;

    buttons.forEach(btn => {
        const b = document.createElement('button');
        b.textContent = btn.label || 'Выгрузить в Excel';
        b.className = 'px-3 py-2 rounded-lg text-xs font-medium transition-all';
        if (btn.style) {
            if (btn.style.bg) b.style.backgroundColor = btn.style.bg;
            if (btn.style.color) b.style.color = btn.style.color;
            if (btn.style.width && btn.style.width !== 'auto') b.style.width = btn.style.width;
            if (btn.style.height && btn.style.height !== 'auto') b.style.height = btn.style.height;
        } else {
            b.className += ' bg-emerald-700 hover:bg-emerald-600 text-white';
        }
        b.onclick = () => handleExportExcelAction(btn, { source: 'row', row: selectedRow });
        container.appendChild(b);
    });
}

async function handleCustomFormButton(btn, isInsert, formConfig) {
  const action = btn.action || 'setFields';
  const customError = btn.errorMessage || btn.error || '';
  const customSuccess = btn.successMessage || '';

  if (action === 'setFields' || action === 'updateFields') {
    // Rich support: array of specs with valueType, or legacy flat object
    let rawSet = btn.set || btn.fields || {};
    let specs = [];
    if (Array.isArray(rawSet)) {
      specs = rawSet;
    } else if (rawSet && typeof rawSet === 'object') {
      specs = Object.keys(rawSet).map(fld => {
        const v = rawSet[fld];
        if (v && typeof v === 'object') return { field: fld, ...v };
        const isNow = (v === 'NOW' || v === 'now');
        return { field: fld, valueType: isNow ? 'now' : 'constant', value: isNow ? '' : v };
      });
    }

    try {
      for (const spec of specs) {
        const val = await computeSetValueForSpec(spec);
        const el = document.getElementById('f-' + spec.field);
        if (el) {
          setFormInputValue(el, (val != null ? val : ''), document.activeElement === el);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          // ensure even disabled/readonly inputs get the value for save
          if (el.disabled) el.disabled = false;
        }
      }

      const willSave = !!btn.saveAfter || !!btn.autoSave;
      const successText = customSuccess || (willSave ? 'Значения установлены. Выполняется сохранение в БД...' : 'Значения установлены в форму. Нажмите Сохранить.');
      showToast(successText);
      if (willSave) {
        setTimeout(() => {
          try {
            if (isInsert && typeof saveNewRecord === 'function') {
              saveNewRecord();
            } else if (typeof saveUpdatedRecord === 'function') {
              saveUpdatedRecord();
            }
          } catch (e) { console.warn('auto-save after set failed', e); }
        }, 80);
      }
    } catch (e) {
      const msg = customError || ('Ошибка установки значений: ' + (e && e.message || e));
      showToast(msg, 'error');
    }
  } else if (action === 'importExcel') {
    try {
      const filePath = await window.electronAPI.selectFile({
        filters: [{ name: 'Excel Files', extensions: ['xlsx', 'xls'] }]
      });
      if (!filePath) return;

      const defaultMap = btn.defaultCellMapping || btn.mapping || {};
      const mapKeys = Object.keys(defaultMap || {});

      if (mapKeys.length > 0) {
        // Полностью автоматическое применение по маппингу, заданному в админке кнопки.
        // Интерактивное окно "Сопоставление ячеек" полностью убрано.
        // Алерт при отсутствии маппинга или пустом результате тоже убран.
        const appliedCount = await applyImportedExcelCells(filePath, defaultMap);
        if (appliedCount > 0) {
          const successText = customSuccess || `Данные из Excel применены автоматически (${appliedCount} полей).`;
          showToast(successText);
        } else if (mapKeys.length > 0 && customError) {
          // При неправильности (ничего не применилось) — показываем указанную пользователем ошибку
          showToast(customError, 'error');
        }
        // если маппинг пустой или не применилось ничего — тихо выходим (или custom error выше)
      } 
      // отсутствие маппинга — ничего не делаем и не показываем алертов
    } catch (e) {
      const msg = customError || ('Ошибка импорта Excel: ' + e.message);
      showToast(msg, 'error');
    }
  } else if (action === 'exportExcel') {
    await handleExportExcelAction(btn, { source: 'form', formConfig });
  }
}

function showExcelMappingModal(rowData, formFields) {
  const modal = document.createElement('div');
  modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-[110]';
  const excelCols = Object.keys(rowData);
  let html = `<div class="bg-slate-800 border border-slate-600 rounded-2xl p-4 w-[500px] max-h-[80vh] overflow-auto">
    <div class="font-semibold mb-2">Сопоставление колонок Excel → поля формы</div>`;
  formFields.forEach(f => {
    html += `<div class="flex items-center gap-2 mb-1">
      <span class="w-32 text-xs">${f.field}</span>
      <select id="map-${f.field}" class="flex-1 bg-slate-700 text-xs px-1 py-0.5 rounded">`;
    excelCols.forEach(col => {
      html += `<option value="${col}">${col}</option>`;
    });
    html += `</select>
    </div>`;
  });
  html += `<div class="mt-2 flex gap-2">
    <button id="apply-map" class="flex-1 bg-emerald-600 px-3 py-1 rounded text-sm">Применить</button>
    <button id="cancel-map" class="flex-1 bg-slate-600 px-3 py-1 rounded text-sm">Отмена</button>
  </div></div>`;
  modal.innerHTML = html;
  document.body.appendChild(modal);
  modal.querySelector('#cancel-map').onclick = () => modal.remove();
  modal.querySelector('#apply-map').onclick = () => {
    formFields.forEach(f => {
      const sel = modal.querySelector(`#map-${f.field}`);
      if (sel) {
        const col = sel.value;
        const val = rowData[col];
        const el = document.getElementById('f-' + f.field);
        if (el) {
          el.value = val != null ? val : '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    });
    modal.remove();
    showToast('Данные из Excel применены.');
  };
}

/**
 * Применяет преднастроенный маппинг ячеек Excel → поля формы.
 * Используется для автоматического импорта когда маппинг задан в админке кнопки.
 */
async function applyImportedExcelCells(filePath, fieldToCellMap) {
  let applied = 0;
  for (const [fld, cell] of Object.entries(fieldToCellMap || {})) {
    const cellRef = (cell || '').toString().trim().toUpperCase();
    if (!cellRef) continue;
    try {
      const val = await window.electronAPI.readExcelCell(filePath, cellRef);
      const el = document.getElementById('f-' + fld);
      if (el) {
        setFormInputValue(el, val != null ? val : '', false);
        el.dispatchEvent(new Event('change', { bubbles: true }));
        applied++;
      }
    } catch (e) {
      console.error('Excel cell apply error', fld, cellRef, e);
    }
  }
  return applied;
}

function getLanguageDisplayName(lang) {
    const names = {
        'armenian': 'армянские буквы',
        'armenian_alphanumeric': 'армянские буквы, цифры и символы',
        'latin': 'латинские буквы',
        'latin_alphanumeric': 'латинские буквы, цифры и символы',
        'cyrillic': 'кириллические буквы',
        'cyrillic_alphanumeric': 'кириллические буквы, цифры и символы',
        'digits': 'только цифры',
        'alphanumeric': 'латинские буквы и цифры'
    };
    return names[lang] || lang;
}

async function validateField(field, value) {
    if (!field.validations || !Array.isArray(field.validations)) return [];
    const errors = [];
    const strVal = value == null ? '' : String(value).trim();

    for (const v of field.validations) {
        if (v.type === 'required') {
            if (!strVal) {
                errors.push(v.error || 'Поле обязательно');
            }
        }

        if (v.type === 'length' || v.type === 'minmax') {
            const len = strVal.length;
            if (v.exact != null && len !== v.exact) {
                errors.push(v.error || 'Длина должна быть ровно ' + v.exact + ' символов');
            } else {
                if (v.min != null && len < v.min) {
                    errors.push(v.error || 'Минимум ' + v.min + ' символов');
                }
                if (v.max != null && len > v.max) {
                    errors.push(v.error || 'Максимум ' + v.max + ' символов');
                }
            }
        }

        if (v.type === 'pattern' && v.pattern) {
            try {
                const re = new RegExp(v.pattern);
                if (strVal && !re.test(strVal)) {
                    errors.push(v.error || 'Не соответствует формату');
                }
            } catch (e) {
                errors.push(v.error || 'Неверный формат регулярного выражения');
            }
        }

        if (v.type === 'uppercase') {
            if (strVal && strVal !== strVal.toUpperCase()) {
                errors.push(v.error || 'Поле должно быть в верхнем регистре');
            }
        }

        if (v.type === 'lowercase') {
            if (strVal && strVal !== strVal.toLowerCase()) {
                errors.push(v.error || 'Поле должно быть в нижнем регистре');
            }
        }

        if (v.type === 'trim') {
            const original = String(value == null ? '' : value);
            if (original !== original.trim()) {
                errors.push(v.error || 'Не должно быть пробелов в начале и конце текста');
            }
        }

        if (v.type === 'language' && v.language) {
            let regex = null;
            const lang = v.language;

            if (lang === 'armenian')
                regex = /^[\u0531-\u0556\u0561-\u0587\s]+$/;
            else if (lang === 'armenian_alphanumeric')
                regex = /^[\u0531-\u0556\u0561-\u05870-9\s.,\-_/()@#$%&+:]+$/;
            else if (lang === 'latin')
                regex = /^[A-Za-z\s]+$/;
            else if (lang === 'latin_alphanumeric')
                regex = /^[A-Za-z0-9\s.,\-_/()@#$%&+:]+$/;
            else if (lang === 'cyrillic')
                regex = /^[\u0400-\u04FF\s]+$/;
            else if (lang === 'cyrillic_alphanumeric')
                regex = /^[\u0400-\u04FF0-9\s.,\-_/()@#$%&+:]+$/;
            else if (lang === 'digits')
                regex = /^\d+$/;
            else if (lang === 'alphanumeric')
                regex = /^[A-Za-z0-9\s]+$/;

            if (regex && !regex.test(strVal)) {
                const display = getLanguageDisplayName(lang);
                errors.push(v.error || ('Поле должно содержать только ' + display));
            }
        }

        if (v.type === 'position' && v.value) {
            const start = (v.start || 1) - 1; // 1-based to 0-based
            const len = v.length || v.value.length;
            if (start < 0 || start + len > strVal.length) {
                errors.push(v.error || 'Позиция ' + (v.start || 1) + ' недоступна');
            } else {
                const actual = strVal.substring(start, start + len);
                if (actual !== v.value) {
                    errors.push(v.error || 'В позиции ' + (v.start || 1) + ' должно быть "' + v.value + '" (сейчас "' + actual + '")');
                }
            }
        }

        if (v.type === 'custom' && v.condition) {
            try {
                const fn = new Function('value', `return (${v.condition});`);
                if (fn(value)) {
                    errors.push(v.error || 'Условие не выполнено');
                }
            } catch (e) {
                errors.push(v.error || 'Ошибка в условии валидации');
            }
        }

        if (v.type === 'uppercase') {
            if (strVal && strVal !== strVal.toUpperCase()) {
                errors.push(v.error || 'Поле должно быть в верхнем регистре');
            }
        }

        if (v.type === 'lowercase') {
            if (strVal && strVal !== strVal.toLowerCase()) {
                errors.push(v.error || 'Поле должно быть в нижнем регистре');
            }
        }

        if (v.type === 'trim') {
            const original = String(value == null ? '' : value);
            if (original !== original.trim()) {
                errors.push(v.error || 'Не должно быть пробелов в начале и конце текста');
            }
        }

        if (v.type === 'uppercase') {
            if (strVal && strVal !== strVal.toUpperCase()) {
                errors.push(v.error || 'Поле должно быть в верхнем регистре');
            }
        }

        if (v.type === 'lowercase') {
            if (strVal && strVal !== strVal.toLowerCase()) {
                errors.push(v.error || 'Поле должно быть в нижнем регистре');
            }
        }

        if (v.type === 'trim') {
            const original = String(value == null ? '' : value);
            if (original !== original.trim()) {
                errors.push(v.error || 'Не должно быть пробелов в начале и конце текста');
            }
        }

        if ((v.type === 'unique' || v.type === 'custom') && v.query) {
            if (strVal || (v.fields && v.fields.length)) {
                try {
                    let params = [value];
                    if (v.fields && Array.isArray(v.fields) && v.fields.length > 0) {
                        params = v.fields.map(fldName => {
                            const fel = document.getElementById('f-' + fldName);
                            if (fel) {
                                if (fel.type === 'checkbox' || field.type === 'checkbox') {
                                    return fel.checked ? (field.checkedValue || 'Y') : (field.uncheckedValue || '');
                                }
                                return fel.value;
                            }
                            return value; // fallback
                        });
                    }
                    const res = await window.electronAPI.executeQuery(v.query, params);
                    if (res.success && res.rows && res.rows.length > 0) {
                        errors.push(v.error || 'Ошибка уникальности');
                    }
                } catch (e) {
                    errors.push(v.error || 'Ошибка выполнения проверки');
                }
            }
        }
    }
    return errors;
}

function syncValidateField(field, value) {
    const errors = [];
    const strVal = value == null ? '' : String(value).trim();

    for (const v of (field.validations || [])) {
        if (v.type === 'required' && !strVal) {
            errors.push(v.error || 'Поле обязательно');
        }

        if (v.type === 'length' || v.type === 'minmax') {
            const len = strVal.length;
            if (v.exact != null && len !== v.exact) {
                errors.push(v.error || 'Длина должна быть ровно ' + v.exact + ' символов');
            } else {
                if (v.min != null && len < v.min) errors.push(v.error || 'Минимум ' + v.min + ' символов');
                if (v.max != null && len > v.max) errors.push(v.error || 'Максимум ' + v.max + ' символов');
            }
        }

        if (v.type === 'pattern' && v.pattern) {
            try {
                const re = new RegExp(v.pattern);
                if (strVal && !re.test(strVal)) {
                    errors.push(v.error || 'Не соответствует формату');
                }
            } catch (e) {
                errors.push(v.error || 'Неверный формат регулярного выражения');
            }
        }

        if (v.type === 'text' && v.text_type) {
            let regex = null;
            const t = v.text_type;
            if (t === 'letters_only') regex = /^[a-zA-Zа-яА-ЯёЁ\u0531-\u0587\s]+$/;
            else if (t === 'no_digits') regex = /^[^\d]+$/;
            else if (t === 'no_special') regex = /^[a-zA-Zа-яА-ЯёЁ\u0531-\u0587\s]+$/;
            else if (t === 'armenian_only') regex = /^[\u0531-\u0556\u0561-\u0587]+$/;
            if (regex && !regex.test(strVal)) {
                errors.push(v.error || 'Текст не соответствует выбранному правилу');
            }
        }

        if (v.type === 'language' && v.language) {
            let regex = null;
            const lang = v.language;

            if (lang === 'armenian')
                regex = /^[\u0531-\u0556\u0561-\u0587\s]+$/;
            else if (lang === 'armenian_alphanumeric')
                regex = /^[\u0531-\u0556\u0561-\u05870-9\s.,\-_/()@#$%&+:]+$/;
            else if (lang === 'latin')
                regex = /^[A-Za-z\s]+$/;
            else if (lang === 'latin_alphanumeric')
                regex = /^[A-Za-z0-9\s.,\-_/()@#$%&+:]+$/;
            else if (lang === 'cyrillic')
                regex = /^[\u0400-\u04FF\s]+$/;
            else if (lang === 'cyrillic_alphanumeric')
                regex = /^[\u0400-\u04FF0-9\s.,\-_/()@#$%&+:]+$/;
            else if (lang === 'digits')
                regex = /^\d+$/;
            else if (lang === 'alphanumeric')
                regex = /^[A-Za-z0-9\s]+$/;

            if (regex && !regex.test(strVal)) {
                const display = getLanguageDisplayName(lang);
                errors.push(v.error || ('Поле должно содержать только ' + display));
            }
        }

        if (v.type === 'position' && v.value) {
            const start = (v.start || 1) - 1;
            const len = v.length || v.value.length;
            if (start < 0 || start + len > strVal.length) {
                errors.push(v.error || 'Позиция ' + (v.start || 1) + ' недоступна');
            } else {
                const actual = strVal.substring(start, start + len);
                if (actual !== v.value) {
                    errors.push(v.error || 'В позиции ' + (v.start || 1) + ' должно быть "' + v.value + '"');
                }
            }
        }

        if (v.type === 'custom' && v.condition) {
            try {
                // Простая клиентская if-логика, напр. "value > 1"
                const fn = new Function('value', `return (${v.condition});`);
                if (fn(value)) {
                    errors.push(v.error || 'Условие не выполнено');
                }
            } catch (e) {
                errors.push(v.error || 'Ошибка в условии валидации');
            }
        }
    }
    return errors;
}

function updateFormSaveButton() {
    const btn = document.getElementById('form-save-btn');
    if (!btn) return;

    const hasError = document.querySelectorAll('#form-fields [id^="err-"]').length > 0 &&
                     Array.from(document.querySelectorAll('#form-fields [id^="err-"]'))
                           .some(el => el.textContent.trim() !== '');

    btn.disabled = hasError;
}

function setupLiveValidation(fields) {
    if (!fields || !Array.isArray(fields)) return;

    fields.forEach(field => {
        if (field.systemVariable || field.autoValue || field.hiddenInForm || field.disabled || field.readonly) return;

        const el = document.getElementById('f-' + field.field);
        const errEl = document.getElementById('err-' + field.field);
        if (!el || !errEl) return;

        const check = async (isBlur = false) => {
            let val = (el.type === 'checkbox' || field.type === 'checkbox') 
                ? (el.checked ? (field.checkedValue || 'Y') : (field.uncheckedValue || '')) 
                : el.value;

            let errs = [];

            // Always run sync validations immediately
            errs = syncValidateField(field, val);

            if (errs.length === 0 && isBlur) {
                // On blur, also run full (including async unique/custom)
                errs = await validateField(field, val);
            }

            errEl.textContent = errs.length ? errs[0] : '';

            if (errs.length) {
                el.classList.add('!border-red-500', 'focus:!border-red-500');
            } else {
                el.classList.remove('!border-red-500', 'focus:!border-red-500');
            }

            updateFormSaveButton();
        };

        el.addEventListener('input', () => check(false));
        el.addEventListener('change', () => check(false));

        // Async checks only on blur to avoid too many DB calls
        el.addEventListener('blur', () => check(true));

        // Initial check
        setTimeout(() => check(false), 30);
    });

    // Initial button state
    setTimeout(() => {
        updateFormSaveButton();
        // Re-check after lookups populate selects
        fields.forEach(field => {
            if (field.systemVariable || field.autoValue || field.hiddenInForm || field.disabled || field.readonly) return;
            const el = document.getElementById('f-' + field.field);
            if (el) {
                const check = () => {
                    let val = (el.type === 'checkbox' || field.type === 'checkbox') 
                        ? (el.checked ? (field.checkedValue || 'Y') : (field.uncheckedValue || '')) 
                        : el.value;
                    const errs = syncValidateField(field, val);
                    const errEl = document.getElementById('err-' + field.field);
                    if (errEl) errEl.textContent = errs.length ? errs[0] : '';
                    if (errs.length) {
                        el.classList.add('!border-red-500', 'focus:!border-red-500');
                    } else {
                        el.classList.remove('!border-red-500', 'focus:!border-red-500');
                    }
                };
                setTimeout(check, 150);
            }
        });
        updateFormSaveButton();
    }, 120);
}

function formatDate(date, format = 'YYYY-MM-DD HH:mm:ss') {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return format
        .replace(/YYYY/g, y)
        .replace(/MM/g, m)
        .replace(/DD/g, d)
        .replace(/HH/g, h)
        .replace(/mm/g, min)
        .replace(/ss/g, s);
}

function getSystemValue(field, mode = 'insert') {
    // Support both legacy systemVariable string and new rich autoValue object
    let sys = field.systemVariable;
    let auto = field.autoValue;

    const now = new Date();

    // If using the new autoValue structure
    if (auto && typeof auto === 'object') {
        const type = auto.type || auto;
        switch (type) {
            case 'uuid':
            case 'UUID':
                return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
                    return v.toString(16);
                });
            case 'timestamp':
                return Math.floor(now.getTime() / 1000);
            case 'now':
            case 'CURRENT_DATETIME':
                return formatDate(now, auto.format || field.format || 'YYYY-MM-DD HH:mm:ss');
            case 'today':
            case 'CURRENT_DATE':
                return formatDate(now, auto.format || field.format || 'YYYY-MM-DD');
            case 'user_login':
            case 'CURRENT_USER':
                return currentUser?.login || (localStorage.getItem('currentUser') ? JSON.parse(localStorage.getItem('currentUser')).login : 'system');
            case 'user_id':
                return currentUser?.id || (localStorage.getItem('currentUser') ? JSON.parse(localStorage.getItem('currentUser')).id : null);
            case 'random_string':
                return Math.random().toString(36).substring(2, 12);
            case 'random_int':
                const minI = parseInt(auto.min || 100000);
                const maxI = parseInt(auto.max || 999999);
                return Math.floor(Math.random() * (maxI - minI + 1)) + minI;
            case 'random_float':
                const minF = parseFloat(auto.min || 0);
                const maxF = parseFloat(auto.max || 1);
                return (Math.random() * (maxF - minF) + minF).toFixed(4);
            case 'short_id':
                return Math.random().toString(36).substring(2, 10);
            case 'year':
                return now.getFullYear();
            case 'month':
                return String(now.getMonth()+1).padStart(2,'0');
            case 'day':
                return String(now.getDate()).padStart(2,'0');
            case 'copy':
            case 'copy_field':
                return null;
            case 'constant':
                return auto.value || '';
            default:
                if (typeof type === 'string' && type.startsWith('sql:')) {
                    return null;
                }
                return null;
        }
    }

    // Legacy string support
    if (!sys) return null;

    switch (sys.toLowerCase ? sys.toLowerCase() : sys) {
        case 'now':
        case 'current_datetime':
            return formatDate(now, field.format || 'YYYY-MM-DD HH:mm:ss');
        case 'today':
        case 'current_date':
            return formatDate(now, field.format || 'YYYY-MM-DD');
        case 'timestamp':
            return Math.floor(now.getTime() / 1000);
        case 'user_login':
        case 'current_user':
            return currentUser?.login || (localStorage.getItem('currentUser') ? JSON.parse(localStorage.getItem('currentUser')).login : 'system');
        case 'user_id':
        case 'current_user_id':
            return currentUser?.id || (localStorage.getItem('currentUser') ? JSON.parse(localStorage.getItem('currentUser')).id : null);
        case 'uuid':
            return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            });
        case 'random_string':
            return Math.random().toString(36).substring(2, 12);
        case 'random_int':
            const minI = parseInt(field.autoValue?.min || 100000);
            const maxI = parseInt(field.autoValue?.max || 999999);
            return Math.floor(Math.random() * (maxI - minI + 1)) + minI;
        case 'short_id':
            return Math.random().toString(36).substring(2, 10);
        case 'year':
            return now.getFullYear();
        case 'month':
            return String(now.getMonth() + 1).padStart(2, '0');
        case 'day':
            return String(now.getDate()).padStart(2, '0');
        case 'constant':
            return field.defaultValue || sys;
        default:
            return null;
    }
}

async function computeAutoValue(field) {
    if (!field) return null;
    const auto = field.autoValue || {};
    let type = (auto.type || field.systemVariable || '').toString();

    // Explicit SQL support for dynamic defaults like SELECT MAX(TID)+1 ...
    if (type === 'sql' || auto.query || type.startsWith('sql:')) {
        let sql = auto.query;
        if (!sql && type.startsWith('sql:')) {
            sql = type.substring(4).trim();
        }
        // Fallback: user sometimes puts scalar SELECT (MAX+1) into lookupQuery + marks as sql auto. Support it for TerminalID case etc.
        if (!sql && (field.lookupQuery || field.lookup?.sql) && (type.includes('sql') || type === 'sql' || !type)) {
            sql = field.lookupQuery || (field.lookup && field.lookup.sql);
        }
        if (sql) {
            console.log('[auto sql] executing for field', field.field, 'query:', sql);
            try {
                const res = await window.electronAPI.executeQuery(sql);
                console.log('[auto sql] result:', res);
                if (res && res.success) {
                    if (res.rows && res.rows.length > 0) {
                        const row = res.rows[0];
                        const val = Object.values(row)[0];
                        console.log('[auto sql] value:', val);
                        return val != null ? String(val) : '1';
                    } else {
                        console.warn('[auto sql] no rows, fallback to 1');
                        return '1';
                    }
                } else {
                    console.warn('[auto sql] not success');
                }
            } catch (e) {
                console.error('Dynamic SQL auto value error:', sql || field.defaultValue, e);
            }
            return null;
        }
    }

    // Support putting SQL directly in defaultValue (user case)
    if (!type && field.defaultValue && typeof field.defaultValue === 'string' && field.defaultValue.trim().toLowerCase().startsWith('select ')) {
        console.log('[auto sql default] executing for field', field.field, 'query:', field.defaultValue);
        try {
            const res = await window.electronAPI.executeQuery(field.defaultValue);
            console.log('[auto sql default] result:', res);
            if (res && res.success) {
                if (res.rows && res.rows.length > 0) {
                    const row = res.rows[0];
                    const val = Object.values(row)[0];
                    console.log('[auto sql default] value:', val);
                    return val != null ? String(val) : '1';
                } else {
                    console.warn('[auto sql default] no rows, fallback to 1');
                    return '1';
                }
            } else {
                console.warn('[auto sql default] not success');
            }
        } catch (e) {
            console.error('SQL in defaultValue error:', field.defaultValue, e);
        }
    }

    // fallback to existing sync logic
    return getSystemValue(field);
}

function applyValueTransform(val, t) {
  if (val == null || val === '' || !t) return val;
  const s = String(val);
  if (t.type === 'firstN') {
    const n = parseInt(t.length) || 4;
    return s.substring(0, n);
  }
  if (t.type === 'lastN') {
    const n = parseInt(t.length) || 4;
    return s.slice(-n);
  }
  if (t.type === 'substring') {
    const start = parseInt(t.start) || 0;
    const len = t.length != null ? parseInt(t.length) : undefined;
    return len != null ? s.substr(start, len) : s.substr(start);
  }
  if (t.type === 'split') {
    const d = t.delimiter || ' - ';
    const idx = parseInt(t.take) || 0;
    const parts = s.split(d);
    return parts[idx] !== undefined ? parts[idx].trim() : s;
  }
  if (t.type === 'regex') {
    try {
      const re = new RegExp(t.pattern || '^(.{4})');
      const m = s.match(re);
      if (m && m[1]) return m[1];
    } catch (e) {}
    return s;
  }
  return val;
}

function applyTransforms(data, fields) {
  for (const f of fields) {
    let field = f;
    if (!field.transforms || !Array.isArray(field.transforms) || field.transforms.length === 0) {
      // lookup transforms from master fields if not present on this (e.g. insert.fields slim copy)
      const master = (currentWindowConfig && (currentWindowConfig.fields || [])) || [];
      const full = master.find(mf => mf.field === f.field);
      if (full && full.transforms && full.transforms.length > 0) {
        field = full;
      }
    }
    if (field.transforms && Array.isArray(field.transforms) && data.hasOwnProperty(f.field)) {
      for (const t of field.transforms) {
        data[f.field] = applyValueTransform(data[f.field], t);
      }
    }
  }
}

// Helper for checkbox type special behavior
// Supports system variables (NOW, CURRENT_USER, sql:..., etc.) via computeAutoValue
// Special: 'date'/'now' etc also gives current date
async function getCheckboxFormValue(field, el) {
  if (!el) return '';
  const isChecked = el.checked;
  if (isChecked) {
    let cv = field.checkedValue || 'Y';
    const l = String(cv).trim().toLowerCase();
    if (l === 'date' || l === 'now' || l === 'today' || l === 'current_date') {
      const d = new Date();
      return d.toISOString().split('T')[0]; // YYYY-MM-DD
    }
    if (looksLikeSystemValue(cv)) {
      const tempField = {
        defaultValue: cv,
        systemVariable: cv
      };
      const resolved = await computeAutoValue(tempField);
      if (resolved != null) return resolved;
    }
    return cv;
  } else {
    let uv = field.uncheckedValue || '';
    if (looksLikeSystemValue(uv)) {
      const tempField = {
        defaultValue: uv,
        systemVariable: uv
      };
      const resolved = await computeAutoValue(tempField);
      if (resolved != null) return resolved;
    }
    return uv;
  }
}

function looksLikeSystemValue(val) {
  if (!val) return false;
  const s = String(val).trim();
  const lower = s.toLowerCase();
  const systemKeys = [
    'current_user', 'current_user_id', 'now', 'today', 'now_iso',
    'timestamp', 'unix_millis', 'uuid', 'short_id', 'random_string',
    'random_int', 'random_float', 'year', 'month', 'day', 'copy',
    'constant', 'custom'
  ];
  if (systemKeys.some(k => lower === k || lower.startsWith(k + ':'))) return true;
  if (s.startsWith('sql:') || lower.startsWith('select ')) return true;
  if (lower.includes(':')) return true;
  return false;
}

function isCheckboxCheckedFromValue(field, value) {
  if (value == null || value === '' || value === false || value === '0' || value === 'N') return false;
  const unchecked = field.uncheckedValue || '';
  if (value === unchecked) return false;
  return true;
}

async function saveNewRecord() {
    const saveBtn = document.getElementById('form-save-btn');
    if (saveBtn && saveBtn.disabled) return;

    const data = {};
    const fieldsSrc = (currentWindowConfig.insert && currentWindowConfig.insert.fields && currentWindowConfig.insert.fields.length > 0) ?
                      currentWindowConfig.insert.fields :
                      (currentWindowConfig.form && currentWindowConfig.form.fields) || [];

    // First set system / auto values (they are not in the form)
    for (const field of fieldsSrc) {
        if (field.systemVariable || field.autoValue) {
            let val = await computeAutoValue(field);
            console.log('[save auto] for', field.field, 'computed=', val);

            // Special handling for COPY
            if (!val && field.autoValue && field.autoValue.type === 'COPY' && field.autoValue.source) {
                const sourceField = field.autoValue.source;
                const sourceEl = document.getElementById('f-' + sourceField);
                if (sourceEl) val = sourceEl.value;
            }

            if (val != null) {
                data[field.field] = val;
            }
        }
    }

    // Force sql defaults from defaultValue for fields that have SELECT in default (even if no auto flag)
    for (const field of fieldsSrc) {
        if (data[field.field] === undefined &&
            field.defaultValue && typeof field.defaultValue === 'string' &&
            field.defaultValue.trim().toLowerCase().startsWith('select ')) {
            const val = await computeAutoValue(field);
            if (val != null) {
                data[field.field] = val;
            }
        }
    }

    // Then collect user values and validate non-system fields
    for (const field of fieldsSrc) {
        if (field.systemVariable || field.autoValue) continue;  // already set by auto logic

        const el = document.getElementById('f-' + field.field);
        if (!el) continue;

        let val = '';
        if (field.type === 'checkbox') {
            val = await getCheckboxFormValue(field, el);
        } else {
            val = el.value.trim();
        }

        const errs = await validateField(field, val);
        if (errs.length > 0) {
            showToast(errs[0], 'error');
            return;
        }
        data[field.field] = val;
    }

    // Ensure sql defaults are set fresh at save time if the UI didn't provide a value
    for (const field of fieldsSrc) {
        if (field.defaultValue && typeof field.defaultValue === 'string' &&
            field.defaultValue.trim().toLowerCase().startsWith('select ')) {
            if (!data[field.field] || data[field.field] === '') {
                const val = await computeAutoValue(field);
                console.log('[save ensure sql default] for', field.field, 'forced=', val);
                if (val != null) data[field.field] = val;
            }
        }
    }

    // Apply value transforms (e.g. first 4 chars from "5411 - магазин")
    applyTransforms(data, fieldsSrc);

    // Conditional defaults: if another field == X then set default Y (for insert)
    for (const field of fieldsSrc) {
      if (field.conditionalDefaults && (!data[field.field] || data[field.field] === '')) {
        for (const cd of (field.conditionalDefaults || [])) {
          const srcEl = document.getElementById('f-' + cd.ifField);
          if (srcEl) {
            const sv = srcEl.value;
            if ((cd.op || '==') === '==' && sv == cd.ifValue) {
              data[field.field] = cd.defaultValue;
            }
          }
        }
      }
    }

    const ins = currentWindowConfig.insert || {};
    const table = currentWindowConfig.insert?.table || currentWindowConfig.form?.table || ins.table || currentWindowConfig.dataSource?.table;
    if (!table) { showToast('Не указана таблица для вставки', 'error'); return; }

    const columns = Object.keys(data).join(', ');
    const placeholders = Object.keys(data).map(() => '?').join(', ');
    const values = Object.values(data);

    const result = await window.electronAPI.executeQuery('INSERT INTO ' + table + ' (' + columns + ') VALUES (' + placeholders + ')', values);
    if (result.success) {
        showToast('✅ Запись успешно создана!');
        closeFormModal();
        performSearch();
    } else showToast('❌ Ошибка: ' + result.error, 'error');
}

async function saveUpdatedRecord() {
    const saveBtn = document.getElementById('form-save-btn');
    if (saveBtn && saveBtn.disabled) return;

    if (!selectedRow) return;
    const data = {};
    const fieldsSrc = (currentWindowConfig.update && currentWindowConfig.update.fields && currentWindowConfig.update.fields.length > 0) ?
                      currentWindowConfig.update.fields :
                      (currentWindowConfig.form && currentWindowConfig.form.fields) || [];
    const pk = currentWindowConfig.update?.keyField || currentWindowConfig.dataSource.primaryKey;
    if (!pk) { showToast('Не указан primaryKey для обновления', 'error'); return; }
    const pkValue = selectedRow[pk] ?? selectedRow[pk.toUpperCase()] ?? selectedRow[pk.toLowerCase()];

    // Set system / auto values first (for update)
    for (const field of fieldsSrc) {
        if (field.systemVariable || field.autoValue) {
            let val = await computeAutoValue(field);

            if (!val && field.autoValue && field.autoValue.type === 'COPY' && field.autoValue.source) {
                const sourceEl = document.getElementById('f-' + field.autoValue.source);
                if (sourceEl) val = sourceEl.value;
            }

            if (val != null) data[field.field] = val;
        }
    }

    // Collect user values + validate non-system
    for (const field of fieldsSrc) {
        if (field.systemVariable || field.autoValue) continue;


        const el = document.getElementById('f-' + field.field);
        if (!el) continue;
        let val = '';
        if (field.type === 'checkbox') {
            val = await getCheckboxFormValue(field, el);
        } else {
            val = el.value.trim();
        }
        const errs = await validateField(field, val);
        if (errs.length > 0) {
            showToast(errs[0], 'error');
            return;
        }
        data[field.field] = val;
    }

    // Apply value transforms (e.g. extract first 4 chars)
    applyTransforms(data, fieldsSrc);

    // conditional defaults if needed
    for (const field of fieldsSrc) {
      if (field.conditionalDefaults && (!data[field.field] || data[field.field] === '')) {
        for (const cd of (field.conditionalDefaults || [])) {
          const srcEl = document.getElementById('f-' + cd.ifField);
          if (srcEl) {
            const sv = srcEl.value;
            if ((cd.op || '==') === '==' && sv == cd.ifValue) {
              data[field.field] = cd.defaultValue;
            }
          }
        }
      }
    }

    const upd = currentWindowConfig.update || {};
    const table = currentWindowConfig.update?.table || currentWindowConfig.form?.table || upd.table || currentWindowConfig.dataSource?.table;
    const setParts = Object.keys(data).map(function(k) { return k + '=?'; }).join(', ');
    const values = [...Object.values(data), pkValue];

    const result = await window.electronAPI.executeQuery('UPDATE ' + table + ' SET ' + setParts + ' WHERE ' + pk + ' = ?', values);
    if (result.success) {
        showToast('✅ Запись успешно обновлена!');
        closeFormModal();
        performSearch();
    } else showToast('❌ Ошибка: ' + result.error, 'error');
}

// ==================== АДМИН + РЕДАКТОР ====================

async function openAdminWindow() {
    // ensure fresh fullConfig
    if (window.electronAPI && window.electronAPI.getConfig) {
      try { fullConfig = await window.electronAPI.getConfig() || fullConfig; } catch(e){}
    }
    if (!fullConfig) fullConfig = { title: 'GTerminalPro', database: '', logo: '', windows: [] };

    // Clean floating admin guide buttons when going back to list
    document.querySelectorAll('#admin-floating-guide').forEach(el => el.remove());

    // Reflect admin mode in top title + clear any window active highlight in sidebar (dynamic feel)
    const topTitle = document.getElementById('window-title');
    if (topTitle) topTitle.textContent = 'Администрирование';
    document.querySelectorAll('#window-list button').forEach(b => {
      b.classList.remove('bg-slate-700', 'bg-blue-600', 'ring-1', 'ring-blue-400');
    });

    const container = document.getElementById('current-window');
    const wins = (fullConfig && fullConfig.windows) ? fullConfig.windows : [];

    let listHtml = wins.length === 0 
        ? '<div class="text-center py-10 text-slate-400">Пока нет окон. Добавьте первое.</div>'
        : '<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">' + 
          wins.map(function(w) {
              var id = w.id || w.title;
              var safe = String(id).replace(/'/g, "\\'");
              return '<div onclick="if(window.selectAdminWindow) window.selectAdminWindow(\'' + safe + '\');" class="bg-slate-800 border border-slate-700 hover:border-amber-500 rounded-2xl p-4 cursor-pointer"><div class="font-semibold">' + w.title + '</div><div class="text-xs text-slate-400">' + (w.id || '') + '</div><div class="text-[10px] text-amber-400 mt-3">Открыть настройки →</div></div>';
          }).join('') + '</div>';

    // Prepare logo preview src
    let logoSrc = fullConfig.logo || '';
    if (logoSrc && !logoSrc.startsWith('data:') && !logoSrc.startsWith('file:')) {
      logoSrc = 'file:///' + logoSrc.replace(/\\/g, '/');
    }

    container.innerHTML = 
        '<div class="p-6 max-w-7xl mx-auto h-full overflow-auto custom-scroll">' +
        '<div class="flex items-center justify-between mb-6">' +
        '<div><h1 class="text-3xl font-bold text-white">Администрирование</h1>' +
        '<div class="text-slate-400 mt-1 text-sm">Выберите окно для настройки</div></div>' +
        '<div class="flex items-center gap-2">' +
        '<button onclick="addNewWindow()" class="bg-blue-600 hover:bg-blue-500 px-4 py-1.5 rounded-xl text-sm font-semibold flex items-center gap-2"><i class="fas fa-plus"></i> + Новое окно</button>' +
        '<button onclick="showAdminGuide()" class="bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded-xl text-sm flex items-center gap-1" title="Справка и User Guide"><i class="fas fa-question-circle"></i> ?</button>' +
        '</div></div>' +

        '<!-- ОБЩИЕ НАСТРОЙКИ ПРИЛОЖЕНИЯ (включая логотип) -->' +
        '<div class="mb-6 bg-slate-800 border border-slate-700 rounded-2xl p-4">' +
        '<h3 class="text-lg font-semibold mb-3 text-amber-300">Общие настройки приложения</h3>' +
        '<div class="grid grid-cols-1 md:grid-cols-2 gap-4">' +
        '<div>' +
        '<label class="block text-xs text-slate-400 mb-1">Название приложения</label>' +
        '<input id="app-title" value="' + (fullConfig.title || '') + '" class="w-full bg-slate-900 border border-slate-600 rounded-xl px-3 py-1.5 text-sm">' +
        '</div>' +
        '<div>' +
        '<label class="block text-xs text-slate-400 mb-1">Путь к базе данных (абсолютный или относительный)</label>' +
        '<input id="app-database" value="' + (fullConfig.database || '') + '" class="w-full bg-slate-900 border border-slate-600 rounded-xl px-3 py-1.5 text-sm">' +
        '</div>' +
        '</div>' +
        '<div class="mt-4">' +
        '<label class="block text-xs text-slate-400 mb-1">Логотип (выберите файл — сохранится как data URL в конфиг, чтобы не зависеть от путей в portable)</label>' +
        '<div class="flex gap-2 items-center">' +
        '<input type="file" id="app-logo-file" accept="image/*" class="text-sm file:mr-2 file:px-3 file:py-1 file:rounded-xl file:border-0 file:bg-blue-700 file:text-white">' +
        '<button onclick="previewAndSetLogo()" class="bg-blue-600 hover:bg-blue-500 px-3 py-1 rounded-xl text-sm">Загрузить</button>' +
        '<button onclick="clearLogo()" class="bg-red-600 hover:bg-red-500 px-3 py-1 rounded-xl text-sm">Очистить</button>' +
        '</div>' +
        '<div id="logo-preview" class="mt-2 w-16 h-16 border border-slate-600 rounded-xl overflow-hidden bg-slate-900 flex items-center justify-center">' +
        (logoSrc ? '<img src="' + logoSrc.replace(/"/g, '&quot;') + '" style="max-width:100%; max-height:100%; object-fit:contain;">' : '<span class="text-[10px] text-slate-500">нет логотипа</span>') +
        '</div>' +
        '<div class="text-[10px] text-slate-500 mt-1">Логотип будет встроен в config.json (data URL). Подходит для single-exe portable. Размер контейнера в сайдбаре маленький — картинка масштабируется.</div>' +
        '</div>' +
        '<button onclick="saveGeneralSettings()" class="mt-4 bg-emerald-700 hover:bg-emerald-600 px-4 py-1.5 rounded-xl text-sm font-semibold">Сохранить общие настройки + логотип</button>' +
        '</div>' +

        '<div class="flex items-center justify-between mb-3"><h3 class="text-lg font-semibold">Окна</h3></div>' +
        listHtml +
        '<div class="mt-8">' +
        '<div class="flex items-center justify-between mb-3"><h3 class="text-lg font-semibold">Пользователи</h3></div>' +
        '<button onclick="showUsersManagement()" class="bg-emerald-600 hover:bg-emerald-500 px-4 py-1.5 rounded-xl text-sm font-semibold flex items-center gap-2"><i class="fas fa-users"></i> Управление пользователями</button>' +
        '<div class="mt-2 text-xs text-slate-500">Добавляйте пользователей, задавайте роль и права доступа к окнам (WINDOWS_ACCESS, INSERT_ACCESS и т.д.)</div>' +
        '</div>' +
        '<div class="mt-8 text-xs text-slate-500">Нажмите на окно, чтобы открыть его настройки. Кнопка «Гайд» доступна везде в админке.</div>' +
        '<button onclick="showAdminGuide()" class="fixed bottom-4 right-4 bg-slate-800 hover:bg-slate-700 border border-slate-600 text-sm px-3 py-1.5 rounded-full flex items-center gap-1 shadow-lg z-[100]" title="Открыть User Guide"><i class="fas fa-question-circle"></i> Гайд</button></div>';
}

if (typeof window !== 'undefined') {
  window.openAdminWindow = openAdminWindow;
  window.previewAndSetLogo = previewAndSetLogo;
  window.clearLogo = clearLogo;
  window.saveGeneralSettings = saveGeneralSettings;
}

async function previewAndSetLogo() {
  const fileInput = document.getElementById('app-logo-file');
  if (!fileInput || !fileInput.files || !fileInput.files[0]) {
    alert('Выберите файл изображения');
    return;
  }
  const file = fileInput.files[0];
  const reader = new FileReader();
  reader.onload = function(e) {
    fullConfig.logo = e.target.result; // data URL
    const preview = document.getElementById('logo-preview');
    if (preview) {
      preview.innerHTML = '<img src="' + fullConfig.logo + '" style="max-width:100%; max-height:100%; object-fit:contain;">';
    }
  };
  reader.readAsDataURL(file);
}

function clearLogo() {
  fullConfig.logo = '';
  const preview = document.getElementById('logo-preview');
  if (preview) {
    preview.innerHTML = '<span class="text-[10px] text-slate-500">нет логотипа</span>';
  }
}

async function saveGeneralSettings() {
  if (!fullConfig) {
    fullConfig = await window.electronAPI.loadConfig();
  }
  fullConfig.title = (document.getElementById('app-title') || {}).value || fullConfig.title || 'GTerminalPro';
  fullConfig.database = (document.getElementById('app-database') || {}).value || fullConfig.database || '';
  // logo is already set via previewAndSetLogo or cleared

  try {
    await window.electronAPI.saveConfig(fullConfig);
    // update live UI
    const topTitle = document.getElementById('window-title');
    if (topTitle) topTitle.textContent = fullConfig.title || 'GTerminalPro';
    updateLogo();
    alert('Общие настройки и логотип сохранены в конфиг!');
  } catch (e) {
    alert('Ошибка сохранения: ' + e.message);
  }
}

async function showUsersManagement() {
  const container = document.getElementById('current-window');
  let users = [];
  try {
    users = await window.electronAPI.getUsers();
  } catch (e) {
    container.innerHTML = '<div class="p-6 text-red-400">Ошибка загрузки пользователей: ' + e.message + '</div>';
    return;
  }

  let html = `
    <div class="p-6 max-w-7xl mx-auto h-full overflow-auto custom-scroll">
      <div class="flex items-center justify-between mb-4">
        <div>
          <button onclick="if(window.openAdminWindow) window.openAdminWindow();" class="text-xs px-3 py-1 bg-slate-700 hover:bg-slate-600 rounded-xl mb-1">← В админ</button>
          <h2 class="text-2xl font-bold text-white">Пользователи</h2>
        </div>
        <button onclick="addUser()" class="bg-emerald-600 hover:bg-emerald-500 px-4 py-1.5 rounded-xl text-sm font-semibold flex items-center gap-2"><i class="fas fa-user-plus"></i> + Добавить пользователя</button>
      </div>

      <table class="w-full text-sm">
        <thead>
          <tr>
            <th class="px-3 py-2 text-left">ID</th>
            <th class="px-3 py-2 text-left">LOGIN</th>
            <th class="px-3 py-2 text-left">ROLE</th>
            <th class="px-3 py-2 text-left">ACTIVE</th>
            <th class="px-3 py-2 text-left">WINDOWS</th>
            <th class="px-3 py-2 text-left">INSERT</th>
            <th class="px-3 py-2 text-left">UPDATE</th>
            <th class="px-3 py-2 text-left">DELETE</th>
            <th class="px-3 py-2">Действия</th>
          </tr>
        </thead>
        <tbody>
  `;

  users.forEach(u => {
    html += `
      <tr class="border-b border-slate-700 hover:bg-slate-800">
        <td class="px-3 py-1.5">${u.ID}</td>
        <td class="px-3 py-1.5 font-medium">${u.LOGIN}</td>
        <td class="px-3 py-1.5"><span class="px-1.5 py-0.5 rounded text-xs ${u.ROLE === 'ADMIN' ? 'bg-red-900 text-red-300' : 'bg-slate-700'}">${u.ROLE || 'USER'}</span></td>
        <td class="px-3 py-1.5">${u.IS_ACTIVE ? '<span class="text-emerald-400">✓</span>' : '<span class="text-red-400">✗</span>'}</td>
        <td class="px-3 py-1.5 text-xs text-slate-400">${u.WINDOWS_ACCESS || '-'}</td>
        <td class="px-3 py-1.5 text-xs text-slate-400">${u.INSERT_ACCESS || '-'}</td>
        <td class="px-3 py-1.5 text-xs text-slate-400">${u.UPDATE_ACCESS || '-'}</td>
        <td class="px-3 py-1.5 text-xs text-slate-400">${u.DELETE_ACCESS || '-'}</td>
        <td class="px-3 py-1.5 text-right">
          <button onclick="editUser(${u.ID})" class="px-2 py-0.5 text-xs bg-emerald-700 hover:bg-emerald-600 rounded mr-1">✎</button>
          <button onclick="deleteUser(${u.ID})" class="px-2 py-0.5 text-xs bg-red-700 hover:bg-red-600 rounded">×</button>
        </td>
      </tr>
    `;
  });

  html += `
        </tbody>
      </table>
      <div class="mt-4 text-xs text-slate-500">
        Доступы указываются через запятую (например: 1,2). WINDOWS_ACCESS — видимые окна, остальные — права на операции.
      </div>
    </div>
  `;

  container.innerHTML = html;
}

async function addUser() {
  await showUserEditModal(null);
}

async function editUser(id) {
  const users = await window.electronAPI.getUsers();
  const user = users.find(u => u.ID == id);
  if (user) await showUserEditModal(user);
}

async function showUserEditModal(user) {
  const isNew = !user;
  const wins = (fullConfig && fullConfig.windows) ? fullConfig.windows : [];

  const modal = document.createElement('div');
  modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-[999] p-4';

  let accessHtml = '';
  if (wins.length > 0) {
    accessHtml = `<div class="mt-3"><label class="text-xs text-slate-400">Быстрый выбор доступов (окна)</label><div class="grid grid-cols-2 gap-1 text-xs mt-1">`;
    wins.forEach(w => {
      const wid = w.id || w.windowId || w.title;
      accessHtml += `
        <label class="flex items-center gap-1">
          <input type="checkbox" class="win-access" data-wid="${wid}" ${user && (user.WINDOWS_ACCESS||'').split(',').map(s=>s.trim()).includes(String(wid)) ? 'checked' : ''}>
          <span>${w.title} (id:${wid})</span>
        </label>`;
    });
    accessHtml += `</div><div class="text-[10px] text-slate-500 mt-1">Отмеченные будут добавлены в WINDOWS_ACCESS. Для INSERT/UPDATE/DELETE используйте текстовые поля ниже.</div></div>`;
  }

  modal.innerHTML = `
    <div class="bg-slate-800 border border-slate-600 rounded-2xl w-full max-w-lg p-5 shadow-2xl">
      <div class="font-semibold text-lg mb-4">${isNew ? 'Добавить пользователя' : 'Редактировать пользователя #' + user.ID}</div>
      
      <div class="space-y-3">
        <div>
          <label class="block text-xs text-slate-400">Логин</label>
          <input id="user-login" value="${user ? user.LOGIN : ''}" class="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm">
        </div>
        <div>
          <label class="block text-xs text-slate-400">Пароль ${isNew ? '' : '(оставьте пустым, чтобы не менять)'}</label>
          <input id="user-pass" type="password" value="" class="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm">
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs text-slate-400">ROLE</label>
            <select id="user-role" class="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm">
              <option value="ADMIN" ${user && user.ROLE==='ADMIN' ? 'selected' : ''}>ADMIN</option>
              <option value="USER" ${user && user.ROLE==='USER' ? 'selected' : ''}>USER</option>
            </select>
          </div>
          <div>
            <label class="block text-xs text-slate-400">IS_ACTIVE</label>
            <div class="pt-1">
              <label><input type="checkbox" id="user-active" ${!user || user.IS_ACTIVE ? 'checked' : ''}> Активен</label>
            </div>
          </div>
        </div>

        <div>
          <label class="block text-xs text-slate-400">WINDOWS_ACCESS (через запятую)</label>
          <input id="user-windows" value="${user ? user.WINDOWS_ACCESS || '' : ''}" class="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm font-mono">
        </div>
        <div class="grid grid-cols-3 gap-2">
          <div>
            <label class="block text-xs text-slate-400">INSERT_ACCESS</label>
            <input id="user-insert" value="${user ? user.INSERT_ACCESS || '' : ''}" class="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm font-mono">
          </div>
          <div>
            <label class="block text-xs text-slate-400">UPDATE_ACCESS</label>
            <input id="user-update" value="${user ? user.UPDATE_ACCESS || '' : ''}" class="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm font-mono">
          </div>
          <div>
            <label class="block text-xs text-slate-400">DELETE_ACCESS</label>
            <input id="user-delete" value="${user ? user.DELETE_ACCESS || '' : ''}" class="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm font-mono">
          </div>
        </div>

        ${accessHtml}
      </div>

      <div class="mt-5 flex gap-2">
        <button id="user-save" class="flex-1 bg-emerald-600 hover:bg-emerald-500 px-4 py-2 rounded-xl text-sm font-semibold">Сохранить</button>
        <button id="user-cancel" class="flex-1 bg-slate-700 hover:bg-slate-600 px-4 py-2 rounded-xl text-sm">Отмена</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Auto-fill access fields from checkboxes
  modal.querySelectorAll('.win-access').forEach(chk => {
    chk.onchange = () => {
      const selected = Array.from(modal.querySelectorAll('.win-access:checked')).map(c => c.dataset.wid);
      const winField = modal.querySelector('#user-windows');
      if (winField) winField.value = selected.join(',');
    };
  });

  modal.querySelector('#user-cancel').onclick = () => modal.remove();
  modal.querySelector('#user-save').onclick = async () => {
    const data = {
      LOGIN: modal.querySelector('#user-login').value.trim(),
      PASSWORD: modal.querySelector('#user-pass').value,
      ROLE: modal.querySelector('#user-role').value,
      IS_ACTIVE: modal.querySelector('#user-active').checked ? 1 : 0,
      WINDOWS_ACCESS: modal.querySelector('#user-windows').value.trim(),
      INSERT_ACCESS: modal.querySelector('#user-insert').value.trim(),
      UPDATE_ACCESS: modal.querySelector('#user-update').value.trim(),
      DELETE_ACCESS: modal.querySelector('#user-delete').value.trim()
    };
    if (user) data.ID = user.ID;

    if (!data.LOGIN) {
      showToast('Логин обязателен', 'error');
      return;
    }
    if (isNew && !data.PASSWORD) {
      showToast('Пароль обязателен для нового пользователя', 'error');
      return;
    }

    const res = await window.electronAPI.saveUser(data);
    if (res && res.success) {
      modal.remove();
      showUsersManagement();
    } else {
      showToast('Ошибка сохранения: ' + (res ? res.error : 'unknown'), 'error');
    }
  };
}

async function deleteUser(id) {
  const ok = await customConfirm('Удалить пользователя?');
  if (!ok) return;
  const res = await window.electronAPI.deleteUser(id);
  if (res && res.success) {
    showUsersManagement();
  } else {
    showToast('Ошибка удаления: ' + (res ? res.error : ''), 'error');
  }
}









function selectAdminWindow(idOrTitle) {
  const wins = (fullConfig && fullConfig.windows) ? fullConfig.windows : [];
  const chosen = wins.find(w => (w.id || w.title) == idOrTitle || w.title == idOrTitle);
  if (!chosen) return;
  currentWindowConfig = normalizeWindowConfig(chosen);
  if (!Array.isArray(currentWindowConfig.rowFormatting)) currentWindowConfig.rowFormatting = [];
  if (!currentWindowConfig.insert) currentWindowConfig.insert = { table: '', fields: [] };
  if (!currentWindowConfig.update) currentWindowConfig.update = { table: '', keyField: '', fields: [] };
  if (!currentWindowConfig.delete) currentWindowConfig.delete = { table: '', keyField: '' };
  if (!currentWindowConfig.grid) currentWindowConfig.grid = [];
  if (!currentWindowConfig.details) currentWindowConfig.details = [];
  if (!currentWindowConfig.filters) currentWindowConfig.filters = [];

  // Dynamic title in top bar for admin editing context
  const topTitle = document.getElementById('window-title');
  if (topTitle) topTitle.textContent = 'Настройка: ' + (chosen.title || '');

  renderAdminConfigUI();
}

if (typeof window !== 'undefined') {
  window.selectAdminWindow = selectAdminWindow;
  window.showUsersManagement = showUsersManagement;
  window.addUser = addUser;
  window.editUser = editUser;
  window.deleteUser = deleteUser;
}

function renderAdminConfigUI() {
    var container = document.getElementById('current-window');
    if (!currentWindowConfig) return;

    if (!currentWindowConfig.insert) currentWindowConfig.insert = { table: '', fields: [] };
    if (!currentWindowConfig.update) currentWindowConfig.update = { table: '', keyField: '', fields: [] };
    if (!currentWindowConfig.delete) currentWindowConfig.delete = { table: '', keyField: '' };
    if (!currentWindowConfig.grid) currentWindowConfig.grid = [];
    if (!currentWindowConfig.details) currentWindowConfig.details = [];
    if (!currentWindowConfig.filters) currentWindowConfig.filters = [];
    if (!currentWindowConfig.formCustomButtons) currentWindowConfig.formCustomButtons = [];

    // Ensure insert/update use the main table (table input removed from insert/update sections; table is set at window level in admin)
    const mainTable = currentWindowConfig.dataSource?.table || currentWindowConfig.table || '';
    if (mainTable) {
      if (!currentWindowConfig.insert) currentWindowConfig.insert = {};
      currentWindowConfig.insert.table = mainTable;
      if (!currentWindowConfig.update) currentWindowConfig.update = {};
      currentWindowConfig.update.table = mainTable;
    }

    // === UNIFIED FIELDS MASTER (to avoid duplicating definitions between INSERT and UPDATE) ===
    // All field definitions live here once. INSERT/UPDATE lists hold subsets for ordering + mode-specific props.
    if (!currentWindowConfig.fields) currentWindowConfig.fields = [];
    const masterMap = {};
    currentWindowConfig.fields.forEach(f => { if (f.field) masterMap[f.field] = {...f}; });

    const insFs = currentWindowConfig.insert.fields || [];
    const updFs = currentWindowConfig.update.fields || [];
    [...insFs, ...updFs].forEach(f => {
      if (f.field && !masterMap[f.field]) {
        masterMap[f.field] = {...f};
      }
    });
    currentWindowConfig.fields = Object.values(masterMap);

    // Initialize use flags if missing
    currentWindowConfig.fields.forEach(f => {
      if (f.useInInsert === undefined) f.useInInsert = true;
      if (f.useInUpdate === undefined) f.useInUpdate = true;
    });

    // Always rebuild lists from master (only master is truth)
    rebuildFormListsFromMaster();

    if (!Array.isArray(currentWindowConfig.rowFormatting)) currentWindowConfig.rowFormatting = [];

    var wins = (fullConfig && fullConfig.windows) ? fullConfig.windows : [];
    var curr = currentWindowConfig.id || currentWindowConfig.title || '';
    var selectHtml = wins.map(function(w) {
        var v = w.id || w.title;
        var s = (v == curr) ? 'selected' : '';
        return '<option value="' + v + '" ' + s + '>' + (w.title || v) + '</option>';
    }).join('');

    var html = '<div class="p-6 max-w-7xl mx-auto h-full overflow-auto custom-scroll">' +
        '<div class="flex items-center justify-between mb-4">' +
        '<div><button onclick="if (window.openAdminWindow) window.openAdminWindow();" class="text-xs px-3 py-1 bg-slate-700 hover:bg-slate-600 rounded-xl mb-1">← Ко всем окнам</button>' +
        '<h2 class="text-2xl font-bold text-white">Настройка: <span class="text-amber-400">' + currentWindowConfig.title + '</span></h2></div>' +
        '<div class="flex gap-2">' +
        '<button onclick="addNewWindow()" class="bg-blue-600 hover:bg-blue-500 px-3 py-1.5 rounded-xl text-sm">+ Новое окно</button>' +
        '<button onclick="saveInsertUpdateConfig()" class="bg-emerald-700 hover:bg-emerald-600 px-4 py-1.5 rounded-xl text-sm font-semibold flex items-center gap-1"><i class="fas fa-save"></i> Сохранить</button>' +
        '<button onclick="reloadCurrentWindow()" class="bg-slate-600 hover:bg-slate-500 px-3 py-1.5 rounded-xl text-sm">Перезагрузить данные</button>' +
        '<button onclick="showAdminGuide()" class="bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded-xl text-sm flex items-center gap-1" title="Справка и User Guide по всем возможностям настройки"><i class="fas fa-question-circle"></i> ?</button>' +
        '</div></div>' +

        '<div class="mb-4"><select id="admin-window-select" class="bg-slate-900 border border-slate-600 rounded-xl px-3 py-1.5 text-sm" onchange="var v=this.value; var c=(fullConfig&&fullConfig.windows||[]).find(function(w){return (w.id||w.title)==v}); if(c){currentWindowConfig=normalizeWindowConfig(c); renderAdminConfigUI();}">' + selectHtml + '</select></div>' +

        '<!-- ЕДИНЫЙ СПИСОК ПОЛЕЙ (рекомендуемый способ, чтобы не дублировать) -->' +
        '<div class="mb-4 bg-slate-900 border border-slate-700 rounded-2xl p-3">' +
        '<div class="flex items-center justify-between mb-2">' +
        '<span class="font-semibold text-sm text-teal-300">Поля таблицы (единственный мастер-список)</span>' +
        '<button onclick="addMasterFieldAndOpenEditor()" class="text-xs bg-teal-600 hover:bg-teal-500 px-2 py-0.5 rounded">+ Добавить поле</button>' +
        '</div>' +
        '<div id="unified-fields-list" class="space-y-1 text-xs"></div>' +
        '<div class="text-[10px] text-slate-500 mt-1">Галочки включают поле в Insert или Update. Порядок общий (из этого списка). Все свойства редактируются один раз.</div>' +
        '</div>' +

        '<div class="grid grid-cols-1 lg:grid-cols-2 gap-3">' +
        '<div class="bg-slate-800 border border-slate-700 rounded-2xl p-4">' +
        '<h3 class="text-emerald-400 font-semibold mb-2">INSERT</h3>' +
        '<div class="text-[10px] text-slate-400">Таблица: ' + (currentWindowConfig.insert && currentWindowConfig.insert.table || currentWindowConfig.dataSource && currentWindowConfig.dataSource.table || currentWindowConfig.table || '—') + ' (из основной конфигурации окна)</div>' +
        '</div>' +

        '<div class="bg-slate-800 border border-slate-700 rounded-2xl p-4">' +
        '<h3 class="text-yellow-400 font-semibold mb-2">UPDATE</h3>' +
        '<div class="grid grid-cols-2 gap-2 mb-2"><div><label class="text-xs text-slate-400">Ключ</label><input id="update-keyfield" value="' + (currentWindowConfig.update.keyField || '') + '" class="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm"></div></div>' +
        '<div class="text-[10px] text-slate-400">Таблица: ' + (currentWindowConfig.update && currentWindowConfig.update.table || currentWindowConfig.dataSource && currentWindowConfig.dataSource.table || currentWindowConfig.table || '—') + ' (из основной конфигурации окна)</div>' +
        '</div></div>' +

        '<div class="mt-4 bg-slate-800 border border-slate-700 rounded-2xl p-4">' +
        '<h3 class="text-red-400 font-semibold mb-2">DELETE</h3>' +
        '<div class="grid grid-cols-2 gap-2"><input id="delete-table" value="' + (currentWindowConfig.delete && currentWindowConfig.delete.table || '') + '" class="bg-slate-900 border border-slate-600 rounded px-3 py-1 text-sm" placeholder="Таблица"><input id="delete-keyfield" value="' + (currentWindowConfig.delete && currentWindowConfig.delete.keyField || '') + '" class="bg-slate-900 border border-slate-600 rounded px-3 py-1 text-sm" placeholder="Ключ"></div>' +
        '</div>' +

        '<div class="mt-4 bg-slate-800 border border-slate-700 rounded-2xl p-4">' +
        '<div class="flex justify-between mb-2"><h3 class="text-blue-400 font-semibold">GRID (главная таблица)</h3><div class="text-xs"><button onclick="autoFillGridFromQuery()" class="bg-blue-700 px-2 py-0.5 rounded">Авто</button><button onclick="addGridColumn()" class="bg-blue-600 px-2 py-0.5 rounded ml-1">+ Колонка</button></div></div>' +
        '<div id="grid-columns-list" class="space-y-1 max-h-[160px] overflow-auto custom-scroll"></div>' +
        '</div>' +

        '<div class="mt-4 bg-slate-800 border border-slate-700 rounded-2xl p-4">' +
        '<div class="flex justify-between mb-2"><h3 class="text-emerald-400 font-semibold">DETAILS (окно деталей — двойной клик по строке)</h3><div class="text-xs"><button onclick="autoFillDetailsFromQuery()" class="bg-emerald-700 px-2 py-0.5 rounded">Авто</button><button onclick="addDetailColumn()" class="bg-emerald-600 px-2 py-0.5 rounded ml-1">+ Поле</button></div></div>' +
        '<div id="details-columns-list" class="space-y-1 max-h-[160px] overflow-auto custom-scroll"></div>' +
        '</div>' +

        '<div class="mt-4 bg-slate-800 border border-slate-700 rounded-2xl p-4">' +
        '<div class="flex justify-between mb-2"><h3 class="text-violet-400 font-semibold">ФИЛЬТРЫ (операторы настраиваются здесь)</h3><button onclick="addFilter()" class="bg-violet-600 px-2 py-0.5 rounded text-xs">+ Фильтр</button></div>' +
        '<div class="text-[9px] text-slate-500 mb-1">Можно выбрать стандартные операторы и добавить кастомные SQL (например: closed → CloseDate IS NOT NULL).</div>' +
        '<div id="filters-list" class="space-y-1 max-h-[120px] overflow-auto custom-scroll"></div>' +
        '</div>' +

        '<div class="mt-4 bg-slate-800 border border-slate-700 rounded-2xl p-4">' +
        '<div class="flex justify-between mb-2"><h3 class="text-orange-400 font-semibold">КНОПКИ В ФОРМЕ (вверху формы)</h3><button onclick="addFormButton()" class="bg-orange-600 px-2 py-0.5 rounded text-xs">+ Добавить кнопку</button></div>' +
        '<div id="form-buttons-list" class="space-y-1 max-h-[160px] overflow-auto custom-scroll text-xs"></div>' +
        '<div class="text-[9px] text-slate-500 mt-1">Кнопки формы и таблицы. Режимы: Insert/Update (в форме), Select (в панели при выборе строки). Для exportExcel: шаблон из C:\\GTerminalPro\\templates + маппинг поле→ячейка. Результат в C:\\GTerminalPro\\exports.</div>' +
        '</div>' +

        '<div class="mt-4 bg-slate-800 border border-slate-700 rounded-2xl p-4">' +
        '<div class="flex justify-between mb-2"><h3 class="text-red-400 font-semibold">ФОРМАТИРОВАНИЕ СТРОК (условные стили в таблице)</h3><button onclick="addRowFormattingRule()" class="bg-red-600 px-2 py-0.5 rounded text-xs">+ Правило</button></div>' +
        '<div id="row-formatting-list" class="space-y-1 max-h-[140px] overflow-auto custom-scroll text-xs"></div>' +
        '<div class="text-[9px] text-slate-500 mt-1">Например: closeDate notEmpty → красный бордер. Выбирай цвета через палитру (как для кнопок). Много правил на окно.</div>' +
        '</div>' +

        '<div class="mt-4 bg-slate-800 border border-slate-700 rounded-2xl p-4">' +
        '<h3 class="text-amber-400 font-semibold mb-2">Основной запрос (query / dataSource.query)</h3>' +
        '<textarea id="admin-query" class="w-full h-28 bg-slate-900 border border-slate-600 rounded p-2 text-xs font-mono" placeholder="SELECT ... FROM ...">' + (currentWindowConfig.query || (currentWindowConfig.dataSource && currentWindowConfig.dataSource.query) || '') + '</textarea>' +
        '<div class="text-[10px] text-slate-500 mt-1">Измените запрос здесь. Используйте «Авто» в GRID/DETAILS чтобы обновить колонки из него.</div>' +
        '</div>' +

        '<div class="mt-3 text-xs text-slate-400">Нажмите «Сохранить» после изменений. Админ остаётся открытым.</div>' +
        '</div>';

    container.innerHTML = html;

    // Ensure one floating guide button for admin
    document.querySelectorAll('#admin-floating-guide').forEach(el => el.remove());
    setTimeout(function() {
        const floatBtn = document.createElement('button');
        floatBtn.id = 'admin-floating-guide';
        floatBtn.className = 'fixed bottom-4 right-4 bg-slate-800 hover:bg-slate-700 border border-slate-600 text-sm px-3 py-1.5 rounded-full flex items-center gap-1 shadow-lg z-[100]';
        floatBtn.innerHTML = '<i class="fas fa-question-circle"></i> Гайд';
        floatBtn.title = 'Открыть полный User Guide (доступен из любого места в админке)';
        floatBtn.onclick = () => showAdminGuide();
        document.body.appendChild(floatBtn);
    }, 50);

    // Attach immediately where possible
    var sel = document.getElementById('admin-window-select');
    if (sel) {
        sel.onchange = function() {
            var v = sel.value;
            var c = (fullConfig && fullConfig.windows || []).find(function(w){ return (w.id || w.title) == v; });
            if (c) {
                currentWindowConfig = normalizeWindowConfig(c);
                if (!Array.isArray(currentWindowConfig.rowFormatting)) currentWindowConfig.rowFormatting = [];
                renderAdminConfigUI();
            }
        };
    }

    if (typeof renderUnifiedFieldsList === 'function') renderUnifiedFieldsList();
    if (typeof renderGridList === 'function') renderGridList();
    if (typeof renderDetailsList === 'function') renderDetailsList();
    if (typeof renderFiltersList === 'function') renderFiltersList();
    if (typeof renderFormButtonsList === 'function') renderFormButtonsList();
    if (typeof renderRowFormattingList === 'function') renderRowFormattingList();

    // Render unified fields view (duplicate call was here, keep for safety)
    if (typeof renderUnifiedFieldsList === 'function') renderUnifiedFieldsList();
}

function renderUnifiedFieldsList() {
  const container = document.getElementById('unified-fields-list');
  if (!container) return;

  const masterFields = currentWindowConfig.fields || [];
  const insFields = currentWindowConfig.insert.fields || [];
  const updFields = currentWindowConfig.update.fields || [];

  const insSet = new Set(insFields.map(f => f.field));
  const updSet = new Set(updFields.map(f => f.field));

  const names = masterFields.map(f => f.field);

  if (names.length === 0) {
    container.innerHTML = '<div class="text-slate-500 text-xs">Пока нет полей. Добавь через + выше или в списках INSERT/UPDATE.</div>';
    return;
  }

  container.innerHTML = masterFields.map((f, i) => {
    const name = f.field;

    return `
      <div class="flex items-center gap-2 bg-slate-800 px-2 py-1 rounded text-xs">
        <span class="flex-1 font-mono">${name}${f.readonly ? ' [ro]' : ''}${f.disabled ? ' [dis]' : ''}</span>
        <span class="text-[10px] text-slate-300">${f.title || ''}</span>
        
        <label class="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" ${(f.useInInsert !== false) ? 'checked' : ''} onchange="toggleFieldUsage('${name}', 'insert', this.checked)">
          <span class="text-[9px]">Insert</span>
        </label>
        
        <label class="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" ${(f.useInUpdate !== false) ? 'checked' : ''} onchange="toggleFieldUsage('${name}', 'update', this.checked)">
          <span class="text-[9px]">Update</span>
        </label>

        <button class="px-1 py-0.5 text-[10px] bg-slate-600 rounded hover:bg-slate-500" onclick="moveMasterFieldUp(${i})" title="Вверх">↑</button>
        <button class="px-1 py-0.5 text-[10px] bg-slate-600 rounded hover:bg-slate-500" onclick="moveMasterFieldDown(${i})" title="Вниз">↓</button>
        <button class="px-1.5 py-0.5 text-[10px] bg-emerald-700 rounded hover:bg-emerald-600" onclick="editMasterField('${name}')">✎</button>
        <button class="px-1.5 py-0.5 text-[10px] bg-red-700 rounded hover:bg-red-600" onclick="deleteMasterField(${i})">×</button>
      </div>
    `;
  }).join('');
}

function toggleFieldUsage(fieldName, mode, checked) {
  const masterFields = currentWindowConfig.fields || [];
  const masterF = masterFields.find(f => f.field === fieldName);
  if (!masterF) return;

  if (mode === 'insert') {
    masterF.useInInsert = checked;
  } else {
    masterF.useInUpdate = checked;
  }

  // Rebuild the lists from master (so forms get correct data)
  rebuildFormListsFromMaster();

  renderUnifiedFieldsList();
}

function addMasterFieldAndOpenEditor() {
  const name = prompt('Имя поля (как в БД):', 'new_col');
  if (!name) return;

  const newF = { field: name, title: name, type: 'text', useInInsert: true, useInUpdate: true };

  if (!currentWindowConfig.fields) currentWindowConfig.fields = [];
  // Add to master
  if (!currentWindowConfig.fields.find(f => f.field === name)) {
    currentWindowConfig.fields.push(newF);
  }

  // Add to both lists by default
  if (!currentWindowConfig.insert.fields) currentWindowConfig.insert.fields = [];
  if (!currentWindowConfig.update.fields) currentWindowConfig.update.fields = [];
  if (!currentWindowConfig.insert.fields.find(f => f.field === name)) currentWindowConfig.insert.fields.push({...newF});
  if (!currentWindowConfig.update.fields.find(f => f.field === name)) currentWindowConfig.update.fields.push({...newF});

  renderInsertFieldsList();
  renderUpdateFieldsList();
  renderUnifiedFieldsList();

  // Open editor
  editMasterField(name);
}

function rebuildFormListsFromMaster() {
  const master = currentWindowConfig.fields || [];

  // Only master order. No separate per-form order for simplicity (user can reorder master)
  currentWindowConfig.insert.fields = master
    .filter(f => f.useInInsert)
    .map(f => ({ ...f }));

  currentWindowConfig.update.fields = master
    .filter(f => f.useInUpdate)
    .map(f => ({ ...f }));
}

function moveMasterFieldUp(index) {
  const fields = currentWindowConfig.fields;
  if (!fields || index <= 0) return;
  [fields[index - 1], fields[index]] = [fields[index], fields[index - 1]];
  renderUnifiedFieldsList();
  rebuildFormListsFromMaster();
}

function moveMasterFieldDown(index) {
  const fields = currentWindowConfig.fields;
  if (!fields || index >= fields.length - 1) return;
  [fields[index], fields[index + 1]] = [fields[index + 1], fields[index]];
  renderUnifiedFieldsList();
  rebuildFormListsFromMaster();
}

async function deleteMasterField(index) {
  if (!currentWindowConfig.fields) return;
  const f = currentWindowConfig.fields[index];
  if (await customConfirm(`Удалить поле "${f.field}" из мастера? Оно будет удалено из Insert и Update.`)) {
    const fieldName = f.field;
    currentWindowConfig.fields.splice(index, 1);
    // remove from lists too
    if (currentWindowConfig.insert.fields) {
      currentWindowConfig.insert.fields = currentWindowConfig.insert.fields.filter(ff => ff.field !== fieldName);
    }
    if (currentWindowConfig.update.fields) {
      currentWindowConfig.update.fields = currentWindowConfig.update.fields.filter(ff => ff.field !== fieldName);
    }
    renderUnifiedFieldsList();
    // no need to call old renders
  }
}

function editMasterField(fieldName) {
  // Prefer master for editing common properties
  const masterIdx = (currentWindowConfig.fields || []).findIndex(f => f.field === fieldName);
  if (masterIdx >= 0) {
    const masterField = currentWindowConfig.fields[masterIdx];
    openFieldEditor(masterField, (updated) => {
      currentWindowConfig.fields[masterIdx] = updated;
      // Propagate to insert and update lists
      ['insert', 'update'].forEach(listName => {
        const lst = listName === 'insert' ? currentWindowConfig.insert.fields : currentWindowConfig.update.fields;
        if (lst) {
          const i = lst.findIndex(f => f.field === fieldName);
          if (i >= 0) {
            const specific = lst[i];
            lst[i] = { ...updated };
          }
        }
      });
      renderInsertFieldsList();
      renderUpdateFieldsList();
      renderUnifiedFieldsList();
    }, currentWindowConfig.fields);
    return;
  }

  // Fallback to old
  let idx = (currentWindowConfig.insert.fields || []).findIndex(f => f.field === fieldName);
  if (idx >= 0) { editInsertField(idx); return; }
  idx = (currentWindowConfig.update.fields || []).findIndex(f => f.field === fieldName);
  if (idx >= 0) { editUpdateField(idx); return; }
}

if (typeof window !== 'undefined') {
  window.renderAdminConfigUI = renderAdminConfigUI;
}

function syncInsertUpdateFields(direction = 'both') {
  if (!currentWindowConfig.insert || !currentWindowConfig.update) {
    showToast('INSERT или UPDATE не настроены', 'error');
    return;
  }

  const insF = currentWindowConfig.insert.fields || [];
  const updF = currentWindowConfig.update.fields || [];

  const map = {};

  // Build map from both
  [...insF, ...updF].forEach(f => {
    if (!f.field) return;
    if (!map[f.field]) {
      map[f.field] = JSON.parse(JSON.stringify(f)); // deep copy
    } else {
      // Merge common properties (everything except update-specific)
      Object.keys(f).forEach(key => {
        const isUpdateSpecific = key.includes('Update');
        if (!isUpdateSpecific && f[key] !== undefined && f[key] !== null) {
          map[f.field][key] = f[key];
        }
      });
    }
  });

  // Rebuild lists
  if (direction === 'both' || direction === 'insertToUpdate') {
    currentWindowConfig.update.fields = updF.map(f => map[f.field] ? {...map[f.field]} : f );
    // Add fields that exist in insert but not in update (optional, user can remove)
    insF.forEach(f => {
      if (!updF.find(u => u.field === f.field)) {
        const copy = {...map[f.field]};
        // don't copy insert-only if any
        currentWindowConfig.update.fields.push(copy);
      }
    });
  }

  if (direction === 'both' || direction === 'updateToInsert') {
    currentWindowConfig.insert.fields = insF.map(f => map[f.field] ? {...map[f.field]} : f);
    updF.forEach(f => {
      if (!insF.find(i => i.field === f.field)) {
        const copy = {...map[f.field]};

        currentWindowConfig.insert.fields.push(copy);
      }
    });
  }

  showToast('Поля синхронизированы. Общие свойства (title, type, validations, transforms, auto и т.д.) теперь одинаковые.');
  renderAdminConfigUI();
}

window.syncInsertUpdateFields = syncInsertUpdateFields;

function showAdminGuide() {
  const modal = document.createElement('div');
  modal.className = 'fixed inset-0 bg-black/90 flex items-center justify-center z-[999] p-4';

  const features = [
    {
      category: "GRID (главная таблица)",
      title: "Настройка колонок в таблице",
      desc: "Указываете какие поля показывать в основном гриде и их красивые названия (title). Можно авто-заполнить первые колонки из запроса.",
      example: "Поле: SERIAL_NUMBER → Название: Серийный номер",
      keywords: "grid колонка название title авто"
    },
    {
      category: "DETAILS (окно деталей)",
      title: "Что показывать при двойном клике",
      desc: "Аналогично GRID. Настраиваете список полей, которые будут отображаться в отдельном окне деталей.",
      example: "Все важные поля: LEGAL_NAME, STATUS и т.д.",
      keywords: "details детали двойной клик окно деталей"
    },
    {
      category: "Поля INSERT / UPDATE ★",
      title: "Редактор каждой колонки — ПОДРОБНЫЙ СПРАВОЧНИК",
      desc: "Нажми ✎ напротив поля. Откроется редактор. Здесь описаны ВСЕ разделы, функции и параметры.",
      example: "Смотри ниже полное описание каждого пункта редактора.",
      keywords: "поле редактор insert update star подробный справочник guide help"
    },
    {
      category: "Поля INSERT / UPDATE",
      title: "1. Основные свойства поля",
      desc: "• Title — красивое название, которое видит пользователь.\\n• Type — тип поля: text, textarea, number, date, checkbox (при отмеченном можно 'date' → текущая дата, при снятом — пусто), select, lookup.\\n• Default value — значение по умолчанию при создании.\\n• Required — обязательно для заполнения.\\n• Disabled (в форме) — пользователь не может менять значение (например после автоподстановки комиссии).\\n• Hidden — поле не показывается в форме, но значение может подставляться автоматически.",
      example: "Title: 'Номер карты', Type: 'text', Required: true",
      keywords: "title type required readonly hidden default"
    },
    {
      category: "Поля INSERT / UPDATE",
      title: "2. System / Auto variable (авто-значения) — самый важный раздел",
      desc: "Выпадающий список. Поле заполняется автоматически при сохранении.\n\nДоступные варианты:\n• CURRENT_USER — логин текущего пользователя\n• CURRENT_USER_ID — ID пользователя\n• NOW — текущая дата+время (можно задать формат)\n• TODAY — только дата\n• NOW_ISO — ISO формат\n• TIMESTAMP — unix секунды\n• UNIX_MILLIS — unix миллисекунды\n• UUID — уникальный идентификатор (550e8400-e29b...)\n• SHORT_ID — короткий случайный ID (8 символов)\n• RANDOM_STRING — случайная строка\n• RANDOM_INT — случайное целое (указывай Min и Max)\n• RANDOM_FLOAT — случайное дробное (Min/Max)\n• YEAR / MONTH / DAY — части даты\n• COPY — копировать значение из другой колонки (выбери источник)\n• CONSTANT — всегда одно и то же значение\n• CUSTOM — своё значение или sql:...",
      example: "RANDOM_INT Min:100000 Max:999999 → при сохранении будет число 743821",
      keywords: "system auto variable uuid random_int copy constant now current_user"
    },
    {
      category: "Поля INSERT / UPDATE",
      title: "3. Связанные / Зависимые колонки + cascading lookup",
      desc: "Это тот блок «Источник данных + Зависимости» в редакторе поля.\nСвязь: Тип поля = lookup/select → иди в этот блок.\n• Простой lookup: dependsOn пустой + SQL запрос\n• Cascading: dependsOn = другое поле + SQL с ?\n• Условный (conditional): зависит от поля + один SQL с CASE WHEN ? = 'значение' (или несколько ? ) / UNION для разных таблиц. Или используй lookupConditions для полностью разных запросов.\n\nПри dependsOn поле перезагружает список когда меняется родитель.",
      example: "Region: простой SELECT RegionName FROM REGIONS\nDistrict: dependsOn=City + основной SQL + условие: если City='Երևан' то SELECT DistrictName FROM DISTRICTS",
      keywords: "dependsOn lookup cascading страна город связанная колонка источник данных"
    },
    {
      category: "Поля INSERT / UPDATE",
      title: "4. Валидации (правила проверки)",
      desc: "Через 'Добавить мощную возможность' → Валидация.\n\nТипы валидаций:\n• required — обязательно\n• length — длина (min, max, exact)\n• minmax — минимум/максимум значения\n• position — проверка конкретной позиции в строке (start, value)\n• language — только определённые символы (armenian, cyrillic, digits...)\n• pattern — регулярное выражение\n• unique — проверка уникальности через SQL запрос (можно composite: укажите поля через запятую в редакторе, напр. TerminalID,MerchantID и запрос SELECT 1 FROM t WHERE tid=? AND mid=?)\n• custom — SQL запрос ИЛИ условие if (напр. value > 1). Для custom можно указать условие JS-like и/или SQL с ?",
      example: "position: start=1, value=ARM → первые 3 символа должны быть 'ARM'",
      keywords: "валидация validation length position pattern unique required"
    },
    {
      category: "Поля INSERT / UPDATE",
      title: "5. Условная видимость / обязательность",
      desc: "Через 'Добавить мощную возможность' → Условная видимость.\nПоле появляется или становится обязательным только при определённом значении другого поля.",
      example: "Показывать поле 'Серия паспорта' только если country == 'Armenia'",
      keywords: "conditional visibility requiredIf showWhen условная"
    },
    {
      category: "Поля INSERT / UPDATE",
      title: "6. Другие полезные возможности",
      desc: "• Placeholder — подсказка внутри поля\n• Help — описание (показывается при наведении)\n• Cross-проверка — сравнивать значение с другим полем\n• Allowed values — белый список значений\n• AutoValue в старом стиле тоже работает (для совместимости)",
      example: "Placeholder: 'Введите номер карты'",
      keywords: "placeholder help cross allowed mask"
    },
    {
      category: "Важно!",
      title: "Где сохраняется конфиг (путь к файлу)",
      desc: "Сохранение всегда идёт в файл, который сейчас используется программой.\n\nОсновной путь (самый частый):\nC:\\GTerminalPro\\config.json\n\nЕсли такого файла нет — программа ищет:\n1. D:\\GterminalPro\\config\\config.json (или где лежит проект)\n2. D:\\GterminalPro\\config.json\n\nПосле нажатия 'Сохранить' в админке изменения должны появиться именно в том файле, который программа загрузила.",
      example: "Ищи файл по пути C:\\GTerminalPro\\config.json — там должны быть твои изменения после сохранения.",
      keywords: "конфиг путь config.json C:/GTerminalPro сохранить файл где"
    },
    {
      category: "System / Auto variable",
      title: "Автоматические значения + Значение по умолчанию",
      desc: "• «Значение по умолчанию» (вверху редактора) — простое статическое значение (например 'ACTIVE', 0, 'N'). Используется если нет авто.\n• System/Auto (фиолетовый блок) — динамика: CURRENT_USER, UUID, SELECT MAX(...) sql, NOW, COPY из другого поля и т.д. \nПростое значение никогда не пиши в default если используешь авто или lookupQuery.",
      example: "Для MCC: не трогай defaultValue. Для zip_code: используй auto SQL MAX(TID)+1",
      keywords: "auto system uuid random current_user copy constant now today timestamp default значение по умолчанию"
    },
    {
      category: "Зависимые / Связанные колонки",
      title: "Cascading lookup vs Простой lookup",
      desc: "В редакторе: Тип поля → lookup/select, потом в блоке «Источник данных + Зависимости»:\n- Простой (без связи): dependsOn пустой, обычный SELECT\n- Cascading (зависимый): dependsOn=другое_поле + SELECT ... WHERE поле = ?",
      example: "MCC (простой): Тип поля=lookup, зависит от: (пусто), SQL без WHERE\nГород (cascading): dependsOn=Страна, SQL с WHERE country = ?",
      keywords: "dependsOn lookup cascading страна город связанная колонка простой vs cascading"
    },
    {
      category: "Валидации",
      title: "Правила проверки значения",
      desc: "Можно добавить много типов валидаций на поле (required, length, pattern, position, language, unique, cross-field и др.).",
      example: "length min:3 max:50 • position 1-3 должно быть 'ARM' • unique по SQL (в т.ч. связка TerminalID+MerchantID)",
      keywords: "валидация validation required length pattern position language unique"
    },
    {
      category: "Условная видимость",
      title: "Conditional visibility",
      desc: "Поле показывается или становится обязательным только при определённом значении другого поля.",
      example: "Показывать поле 'Номер визы' только если country = Armenia",
      keywords: "conditional visibility условная видимость requiredIf showWhen"
    },
    {
      category: "Lookup / Select (выпадающие списки из БД)",
      title: "select vs lookup — в чём разница?",
      desc: "• type: \"select\" (выпадающий) → классический <select>. Обязательно выбрать из списка. Хорошо для маленьких списков (5-100 элементов).\n• type: \"lookup\" (динамический) → текстовое поле с автоподсказками (input + datalist). Можно печатать, браузер сам фильтрует по префиксу (набираешь \"41\" — сразу показывает 410000 и т.д.). Идеально для MCC, больших справочников, артикулов. Можно вводить вручную + подсказки.\n\nОба типа поддерживают lookupQuery (SELECT ... as value, ... as display). lookup + dependsOn = cascading (Страна → Город).",
      example: "MCC: type=lookup + SELECT DISTINCT mcc as value, mcc as display FROM ...",
      keywords: "lookup select динамический datalist фильтр префикс MCC большой список"
    },
    {
      category: "Lookup / Auto заполнение",
      title: "Какой функционал выбрать для АВТОПОДСТАНОВКИ (чтобы не открылся выпадающий список при 1 возможности)",
      desc: "• Для автоподстановки **одного** значения (например следующий ID: SELECT MAX(TerminalID)+1 FROM ...) — используй **System / Auto variable** (фиолетовый блок в редакторе поля) → тип **SQL**.\n  Тип поля ставь обычный text/number. НЕ используй type=lookup и НЕ клади запрос в lookupQuery.\n• lookup / select + lookupQuery — это когда нужен **СПИСОК** для выбора (даже если сейчас 1 запись).\n\nТеперь в коде добавлено: если lookup вернул ровно 1 строку — значение автоматически подставится, datalist будет очищен, list= убран → выпадающий список НЕ откроется.",
      example: "TerminalID: type=text + Auto=SQL с \"SELECT MAX(TerminalID)+1 FROM MERCHANTS\"\nMCC: type=select + searchable + lookupQuery (список — нормально показать варианты)",
      keywords: "автопостовление автоподстановка 1 возможность выпадающий список не открывать lookup auto sql max"
    },
    {
      category: "Выпадающие списки (3 чётких режима)",
      title: "Авто (1 значение без списка) / Список из базы с поиском+скроллом / Ручной список без БД",
      desc: "1. Чистое автозаполнение (один вариант автоматически) — System/Auto (SQL или CONSTANT). Списка нет вообще.\n2. Выпадающий список С ПОИСКОМ и ПРОКРУТКОЙ из базы — type=lookup + Источник: SQL запрос (или cascading).\n3. Выпадающий список С ПОИСКОМ без обращения к базе — type=lookup + Источник: «Ручной список» и напиши варианты построчно (можно value|текст).\n\nПоиск работает при наборе, список прокручивается, выглядит красиво.",
      example: "Ручной: \"Активный\nЗакрыт\nВ архиве\"\nС поиском: MCC lookupQuery + type=lookup",
      keywords: "ручной список статический варианты без базы поиск скролл выпадающий lookup"
    },
    {
      category: "Основные свойства поля",
      title: "title, type, required, readonly, default, placeholder, help",
      desc: "Стандартные настройки: отображаемое название, тип (text, number, date, textarea, checkbox — отмечен = дата, пустой = пусто), обязательное, только для чтения, значение по умолчанию и т.д.",
      example: "title: 'Юридическое название', type: 'text', required: true",
      keywords: "title type required readonly default placeholder help"
    },
    {
      category: "Фильтры в окне",
      title: "Фильтры: настраиваемые и кастомные операторы",
      desc: "В редакторе фильтра (✎) выберите какие стандартные операторы показывать (=, LIKE, IS NULL и др.) и добавьте кастомные SQL-операторы.\n\nКастомный пример:\n• label: closed\n• sql: CloseDate IS NOT NULL\n• needsValue: false\n\nВ выпадающем списке пользователь увидит «closed», а в WHERE попадёт ваш SQL. Можно использовать {field} и {value} в SQL.",
      example: "Status: custom closed → CloseDate IS NOT NULL; custom open → CloseDate IS NULL",
      keywords: "фильтр filter оператор like in custom sql is null"
    },
    {
      category: "Поля INSERT / UPDATE ★",
      title: "Кастомный размер поля (ширина + высота)",
      desc: "В редакторе поля → «Размер поля в форме»:\n• По умолчанию / Полная ширина\n• Кастомный — укажите любую ширину (300px, 50%, 100%) и высоту (40px, auto).\n\nПрименяется прямо к input/textarea/select в форме.",
      example: "Ширина: 280px, Высота: 60px → большое поле для комментария",
      keywords: "width height size custom px % форма размер"
    },
    {
      category: "Поля INSERT / UPDATE ★",
      title: "Searchable для обычного select",
      desc: "В редакторе поля (для type=select) поставь галочку «Сделать поисковым».\n\nОбычный <select> превратится в текстовое поле с фильтрацией: можно печатать и сразу находить нужный пункт в списке (как lookup).",
      example: "Большой справочник MCC — пользователь печатает «41» и сразу видит нужные коды.",
      keywords: "searchable select поиск фильтр список"
    },
    {
      category: "Поля INSERT / UPDATE ★",
      title: "Transforms — преобразование значения при сохранении",
      desc: "Через «Добавить правило» → Transform.\n\nПоддерживаемые типы:\n• Первые N символов\n• Последние N символов\n• Substring (start + length)\n• Split по разделителю + взять часть (индекс)\n• Regex extract\n\nОчень полезно, когда в lookup показывается «5411 - Магазин», а в БД нужно сохранить только «5411».",
      example: "lastN=4 или split delimiter=\" - \" take=0",
      keywords: "transform firstN lastN substring split regex extract сохранить"
    },
    {
      category: "Поля INSERT / UPDATE ★",
      title: "Conditional Default (если X то default Y)",
      desc: "Через «Добавить правило» → Conditional default.\n\nЕсли значение в другом поле совпадает — автоматически подставляется нужный default при сохранении.",
      example: "Если category == 'retail' → default = '5411'",
      keywords: "conditional default если то X Y"
    },
    {
      category: "Поля INSERT / UPDATE",
      title: "Переупорядочивание полей (↑ ↓)",
      desc: "В админке в блоках INSERT и UPDATE рядом с каждым полем есть кнопки ↑ и ↓. Порядок влияет на то, в каком порядке поля будут в форме.",
      example: "Сначала важные поля, потом второстепенные.",
      keywords: "reorder порядок полей стрелки insert update"
    },
    {
      category: "Главное окно",
      title: "Live-операторы фильтров + 21 строка на страницу",
      desc: "В основном окне фильтры — только поля. Оператор (LIKE, =, >, IN и др.) выбирается пользователем в реальном времени.\n\nПагинация жёстко 21 строка (удобно для классического просмотра).",
      example: "Фильтр по CARD_NUMBER → пользователь выбирает «содержит» и вводит 1234",
      keywords: "фильтр оператор like 21 pagination строки"
    },
    {
      category: "Дизайн",
      title: "Классический видимый дизайн (scrollbar, компактность)",
      desc: "Все скроллбары сделаны видимыми и классическими (12-14px). Интерфейс намеренно плотный и функциональный, как в старых десктопных утилитах (DBeaver classic, SQLiteStudio).",
      example: "Нет огромных отступов и модных скруглений — максимум информации на экране.",
      keywords: "дизайн scrollbar классический компактный плотный"
    },
    {
      category: "Правила и фичи редактора",
      title: "Полный список «Добавить правило / возможность»",
      desc: "Validation, Conditional visibility, Cross-check, Mask/Help, Allowed values, Transform, Conditional Default.\n\nКаждое правило можно редактировать (✎) и удалять.",
      example: "Добавил transform + validation + conditional default на одно поле.",
      keywords: "правила transform validation conditional cross allowed"
    }
  ];

  let html = `
    <div class="bg-slate-800 border border-slate-600 rounded-2xl w-full max-w-4xl max-h-[88vh] flex flex-col shadow-xl">
      <div class="px-4 py-3 border-b border-slate-700 flex items-center justify-between bg-slate-900 rounded-t-2xl">
        <div class="flex items-center gap-2.5">
          <i class="fas fa-book text-amber-400"></i>
          <span class="text-base font-semibold">User Guide — Полная справка</span>
        </div>
        <button onclick="this.closest('.fixed').remove()" class="text-2xl text-slate-400 hover:text-white leading-none px-1">×</button>
      </div>

      <div class="px-3 py-2 border-b border-slate-700 bg-slate-950">
        <div class="text-[10px] text-amber-400 mb-0.5">
          Конфиг: <strong>C:\GTerminalPro\config.json</strong>
        </div>
        <input id="guide-search" 
               type="text" 
               placeholder="Поиск по всему гайду: transform, searchable, width, validation, lookup, auto..." 
               class="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 text-xs focus:border-amber-500 outline-none">
      </div>

      <div id="guide-list" class="flex-1 overflow-auto p-3 custom-scroll space-y-2 text-xs">
  `;

  features.forEach((f, i) => {
    html += `
      <div class="guide-item bg-slate-900 border border-slate-700 rounded-xl p-2.5 text-sm" data-keywords="${f.keywords} ${f.title} ${f.desc} ${f.category}">
        <div class="flex items-start justify-between">
          <div>
            <span class="text-[10px] uppercase tracking-wide text-amber-400 font-semibold">${f.category}</span>
            <div class="font-semibold text-[13.5px] leading-tight mt-0.5">${f.title}</div>
          </div>
        </div>
        <div class="mt-1 text-slate-300 text-[12.5px] leading-snug">${f.desc}</div>
        <div class="mt-1.5 text-[10px] bg-black/50 p-1.5 rounded font-mono text-emerald-400 border border-emerald-900/50">
          ${f.example}
        </div>
      </div>
    `;
  });

  html += `
      </div>

      <div class="px-3 py-2 border-t border-slate-700 text-[10px] text-slate-500 bg-slate-900 rounded-b-2xl">
        Поиск работает по всем ключам. Полный справочник по всем фичам редактора (transforms, searchable select, custom size, conditional default и др.).
      </div>
    </div>
  `;

  modal.innerHTML = html;
  document.body.appendChild(modal);

  // Search functionality
  const searchInput = modal.querySelector('#guide-search');
  const list = modal.querySelector('#guide-list');
  const items = list.querySelectorAll('.guide-item');

  searchInput.oninput = () => {
    const term = searchInput.value.toLowerCase().trim();
    items.forEach(item => {
      const keywords = item.getAttribute('data-keywords').toLowerCase();
      if (!term || keywords.includes(term)) {
        item.style.display = '';
      } else {
        item.style.display = 'none';
      }
    });
  };

  // Focus search
  setTimeout(() => searchInput.focus(), 100);
}








function refreshAdminInputsAndLists() {
    // Update key inputs (table inputs removed for insert/update as they come from main config)
    const updK = document.getElementById('update-keyfield');
    const delT = document.getElementById('delete-table');
    const delK = document.getElementById('delete-keyfield');

    if (updK && currentWindowConfig.update) updK.value = currentWindowConfig.update.keyField || '';
    if (delT && currentWindowConfig.delete) delT.value = currentWindowConfig.delete.table || '';
    if (delK && currentWindowConfig.delete) delK.value = currentWindowConfig.delete.keyField || '';

    if (typeof renderUnifiedFieldsList === 'function') renderUnifiedFieldsList();
    renderGridList();
    if (typeof renderDetailsList === 'function') renderDetailsList();
    renderFiltersList();
}

// ==================== GRID & FILTERS CONFIG (restored functionality) ====================

function renderGridList() {
    const container = document.getElementById('grid-columns-list');
    if (!container) return;
    const grid = currentWindowConfig.grid || [];
    container.innerHTML = '';
    grid.forEach((col, i) => {
        const div = document.createElement('div');
        div.className = 'bg-slate-800 p-2 rounded-xl border border-slate-700 text-sm flex justify-between items-center';
        div.innerHTML = 
            '<div>' +
            '<span class="font-medium">' + (col.title || col.field) + '</span>' +
            '<span class="text-xs text-blue-400 ml-2">(' + col.field + ')</span>' +
            '</div>' +
            '<div class="flex gap-1">' +
            '<button class="px-2 py-0.5 text-xs bg-blue-700 rounded" onclick="editGridColumn(' + i + ')">✎ Название</button>' +
            '<button class="px-2 py-0.5 text-xs bg-red-700 rounded" onclick="deleteGridColumn(' + i + ')">×</button>' +
            '</div>';
        container.appendChild(div);
    });
    if (typeof renderUnifiedFieldsList === 'function') renderUnifiedFieldsList();
}

async function addGridColumn() {
    const field = await customPrompt('Поле колонки (из БД):', '');
    if (!field) return;
    const title = await customPrompt('Отображаемое название / description:', field);
    if (!currentWindowConfig.grid) currentWindowConfig.grid = [];
    currentWindowConfig.grid.push({ field: field.trim(), title: (title || field).trim() });
    renderGridList();
}

async function editGridColumn(index) {
    if (!currentWindowConfig.grid || !currentWindowConfig.grid[index]) return;
    const col = currentWindowConfig.grid[index];
    const newTitle = await customPrompt('Название колонки (description):', col.title || col.field);
    if (newTitle !== null) {
        col.title = newTitle.trim();
        renderGridList();
    }
}

async function deleteGridColumn(index) {
    if (!currentWindowConfig.grid) return;
    if (await customConfirm('Удалить колонку из главной таблицы?')) {
        currentWindowConfig.grid.splice(index, 1);
        renderGridList();
    }
}

async function autoFillGridFromQuery() {
    const q = currentWindowConfig.query || (currentWindowConfig.dataSource && currentWindowConfig.dataSource.query);
    if (!q) { showToast('В конфиге окна нет основного SQL запроса', 'error'); return; }
    try {
        const testSql = q + (/limit\s+\d+/i.test(q) ? '' : ' LIMIT 1');
        const res = await window.electronAPI.executeQuery(testSql);
        if (res.success && res.rows && res.rows.length > 0) {
            const cols = Object.keys(res.rows[0]).map(f => ({ field: f, title: f })).slice(0, 10);
            currentWindowConfig.grid = cols;
            renderGridList();
            showToast('Grid колонки обновлены автоматически (первые 10) из запроса');
        } else {
            showToast('Не удалось получить колонки', 'error');
        }
    } catch (e) {
        showToast('Ошибка авто-заполнения grid: ' + e.message, 'error');
    }
}

// ==================== DETAILS (аналогично GRID) ====================
function renderDetailsList() {
    const container = document.getElementById('details-columns-list');
    if (!container) return;
    const dets = currentWindowConfig.details || [];
    container.innerHTML = '';
    dets.forEach((col, i) => {
        const div = document.createElement('div');
        div.className = 'bg-slate-800 p-2 rounded-xl border border-slate-700 text-sm flex justify-between items-center';
        div.innerHTML = 
            '<div>' +
            '<span class="font-medium">' + (col.title || col.field) + '</span>' +
            '<span class="text-xs text-emerald-400 ml-2">(' + col.field + ')</span>' +
            '</div>' +
            '<div class="flex gap-1">' +
            '<button class="px-2 py-0.5 text-xs bg-emerald-700 rounded" onclick="editDetailColumn(' + i + ')">✎ Название</button>' +
            '<button class="px-2 py-0.5 text-xs bg-red-700 rounded" onclick="deleteDetailColumn(' + i + ')">×</button>' +
            '</div>';
        container.appendChild(div);
    });
    if (typeof renderUnifiedFieldsList === 'function') renderUnifiedFieldsList();
}

async function addDetailColumn() {
    const field = await customPrompt('Поле для деталей (из БД):', '');
    if (!field) return;
    const title = await customPrompt('Отображаемое название в деталях:', field);
    if (!currentWindowConfig.details) currentWindowConfig.details = [];
    currentWindowConfig.details.push({ field: field.trim(), title: (title || field).trim() });
    renderDetailsList();
}

async function editDetailColumn(index) {
    if (!currentWindowConfig.details || !currentWindowConfig.details[index]) return;
    const col = currentWindowConfig.details[index];
    const newTitle = await customPrompt('Название в окне деталей:', col.title || col.field);
    if (newTitle !== null) {
        col.title = newTitle.trim();
        renderDetailsList();
    }
}

async function deleteDetailColumn(index) {
    if (!currentWindowConfig.details) return;
    if (await customConfirm('Удалить поле из деталей?')) {
        currentWindowConfig.details.splice(index, 1);
        renderDetailsList();
    }
}

async function autoFillDetailsFromQuery() {
    const q = currentWindowConfig.query || (currentWindowConfig.dataSource && currentWindowConfig.dataSource.query);
    if (!q) { showToast('В конфиге окна нет основного SQL запроса', 'error'); return; }
    try {
        const testSql = q + (/limit\s+\d+/i.test(q) ? '' : ' LIMIT 1');
        const res = await window.electronAPI.executeQuery(testSql);
        if (res.success && res.rows && res.rows.length > 0) {
            const cols = Object.keys(res.rows[0]).map(f => ({ field: f, title: f }));
            currentWindowConfig.details = cols;  // все колонки или можно .slice если надо
            renderDetailsList();
            showToast('DETAILS обновлены из запроса');
        } else {
            showToast('Не удалось получить колонки', 'error');
        }
    } catch (e) {
        showToast('Ошибка авто-заполнения details: ' + e.message, 'error');
    }
}

function describeFilterOperators(f) {
    const stdCount = Array.isArray(f.operators) ? f.operators.length : DEFAULT_FILTER_OPERATORS.length;
    const customCount = (f.customOperators || []).length;
    const customLabels = (f.customOperators || []).map(c => c.label).filter(Boolean).join(', ');
    let text = stdCount + ' станд.';
    if (customCount) text += ', ' + customCount + ' кастом (' + customLabels + ')';
    if (f.defaultOperator) text += ', default: ' + f.defaultOperator;
    return text;
}

function renderFiltersList() {
    const container = document.getElementById('filters-list');
    if (!container) return;
    const fls = currentWindowConfig.filters || [];
    container.innerHTML = '';
    if (!fls.length) {
        container.innerHTML = '<div class="text-slate-500 text-xs p-1">Нет фильтров. Нажми + чтобы добавить.</div>';
    }
    fls.forEach((f, i) => {
        const div = document.createElement('div');
        div.className = 'bg-slate-800 p-2 rounded-xl border border-slate-700 text-sm flex justify-between items-center';
        div.innerHTML = 
            '<div class="min-w-0">' +
            '<div><span class="font-medium">' + (f.title || f.field) + '</span>' +
            '<span class="text-xs text-violet-400 ml-1">(' + f.field + ')</span></div>' +
            '<div class="text-[10px] text-slate-500 truncate">' + describeFilterOperators(f) + '</div>' +
            '</div>' +
            '<div class="flex gap-1 flex-shrink-0">' +
            '<button class="px-2 py-0.5 text-xs bg-violet-700 rounded" onclick="editFilter(' + i + ')">✎</button>' +
            '<button class="px-2 py-0.5 text-xs bg-red-700 rounded" onclick="deleteFilter(' + i + ')">×</button>' +
            '</div>';
        container.appendChild(div);
    });
    if (typeof renderUnifiedFieldsList === 'function') renderUnifiedFieldsList();
}

function showFilterEditorModal(index, isNew) {
    if (!currentWindowConfig.filters || !currentWindowConfig.filters[index]) return;
    const filter = currentWindowConfig.filters[index];
    if (!filter.customOperators) filter.customOperators = [];
    if (!filter.operators) filter.operators = DEFAULT_FILTER_OPERATORS.slice();

    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 bg-black/85 flex items-center justify-center z-[999] p-4';
    modal.innerHTML = `
      <div class="bg-slate-800 border border-slate-600 rounded-2xl w-full max-w-2xl p-5 max-h-[90vh] overflow-auto">
        <div class="font-semibold mb-3">Редактор фильтра</div>
        <div class="grid grid-cols-2 gap-3 text-sm mb-4">
          <div>
            <label class="block text-xs text-slate-400 mb-1">Поле (из БД)</label>
            <input id="fe-field" value="${(filter.field || '').replace(/"/g, '&quot;')}" class="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5">
          </div>
          <div>
            <label class="block text-xs text-slate-400 mb-1">Название в окне</label>
            <input id="fe-title" value="${(filter.title || filter.field || '').replace(/"/g, '&quot;')}" class="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5">
          </div>
        </div>

        <div class="mb-4">
          <div class="text-xs font-semibold text-violet-300 mb-2">Стандартные операторы (что показывать в списке)</div>
          <div id="fe-std-ops" class="grid grid-cols-2 gap-1 text-xs"></div>
        </div>

        <div class="mb-4">
          <div class="flex justify-between items-center mb-2">
            <div class="text-xs font-semibold text-emerald-300">Кастомные операторы (SQL)</div>
            <button id="fe-add-custom" type="button" class="bg-emerald-700 hover:bg-emerald-600 px-2 py-0.5 rounded text-[10px]">+ Добавить</button>
          </div>
          <div id="fe-custom-list" class="space-y-2"></div>
          <div class="text-[10px] text-slate-500 mt-1">Пример: label <b>closed</b>, sql <b>CloseDate IS NOT NULL</b>. Можно {field} и {value}. Если needsValue=true — поле значения обязательно.</div>
        </div>

        <div class="mb-2">
          <label class="block text-xs text-slate-400 mb-1">Оператор по умолчанию</label>
          <select id="fe-default-op" class="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-sm"></select>
        </div>

        <div class="mt-4 flex gap-2">
          <button id="fe-save" class="flex-1 bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 rounded">Сохранить</button>
          <button id="fe-cancel" class="flex-1 bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded">Отмена</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const stdContainer = modal.querySelector('#fe-std-ops');
    Object.keys(FILTER_OPERATOR_CATALOG).forEach(opKey => {
        const def = FILTER_OPERATOR_CATALOG[opKey];
        const checked = filter.operators.includes(opKey) ? 'checked' : '';
        const row = document.createElement('label');
        row.className = 'flex items-center gap-2 bg-slate-900 border border-slate-700 rounded px-2 py-1 cursor-pointer';
        row.innerHTML = `<input type="checkbox" class="fe-std-op" value="${opKey}" ${checked}> <span>${def.label}</span>`;
        stdContainer.appendChild(row);
    });

    function rebuildDefaultOptions() {
        const draft = collectDraftFilter();
        const options = getFilterOperatorOptions(draft);
        const sel = modal.querySelector('#fe-default-op');
        const current = filter.defaultOperator || '';
        sel.innerHTML = options.map(op => {
            const selected = (resolveFilterDefaultOperatorValue({ defaultOperator: current }, options) === op.value) ? 'selected' : '';
            return `<option value="${op.value}" ${selected}>${op.label}</option>`;
        }).join('');
    }

    function renderCustomRows() {
        const list = modal.querySelector('#fe-custom-list');
        list.innerHTML = '';
        (filter.customOperators || []).forEach((custom, idx) => {
            const row = document.createElement('div');
            row.className = 'bg-slate-900 border border-slate-700 rounded p-2 grid grid-cols-12 gap-2 items-center';
            row.innerHTML = `
              <input data-custom-label="${idx}" value="${(custom.label || '').replace(/"/g, '&quot;')}" placeholder="label (closed)" class="col-span-2 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs">
              <input data-custom-sql="${idx}" value="${(custom.sql || '').replace(/"/g, '&quot;')}" placeholder="SQL (CloseDate IS NOT NULL)" class="col-span-8 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs font-mono">
              <label class="col-span-1 flex items-center gap-1 text-[10px]"><input type="checkbox" data-custom-needs="${idx}" ${custom.needsValue ? 'checked' : ''}> val</label>
              <button type="button" data-custom-del="${idx}" class="col-span-1 bg-red-700 hover:bg-red-600 rounded px-1 py-1 text-xs">×</button>
            `;
            list.appendChild(row);
        });
        rebuildDefaultOptions();
    }

    function collectDraftFilter() {
        const stdOps = Array.from(modal.querySelectorAll('.fe-std-op:checked')).map(el => el.value);
        const customOperators = (filter.customOperators || []).map((custom, idx) => {
            const labelEl = modal.querySelector('[data-custom-label="' + idx + '"]');
            const sqlEl = modal.querySelector('[data-custom-sql="' + idx + '"]');
            const needsEl = modal.querySelector('[data-custom-needs="' + idx + '"]');
            return {
                label: labelEl ? labelEl.value.trim() : (custom.label || ''),
                sql: sqlEl ? sqlEl.value.trim() : (custom.sql || ''),
                needsValue: needsEl ? needsEl.checked : !!custom.needsValue
            };
        }).filter(c => c.label || c.sql);
        return {
            field: filter.field,
            title: filter.title,
            operators: stdOps.length ? stdOps : DEFAULT_FILTER_OPERATORS.slice(),
            customOperators,
            defaultOperator: modal.querySelector('#fe-default-op') ? modal.querySelector('#fe-default-op').value : ''
        };
    }

    modal.querySelector('#fe-add-custom').onclick = () => {
        filter.customOperators.push({ label: '', sql: '', needsValue: false });
        renderCustomRows();
    };

    modal.querySelector('#fe-custom-list').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-custom-del]');
        if (!btn) return;
        const idx = parseInt(btn.getAttribute('data-custom-del'), 10);
        filter.customOperators.splice(idx, 1);
        renderCustomRows();
    });

    modal.querySelector('#fe-custom-list').addEventListener('input', rebuildDefaultOptions);
    stdContainer.addEventListener('change', rebuildDefaultOptions);

    renderCustomRows();

    modal.querySelector('#fe-cancel').onclick = () => {
        if (isNew) currentWindowConfig.filters.splice(index, 1);
        modal.remove();
        renderFiltersList();
    };

    modal.querySelector('#fe-save').onclick = () => {
        const field = modal.querySelector('#fe-field').value.trim();
        const title = modal.querySelector('#fe-title').value.trim();
        if (!field) {
            showToast('Укажите поле фильтра', 'error');
            return;
        }

        const stdOps = Array.from(modal.querySelectorAll('.fe-std-op:checked')).map(el => el.value);
        const customOperators = (filter.customOperators || []).map((custom, idx) => {
            const labelEl = modal.querySelector('[data-custom-label="' + idx + '"]');
            const sqlEl = modal.querySelector('[data-custom-sql="' + idx + '"]');
            const needsEl = modal.querySelector('[data-custom-needs="' + idx + '"]');
            return {
                label: labelEl ? labelEl.value.trim() : '',
                sql: sqlEl ? sqlEl.value.trim() : '',
                needsValue: needsEl ? needsEl.checked : false
            };
        }).filter(c => c.label && c.sql);

        const defaultSel = modal.querySelector('#fe-default-op');
        const defaultOperator = defaultSel ? defaultSel.value : '';

        filter.field = field;
        filter.title = title || field;
        if (!stdOps.length && customOperators.length) {
            filter.operators = [];
        } else if (stdOps.length === Object.keys(FILTER_OPERATOR_CATALOG).length) {
            delete filter.operators;
        } else if (stdOps.length) {
            filter.operators = stdOps;
        } else {
            delete filter.operators;
        }

        if (customOperators.length) filter.customOperators = customOperators;
        else delete filter.customOperators;

        if (defaultOperator) filter.defaultOperator = defaultOperator;
        else delete filter.defaultOperator;

        modal.remove();
        renderFiltersList();
        showToast('Фильтр сохранён');
    };
}

async function addFilter() {
    if (!currentWindowConfig.filters) currentWindowConfig.filters = [];
    currentWindowConfig.filters.push({
        field: '',
        title: '',
        operators: DEFAULT_FILTER_OPERATORS.slice(),
        customOperators: []
    });
    showFilterEditorModal(currentWindowConfig.filters.length - 1, true);
}

function editFilter(index) {
    if (!currentWindowConfig.filters || !currentWindowConfig.filters[index]) return;
    showFilterEditorModal(index, false);
}

async function deleteFilter(index) {
    if (!currentWindowConfig.filters) return;
    if (await customConfirm('Удалить этот фильтр?')) {
        currentWindowConfig.filters.splice(index, 1);
        renderFiltersList();
    }
}

function renderFormButtonsList() {
  const container = document.getElementById('form-buttons-list');
  if (!container) return;
  const buttons = currentWindowConfig.formCustomButtons || [];
  container.innerHTML = '';
  if (buttons.length === 0) {
    container.innerHTML = '<div class="text-slate-500 text-xs p-1">Нет кнопок. Нажми + чтобы добавить (появятся вверху формы).</div>';
    return;
  }
  buttons.forEach((btn, i) => {
    const div = document.createElement('div');
    div.className = 'bg-slate-900 border border-slate-700 p-2 rounded flex justify-between items-start text-xs';
    const styleInfo = btn.style ? `style: ${JSON.stringify(btn.style)}` : '';
    const stylePreview = btn.style ? `bg:${btn.style.bg||''} color:${btn.style.color||''}` : '';
    const posText = btn.position === 'bottom' ? 'внизу' : 'вверху';
    const modesText = (btn.modes && btn.modes.length) ? btn.modes.join('+') : 'insert+update';
    div.innerHTML = `
      <div class="flex-1">
        <div><span class="font-semibold">${btn.label}</span> <span class="text-orange-400">(${btn.action})</span> <span class="text-[9px] text-slate-500">[${posText}] [${modesText}]</span></div>
        <div class="text-[9px] text-slate-400 mt-0.5">${btn.set ? 'set: ' + (Array.isArray(btn.set) ? btn.set.map(s => s.field + '=' + (s.valueType||'val')).join(', ') : JSON.stringify(btn.set)).slice(0,70) : ''}${btn.saveAfter ? ' [auto-save]' : ''} ${btn.templateFile ? 'tpl: ' + btn.templateFile + ' ' : ''}${btn.defaultCellMapping ? 'cells: ' + JSON.stringify(btn.defaultCellMapping).slice(0,40) : ''} ${btn.errorMessage ? '⚠ ' + btn.errorMessage.slice(0,30) : ''} ${btn.successMessage ? '✓ ' + btn.successMessage.slice(0,30) : ''} ${stylePreview}</div>
      </div>
      <div class="flex gap-1 text-[10px]">
        <button class="px-1.5 bg-emerald-700 rounded" onclick="editFormButton(${i})">✎</button>
        <button class="px-1.5 bg-red-700 rounded" onclick="deleteFormButton(${i})">×</button>
      </div>
    `;
    container.appendChild(div);
  });
}

async function addFormButton() {
  showButtonEditor(null, (newBtn) => {
    if (!currentWindowConfig.formCustomButtons) currentWindowConfig.formCustomButtons = [];
    currentWindowConfig.formCustomButtons.push(newBtn);
    renderFormButtonsList();
  });
}

async function editFormButton(index) {
  const btn = currentWindowConfig.formCustomButtons[index];
  showButtonEditor(btn, (updatedBtn) => {
    currentWindowConfig.formCustomButtons[index] = updatedBtn;
    renderFormButtonsList();
  });
}

function showButtonEditor(existingBtn, onSave) {
  const isNew = !existingBtn;
  const btn = existingBtn ? {...existingBtn} : {
    label: 'Новая кнопка',
    action: 'importExcel',
    style: { bg: '#0ea5e9', color: '#fff', width: 'auto', height: 'auto' },
    defaultCellMapping: {},
    set: [],
    modes: ['insert', 'update'],
    errorMessage: '',
    successMessage: ''
  };

  const modal = document.createElement('div');
  modal.className = 'fixed inset-0 bg-black/90 flex items-center justify-center z-[999] p-4';
  modal.innerHTML = `
    <div class="bg-slate-800 border border-slate-600 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-auto shadow-2xl">
      <div class="px-5 py-4 border-b border-slate-700 flex items-center justify-between bg-slate-900">
        <span class="font-semibold text-lg">${isNew ? 'Добавить кнопку' : 'Редактировать кнопку'}</span>
        <button id="close-btn" class="text-2xl leading-none px-2 text-slate-400 hover:text-white">×</button>
      </div>
      <div class="p-5 space-y-4">
        <!-- Основные -->
        <div>
          <label class="block text-xs text-slate-400 mb-1">Текст кнопки</label>
          <input id="btn-label" value="${btn.label || ''}" class="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm">
        </div>

        <div>
          <label class="block text-xs text-slate-400 mb-1">Действие (функционал)</label>
          <select id="btn-action" class="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm">
            <option value="importExcel">Загрузить из Excel (заполнить форму из ячеек)</option>
            <option value="exportExcel">Выгрузить в Excel</option>
            <option value="setFields">Установить значения полей (change in DB)</option>
          </select>
        </div>

        <div>
          <label class="block text-xs text-slate-400 mb-1">Где отображать</label>
          <select id="btn-position" class="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm">
            <option value="top">Вверху формы (перед полями)</option>
            <option value="bottom">Внизу формы (после полей)</option>
          </select>
        </div>

        <!-- Доступность по типам форм (insert / update / delete) -->
        <div class="border border-slate-700 rounded-xl p-3 bg-slate-950/60">
          <div class="text-xs font-semibold text-slate-300 mb-1.5">Кнопка доступна в формах:</div>
          <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <label class="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" id="btn-mode-insert" checked class="accent-emerald-500">
              <span>Insert (добавление новой записи)</span>
            </label>
            <label class="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" id="btn-mode-update" checked class="accent-emerald-500">
              <span>Update (редактирование записи)</span>
            </label>
            <label class="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" id="btn-mode-delete" class="accent-emerald-500">
              <span>Delete</span>
            </label>
            <label class="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" id="btn-mode-select" class="accent-emerald-500">
              <span>Select (при выборе строки в таблице — кнопка в панели окна)</span>
            </label>
          </div>
          <div class="text-[9px] text-slate-500 mt-1">Insert/Update — кнопка в форме. Select — в главном окне после выбора строки (удобно для выгрузки в Excel без открытия формы).</div>
        </div>

        <!-- Сообщения при выполнении кнопки -->
        <div class="border border-slate-700 rounded-xl p-3 bg-slate-950/60 space-y-3">
          <div class="text-xs font-semibold text-slate-300">Сообщения при выполнении</div>

          <div>
            <label class="block text-xs text-slate-400 mb-1">При ошибке</label>
            <input id="btn-error-message" value="${(btn.errorMessage || btn.error || '').replace(/"/g, '&quot;')}" placeholder="Например: Не удалось загрузить данные из файла" class="w-full bg-slate-900 border border-slate-600 rounded px-3 py-1.5 text-sm">
            <div class="text-[9px] text-slate-500 mt-0.5">Если оставить пустым — будет стандартное сообщение об ошибке.</div>
          </div>

          <div>
            <label class="block text-xs text-slate-400 mb-1">При успехе</label>
            <input id="btn-success-message" value="${(btn.successMessage || '').replace(/"/g, '&quot;')}" placeholder="Например: Данные успешно загружены из Excel" class="w-full bg-slate-900 border border-slate-600 rounded px-3 py-1.5 text-sm">
            <div class="text-[9px] text-slate-500 mt-0.5">Если оставить пустым — будет стандартное сообщение об успехе.</div>
          </div>
        </div>

        <!-- Стиль -->
        <div class="border border-slate-700 rounded-xl p-3 bg-slate-950/60">
          <div class="text-xs font-semibold text-slate-300 mb-2">Стиль кнопки</div>
          <div class="grid grid-cols-2 gap-3 text-xs">
            <div>
              <label class="block text-slate-400 mb-0.5">Цвет фона</label>
              <input id="btn-bg" type="color" value="${btn.style?.bg || '#0ea5e9'}" class="w-full h-9 bg-slate-900 border border-slate-600 rounded cursor-pointer">
            </div>
            <div>
              <label class="block text-slate-400 mb-0.5">Цвет текста</label>
              <input id="btn-color" type="color" value="${btn.style?.color || '#ffffff'}" class="w-full h-9 bg-slate-900 border border-slate-600 rounded cursor-pointer">
            </div>
            <div>
              <label class="block text-slate-400 mb-0.5">Ширина</label>
              <input id="btn-width" value="${btn.style?.width || 'auto'}" placeholder="auto или 160px" class="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-sm">
            </div>
            <div>
              <label class="block text-slate-400 mb-0.5">Высота</label>
              <input id="btn-height" value="${btn.style?.height || 'auto'}" placeholder="auto или 34px" class="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-sm">
            </div>
          </div>
        </div>

        <!-- Динамическая конфигурация по action -->
        <div id="btn-config-area" class="border border-slate-700 rounded-xl p-3 bg-slate-950/60 min-h-[120px]">
          <!-- JS заполнит в зависимости от action -->
        </div>
      </div>
      <div class="px-5 py-4 border-t border-slate-700 bg-slate-900 flex justify-end gap-2 rounded-b-2xl">
        <button id="cancel-btn" class="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-xl text-sm">Отмена</button>
        <button id="save-btn" class="px-5 py-2 bg-emerald-700 hover:bg-emerald-600 rounded-xl text-sm font-semibold">Сохранить кнопку</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const actionSel = modal.querySelector('#btn-action');
  const configArea = modal.querySelector('#btn-config-area');
  const posSel = modal.querySelector('#btn-position');

  const modeInsert = modal.querySelector('#btn-mode-insert');
  const modeUpdate = modal.querySelector('#btn-mode-update');
  const modeDelete = modal.querySelector('#btn-mode-delete');
  const modeSelect = modal.querySelector('#btn-mode-select');

  // Set initial values
  actionSel.value = btn.action || 'importExcel';
  posSel.value = btn.position || 'top';

  // Init modes checkboxes (default to insert+update if not specified)
  const initialModes = Array.isArray(btn.modes) && btn.modes.length > 0 ? btn.modes : ['insert', 'update'];
  if (modeInsert) modeInsert.checked = initialModes.includes('insert');
  if (modeUpdate) modeUpdate.checked = initialModes.includes('update');
  if (modeDelete) modeDelete.checked = initialModes.includes('delete');
  if (modeSelect) modeSelect.checked = initialModes.includes('select');

  function renderConfigArea() {
    configArea.innerHTML = '';
    const act = actionSel.value;

    if (act === 'importExcel' || act === 'exportExcel') {
      const isExport = act === 'exportExcel';
      let html = '';

      if (isExport) {
        html += `
          <div class="text-xs font-semibold text-emerald-300 mb-2">Шаблон Excel для выгрузки</div>
          <div class="grid grid-cols-1 gap-2 mb-3 text-xs">
            <div>
              <label class="block text-slate-400 mb-0.5">Папка шаблонов</label>
              <input id="exp-template-dir" value="${(btn.templateDir || 'C:\\\\GTerminalPro\\\\templates').replace(/"/g, '&quot;')}" class="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 font-mono text-[11px]" placeholder="C:\\GTerminalPro\\templates">
            </div>
            <div class="flex gap-2 items-end">
              <div class="flex-1">
                <label class="block text-slate-400 mb-0.5">Файл шаблона (.xlsx)</label>
                <input id="exp-template-file" value="${(btn.templateFile || btn.template || '').replace(/"/g, '&quot;')}" class="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 font-mono text-[11px]" placeholder="merchant_template.xlsx">
              </div>
              <button type="button" id="exp-browse-template" class="px-2 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-[10px] whitespace-nowrap">Обзор...</button>
            </div>
            <div>
              <label class="block text-slate-400 mb-0.5">Имя выходного файла (в C:\\GTerminalPro\\exports)</label>
              <input id="exp-output-name" value="${(btn.outputFilename || '').replace(/"/g, '&quot;')}" class="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 font-mono text-[11px]" placeholder="export_{TerminalID}.xlsx">
              <div class="text-[9px] text-slate-500 mt-0.5">Можно {TerminalID}, {MerchantID} — подставятся из данных строки/формы.</div>
            </div>
          </div>
        `;
      }

      html += `
        <div class="text-xs font-semibold mb-1.5">Маппинг: Поле → Ячейка Excel (A2, B5 и т.д.)</div>
        <div id="mapping-rows" class="space-y-1 mb-2 max-h-[200px] overflow-auto custom-scroll p-1 border border-slate-800 rounded"></div>
        <button id="add-map-row" class="text-xs px-2 py-1 bg-orange-600 hover:bg-orange-500 rounded">+ Добавить поле для маппинга</button>
        <div class="text-[10px] text-slate-500 mt-1">${isExport ? 'Данные из формы или выбранной строки запишутся в указанные ячейки шаблона и сохранятся в exports.' : 'При клике данные из ячеек Excel автоматически заполнят поля формы.'}</div>
      `;
      configArea.innerHTML = html;

      if (isExport) {
        const browseBtn = configArea.querySelector('#exp-browse-template');
        if (browseBtn) {
          browseBtn.onclick = async () => {
            const dirInp = configArea.querySelector('#exp-template-dir');
            const fileInp = configArea.querySelector('#exp-template-file');
            const picked = await window.electronAPI.selectFile({
              defaultPath: (dirInp && dirInp.value) || 'C:\\GTerminalPro\\templates',
              filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }]
            });
            if (!picked) return;
            const parts = picked.replace(/\\/g, '/').split('/');
            const fname = parts.pop();
            if (fileInp) fileInp.value = fname || picked;
            if (dirInp && parts.length) dirInp.value = parts.join('\\');
          };
        }
      }

      const rowsContainer = configArea.querySelector('#mapping-rows');
      const addBtn = configArea.querySelector('#add-map-row');

      if (!btn.defaultCellMapping || typeof btn.defaultCellMapping !== 'object') {
        btn.defaultCellMapping = (btn.mapping && typeof btn.mapping === 'object') ? { ...btn.mapping } : {};
      }
      let currentMap = btn.defaultCellMapping;

      function getUsedFields() {
        return Object.keys(currentMap || {});
      }

      function getWindowFieldsForMapping() {
        const fromFields = (currentWindowConfig.fields || []).filter(f => !f.hiddenInForm);
        if (fromFields.length) return fromFields;
        const grid = currentWindowConfig.grid || [];
        return grid.map(c => ({ field: c.field, title: c.title || c.field }));
      }

      function getAvailForAdd() {
        const used = new Set(getUsedFields());
        return getWindowFieldsForMapping().filter(f => !used.has(f.field));
      }

      function getOptionsForRow(currentField) {
        const used = new Set(getUsedFields());
        const all = getWindowFieldsForMapping();
        const opts = [];
        // always include the current one for this row
        all.forEach(f => {
          if (!used.has(f.field) || f.field === currentField) {
            opts.push(f);
          }
        });
        // also keep any legacy field not in master
        if (currentField && !all.find(f => f.field === currentField)) {
          opts.push({ field: currentField, title: currentField });
        }
        return opts;
      }

      function syncBtnMap() {
        btn.defaultCellMapping = currentMap;
        if (isExport) btn.mapping = { ...currentMap };
      }

      function renderRows() {
        rowsContainer.innerHTML = '';
        const usedNow = getUsedFields();

        Object.keys(currentMap).forEach(formField => {
          const cell = currentMap[formField] || '';
          const row = document.createElement('div');
          row.className = 'flex gap-2 items-center bg-slate-900 border border-slate-700 rounded p-1';
          row.innerHTML = `
            <select class="map-field bg-slate-800 border border-slate-600 rounded px-1 py-0.5 text-xs flex-1"></select>
            <input class="map-cell bg-slate-800 border border-slate-600 rounded px-1 py-0.5 text-xs font-mono w-20" value="${cell}" placeholder="A2">
            <button class="text-red-400 hover:text-red-500 px-1 text-sm" title="Удалить">×</button>
          `;

          const sel = row.querySelector('.map-field');
          const inp = row.querySelector('.map-cell');
          const del = row.querySelector('button');

          // Populate only non-duplicate choices (current + unused)
          const options = getOptionsForRow(formField);
          options.forEach(f => {
            const opt = document.createElement('option');
            opt.value = f.field;
            opt.textContent = f.title || f.field;
            if (f.field === formField) opt.selected = true;
            sel.appendChild(opt);
          });

          // Cell input updates the map under the *current* selected field key
          inp.oninput = () => {
            const key = sel.value || formField;
            currentMap[key] = inp.value.trim();
            syncBtnMap();
          };

          sel.onchange = () => {
            const newKey = sel.value;
            const val = inp.value.trim();
            // remove the old key this row represented
            if (formField && currentMap.hasOwnProperty(formField)) {
              delete currentMap[formField];
            }
            // assign (if newKey was used elsewhere it will be overwritten - simple and safe)
            currentMap[newKey] = val;
            syncBtnMap();
            renderRows(); // refresh selects so duplicates disappear from other rows
          };

          del.onclick = () => {
            const key = sel.value || formField;
            delete currentMap[key];
            syncBtnMap();
            renderRows();
          };

          rowsContainer.appendChild(row);
        });
      }

      addBtn.onclick = () => {
        const unused = getAvailForAdd();
        if (unused.length === 0) {
          showToast('Все доступные поля формы уже добавлены в маппинг.', 'error');
          return;
        }
        const nextField = unused[0].field;
        currentMap[nextField] = 'A1';
        syncBtnMap();
        renderRows();
      };

      // initial render
      renderRows();

    } else if (act === 'setFields') {
      // Rich editor for many value source options for DB/set in form
      let html = `
        <div class="text-xs font-semibold mb-1.5">Установка значений (много источников: константа, NOW, из поля формы, SQL из БД и др.)</div>
        <div id="set-rows" class="space-y-2 mb-2"></div>
        <button id="add-set-row" class="text-xs px-2 py-1 bg-orange-600 hover:bg-orange-500 rounded">+ Добавить поле для установки</button>
        <div class="mt-3 flex items-center gap-2 text-xs">
          <label class="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" id="set-save-after" class="accent-emerald-500">
            <span>Автоматически сохранить в БД после установки (один клик)</span>
          </label>
        </div>
      `;
      configArea.innerHTML = html;

      const rowsC = configArea.querySelector('#set-rows');
      const addB = configArea.querySelector('#add-set-row');
      const saveAfterChk = configArea.querySelector('#set-save-after');

      if (!Array.isArray(btn.set)) {
        // convert legacy flat object to rich array
        const legacy = btn.set || {};
        btn.set = Object.keys(legacy).map(fld => {
          const v = legacy[fld];
          if (v && typeof v === 'object') return { field: fld, ...v };
          const isNow = (v === 'NOW' || v === 'now');
          return { field: fld, valueType: isNow ? 'now' : 'constant', value: isNow ? '' : v };
        });
      }
      if (!btn.set) btn.set = [];
      saveAfterChk.checked = !!btn.saveAfter;

      function getAvailFields() {
        return (currentWindowConfig.fields || []).filter(f => !f.hiddenInForm);
      }

      function createValueUI(rowEl, spec) {
        const box = rowEl.querySelector('.set-value-ui');
        box.innerHTML = '';
        const t = spec.valueType || 'constant';

        if (t === 'constant') {
          const wrap = document.createElement('div');
          wrap.className = 'flex-1 flex gap-1 items-center';
          wrap.innerHTML = `<span class="text-[10px] text-slate-400 w-16">Значение:</span>
            <input class="set-const flex-1 bg-slate-800 border border-slate-600 rounded px-1 py-0.5 text-xs font-mono" value="${spec.value || ''}" placeholder="CLOSED / 1 / Активен">`;
          box.appendChild(wrap);
          const inp = wrap.querySelector('.set-const');
          inp.oninput = () => { spec.value = inp.value; };
        } else if (t === 'now' || t === 'NOW') {
          const wrap = document.createElement('div');
          wrap.className = 'flex-1 flex gap-1 items-center';
          wrap.innerHTML = `<span class="text-[10px] text-slate-400 w-16">Формат:</span>
            <input class="set-fmt flex-1 bg-slate-800 border border-slate-600 rounded px-1 py-0.5 text-xs font-mono" value="${spec.format || 'DD/MM/YYYY HH:mm:ss'}" placeholder="DD/MM/YYYY HH:mm:ss">
            <span class="text-[9px] text-emerald-400">NOW</span>`;
          box.appendChild(wrap);
          const inp = wrap.querySelector('.set-fmt');
          inp.oninput = () => { spec.format = inp.value.trim(); };
        } else if (t === 'fromForm' || t === 'copy') {
          const wrap = document.createElement('div');
          wrap.className = 'flex-1 flex gap-1 items-center';
          wrap.innerHTML = `<span class="text-[10px] text-slate-400 w-16">Источник:</span>
            <select class="set-src flex-1 bg-slate-800 border border-slate-600 rounded px-1 py-0.5 text-xs"></select>`;
          box.appendChild(wrap);
          const sel = wrap.querySelector('.set-src');
          const av = getAvailFields();
          av.forEach(f => {
            const o = document.createElement('option');
            o.value = f.field; o.textContent = (f.title || f.field) + ' (' + f.field + ')';
            if ((spec.sourceField || spec.source) === f.field) o.selected = true;
            sel.appendChild(o);
          });
          sel.onchange = () => { spec.sourceField = sel.value; };
          if (!spec.sourceField && av.length) spec.sourceField = av[0].field;
        } else if (t === 'sql' || t === 'fromDB') {
          const wrap = document.createElement('div');
          wrap.className = 'w-full space-y-1';
          wrap.innerHTML = `
            <div class="flex gap-1"><span class="text-[10px] text-slate-400">SQL (SELECT ... возвращает 1 значение):</span></div>
            <textarea class="set-sql w-full bg-slate-800 border border-slate-600 rounded px-1 py-0.5 text-xs font-mono" rows="2" placeholder="SELECT Status FROM Terminals WHERE TID = ?"></textarea>
            <div class="text-[10px] text-slate-400">Параметры (порядок важен для ?):</div>
            <div class="param-list space-y-0.5"></div>
            <button class="add-param text-[10px] px-1.5 py-0 bg-slate-700 hover:bg-slate-600 rounded">+ Параметр (поле или константа)</button>
          `;
          box.appendChild(wrap);

          const ta = wrap.querySelector('.set-sql');
          ta.value = spec.query || '';
          ta.oninput = () => { spec.query = ta.value; };

          const pList = wrap.querySelector('.param-list');
          const addP = wrap.querySelector('.add-param');

          if (!Array.isArray(spec.paramSources)) spec.paramSources = [];

          function renderParams() {
            pList.innerHTML = '';
            spec.paramSources.forEach((p, idx) => {
              const pr = document.createElement('div');
              pr.className = 'flex gap-1 items-center text-[10px]';
              const kind = (p.kind || 'field');
              pr.innerHTML = `
                <select class="p-kind bg-slate-900 border border-slate-600 rounded px-1 text-xs">
                  <option value="field">Поле формы</option>
                  <option value="literal">Константа</option>
                </select>
                <input class="p-val flex-1 bg-slate-800 border border-slate-600 rounded px-1 py-0 text-xs" placeholder="имя поля или значение">
                <button class="px-1 text-red-400">×</button>
              `;
              const kSel = pr.querySelector('.p-kind');
              const vInp = pr.querySelector('.p-val');
              const del = pr.querySelector('button');
              kSel.value = kind;
              vInp.value = p.val != null ? p.val : (p.name || '');
              kSel.onchange = () => { p.kind = kSel.value; };
              vInp.oninput = () => { p.val = vInp.value.trim(); if (kSel.value==='field') p.name = p.val; };
              del.onclick = () => { spec.paramSources.splice(idx,1); renderParams(); };
              pList.appendChild(pr);
            });
          }
          renderParams();

          addP.onclick = () => {
            spec.paramSources.push({ kind: 'field', val: '' });
            renderParams();
          };
        } else if (t === 'uuid' || t === 'UUID') {
          const sp = document.createElement('span');
          sp.className = 'text-[10px] text-emerald-400 italic';
          sp.textContent = 'Будет сгенерирован UUID v4';
          box.appendChild(sp);
        } else if (t === 'empty') {
          const sp = document.createElement('span');
          sp.className = 'text-[10px] text-slate-500 italic';
          sp.textContent = 'Поле будет очищено';
          box.appendChild(sp);
        }
      }

      function renderSetRows() {
        rowsC.innerHTML = '';
        const avail = getAvailFields();

        (btn.set || []).forEach((spec, idx) => {
          if (!spec.field && avail.length) spec.field = avail[0].field;

          const row = document.createElement('div');
          row.className = 'set-row border border-slate-700 bg-slate-950 rounded p-1.5 space-y-1';
          row.innerHTML = `
            <div class="flex gap-1 items-center">
              <select class="set-field bg-slate-800 border border-slate-600 rounded px-1 py-0.5 text-xs flex-1"></select>
              <select class="set-type bg-slate-800 border border-slate-600 rounded px-1 py-0.5 text-xs">
                <option value="constant">Константа</option>
                <option value="now">Сейчас (NOW + формат)</option>
                <option value="today">Только дата (TODAY)</option>
                <option value="fromForm">Из другого поля формы</option>
                <option value="sql">Значение из БД (SQL запрос)</option>
                <option value="currentUser">Текущий пользователь</option>
                <option value="currentUserId">ID текущего пользователя</option>
                <option value="uuid">UUID (уникальный)</option>
                <option value="empty">Очистить (пусто)</option>
              </select>
              <button class="del-btn text-red-400 hover:text-red-500 px-1 text-sm font-bold" title="Удалить">×</button>
            </div>
            <div class="set-value-ui flex gap-1 text-xs"></div>
          `;

          const fSel = row.querySelector('.set-field');
          const tSel = row.querySelector('.set-type');
          const del = row.querySelector('.del-btn');

          // fields
          avail.forEach(f => {
            const o = document.createElement('option');
            o.value = f.field; o.textContent = f.title || f.field;
            if (f.field === spec.field) o.selected = true;
            fSel.appendChild(o);
          });
          if (!avail.find(f=>f.field===spec.field) && spec.field) {
            const oo = document.createElement('option'); oo.value = spec.field; oo.textContent = spec.field; oo.selected=true;
            fSel.appendChild(oo);
          }

          tSel.value = spec.valueType || 'constant';

          // initial value ui
          createValueUI(row, spec);

          fSel.onchange = () => {
            spec.field = fSel.value;
          };
          tSel.onchange = () => {
            spec.valueType = tSel.value;
            // reset dependent fields for clean switch
            if (spec.valueType === 'constant') { spec.value = spec.value || ''; delete spec.format; delete spec.sourceField; delete spec.query; delete spec.paramSources; }
            else if (spec.valueType === 'now' || spec.valueType==='today') { spec.format = spec.format || (spec.valueType==='now' ? 'DD/MM/YYYY HH:mm:ss' : 'DD/MM/YYYY'); delete spec.sourceField; delete spec.query; delete spec.paramSources; }
            else if (spec.valueType === 'fromForm') { spec.sourceField = spec.sourceField || (avail[0]&&avail[0].field); delete spec.format; delete spec.query; delete spec.paramSources; }
            else if (spec.valueType === 'sql' || spec.valueType==='fromDB') { if(!spec.query) spec.query=''; if(!Array.isArray(spec.paramSources)) spec.paramSources=[]; delete spec.format; delete spec.sourceField; delete spec.value; }
            else { delete spec.format; delete spec.sourceField; delete spec.query; delete spec.paramSources; }
            createValueUI(row, spec);
          };
          del.onclick = () => {
            btn.set.splice(idx, 1);
            renderSetRows();
          };

          rowsC.appendChild(row);
        });
      }

      addB.onclick = () => {
        const avail = getAvailFields();
        if (avail.length === 0) return;
        btn.set.push({
          field: avail[0].field,
          valueType: 'constant',
          value: ''
        });
        renderSetRows();
      };

      saveAfterChk.onchange = () => { btn.saveAfter = saveAfterChk.checked; };

      renderSetRows();
    }
  }

  actionSel.onchange = renderConfigArea;
  renderConfigArea(); // initial

  modal.querySelector('#cancel-btn').onclick = () => modal.remove();
  modal.querySelector('#close-btn').onclick = () => modal.remove();

  modal.querySelector('#save-btn').onclick = () => {
    // gather from inputs
    btn.label = modal.querySelector('#btn-label').value.trim() || btn.label;
    btn.action = actionSel.value;
    btn.position = posSel.value;

    btn.style = {
      bg: modal.querySelector('#btn-bg').value,
      color: modal.querySelector('#btn-color').value,
      width: modal.querySelector('#btn-width').value,
      height: modal.querySelector('#btn-height').value
    };

    // modes (insert/update/delete)
    btn.modes = [];
    if (modeInsert && modeInsert.checked) btn.modes.push('insert');
    if (modeUpdate && modeUpdate.checked) btn.modes.push('update');
    if (modeDelete && modeDelete.checked) btn.modes.push('delete');
    if (modeSelect && modeSelect.checked) btn.modes.push('select');
    if (btn.modes.length === 0) {
      btn.modes = ['insert', 'update'];
    }

    if (actionSel.value === 'exportExcel') {
      const tDir = configArea.querySelector('#exp-template-dir');
      const tFile = configArea.querySelector('#exp-template-file');
      const outName = configArea.querySelector('#exp-output-name');
      const td = tDir ? tDir.value.trim() : '';
      const tf = tFile ? tFile.value.trim() : '';
      const on = outName ? outName.value.trim() : '';
      if (td) btn.templateDir = td; else delete btn.templateDir;
      if (tf) btn.templateFile = tf; else delete btn.templateFile;
      if (on) btn.outputFilename = on; else delete btn.outputFilename;
      delete btn.templatePath;
      if (btn.defaultCellMapping) btn.mapping = { ...btn.defaultCellMapping };
    }

    if (actionSel.value === 'setFields') {
      const chk = configArea.querySelector('#set-save-after');
      if (chk) btn.saveAfter = chk.checked;
    }

    // custom error message
    const errInp = modal.querySelector('#btn-error-message');
    if (errInp) {
      const em = errInp.value.trim();
      if (em) btn.errorMessage = em; else delete btn.errorMessage;
      delete btn.error; // legacy cleanup
    }

    // custom success message
    const succInp = modal.querySelector('#btn-success-message');
    if (succInp) {
      const sm = succInp.value.trim();
      if (sm) btn.successMessage = sm; else delete btn.successMessage;
    }

    onSave(btn);
    modal.remove();
  };

  // initial select value
  setTimeout(() => {
    actionSel.value = btn.action || 'importExcel';
    posSel.value = btn.position || 'top';
    renderConfigArea();
  }, 0);
}

async function deleteFormButton(index) {
  if (await customConfirm('Удалить кнопку?')) {
    currentWindowConfig.formCustomButtons.splice(index, 1);
    renderFormButtonsList();
  }
}

function renderRowFormattingList() {
  const container = document.getElementById('row-formatting-list');
  if (!container) return;
  const rules = currentWindowConfig.rowFormatting || [];
  container.innerHTML = '';
  if (rules.length === 0) {
    container.innerHTML = '<div class="text-slate-500 text-xs p-1">Нет правил. Нажми + чтобы добавить (например: closeDate не пусто → красный бордер).</div>';
    return;
  }
  rules.forEach((rule, i) => {
    const div = document.createElement('div');
    div.className = 'bg-slate-900 border border-slate-700 p-2 rounded flex justify-between items-start text-xs';
    const stylePreview = rule.style ? Object.keys(rule.style).map(k => k + ':' + rule.style[k]).join('; ').slice(0,60) : '';
    const opText = rule.operator || 'notEmpty';
    div.innerHTML = `
      <div class="flex-1">
        <div><span class="font-semibold">${rule.field || '?'}</span> <span class="text-red-400">${opText}</span> ${rule.value ? '= ' + rule.value : ''} ${rule.enabled === false ? '<span class="text-slate-500">(выкл)</span>' : ''}</div>
        <div class="text-[9px] text-slate-400 mt-0.5 flex items-center gap-1">${stylePreview}
          ${rule.style && rule.style.backgroundColor ? `<span class="inline-block w-3 h-3 rounded border" style="background:${rule.style.backgroundColor}"></span>` : ''}
          ${rule.style && rule.style.color ? `<span class="inline-block w-3 h-3 rounded border" style="background:${rule.style.color}"></span>` : ''}
          ${rule.style && rule.style.border ? `<span class="inline-block w-3 h-3 rounded border" style="border:1px solid ${rule.style.border.match(/#[0-9a-fA-F]{3,6}/)?.[0] || '#ccc'}"></span>` : ''}
        </div>
      </div>
      <div class="flex gap-1 text-[10px]">
        <button class="px-1.5 bg-emerald-700 rounded" onclick="editRowFormattingRule(${i})">✎</button>
        <button class="px-1.5 bg-red-700 rounded" onclick="deleteRowFormattingRule(${i})">×</button>
      </div>
    `;
    container.appendChild(div);
  });
}

function addRowFormattingRule() {
  const newRule = {
    field: (currentWindowConfig.fields && currentWindowConfig.fields[0] && currentWindowConfig.fields[0].field) || 'closeDate',
    operator: 'notEmpty',
    value: '',
    style: { border: '2px solid #dc2626', backgroundColor: '#fee2e2' },
    enabled: true
  };
  if (!currentWindowConfig.rowFormatting) currentWindowConfig.rowFormatting = [];
  currentWindowConfig.rowFormatting.push(newRule);
  renderRowFormattingList();
  // Immediately open editor for the new one
  editRowFormattingRule(currentWindowConfig.rowFormatting.length - 1);
}

function editRowFormattingRule(index) {
  const rule = currentWindowConfig.rowFormatting[index];
  if (!rule) return;

  const fields = (currentWindowConfig.fields || []).map(f => f.field);
  const ops = ['notEmpty', 'empty', 'equals', 'notEquals', 'contains', 'notContains', 'gt', 'lt'];

  const modal = document.createElement('div');
  modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-[999]';
  modal.innerHTML = `
    <div class="bg-slate-800 border border-slate-600 rounded-2xl w-full max-w-md p-5">
      <div class="font-semibold mb-3">Правило форматирования строки</div>
      <div class="space-y-3 text-sm">
        <div>
          <label class="block text-xs text-slate-400">Поле</label>
          <select id="rf-field" class="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1">
            ${fields.map(f => `<option value="${f}" ${f===rule.field?'selected':''}>${f}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="block text-xs text-slate-400">Оператор</label>
          <select id="rf-op" class="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1">
            ${ops.map(o => `<option value="${o}" ${o===rule.operator?'selected':''}>${o}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="block text-xs text-slate-400">Значение (для equals/contains/gt...)</label>
          <input id="rf-val" value="${rule.value || ''}" class="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1">
        </div>
        <div>
          <label class="block text-xs text-slate-400">Border color</label>
          <input id="rf-border-color" type="color" value="${(rule.style && rule.style.border && rule.style.border.match(/#[0-9a-fA-F]{3,6}/)?.[0]) || '#dc2626'}" class="w-full h-9 bg-slate-900 border border-slate-600 rounded cursor-pointer">
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-xs text-slate-400">Background</label>
            <input id="rf-bg" type="color" value="${rule.style && rule.style.backgroundColor ? rule.style.backgroundColor : '#fee2e2'}" class="w-full h-9 bg-slate-900 border border-slate-600 rounded cursor-pointer">
          </div>
          <div>
            <label class="block text-xs text-slate-400">Text color</label>
            <input id="rf-color" type="color" value="${rule.style && rule.style.color ? rule.style.color : '#7f1d1d'}" class="w-full h-9 bg-slate-900 border border-slate-600 rounded cursor-pointer">
          </div>
        </div>
        <div>
          <label class="block text-xs text-slate-400">Advanced border (full css, optional)</label>
          <input id="rf-border" value="${rule.style && rule.style.border || ''}" placeholder="2px solid #dc2626 or 1px dashed red" class="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs">
        </div>
        <label class="flex items-center gap-2 text-xs"><input type="checkbox" id="rf-enabled" ${rule.enabled !== false ? 'checked' : ''}> Включено</label>
      </div>
      <div class="mt-4 flex gap-2">
        <button id="rf-save" class="flex-1 bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 rounded">Сохранить</button>
        <button id="rf-cancel" class="flex-1 bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded">Отмена</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector('#rf-cancel').onclick = () => modal.remove();
  modal.querySelector('#rf-save').onclick = () => {
    rule.field = modal.querySelector('#rf-field').value;
    rule.operator = modal.querySelector('#rf-op').value;
    rule.value = modal.querySelector('#rf-val').value;
    rule.enabled = modal.querySelector('#rf-enabled').checked;
    rule.style = rule.style || {};
    const borderFull = modal.querySelector('#rf-border').value.trim();
    const borderColor = modal.querySelector('#rf-border-color').value;
    const bg = modal.querySelector('#rf-bg').value;
    const c = modal.querySelector('#rf-color').value;

    if (borderFull) {
      rule.style.border = borderFull;
    } else if (borderColor) {
      rule.style.border = `2px solid ${borderColor}`;
    } else {
      delete rule.style.border;
    }

    if (bg) rule.style.backgroundColor = bg; else delete rule.style.backgroundColor;
    if (c) rule.style.color = c; else delete rule.style.color;

    if (Object.keys(rule.style).length === 0) delete rule.style;

    renderRowFormattingList();
    modal.remove();
  };
}

function deleteRowFormattingRule(index) {
  if (!currentWindowConfig.rowFormatting) return;
  currentWindowConfig.rowFormatting.splice(index, 1);
  renderRowFormattingList();
}

// Helper to get table for operation per window
function getTableForOp(op) {
    if (op === 'insert') return currentWindowConfig.insert?.table || currentWindowConfig.dataSource?.table;
    if (op === 'update') return currentWindowConfig.update?.table || currentWindowConfig.dataSource?.table;
    if (op === 'delete') return currentWindowConfig.delete?.table || currentWindowConfig.dataSource?.table;
    return null;
}

async function addNewWindow() {
    const name = await customPrompt('Название нового окна:', 'Новое окно');
    if (!name) return;

    // Suggest ID from name, but let user override (needed for roles/references)
    let suggestedId = name.toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (!suggestedId) suggestedId = 'win_' + Date.now().toString().slice(-8);

    const idInput = await customPrompt('ID окна (уникальный идентификатор, для ролей и ссылок):', suggestedId);
    const query = await customPrompt('Основной SQL запрос (SELECT ... FROM ...):', 'SELECT * FROM new_table');
    if (!query) return;

    // Use provided ID or the suggested one
    let id = (idInput || suggestedId || '').trim();
    if (!id) {
        id = suggestedId;
    }

    const newWin = {
        id: id,
        title: name,
        query: query,
        filters: [],
        grid: [],
        insert: { table: '', fields: [] },
        update: { table: '', keyField: '', fields: [] },
        delete: { table: '', keyField: '' }
    };

    // try to extract table
    const match = query.match(/FROM\s+([^\s,]+)/i);
    if (match) {
        const tbl = match[1];
        newWin.insert.table = tbl;
        newWin.update.table = tbl;
        newWin.delete.table = tbl;
    }

    // auto default grid and fields from query if possible
    try {
        const testSql = query + (query.toLowerCase().includes('limit') ? '' : ' LIMIT 1');
        const res = await window.electronAPI.executeQuery(testSql);
        if (res.success && res.rows && res.rows.length > 0) {
            const allCols = Object.keys(res.rows[0]).map(f => ({ field: f, title: f }));
            newWin.grid = allCols.slice(0, 10);   // автоматически первые 10 колонок в главном окне
            newWin.insert.fields = allCols.map(c => ({ field: c.field, title: c.field, type: 'text', useInInsert: true, useInUpdate: true }));
            newWin.update.fields = allCols.map(c => ({ field: c.field, title: c.field, type: 'text', useInInsert: true, useInUpdate: true }));
            newWin.details = allCols;  // автозаполнение details всеми колонками из запроса
        }
    } catch(e) {
        // fallback to empty
    }

    if (!Array.isArray(fullConfig.windows)) fullConfig.windows = [];
    fullConfig.windows.push(newWin);

    showToast('Новое окно добавлено. Теперь настройте INSERT/UPDATE/DELETE для него и нажмите «Сохранить конфиг».');
    // refresh sidebar list
    refreshWindowList();

    // IMPORTANT: Stay inside admin (do not call loadWindow)
    // Set as current and re-open admin UI so user can immediately configure per-window tables/fields
    currentWindowConfig = normalizeWindowConfig(newWin);
    if (!Array.isArray(currentWindowConfig.rowFormatting)) currentWindowConfig.rowFormatting = [];
    renderAdminConfigUI();
}

function refreshWindowList() {
    console.log('[REFRESH] === refreshWindowList called ===');
    const list = document.getElementById('window-list');
    console.log('[REFRESH] #window-list element found?', !!list);
    if (!list || !fullConfig) { console.warn('[REFRESH] no list or no fullConfig'); return; }
    if (!fullConfig.windows) fullConfig.windows = [];
    console.log('[REFRESH] fullConfig has', fullConfig.windows.length, 'windows');
    list.innerHTML = '';

    const currentWinId = currentWindowConfig ? String(currentWindowConfig.id || currentWindowConfig.windowId || currentWindowConfig.title) : null;

    // Respect per-user WINDOWS_ACCESS (comma list). ADMIN sees all.
    const allowed = (currentUser && currentUser.windowsAccess)
      ? String(currentUser.windowsAccess).split(',').map(s => s.trim()).filter(Boolean)
      : null;

    const roleStr = String(currentUser && (currentUser.role || currentUser.ROLE) || '').toUpperCase();
    const isAdmin = currentUser && (roleStr === 'ADMIN' || (currentUser.login || currentUser.LOGIN || '').toLowerCase() === 'admin');
    console.log('[REFRESH] currentUser:', currentUser ? {login: currentUser.login || currentUser.LOGIN, role: currentUser.role || currentUser.ROLE} : null);
    console.log('[REFRESH] isAdmin calc:', isAdmin, 'allowed:', allowed);
    let visibleWindows = fullConfig.windows.filter(win => {
      const wid = String(win.id || win.windowId || win.title);
      if (isAdmin) return true;
      if (!allowed || allowed.length === 0) return true;
      return allowed.includes(wid);
    });
    console.log('[REFRESH] after filter visible count=', visibleWindows.length, 'ids:', visibleWindows.map(w => w.id || w.title));

    // Safety: if login is admin, always show all windows (to guarantee display)
    const loginName = (currentUser && (currentUser.login || currentUser.LOGIN || '')).toLowerCase();
    if (loginName === 'admin' && visibleWindows.length < (fullConfig.windows || []).length) {
      console.warn('[REFRESH] forcing all windows because login is admin');
      visibleWindows = (fullConfig.windows || []).slice();
    }

    // Safety: if for some reason 0 but we have windows and isAdmin, force show (to guarantee list)
    if (visibleWindows.length === 0 && fullConfig.windows.length > 0 && isAdmin) {
      console.warn('[REFRESH] forcing show all windows for admin');
      visibleWindows = fullConfig.windows.slice();
    }

    // Ultimate safety: if still no visible windows but config has them, force show all (logged in user should see the configured windows)
    if (visibleWindows.length === 0 && fullConfig.windows && fullConfig.windows.length > 0 && currentUser) {
      console.warn('[REFRESH] ultimate force: showing all windows for logged user');
      visibleWindows = fullConfig.windows.slice();
    }

    console.log('[REFRESH] will append', visibleWindows.length, 'buttons. sidebarCollapsed=', sidebarCollapsed);
    visibleWindows.forEach((win) => {
        const winId = String(win.id || win.windowId || win.title);
        const isActive = currentWinId && winId === currentWinId;
        const icon = win.icon || 'fa-table';
        const hasRels = (win.relations && win.relations.length > 0) ? '<i class="fas fa-link text-[10px] text-violet-400 ml-1"></i>' : '';

        const btn = document.createElement('button');
        btn.dataset.windowId = winId;

        if (sidebarCollapsed) {
            // Collapsed: small icon only, beautiful and clear active state
            btn.className = `w-9 h-9 mx-auto mb-1 flex items-center justify-center rounded-lg transition-all text-lg ${isActive 
                ? 'bg-blue-600 text-white shadow-sm ring-1 ring-blue-400' 
                : 'hover:bg-slate-700 text-blue-400 hover:text-blue-300'}`;
            btn.innerHTML = `<i class="fas ${icon}"></i>`;
            btn.title = win.title + (hasRels ? ' (связанные)' : '');
            btn.onclick = () => {
                // loadWindow + refreshWindowList will set the correct active highlight dynamically
                (window.loadWindow || loadWindow || function(w){ console.error('loadWindow not ready'); })(win);
            };
        } else {
            // Full: normal with text
            btn.className = `w-full text-left px-4 py-2.5 flex items-center gap-3 text-sm transition-colors hover:bg-slate-700 rounded-lg ${isActive ? 'bg-slate-700' : ''}`;
            btn.innerHTML = '<i class="fas ' + icon + ' text-blue-400"></i><span class="font-medium">' + win.title + '</span>' + hasRels;
            btn.onclick = () => {
                // loadWindow + refreshWindowList handles active highlight + title update (dynamic on window choice)
                (window.loadWindow || loadWindow || function(w){ console.error('loadWindow not ready'); })(win);
            };
        }

        list.appendChild(btn);
    });
    console.log('[REFRESH] appended', list.children.length, 'children to #window-list');

    // Admin button (always full text or icon based on collapsed)
    if (isAdmin) {
        const adminBtn = document.createElement('button');
        adminBtn.dataset.role = 'admin';
        if (sidebarCollapsed) {
            adminBtn.className = `w-9 h-9 mx-auto mt-3 flex items-center justify-center rounded-lg transition-all text-lg text-amber-400 hover:bg-slate-700 hover:text-amber-300`;
            adminBtn.innerHTML = `<i class="fas fa-cog"></i>`;
            adminBtn.title = 'Администрирование';
        } else {
            adminBtn.className = 'w-full text-left px-4 py-2.5 flex items-center gap-3 text-sm mt-2 border-t border-slate-700 pt-2 text-amber-400 hover:text-amber-300 hover:bg-slate-700 rounded-lg';
            adminBtn.innerHTML = '<i class="fas fa-cog text-yellow-400"></i><span class="font-medium text-yellow-400">Администрирование</span>';
        }
        adminBtn.onclick = () => {
            document.querySelectorAll('#window-list button').forEach(b => b.classList.remove('bg-slate-700', 'bg-blue-600', 'ring-1', 'ring-blue-400'));
            if (!sidebarCollapsed) adminBtn.classList.add('bg-slate-700');
            if (window.openAdminWindow) window.openAdminWindow();
        };
        list.appendChild(adminBtn);
    }

    if (list.children.length === 0 && fullConfig.windows && fullConfig.windows.length > 0) {
      console.warn('[REFRESH] list still empty after forces, something wrong with DOM or buttons');
    }
}

function renderInsertFieldsList() {
    // No longer rendered separately - only master list is used
    if (typeof renderUnifiedFieldsList === 'function') renderUnifiedFieldsList();
}

function renderUpdateFieldsList() {
    // Deprecated - only master list is used now
    if (typeof renderUnifiedFieldsList === 'function') renderUnifiedFieldsList();
}

function addFieldToInsert() {
    // Redirect to unified master to avoid duplication
    addMasterFieldAndOpenEditor();
}

function addFieldToUpdate() {
    // Redirect to unified master to avoid duplication
    addMasterFieldAndOpenEditor();
}

function editInsertField(index) {
    const field = currentWindowConfig.insert.fields[index];
    const allFields = currentWindowConfig.insert.fields || [];
    openFieldEditor(field, (updated) => {
        currentWindowConfig.insert.fields[index] = updated;
        // Синхронизируем общие свойства с UPDATE (если поле с таким именем есть)
        syncFieldToOtherList(updated, 'update');
        renderInsertFieldsList();
        renderUpdateFieldsList();
    }, allFields);
}

function editUpdateField(index) {
    const field = currentWindowConfig.update.fields[index];
    const allFields = currentWindowConfig.update.fields || [];
    openFieldEditor(field, (updated) => {
        currentWindowConfig.update.fields[index] = updated;
        // Синхронизируем общие свойства с INSERT
        syncFieldToOtherList(updated, 'insert');
        renderUpdateFieldsList();
        renderInsertFieldsList();
    }, allFields);
}

function syncFieldToOtherList(updatedField, targetList) {
  const target = targetList === 'insert' ? currentWindowConfig.insert : currentWindowConfig.update;
  if (!target || !target.fields) return;
  const idx = target.fields.findIndex(f => f.field === updatedField.field);
  if (idx >= 0) {
    const existing = target.fields[idx];
    // Копируем всё, кроме специфичных для update
    Object.keys(updatedField).forEach(key => {
      if (true) { // readonlyInUpdate removed
        existing[key] = updatedField[key];
      }
    });
  }
}

async function deleteInsertField(index) {
    if (await customConfirm('Удалить поле из INSERT?')) {
        currentWindowConfig.insert.fields.splice(index, 1);
        renderInsertFieldsList();
    }
}

function moveInsertFieldUp(index) {
    const fields = currentWindowConfig.insert.fields;
    if (index <= 0 || !fields) return;
    [fields[index - 1], fields[index]] = [fields[index], fields[index - 1]];
    renderInsertFieldsList();
}

function moveInsertFieldDown(index) {
    const fields = currentWindowConfig.insert.fields;
    if (!fields || index >= fields.length - 1) return;
    [fields[index], fields[index + 1]] = [fields[index + 1], fields[index]];
    renderInsertFieldsList();
}

function moveUpdateFieldUp(index) {
    const fields = currentWindowConfig.update.fields;
    if (index <= 0 || !fields) return;
    [fields[index - 1], fields[index]] = [fields[index], fields[index - 1]];
    renderUpdateFieldsList();
}

function moveUpdateFieldDown(index) {
    const fields = currentWindowConfig.update.fields;
    if (!fields || index >= fields.length - 1) return;
    [fields[index], fields[index + 1]] = [fields[index + 1], fields[index]];
    renderUpdateFieldsList();
}

async function deleteUpdateField(index) {
    if (await customConfirm('Удалить поле из UPDATE?')) {
        currentWindowConfig.update.fields.splice(index, 1);
        renderUpdateFieldsList();
    }
}

// ==================== SUPER POWERFUL PER-FIELD EDITOR ====================
// Dropdown driven: choose feature → show its configuration UI
// Supports: advanced validations, linked/cascading columns (user's Armenia→Cities request),
// conditional visibility, auto values, rich lookups, cross-field etc.
async function openFieldEditor(field, onSave, siblingFields = []) {
    // Ensure arrays exist
    if (!field.validations) field.validations = [];
    if (!field.transforms) field.transforms = [];
    if (!field.conditionalDefaults) field.conditionalDefaults = [];
    if (!field.conditional) field.conditional = null;

    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 bg-black/85 flex items-center justify-center z-[999] p-4';
    
    // Build dependsOn options
    const otherFields = (siblingFields || []).filter(f => f.field && f.field !== field.field);
    const dependsOptions = ['<option value="">— нет зависимости —</option>'].concat(
        otherFields.map(f => `<option value="${f.field}" ${field.dependsOn === f.field ? 'selected' : ''}>${f.title || f.field}</option>`)
    ).join('');

    // Current simple badges summary
    const currentSummary = `
        <div class="flex flex-wrap gap-1 text-[10px] mb-2">
            ${field.type ? `<span class="px-1.5 py-0.5 bg-slate-700 rounded">type:${field.type}</span>` : ''}
            ${field.defaultValue ? `<span class="px-1.5 py-0.5 bg-slate-600 rounded">def:${String(field.defaultValue).slice(0,10)}</span>` : ''}
            ${(field.width || field.height) ? `<span class="px-1.5 py-0.5 bg-teal-700 rounded">size:${field.width||''}${field.height?'x'+field.height:''}</span>` : ''}
            ${field.transforms && field.transforms.length ? `<span class="px-1.5 py-0.5 bg-emerald-700 rounded">trans:${field.transforms.length}</span>` : ''}
            ${field.conditionalDefaults && field.conditionalDefaults.length ? `<span class="px-1.5 py-0.5 bg-teal-600 rounded">cdef:${field.conditionalDefaults.length}</span>` : ''}
            ${field.searchable && field.type === 'select' ? `<span class="px-1.5 py-0.5 bg-blue-700 rounded">searchable</span>` : ''}
            ${field.dependsOn ? `<span class="px-1.5 py-0.5 bg-amber-700 rounded">dependsOn:${field.dependsOn}</span>` : ''}
            ${field.lookupQuery || field.lookupWindow ? `<span class="px-1.5 py-0.5 bg-blue-700 rounded">has lookupQuery</span>` : ''}
            ${field.conditional ? `<span class="px-1.5 py-0.5 bg-violet-700 rounded">conditional</span>` : ''}
            ${ (field.autoValue || field.systemVariable) ? `<span class="px-1.5 py-0.5 bg-purple-700 rounded">auto</span>` : ''}
            ${field.validations && field.validations.length ? `<span class="px-1.5 py-0.5 bg-red-800 rounded">rules:${field.validations.length}</span>` : ''}
            ${field.disabled ? `<span class="px-1.5 py-0.5 bg-gray-700 rounded">disabled</span>` : ''}
            ${field.readonly ? `<span class="px-1.5 py-0.5 bg-blue-700 rounded">readonly</span>` : ''}
            ${field.hiddenInForm ? `<span class="px-1.5 py-0.5 bg-red-700 rounded">hidden</span>` : ''}
        </div>`;

    modal.innerHTML = `
      <div class="bg-slate-800 border border-slate-600 rounded-2xl w-full max-w-3xl shadow-xl overflow-hidden">
        <!-- Header -->
        <div class="px-5 py-3 bg-slate-900 flex items-center justify-between border-b border-slate-700">
          <div>
            <span class="text-lg font-semibold">Настройка колонки</span>
            <span class="ml-2 px-2 py-0.5 text-xs bg-emerald-900 rounded font-mono">${field.field}</span>
          </div>
          <div class="flex items-center gap-2">
            <button onclick="showAdminGuide()" class="text-sm px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded text-slate-300" title="Открыть полный User Guide"><i class="fas fa-question-circle"></i> Гайд</button>
            <button id="fe-close-x" class="text-3xl leading-none px-2 text-slate-400 hover:text-white">×</button>
          </div>
        </div>

        <div class="p-3 max-h-[78vh] overflow-auto custom-scroll space-y-2 text-xs">

          ${currentSummary}

          <!-- ОСНОВНЫЕ НАСТРОЙКИ -->
          <div class="border border-slate-700 rounded-xl p-3 bg-slate-950/60">
            <div class="text-emerald-400 text-[10px] font-semibold mb-2 flex items-center gap-1.5">
              <i class="fas fa-info-circle"></i> ОСНОВНЫЕ НАСТРОЙКИ ПОЛЯ
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3">
              <!-- Название -->
              <div>
                <label class="block text-[10px] text-slate-400 mb-0.5">Отображаемое название</label>
                <input id="fe-title" value="${(field.title || field.field).replace(/"/g,'&quot;')}" class="w-full bg-slate-900 border border-slate-600 px-3 py-1 rounded-lg text-sm">
              </div>

              <!-- Тип -->
              <div>
                <label class="block text-[10px] text-slate-400 mb-0.5">Тип поля</label>
                <select id="fe-type" class="w-full bg-slate-900 border border-slate-600 px-3 py-1 rounded-lg text-sm">
                  <option value="text">text (обычное)</option>
                  <option value="textarea">textarea</option>
                  <option value="number">number</option>
                  <option value="date">date</option>
                  <option value="checkbox">checkbox (отмечен → дата если checkedValue=date, иначе пусто)</option>
                  <option value="select">select — обычный выпадающий список</option>
                  <option value="lookup">lookup — поле ввода + выпадающий список С ПОИСКОМ И ПРОКРУТКОЙ (рекомендуется)</option>
                </select>
              </div>

              <!-- Поисковый -->
              <div class="md:col-span-2">
                <label class="flex items-center gap-2 text-[10px] text-slate-400 mb-0.5 cursor-pointer">
                  <input id="fe-searchable" type="checkbox" ${field.searchable ? 'checked' : ''} class="accent-blue-500">
                  <span>Сделать поисковым (вместо обычного выпадающего списка — ввод с фильтрацией)</span>
                </label>
              </div>

              <!-- Значение по умолчанию -->
              <div class="md:col-span-2">
                <label class="block text-[10px] text-slate-400 mb-0.5">Значение по умолчанию (статическое)</label>
                <input id="fe-default" value="${field.defaultValue || ''}" class="w-full bg-slate-900 border border-slate-600 px-3 py-1 rounded-lg text-sm">
                <div class="text-[9px] text-slate-500 mt-0.5">
                  Простое значение при создании. Для динамики используй раздел <b class="text-purple-400">System / Auto</b> ниже. Для lookup не используй здесь.
                </div>
              </div>

              <!-- Checkbox special: checked = date, unchecked = empty -->
              <div id="fe-checkbox-special" class="md:col-span-2" style="display: none;">
                <div>
                  <label class="block text-[10px] text-slate-400 mb-0.5">Значение когда отмечен (checkedValue)</label>
                  <input id="fe-checked-val" value="${field.checkedValue || ''}" placeholder="Y или date / NOW / sql:..." class="w-full bg-slate-900 border border-slate-600 px-3 py-1 rounded-lg text-sm">
                  <div class="text-[8px] text-slate-500">Можно использовать системные переменные (NOW, CURRENT_USER, sql:SELECT...) или "date"</div>
                </div>
                <div>
                  <label class="block text-[10px] text-slate-400 mb-0.5">Значение когда не отмечен (uncheckedValue)</label>
                  <input id="fe-unchecked-val" value="${field.uncheckedValue || ''}" placeholder="пусто" class="w-full bg-slate-900 border border-slate-600 px-3 py-1 rounded-lg text-sm">
                  <div class="text-[8px] text-slate-500">Можно использовать системные переменные</div>
                </div>
              </div>

              <!-- Размер -->
              <div class="md:col-span-2">
                <label class="block text-[10px] text-slate-400 mb-0.5">Размер в форме</label>
                <div class="flex gap-2">
                  <select id="fe-size-mode" class="flex-1 bg-slate-900 border border-slate-600 px-3 py-1 rounded-lg text-sm">
                    <option value="">По умолчанию (половина)</option>
                    <option value="full" ${(field.width === 'full') ? 'selected' : ''}>Полная ширина</option>
                    <option value="custom" ${(field.width && field.width !== 'full') ? 'selected' : ''}>Кастомный размер</option>
                  </select>
                </div>
                <div id="fe-custom-size" class="mt-2 grid grid-cols-2 gap-2" style="display: none;">
                  <div>
                    <label class="text-[9px] text-slate-400">Ширина</label>
                    <input id="fe-custom-width" value="${(field.width && field.width !== 'full') ? field.width : ''}" placeholder="300px / 50%" class="w-full bg-slate-900 border border-slate-600 px-2 py-1 text-xs rounded">
                  </div>
                  <div>
                    <label class="text-[9px] text-slate-400">Высота</label>
                    <input id="fe-custom-height" value="${field.height || ''}" placeholder="40px / auto" class="w-full bg-slate-900 border border-slate-600 px-2 py-1 text-xs rounded">
                  </div>
                </div>
                <div class="text-[8px] text-slate-500 mt-0.5">Кастомный размер применяется к полю в формах Insert/Update.</div>
              </div>
            </div>
          </div>

          <!-- ФЛАГИ -->
          <div class="border border-slate-700 rounded-xl p-3 bg-slate-950/60">
            <div class="text-emerald-400 text-[10px] font-semibold mb-1.5 flex items-center gap-1.5">
              <i class="fas fa-flag"></i> ФЛАГИ
            </div>
            <div class="flex flex-wrap gap-2">
              <label class="flex items-center gap-2 text-xs cursor-pointer bg-slate-900 border border-slate-700 px-3 py-1 rounded-lg hover:border-emerald-600">
                <input id="fe-required" type="checkbox" ${field.required ? 'checked':''} class="accent-emerald-500 w-3.5 h-3.5">
                <span>Обязательное</span>
              </label>
              <label class="flex items-center gap-2 text-xs cursor-pointer bg-slate-900 border border-slate-700 px-3 py-1 rounded-lg hover:border-emerald-600">
                <input id="fe-hidden" type="checkbox" ${field.hiddenInForm ? 'checked':''} class="accent-emerald-500 w-3.5 h-3.5">
                <span>Скрытое</span>
              </label>
              <label class="flex items-center gap-2 text-xs cursor-pointer bg-slate-900 border border-slate-700 px-3 py-1 rounded-lg hover:border-emerald-600">
                <input id="fe-disabled" type="checkbox" ${field.disabled ? 'checked':''} class="accent-emerald-500 w-3.5 h-3.5">
                <span>Disabled (нельзя менять)</span>
              </label>
              <label class="flex items-center gap-2 text-xs cursor-pointer bg-slate-900 border border-slate-700 px-3 py-1 rounded-lg hover:border-emerald-600">
                <input id="fe-readonly" type="checkbox" ${field.readonly ? 'checked':''} class="accent-emerald-500 w-3.5 h-3.5">
                <span>Readonly (нельзя редактировать)</span>
              </label>
            </div>
          </div>

          <!-- LOOKUP SOURCE + DEPENDS - this is the "Связанные / Зависимые колонки" section -->
          <div id="fe-lookup-source-block" class="border border-blue-700 rounded-2xl p-3 bg-slate-900/60">
            <div class="font-semibold text-blue-400 mb-1 flex items-center gap-2">
              <i class="fas fa-database"></i> Источник данных + Зависимости (Связанные / Зависимые колонки)
            </div>
            <div class="text-[9px] text-slate-400 mb-2 leading-tight">
              <b>3 режима для списков / автоподстановки:</b><br>
              • <b>Авто одно значение (без списка)</b> — System/Auto (фиолетовый) + SQL/CONSTANT<br>
              • <b>Выпадающий с поиском + скролл из базы</b> — выбери "SQL запрос"<br>
              • <b>Ручной выпадающий список (без базы, свои варианты)</b> — выбери "Ручной список" и перечисли варианты<br>
              Выбери <b>lookup</b> (а не select) чтобы был красивый поиск + скролл.<br>
              <b>Условный источник (conditional):</b> dependsOn + в "Условный" можно задать основной SQL + особые случаи (если значение = "Երևан" → другой SELECT).
            </div>
            
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label class="text-xs text-slate-400">Зависит от поля (dependsOn)</label>
                <div class="text-[8px] text-amber-300 -mt-0.5 mb-0.5">Оставь пустым для простого lookup. Заполни только если список зависит от другого поля.</div>
                <select id="fe-dependsOn" class="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5">${dependsOptions}</select>
              </div>
              <div>
                <label class="text-xs text-slate-400">Тип источника данных</label>
                <select id="fe-lookup-type" class="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5">
                  <option value="">— без списка —</option>
                  <option value="static" ${ (field.options && field.options.length) ? 'selected' : '' }>Ручной список (несколько вариантов вручную, без БД)</option>
                  <option value="query" ${ (field.lookupQuery) ? 'selected' : '' }>SQL запрос (список из базы)</option>
                  <option value="window" ${ (field.lookupWindow) ? 'selected' : '' }>Другое окно (таблица)</option>
                  <option value="conditional" ${ (field.lookupQuery && field.dependsOn) ? 'selected' : '' }>Условный (cascading + разные запросы по значению, напр. если Город=Երևан)</option>
                </select>
              </div>
            </div>

            <div id="fe-lookup-config" class="mt-2 space-y-2"></div>
            <div class="text-[9px] text-blue-300 mt-1">Простой пример: SELECT DISTINCT mcc as value, mcc as display FROM MERCHANTS  (оставь dependsOn пустым)</div>
            <div class="text-[9px] text-amber-400 mt-1">⚠ Для автоподстановки <b>одного</b> значения без выбора — используй <b>System/Auto → SQL</b> (фиолетовый). Для списка вариантов (с поиском) — здесь.</div>
          </div>

          <!-- ADD ADVANCED FEATURE (dropdown driven as user asked) -->
          <div class="border border-amber-700/60 rounded-2xl p-3 bg-slate-900">
            <div class="mb-2">
              <div class="font-semibold text-amber-400 mb-1">Добавить правило / возможность</div>
              <div class="flex items-center gap-2">
                <select id="fe-feature-select" class="flex-1 bg-slate-800 border border-amber-600 text-amber-300 px-2 py-1.5 rounded text-sm">
                  <option value="">— выберите тип —</option>
                  <option value="validation">Валидация (проверка значения)</option>
                  <option value="conditional">Условная видимость / обязательность</option>
                  <option value="cross">Кросс-проверка (сравнить с другим полем)</option>
                  <option value="mask">Подсказка / Описание</option>
                  <option value="allowed">Разрешённые значения</option>
                  <option value="transform">Transform / Извлечь (первые N символов, split по разделителю — напр. 5411 из "5411 - магазин")</option>
                  <option value="cond_default">Conditional default (если поле X = val → установить default Y)</option>
                </select>
                <button id="fe-add-feature" class="px-4 py-1.5 bg-amber-700 hover:bg-amber-600 text-sm rounded-xl whitespace-nowrap">Добавить</button>
              </div>
              <div class="text-[10px] text-slate-400 mt-0.5">Выбери тип → заполни параметры → нажми Добавить</div>
            </div>
            <!-- Dynamic config area for the chosen feature -->
            <div id="fe-feature-config-area" class="min-h-[34px] text-xs"></div>

            <!-- Current validations + advanced rules list -->
            <div class="mt-3">
              <div class="text-xs text-slate-400 mb-1 flex items-center justify-between">
                <span>Активные правила</span>
                <span class="text-[9px]">(клик ✎ чтобы изменить)</span>
              </div>
              <div id="fe-rules-list" class="max-h-36 overflow-auto custom-scroll bg-black/30 p-1 rounded border border-slate-700 text-xs space-y-1"></div>
            </div>
          </div>

          <!-- SUPER System / Auto variable section -->
          <div class="border border-purple-600/60 bg-slate-900 rounded-2xl p-3">
            <div class="mb-1">
              <span class="font-semibold text-purple-400">System / Auto variable (динамические значения)</span>
            </div>
            <div class="text-[9px] text-slate-400 mb-2">
              Здесь настраиваются авто-заполнения при создании. <b>Простое статическое значение</b> ставь выше в «Значение по умолчанию». Здесь — для CURRENT_USER, UUID, SELECT MAX(...) и т.п.
            </div>
            <div class="flex items-center gap-2 mb-2">
              <span class="font-semibold text-purple-400">Выбери тип:</span>
              <select id="fe-auto-type" class="bg-slate-800 border border-purple-600 text-purple-300 px-2 py-1 text-xs rounded">
                <option value="">— не использовать —</option>
                <option value="CURRENT_USER">CURRENT_USER — логин текущего пользователя</option>
                <option value="CURRENT_USER_ID">CURRENT_USER_ID — ID пользователя</option>
                <option value="NOW">NOW — текущая дата и время</option>
                <option value="TODAY">TODAY — только текущая дата</option>
                <option value="NOW_ISO">NOW_ISO — дата в формате ISO</option>
                <option value="TIMESTAMP">TIMESTAMP — unix timestamp (секунды)</option>
                <option value="UNIX_MILLIS">UNIX_MILLIS — unix время в миллисекундах</option>
                <option value="UUID">UUID — уникальный идентификатор v4</option>
                <option value="SHORT_ID">SHORT_ID — короткий ID (8 символов)</option>
                <option value="RANDOM_STRING">RANDOM_STRING — случайная строка</option>
                <option value="RANDOM_INT">RANDOM_INT — случайное целое число</option>
                <option value="RANDOM_FLOAT">RANDOM_FLOAT — случайное дробное число</option>
                <option value="YEAR">YEAR — текущий год</option>
                <option value="MONTH">MONTH — текущий месяц (01-12)</option>
                <option value="DAY">DAY — текущий день месяца</option>
                <option value="COPY">COPY — копировать значение из другой колонки</option>
                <option value="CONSTANT">CONSTANT — фиксированное значение</option>
                <option value="SQL">SQL Query — динамический (например SELECT MAX(TID)+1 FROM ...)</option>
                <option value="CUSTOM">CUSTOM — произвольное значение</option>
              </select>
            </div>
            <div id="fe-auto-config" class="text-xs"></div>
            <!-- legacy input kept for compatibility but hidden in favor of dropdown -->
            <input id="fe-sys" type="hidden" value="${field.systemVariable || ''}">
          </div>

          <div class="grid grid-cols-2 gap-3 text-xs mt-1">
            <div>
              <label class="block text-slate-400">Placeholder / Подсказка</label>
              <input id="fe-placeholder" value="${field.placeholder || ''}" class="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1">
            </div>
            <div>
              <label class="block text-slate-400">Help / Описание поля</label>
              <input id="fe-help" value="${field.help || ''}" class="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1">
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="px-5 py-3 bg-slate-900 border-t border-slate-700 flex justify-between">
          <div class="text-[10px] text-slate-500 self-center">Изменения применятся после «Сохранить» в админке</div>
          <div class="flex gap-2">
            <button id="fe-cancel" class="px-5 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-2xl text-sm">Отмена</button>
            <button id="fe-save" class="px-6 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded-2xl text-sm font-semibold">Сохранить поле</button>
          </div>
        </div>
      </div>`;

    document.body.appendChild(modal);

    // Extract key elements early for visibility connection between Тип поля and source
    const typeSel = modal.querySelector('#fe-type');
    const lookupSourceBlock = modal.querySelector('#fe-lookup-source-block');

    // Helper: render the dynamic lookup config area
    const lookupConfigContainer = modal.querySelector('#fe-lookup-config');
    function renderLookupConfig() {
      const type = modal.querySelector('#fe-lookup-type').value;
      let html = '';
      if (type === 'static') {
        // Ручной список вариантов (без обращения к базе)
        const staticText = Array.isArray(field.options) 
          ? field.options.map(o => (typeof o === 'string' ? o : (o.value && o.display ? o.value + '|' + o.display : o.value || ''))).join('\n')
          : (field.options || '');
        html = `
          <div>
            <label class="text-xs text-blue-300 font-semibold">Ручные варианты (по одному на строке)</label>
            <textarea id="fe-static-options" class="w-full font-mono text-xs bg-slate-950 border border-blue-800 h-20 rounded p-2" placeholder="Вариант1&#10;5411|Магазин&#10;5412|Супермаркет&#10;или просто одно слово на строке">${staticText}</textarea>
            <div class="text-[9px] text-slate-400 mt-0.5">Формат: <b>значение</b> или <b>значение|отображаемый текст</b>. Будет красивый выпадающий список с поиском и прокруткой.</div>
          </div>`;
      } else if (type === 'query' || type === 'conditional') {
        const conds = Array.isArray(field.lookupConditions) ? field.lookupConditions : [];
        let condHtml = conds.map((c, i) => `
          <div class="flex gap-2 items-start border border-blue-800 p-1 rounded mb-1">
            <div class="flex-1">
              <input class="fe-cond-val w-full text-xs bg-slate-900 border px-1 py-0.5 rounded" value="${c.value || ''}" placeholder="Значение dependsOn (напр. Երևան)">
              <textarea class="fe-cond-query w-full font-mono text-xs bg-slate-950 border h-10 rounded p-1 mt-1" placeholder="SELECT ... FROM ...">${c.query || ''}</textarea>
            </div>
            <button type="button" class="text-red-400 text-xs px-1" onclick="this.closest('.flex').remove()">×</button>
          </div>`).join('');

        html = `
          <div>
            <label class="text-xs text-blue-300">Основной SQL (для всех значений dependsOn, используйте ? )</label>
            <textarea id="fe-lookup-query" class="w-full font-mono text-xs bg-slate-950 border border-blue-800 h-12 rounded p-2">${field.lookupQuery || 'SELECT DISTINCT value_col as value, display_col as display FROM table_name WHERE parent = ?'}</textarea>
            <div class="text-[9px] text-slate-400">Обычный cascading: WHERE xxx = ? <br>Можно один запрос с CASE WHEN ? = 'Երևան' ... или UNION ALL для разных таблиц (код автоматически повторит параметр).</div>
          </div>
          <div class="mt-2">
            <div class="flex justify-between items-center mb-1">
              <label class="text-xs text-amber-300">Условные запросы (если dependsOn == значение)</label>
              <button type="button" id="fe-add-cond" class="text-[10px] bg-amber-700 px-2 py-0.5 rounded">+ Добавить условие</button>
            </div>
            <div id="fe-cond-list">${condHtml || '<div class="text-[10px] text-slate-500">Например: значение=Երևան → запрос из DISTRICTS'}</div>
          </div>
          <div class="grid grid-cols-2 gap-2 mt-1">
            <div><label class="text-xs">Value field</label><input id="fe-lookup-val" value="${field.lookupValueField || ''}" class="w-full text-xs bg-slate-900 border px-2 py-1 rounded" placeholder="name или id"></div>
            <div><label class="text-xs">Display field</label><input id="fe-lookup-disp" value="${field.lookupDisplayField || ''}" class="w-full text-xs bg-slate-900 border px-2 py-1 rounded" placeholder="display или то же"></div>
          </div>`;
      } else if (type === 'window') {
        html = `
          <div>
            <label class="text-xs text-blue-300">ID окна для lookup</label>
            <input id="fe-lookup-win" value="${field.lookupWindow || ''}" class="w-full bg-slate-900 border px-2 py-1 rounded text-xs">
            <div class="text-[9px]">Будет использован query из того окна. Можно указать dependsOn для фильтра.</div>
          </div>`;
      }
      lookupConfigContainer.innerHTML = html;
    }

    modal.querySelector('#fe-lookup-type').onchange = renderLookupConfig;

    // When dependsOn changes, suggest "conditional" type for cascading
    const dependsSel = modal.querySelector('#fe-dependsOn');
    if (dependsSel) {
      dependsSel.onchange = () => {
        const ltype = modal.querySelector('#fe-lookup-type');
        if (ltype && dependsSel.value && ltype.value === '') {
          ltype.value = 'conditional';
        }
        if (typeof renderLookupConfig === 'function') renderLookupConfig();
      };
    }

    renderLookupConfig();   // initial

    // Handle dynamic "add condition" for conditional lookups (Yerevan special case etc.)
    const attachCondAdd = () => {
      const addBtn = modal.querySelector('#fe-add-cond');
      const list = modal.querySelector('#fe-cond-list');
      if (addBtn && list) {
        addBtn.onclick = () => {
          const div = document.createElement('div');
          div.className = 'flex gap-2 items-start border border-blue-800 p-1 rounded mb-1';
          div.innerHTML = `
            <div class="flex-1">
              <input class="fe-cond-val w-full text-xs bg-slate-900 border px-1 py-0.5 rounded" placeholder="Значение (напр. Երևան)">
              <textarea class="fe-cond-query w-full font-mono text-xs bg-slate-950 border h-10 rounded p-1 mt-1" placeholder="SELECT DistrictName as value ... FROM DISTRICTS"></textarea>
            </div>
            <button type="button" class="text-red-400 text-xs px-1" onclick="this.closest('.flex').remove()">×</button>
          `;
          list.appendChild(div);
        };
      }
    };
    setTimeout(attachCondAdd, 50);

    // === CONNECTION between "Тип поля" (top) and lookup source block (clear link) ===
    function updateLookupSourceVisibility() {
      const t = typeSel ? typeSel.value : '';
      const needsSource = (t === 'select' || t === 'lookup');
      
      if (lookupSourceBlock) {
        lookupSourceBlock.style.display = needsSource ? '' : 'none';
        
        if (needsSource) {
          // Auto-select SQL query as source if nothing chosen yet (helps users)
          const srcType = modal.querySelector('#fe-lookup-type');
          if (srcType && !srcType.value) {
            srcType.value = 'query';
            if (typeof renderLookupConfig === 'function') renderLookupConfig();
          }
        }
      }
    }

    // Checkbox special fields visibility - only for checkbox type
    const checkboxSpecialWrap = modal.querySelector('#fe-checkbox-special');
    function updateCheckboxSpecialVisibility() {
      if (checkboxSpecialWrap && typeSel) {
        const t = typeSel.value;
        checkboxSpecialWrap.style.display = (t === 'checkbox') ? 'block' : 'none';
      }
    }

    if (typeSel) {
      typeSel.onchange = () => {
        updateLookupSourceVisibility();
        updateCheckboxSpecialVisibility();
      };
      // initial sync
      updateLookupSourceVisibility();
      setTimeout(updateCheckboxSpecialVisibility, 0);
    }

    // Searchable checkbox visibility (only for classic select)
    const searchableWrap = modal.querySelector('#fe-searchable') ? modal.querySelector('#fe-searchable').closest('div') : null;
    function updateSearchableVisibility() {
      if (searchableWrap && typeSel) {
        const t = typeSel.value;
        searchableWrap.style.display = (t === 'select') ? '' : 'none';
      }
    }
    if (typeSel) {
      const origOnchange = typeSel.onchange;
      typeSel.onchange = () => {
        if (origOnchange) origOnchange();
        updateSearchableVisibility();
      };
      updateSearchableVisibility();
    }

    // Custom size inputs visibility
    const customSizeDiv = modal.querySelector('#fe-custom-size');
    const sizeModeSel = modal.querySelector('#fe-size-mode');
    function updateCustomSizeVisibility() {
      if (customSizeDiv && sizeModeSel) {
        customSizeDiv.style.display = (sizeModeSel.value === 'custom') ? 'grid' : 'none';
      }
    }
    if (sizeModeSel) {
      sizeModeSel.onchange = updateCustomSizeVisibility;
      // initial - also after value is set from template
      setTimeout(updateCustomSizeVisibility, 10);
      setTimeout(() => { if (typeof updateCheckboxSpecialVisibility === 'function') updateCheckboxSpecialVisibility(); }, 10);
    }

    // ==================== System / Auto variable - SUPER dropdown logic ====================
    const autoTypeSel = modal.querySelector('#fe-auto-type');
    const autoConfig = modal.querySelector('#fe-auto-config');
    const hiddenSys = modal.querySelector('#fe-sys');

    function renderAutoConfig() {
      const t = autoTypeSel.value;
      let html = '';

      if (!t) {
        autoConfig.innerHTML = `<div class="text-[10px] text-slate-400">Выберите тип авто-значения (динамическое).<br>Простое статическое значение — используй поле «Значение по умолчанию» выше.</div>`;
        hiddenSys.value = '';
        return;
      }

      // Always show example first
      let example = '';
      let configHtml = '';

      switch (t) {
        case 'CURRENT_USER':
          example = 'admin';
          break;
        case 'CURRENT_USER_ID':
          example = '42';
          break;
        case 'NOW':
          example = '2026-06-19 14:35:22';
          configHtml = `<div class="mt-1"><label class="text-xs text-purple-300">Формат (опционально):</label> <input id="fe-auto-format" value="${field.autoValue?.format || ''}" placeholder="YYYY-MM-DD HH:mm:ss" class="bg-slate-800 border border-purple-600 rounded px-2 py-0.5 text-xs"></div>`;
          break;
        case 'TODAY':
          example = '2026-06-19';
          configHtml = `<div class="mt-1"><label class="text-xs text-purple-300">Формат:</label> <input id="fe-auto-format" value="${field.autoValue?.format || ''}" placeholder="YYYY-MM-DD" class="bg-slate-800 border border-purple-600 rounded px-2 py-0.5 text-xs"></div>`;
          break;
        case 'NOW_ISO':
          example = '2026-06-19T14:35:22.123Z';
          break;
        case 'TIMESTAMP':
          example = '1750341322';
          break;
        case 'UNIX_MILLIS':
          example = '1750341322123';
          break;
        case 'UUID':
          example = '550e8400-e29b-41d4-a716-446655440000';
          break;
        case 'SHORT_ID':
          example = 'a1b2c3d4';
          break;
        case 'RANDOM_STRING':
          example = 'k7m9p2xq';
          break;
        case 'RANDOM_INT':
          const min = field.autoValue?.min || '100000';
          const max = field.autoValue?.max || '999999';
          example = '743821';
          configHtml = `
            <div class="flex gap-2 mt-1">
              <div><label class="text-xs text-purple-300">Min:</label><input id="fe-auto-min" value="${min}" class="w-20 bg-slate-800 border border-purple-600 rounded px-1 py-0.5 text-xs"></div>
              <div><label class="text-xs text-purple-300">Max:</label><input id="fe-auto-max" value="${max}" class="w-20 bg-slate-800 border border-purple-600 rounded px-1 py-0.5 text-xs"></div>
            </div>`;
          break;
        case 'RANDOM_FLOAT':
          example = '0.7342';
          configHtml = `
            <div class="flex gap-2 mt-1">
              <div><label class="text-xs text-purple-300">Min:</label><input id="fe-auto-min" value="${field.autoValue?.min || '0'}" class="w-16 bg-slate-800 border border-purple-600 rounded px-1 py-0.5 text-xs"></div>
              <div><label class="text-xs text-purple-300">Max:</label><input id="fe-auto-max" value="${field.autoValue?.max || '1'}" class="w-16 bg-slate-800 border border-purple-600 rounded px-1 py-0.5 text-xs"></div>
            </div>`;
          break;
        case 'YEAR':
          example = '2026';
          break;
        case 'MONTH':
          example = '06';
          break;
        case 'DAY':
          example = '19';
          break;
        case 'COPY':
          const src = (field.autoValue && field.autoValue.source) || '';
          example = '[значение из выбранной колонки]';
          configHtml = `
            <div class="mt-1">
              <span class="text-purple-300">Копировать из:</span>
              <select id="fe-auto-copy-from" class="bg-slate-800 border border-purple-600 rounded px-2 py-0.5">
                ${otherFields.map(f => `<option value="${f.field}" ${src === f.field ? 'selected' : ''}>${f.title || f.field}</option>`).join('')}
              </select>
            </div>`;
          break;
        case 'CONSTANT':
          const cval = (field.autoValue && field.autoValue.value) || field.defaultValue || '';
          example = cval || 'MY_FIXED_VALUE';
          configHtml = `<input id="fe-auto-constant" value="${cval}" placeholder="фиксированное значение" class="mt-1 w-full bg-slate-800 border border-purple-600 rounded px-2 py-0.5 text-xs">`;
          break;
        case 'SQL':
          const qval = (field.autoValue && field.autoValue.query) || '';
          example = 'SELECT MAX(TID)+1 FROM MERCHANTS';
          configHtml = `<textarea id="fe-auto-sql" class="mt-1 w-full font-mono bg-slate-800 border border-purple-600 rounded px-2 py-0.5 text-xs h-12" placeholder="SELECT MAX(TID)+1 FROM MERCHANTS">${qval}</textarea>`;
          break;
        case 'CUSTOM':
          example = 'любое значение или sql:...';
          configHtml = `<input id="fe-auto-custom" value="${(field.autoValue && field.autoValue.value) || ''}" placeholder="my_value или sql:SELECT ..." class="mt-1 w-full bg-slate-800 border border-purple-600 rounded px-2 py-0.5 text-xs">`;
          break;
        default:
          example = t;
      }

      html = `
        <div class="mb-2 p-2 bg-black/40 rounded border border-purple-700/50">
          <div class="text-[10px] text-purple-300">Пример для выбранного:</div>
          <div class="font-mono text-emerald-300 text-sm">${example}</div>
        </div>
        ${configHtml}
      `;

      autoConfig.innerHTML = html;
      hiddenSys.value = t;

      // re-attach preview listeners after new html is injected
      setTimeout(() => {
        const attach = (el) => { if (el) { el.onchange = el.oninput = updateAutoPreview; } };
        attach(modal.querySelector('#fe-auto-min'));
        attach(modal.querySelector('#fe-auto-max'));
        attach(modal.querySelector('#fe-auto-format'));
        attach(modal.querySelector('#fe-auto-copy-from'));
        attach(modal.querySelector('#fe-auto-constant'));
        attach(modal.querySelector('#fe-auto-custom'));
        attach(modal.querySelector('#fe-auto-sql'));
        updateAutoPreview();
      }, 5);
    }

    // Smart detection of existing value
    function detectInitialAutoType() {
      if (field.autoValue && field.autoValue.type) {
        const t = field.autoValue.type;
        if (['COPY', 'CONSTANT', 'CUSTOM'].includes(t)) return t;
        // map known ones
        return t;
      }
      const sys = field.systemVariable || '';
      const lower = sys.toString().toLowerCase();

      if (lower.includes('user') || lower === 'current_user') return 'CURRENT_USER';
      if (lower.includes('id') && lower.includes('user')) return 'CURRENT_USER_ID';
      if (lower === 'now' || lower.includes('datetime')) return 'NOW';
      if (lower === 'today' || lower.includes('date')) return 'TODAY';
      if (lower === 'timestamp') return 'TIMESTAMP';
      if (lower === 'uuid') return 'UUID';
      if (lower.includes('random')) return 'RANDOM_STRING';
      if (lower.includes('sql')) return 'SQL';
      if (sys) return 'CUSTOM';
      return '';
    }

    const initialAuto = detectInitialAutoType();
    autoTypeSel.value = initialAuto || '';

    autoTypeSel.onchange = () => {
      renderAutoConfig();
      hiddenSys.value = autoTypeSel.value;
      updateAutoPreview();
    };
    renderAutoConfig();

    // Preview for auto value (live)
    function updateAutoPreview() {
      const previewEl = modal.querySelector('#fe-auto-preview');
      if (!previewEl) return;
      const t = autoTypeSel.value;
      let val = '';
      if (!t) {
        previewEl.innerHTML = '';
        return;
      }
      try {
        if (t === 'COPY') {
          const src = modal.querySelector('#fe-auto-copy-from')?.value;
          val = src ? '[копия из ' + src + ']' : '[выберите колонку]';
        } else if (t === 'CONSTANT') {
          val = modal.querySelector('#fe-auto-constant')?.value || 'MY_VALUE';
        } else if (t === 'CUSTOM') {
          val = modal.querySelector('#fe-auto-custom')?.value || 'custom_value';
        } else if (t === 'SQL') {
          val = modal.querySelector('#fe-auto-sql')?.value || 'SELECT MAX(TID)+1 ...';
        } else if (t === 'RANDOM_INT') {
          const min = modal.querySelector('#fe-auto-min')?.value || '100000';
          const max = modal.querySelector('#fe-auto-max')?.value || '999999';
          val = Math.floor(Math.random() * (parseInt(max)-parseInt(min)+1) + parseInt(min));
        } else if (t === 'RANDOM_FLOAT') {
          const min = parseFloat(modal.querySelector('#fe-auto-min')?.value || '0');
          const max = parseFloat(modal.querySelector('#fe-auto-max')?.value || '1');
          val = (Math.random() * (max - min) + min).toFixed(4);
        } else {
          const tempField = { systemVariable: t, autoValue: { type: t } };
          val = getSystemValue(tempField) || t;
        }
      } catch(e) { val = t; }
      previewEl.innerHTML = `<span class="text-purple-400">Пример:</span> <span class="font-mono bg-black/40 px-1 rounded">${val}</span>`;
    }

    // Attach listeners for dynamic preview + new params
    setTimeout(() => {
      const attach = (sel) => { if (sel) sel.onchange = sel.oninput = updateAutoPreview; };

      attach(modal.querySelector('#fe-auto-copy-from'));
      attach(modal.querySelector('#fe-auto-constant'));
      attach(modal.querySelector('#fe-auto-custom'));
      attach(modal.querySelector('#fe-auto-min'));
      attach(modal.querySelector('#fe-auto-max'));
      attach(modal.querySelector('#fe-auto-format'));

      // initial preview container
      let previewContainer = modal.querySelector('#fe-auto-preview');
      if (!previewContainer) {
        previewContainer = document.createElement('div');
        previewContainer.id = 'fe-auto-preview';
        previewContainer.className = 'mt-1 text-xs p-1 bg-black/30 rounded';
        const cfg = modal.querySelector('#fe-auto-config');
        if (cfg) cfg.appendChild(previewContainer);
      }
      updateAutoPreview();
    }, 30);

    // After render, try to prefill dynamic inputs for COPY / CONSTANT if needed
    setTimeout(() => {
      const copySel = modal.querySelector('#fe-auto-copy-from');
      if (copySel && field.autoValue && field.autoValue.source) {
        copySel.value = field.autoValue.source;
      }
      const constInput = modal.querySelector('#fe-auto-constant');
      if (constInput && field.autoValue && field.autoValue.value) {
        constInput.value = field.autoValue.value;
      }
      const customInput = modal.querySelector('#fe-auto-custom');
      if (customInput && field.autoValue && field.autoValue.value) {
        customInput.value = field.autoValue.value;
      }
      const sqlInput = modal.querySelector('#fe-auto-sql');
      if (sqlInput && field.autoValue && field.autoValue.query) {
        sqlInput.value = field.autoValue.query;
      }
      updateAutoPreview();
    }, 30);

    // Set initial type value (typeSel declared early for visibility + connection)
    if (typeSel && field.type) typeSel.value = field.type;
    if (typeof updateLookupSourceVisibility === 'function') updateLookupSourceVisibility();
    if (typeof updateSearchableVisibility === 'function') updateSearchableVisibility();
    if (typeof updateCheckboxSpecialVisibility === 'function') updateCheckboxSpecialVisibility();

    // === RULES / FEATURES management ===
    const rulesList = modal.querySelector('#fe-rules-list');
    const featureSelect = modal.querySelector('#fe-feature-select');
    const featureArea = modal.querySelector('#fe-feature-config-area');

    function refreshRulesList() {
      rulesList.innerHTML = '';
      const rules = [];

      // validations
      (field.validations || []).forEach((v, idx) => {
        let langPart = '';
        if (v.language) {
          langPart = ' ' + getLanguageDisplayName(v.language);
        }
        let desc = `${v.type}${v.min !== undefined ? ' min:'+v.min : ''}${v.max !== undefined ? ' max:'+v.max : ''}${v.value ? ' val:'+v.value : ''}${langPart}${v.condition ? ' if:'+v.condition : ''}${v.fields ? ' fields:'+v.fields.join(',') : ''}${v.query ? ' q:'+v.query.substring(0,30) : ''}`;
        if (v.error) desc += ` [error: ${v.error}]`;
        const el = document.createElement('div');
        el.className = 'flex justify-between bg-slate-800 px-2 py-0.5 rounded items-center text-[11px]';
        el.innerHTML = `<span><span class="bg-red-900 text-red-200 px-1 rounded mr-1">${v.type}</span> ${desc}</span> <span class="flex gap-1"><button class="text-emerald-400 hover:text-emerald-300" data-type="val-edit" data-idx="${idx}">✎</button><button class="text-red-400 hover:text-red-500" data-type="val" data-idx="${idx}">×</button></span>`;
        rulesList.appendChild(el);
        el.querySelector('button[data-type="val"]').onclick = () => {
          field.validations.splice(idx, 1);
          refreshRulesList();
        };
        el.querySelector('button[data-type="val-edit"]').onclick = () => {
          editValidation(idx, refreshRulesList);
        };
      });

      // conditional
      if (field.conditional) {
        const el = document.createElement('div');
        el.className = 'flex justify-between bg-violet-900/50 px-2 py-0.5 rounded items-center';
        el.innerHTML = `<span>if ${field.conditional.field} ${field.conditional.op || '=='} ${field.conditional.value}</span> <button class="text-red-400" data-type="cond">×</button>`;
        rulesList.appendChild(el);
        el.querySelector('button').onclick = () => { field.conditional = null; refreshRulesList(); };
      }

      // auto value
      if (field.autoValue) {
        const el = document.createElement('div');
        el.className = 'flex justify-between bg-purple-900/50 px-2 py-0.5 rounded items-center';
        el.innerHTML = `<span>auto: ${field.autoValue.type || field.autoValue}</span> <button class="text-red-400" data-type="auto">×</button>`;
        rulesList.appendChild(el);
        el.querySelector('button').onclick = () => { delete field.autoValue; refreshRulesList(); };
      }

      // transforms (new)
      (field.transforms || []).forEach((t, idx) => {
        let desc = t.type;
        if (t.type === 'substring') desc += ` (start:${t.start||0} len:${t.length||''})`;
        else if (t.length) desc += ` ${t.length} chars`;
        if (t.delimiter) desc += ` split:'${t.delimiter}' take:${t.take||0}`;
        if (t.pattern) desc += ` regex:${t.pattern}`;
        const el = document.createElement('div');
        el.className = 'flex justify-between bg-emerald-900/50 px-2 py-0.5 rounded items-center text-[11px]';
        el.innerHTML = `<span><span class="bg-emerald-700 text-white px-1 rounded mr-1">transform</span> ${desc}</span> <span class="flex gap-1"><button class="text-emerald-400" data-type="trans-edit" data-idx="${idx}">✎</button><button class="text-red-400" data-type="trans" data-idx="${idx}">×</button></span>`;
        rulesList.appendChild(el);
        el.querySelector('button[data-type="trans"]').onclick = () => {
          field.transforms.splice(idx, 1);
          refreshRulesList();
        };
        el.querySelector('button[data-type="trans-edit"]').onclick = () => {
          editTransform(idx, refreshRulesList);
        };
      });

      // conditional defaults
      (field.conditionalDefaults || []).forEach((d, idx) => {
        const el = document.createElement('div');
        el.className = 'flex justify-between bg-teal-900/50 px-2 py-0.5 rounded items-center text-[11px]';
        el.innerHTML = `<span>if ${d.ifField} == ${d.ifValue} → default ${d.defaultValue}</span> <button class="text-red-400" data-type="cdel" data-idx="${idx}">×</button>`;
        rulesList.appendChild(el);
        el.querySelector('button').onclick = () => { field.conditionalDefaults.splice(idx,1); refreshRulesList(); };
      });

      if (rulesList.children.length === 0) {
        rulesList.innerHTML = '<div class="text-slate-500 px-1">Пока нет правил. Выберите в выпадающем списке выше.</div>';
      }
    }
    refreshRulesList();

    function editValidation(idx, onDone) {
      const v = field.validations[idx] || {};
      featureArea.innerHTML = `
        <div class="bg-slate-950 p-2 rounded">
          <div class="flex gap-2">
            <select id="val-type" class="flex-1 bg-slate-800 text-xs px-2 py-1 rounded">
              <option value="required">required — обязательно</option>
              <option value="length">length — длина строки</option>
              <option value="minmax">min / max значение (число/дата)</option>
              <option value="position">position — проверка позиции</option>
              <option value="language">language / charset</option>
              <option value="pattern">pattern (regex)</option>
              <option value="unique">unique — запрос в БД</option>
              <option value="custom">custom query check</option>
              <option value="uppercase">uppercase — только верхний регистр</option>
              <option value="lowercase">lowercase — только нижний регистр</option>
              <option value="trim">trim — нет пробелов в начале/конце</option>
            </select>
            <button id="val-apply" class="px-3 bg-amber-600 rounded text-xs">Обновить</button>
          </div>
          <div id="val-params" class="mt-2 grid grid-cols-3 gap-1 text-xs"></div>
        </div>`;

      const vtype = featureArea.querySelector('#val-type');
      const params = featureArea.querySelector('#val-params');
      vtype.value = v.type || 'length';

      // force update the params UI
      setTimeout(showValParams, 0);

      function showValParams() {
        params.innerHTML = '';
        const t = vtype.value;
        let paramsHtml = '';
        if (t === 'length') {
          paramsHtml = `<input placeholder="min" id="p-min" value="${v.min||''}" class="bg-slate-800 px-1 rounded"> <input placeholder="max" id="p-max" value="${v.max||''}" class="bg-slate-800 px-1 rounded"> <input placeholder="exact" id="p-exact" value="${v.exact||''}" class="bg-slate-800 px-1 rounded">`;
        } else if (t === 'minmax') {
          paramsHtml = `<input placeholder="min" id="p-min" value="${v.min||''}" class="bg-slate-800 px-1 rounded"> <input placeholder="max" id="p-max" value="${v.max||''}" class="bg-slate-800 px-1 rounded">`;
        } else if (t === 'position') {
          paramsHtml = `<input placeholder="start (1-based)" id="p-start" value="${v.start||1}" class="bg-slate-800 px-1 rounded"> <input placeholder="длина" id="p-len" value="${v.length||''}" class="bg-slate-800 px-1 rounded"> <input placeholder="ожидаемое значение" id="p-val" value="${v.value||''}" class="bg-slate-800 px-1 rounded">`;
        } else if (t === 'language') {
          paramsHtml = `
            <select id="p-lang" class="bg-slate-800 px-1 rounded w-full">
              <option value="armenian">armenian</option>
              <option value="armenian_alphanumeric">armenian + digits + symbols</option>
              <option value="latin">latin</option>
              <option value="latin_alphanumeric">latin + digits + symbols</option>
              <option value="cyrillic">cyrillic</option>
              <option value="cyrillic_alphanumeric">cyrillic + digits + symbols</option>
              <option value="digits">digits</option>
              <option value="alphanumeric">latin letters + digits</option>
            </select>`;
        } else if (t === 'pattern') {
          paramsHtml = `<input id="p-pattern" placeholder="regex" value="${v.pattern || ''}" class="bg-slate-800 px-1 rounded">`;
        } else if (t === 'unique') {
          paramsHtml = `<input id="p-pattern" placeholder="SQL с ?" value="${v.query || ''}" class="bg-slate-800 px-1 rounded"> <input id="p-fields" placeholder="поля" value="${(v.fields||[]).join(',')}" class="bg-slate-800 px-1 rounded">`;
        } else if (t === 'custom') {
          paramsHtml = `<input id="p-cond" placeholder="if условие" value="${v.condition || ''}" class="bg-slate-800 px-1 rounded"> <input id="p-pattern" placeholder="SQL опц" value="${v.query || ''}" class="bg-slate-800 px-1 rounded">`;
        } else if (t === 'uppercase' || t === 'lowercase' || t === 'trim') {
          paramsHtml = '';
        }
        params.innerHTML = paramsHtml + `<input id="p-err" placeholder="Текст ошибки (ОБЯЗАТЕЛЬНО, ваш кастомный)" value="${v.error || ''}" class="bg-slate-800 px-1 rounded w-full mt-1">`;
      }

      vtype.onchange = showValParams;
      showValParams();

      // prefill will be handled by the template in showValParams now
      // but force again for safety
      setTimeout(() => {
        if (vtype.value === 'custom') {
          const condEl = featureArea.querySelector('#p-cond');
          const patEl = featureArea.querySelector('#p-pattern');
          if (condEl && v.condition) condEl.value = v.condition;
          if (patEl && v.query) patEl.value = v.query;
        }
        const errEl = featureArea.querySelector('#p-err');
        if (errEl && v.error) errEl.value = v.error;
      }, 0);

      featureArea.querySelector('#val-apply').onclick = () => {
        const nv = { type: vtype.value };
        const get = id => featureArea.querySelector('#'+id)?.value || '';
        if (nv.type === 'length' || nv.type === 'minmax') {
          if (get('p-min')) nv.min = parseInt(get('p-min'));
          if (get('p-max')) nv.max = parseInt(get('p-max'));
          if (get('p-exact')) nv.exact = parseInt(get('p-exact'));
        }
        if (nv.type === 'position') {
          nv.start = parseInt(get('p-start')) || 1;
          nv.length = parseInt(get('p-len')) || undefined;
          nv.value = get('p-val');
        }
        if (nv.type === 'language') nv.language = get('p-lang');
        if (nv.type === 'pattern') nv.pattern = get('p-pattern');
        if (nv.type === 'unique') {
          nv.query = get('p-pattern');
          const fs = get('p-fields');
          if (fs) nv.fields = fs.split(',').map(s => s.trim()).filter(Boolean);
          else delete nv.fields;
        }
        if (nv.type === 'custom') {
          nv.condition = get('p-cond');
          nv.query = get('p-pattern');
        }
        if (nv.type === 'uppercase' || nv.type === 'lowercase' || nv.type === 'trim') {
          // no extra params
        }

        const customErr = get('p-err').trim();
        if (!customErr) {
          alert('Нужно обязательно прописать свой кастомный текст ошибки!');
          return;
        }
        nv.error = customErr;

        field.validations[idx] = nv;
        featureArea.innerHTML = '';
        if (onDone) onDone();
      };
    }

    function editTransform(idx, onDone) {
      const t = (field.transforms || [])[idx] || {};
      featureArea.innerHTML = `
        <div class="bg-slate-950 p-2 rounded text-xs space-y-1">
          <select id="t-type" class="bg-slate-800 w-full px-1 rounded">
            <option value="firstN">Первые N символов</option>
            <option value="lastN">Последние N символов</option>
            <option value="substring">Substring (start, length)</option>
            <option value="split">Split по разделителю</option>
            <option value="regex">Regex</option>
          </select>
          <div id="t-p" class="grid grid-cols-2 gap-1"></div>
          <button id="t-upd" class="px-2 py-0.5 bg-emerald-600 rounded text-xs mt-1">Обновить</button>
        </div>`;

      const tt = featureArea.querySelector('#t-type');
      const tp = featureArea.querySelector('#t-p');
      tt.value = t.type || 'firstN';

      setTimeout(renderTP, 0);

      function renderTP() {
        tp.innerHTML = '';
        const typ = tt.value;
        if (typ === 'firstN' || typ === 'lastN') {
          tp.innerHTML = `<input id="tp-len" value="${t.length||4}" placeholder="N" class="bg-slate-800 px-1 rounded">`;
        } else if (typ === 'substring') {
          tp.innerHTML = `<input id="tp-start" value="${t.start||0}" placeholder="start" class="bg-slate-800 px-1 rounded"> <input id="tp-len" value="${t.length||''}" placeholder="length" class="bg-slate-800 px-1 rounded">`;
        } else if (typ === 'split') {
          tp.innerHTML = `<input id="tp-d" value="${t.delimiter||' - '}" class="bg-slate-800 px-1"> <input id="tp-i" value="${t.take||0}" placeholder="0" class="bg-slate-800 px-1">`;
        } else if (typ === 'regex') {
          tp.innerHTML = `<input id="tp-re" value="${t.pattern||''}" class="bg-slate-800 px-1 col-span-2">`;
        }
      }
      tt.onchange = () => { renderTP(); };
      setTimeout(renderTP, 5);
      // also force select to reflect value
      setTimeout(() => { if (tt) tt.value = tt.value; }, 10);

      featureArea.querySelector('#t-upd').onclick = () => {
        const nt = { type: tt.value };
        const g = id => featureArea.querySelector('#'+id)?.value || '';
        if (nt.type === 'firstN' || nt.type === 'lastN') nt.length = parseInt(g('tp-len')) || 4;
        if (nt.type === 'substring') {
          nt.start = parseInt(g('tp-start')) || 0;
          nt.length = g('tp-len') ? parseInt(g('tp-len')) : undefined;
        }
        if (nt.type === 'split') { nt.delimiter = g('tp-d'); nt.take = parseInt(g('tp-i'))||0; }
        if (nt.type === 'regex') nt.pattern = g('tp-re');
        field.transforms[idx] = nt;
        featureArea.innerHTML = '';
        if (onDone) onDone();
      };
    }

    // Dynamic feature adder (the main UX the user asked for)
    modal.querySelector('#fe-add-feature').onclick = async () => {
      const feat = featureSelect.value;
      if (!feat) return;

      featureArea.innerHTML = ''; // clear previous

      if (feat === 'validation') {
        featureArea.innerHTML = `
          <div class="bg-slate-950 p-2 rounded">
            <div class="flex gap-2">
              <select id="val-type" class="flex-1 bg-slate-800 text-xs px-2 py-1 rounded">
                <option value="required">required — обязательно</option>
                <option value="length">length — длина строки</option>
                <option value="minmax">min / max значение (число/дата)</option>
                <option value="position">position — проверка позиции</option>
                <option value="language">language / charset</option>
                <option value="pattern">pattern (regex)</option>
                <option value="unique">unique — запрос в БД</option>
                <option value="custom">custom query check</option>
                <option value="uppercase">uppercase — только верхний регистр</option>
                <option value="lowercase">lowercase — только нижний регистр</option>
                <option value="trim">trim — нет пробелов в начале/конце</option>
              </select>
              <button id="val-apply" class="px-3 bg-amber-600 rounded text-xs">Применить</button>
            </div>
            <div id="val-params" class="mt-2 grid grid-cols-3 gap-1 text-xs"></div>
          </div>`;

        const vtype = featureArea.querySelector('#val-type');
        const params = featureArea.querySelector('#val-params');

        function showValParams() {
          params.innerHTML = '';
          const t = vtype.value;
          let paramsHtml = '';
          if (t === 'length') {
            paramsHtml = `<input placeholder="min" id="p-min" class="bg-slate-800 px-1 rounded"> <input placeholder="max" id="p-max" class="bg-slate-800 px-1 rounded"> <input placeholder="exact" id="p-exact" class="bg-slate-800 px-1 rounded">`;
          } else if (t === 'minmax') {
            paramsHtml = `<input placeholder="min" id="p-min" class="bg-slate-800 px-1 rounded"> <input placeholder="max" id="p-max" class="bg-slate-800 px-1 rounded">`;
          } else if (t === 'position') {
            paramsHtml = `<input placeholder="start (1-based)" id="p-start" value="1" class="bg-slate-800 px-1 rounded"> <input placeholder="длина" id="p-len" class="bg-slate-800 px-1 rounded"> <input placeholder="ожидаемое значение" id="p-val" class="bg-slate-800 px-1 rounded">`;
          } else if (t === 'language') {
            paramsHtml = `
                <select id="p-lang" class="bg-slate-800 px-1 rounded w-full">
                    <option value="armenian">armenian</option>
                    <option value="armenian_alphanumeric">armenian + digits + symbols</option>
                    <option value="latin">latin</option>
                    <option value="latin_alphanumeric">latin + digits + symbols</option>
                    <option value="cyrillic">cyrillic</option>
                    <option value="cyrillic_alphanumeric">cyrillic + digits + symbols</option>
                    <option value="digits">digits</option>
                    <option value="alphanumeric">latin letters + digits</option>
                </select>`;
          } else if (t === 'pattern') {
            paramsHtml = `<input id="p-pattern" placeholder="regex" class="bg-slate-800 px-1 rounded">`;
          } else if (t === 'unique') {
            paramsHtml = `<input id="p-pattern" placeholder="SQL с ?" class="bg-slate-800 px-1 rounded"> <input id="p-fields" placeholder="поля" class="bg-slate-800 px-1 rounded">`;
          } else if (t === 'custom') {
            paramsHtml = `<input id="p-cond" placeholder="if условие" class="bg-slate-800 px-1 rounded"> <input id="p-pattern" placeholder="SQL опц" class="bg-slate-800 px-1 rounded">`;
          } else if (t === 'uppercase' || t === 'lowercase' || t === 'trim') {
            paramsHtml = '';
          }
          params.innerHTML = paramsHtml + `<input id="p-err" placeholder="Текст ошибки (ОБЯЗАТЕЛЬНО, ваш кастомный)" class="bg-slate-800 px-1 rounded w-full mt-1">`;
        }
        vtype.onchange = showValParams;
        showValParams();

        featureArea.querySelector('#val-apply').onclick = () => {
          const v = { type: vtype.value };
          const get = id => featureArea.querySelector('#'+id)?.value || '';
          if (v.type === 'length' || v.type === 'minmax') {
            if (get('p-min')) v.min = parseInt(get('p-min'));
            if (get('p-max')) v.max = parseInt(get('p-max'));
            if (get('p-exact')) v.exact = parseInt(get('p-exact'));
          }
          if (v.type === 'position') {
            v.start = parseInt(get('p-start')) || 1;
            v.length = parseInt(get('p-len')) || undefined;
            v.value = get('p-val');
          }
          if (v.type === 'language') v.language = get('p-lang');
          if (v.type === 'pattern') v.pattern = get('p-pattern');
          if (v.type === 'unique') {
            v.query = get('p-pattern');
            const fs = get('p-fields');
            if (fs) v.fields = fs.split(',').map(s => s.trim()).filter(Boolean);
            else delete v.fields;
          }
          if (v.type === 'custom') {
            v.condition = get('p-cond');
            v.query = get('p-pattern');
          }
          if (v.type === 'uppercase' || v.type === 'lowercase' || v.type === 'trim') {
            // no params
          }
          const customErr = get('p-err').trim();
          if (!customErr) {
            alert('Нужно обязательно прописать свой кастомный текст ошибки!');
            return;
          }
          v.error = customErr;

          field.validations.push(v);
          featureArea.innerHTML = '';
          refreshRulesList();
        };

      } else if (feat === 'conditional') {
        featureArea.innerHTML = `
          <div class="bg-slate-950 p-2 rounded text-xs">
            Показывать / требовать если 
            <select id="c-field" class="bg-slate-800 mx-1">${dependsOptions}</select>
            <select id="c-op" class="bg-slate-800"><option value="==">==</option><option value="!=">!=</option><option value="contains">содержит</option></select>
            <input id="c-val" placeholder="значение" class="bg-slate-800 px-1 w-24"> 
            <button id="c-apply" class="ml-1 px-2 bg-violet-600 rounded">Добавить правило</button>
          </div>`;
        featureArea.querySelector('#c-apply').onclick = () => {
          const f = featureArea.querySelector('#c-field').value;
          if (!f) { showToast('Выберите поле', 'error'); return; }
          field.conditional = {
            field: f,
            op: featureArea.querySelector('#c-op').value,
            value: featureArea.querySelector('#c-val').value
          };
          featureArea.innerHTML = '';
          refreshRulesList();
        };

      } else if (feat === 'autovalue') {
        const av = await customPrompt('Тип автогенерации (uuid, timestamp, copy:другое_поле, sql:SELECT ...):', 'uuid');
        if (av) {
          field.autoValue = { type: av };
          if (av.startsWith('copy:')) field.autoValue.source = av.split(':')[1];
          refreshRulesList();
        }

      } else if (feat === 'cross') {
        const other = await customPrompt('Сравнить с полем:', otherFields[0]?.field || '');
        const op = await customPrompt('Оператор (==, !=, >, contains):', '==');
        if (other) {
          field.validations.push({ type: 'cross_field', field: other, op });
          refreshRulesList();
        }

      } else if (feat === 'mask') {
        field.placeholder = await customPrompt('Placeholder:', field.placeholder || '') || field.placeholder;
        field.help = await customPrompt('Help текст (описание):', field.help || '') || field.help;
        refreshRulesList();

      } else if (feat === 'allowed') {
        const list = await customPrompt('Разрешённые значения через запятую:', (field.allowedValues || []).join(','));
        if (list !== null) field.allowedValues = list.split(',').map(x => x.trim()).filter(Boolean);
        refreshRulesList();

      } else if (feat === 'transform') {
        featureArea.innerHTML = `
          <div class="bg-slate-950 p-2 rounded text-xs space-y-2">
            <div>
              <select id="trans-type" class="bg-slate-800 px-2 py-1 rounded w-full">
                <option value="firstN">Первые N символов</option>
                <option value="lastN">Последние N символов</option>
                <option value="substring">Substring (start, length)</option>
                <option value="split">Разделить по разделителю и взять часть</option>
                <option value="regex">Regex extract (группа 1)</option>
              </select>
            </div>
            <div id="trans-params" class="grid grid-cols-2 gap-1"></div>
            <button id="trans-apply" class="px-3 py-1 bg-emerald-600 rounded text-xs">Добавить transform</button>
          </div>`;

        const ttype = featureArea.querySelector('#trans-type');
        const tparams = featureArea.querySelector('#trans-params');

        function showTransParams() {
          tparams.innerHTML = '';
          const t = ttype.value;
          if (t === 'firstN' || t === 'lastN') {
            tparams.innerHTML = `<input id="t-len" placeholder="сколько символов (4)" value="4" class="bg-slate-800 px-1 rounded col-span-2">`;
          } else if (t === 'substring') {
            tparams.innerHTML = `<input id="t-start" placeholder="start (0)" value="0" class="bg-slate-800 px-1 rounded"> <input id="t-len" placeholder="length (4)" value="4" class="bg-slate-800 px-1 rounded">`;
          } else if (t === 'split') {
            tparams.innerHTML = `<input id="t-delim" placeholder="разделитель ( - )" value=" - " class="bg-slate-800 px-1 rounded"> <input id="t-take" placeholder="индекс части (0)" value="0" class="bg-slate-800 px-1 rounded">`;
          } else if (t === 'regex') {
            tparams.innerHTML = `<input id="t-regex" placeholder="regex с ( ) напр. ^(....)" value="^(....)" class="bg-slate-800 px-1 rounded col-span-2">`;
          }
        }
        ttype.onchange = showTransParams;
        showTransParams();

        featureArea.querySelector('#trans-apply').onclick = () => {
          const t = { type: ttype.value };
          const get = id => featureArea.querySelector('#'+id)?.value || '';
          if (t.type === 'firstN' || t.type === 'lastN') t.length = parseInt(get('t-len')) || 4;
          if (t.type === 'substring') {
            t.start = parseInt(get('t-start')) || 0;
            t.length = parseInt(get('t-len')) || undefined;
          }
          if (t.type === 'split') {
            t.delimiter = get('t-delim') || ' - ';
            t.take = parseInt(get('t-take')) || 0;
          }
          if (t.type === 'regex') t.pattern = get('t-regex');
          field.transforms.push(t);
          featureArea.innerHTML = '';
          refreshRulesList();
        };

      } else if (feat === 'cond_default') {
        featureArea.innerHTML = `
          <div class="bg-slate-950 p-2 rounded text-xs">
            Если <select id="cd-if" class="bg-slate-800">${dependsOptions}</select>
            <select id="cd-op" class="bg-slate-800"><option>==</option><option>!=</option></select>
            <input id="cd-val" placeholder="значение X" class="bg-slate-800 px-1 w-20">
            то default = <input id="cd-def" placeholder="Y" class="bg-slate-800 px-1 w-20">
            <button id="cd-apply" class="ml-1 px-2 bg-teal-600 rounded">Добавить</button>
          </div>`;
        featureArea.querySelector('#cd-apply').onclick = () => {
          const ifF = featureArea.querySelector('#cd-if').value;
          if (!ifF) return;
          if (!field.conditionalDefaults) field.conditionalDefaults = [];
          field.conditionalDefaults.push({
            ifField: ifF,
            ifValue: featureArea.querySelector('#cd-val').value,
            op: featureArea.querySelector('#cd-op').value,
            defaultValue: featureArea.querySelector('#cd-def').value
          });
          featureArea.innerHTML = '';
          refreshRulesList();
        };
      }
    };

    // Save logic
    modal.querySelector('#fe-save').onclick = () => {
      field.title = modal.querySelector('#fe-title').value.trim() || field.field;
      field.type = typeSel.value;
      field.defaultValue = modal.querySelector('#fe-default')?.value.trim() || undefined;
      if (!field.defaultValue) delete field.defaultValue;

      const sizeMode = modal.querySelector('#fe-size-mode')?.value || '';
      if (sizeMode === 'full') {
        field.width = 'full';
      } else if (sizeMode === 'custom') {
        const cw = modal.querySelector('#fe-custom-width')?.value.trim();
        const ch = modal.querySelector('#fe-custom-height')?.value.trim();
        if (cw) field.width = cw;
        if (ch) field.height = ch;
        if (!cw) delete field.width;
        if (!ch) delete field.height;
      } else {
        delete field.width;
        delete field.height;
      }

      field.searchable = !!modal.querySelector('#fe-searchable')?.checked;
      if (!field.searchable) delete field.searchable;

      // Auto-promote SELECT from defaultValue into lookupQuery when type=lookup (user often puts query in default)
      if (field.type === 'lookup' && !field.lookupQuery && !field.lookupWindow && field.defaultValue &&
          typeof field.defaultValue === 'string' && field.defaultValue.trim().toLowerCase().startsWith('select ')) {
        field.lookupQuery = field.defaultValue.trim();
        delete field.defaultValue;
      }

      field.required = modal.querySelector('#fe-required').checked;
      field.hiddenInForm = modal.querySelector('#fe-hidden').checked;
      field.disabled = !!modal.querySelector('#fe-disabled')?.checked;
      if (!field.disabled) delete field.disabled;
      field.readonly = !!modal.querySelector('#fe-readonly')?.checked;
      if (!field.readonly) delete field.readonly;

      // Checkbox special values
      if (typeSel.value === 'checkbox') {
        const cv = modal.querySelector('#fe-checked-val')?.value.trim();
        const uv = modal.querySelector('#fe-unchecked-val')?.value.trim();
        if (cv) field.checkedValue = cv;
        if (uv !== undefined) field.uncheckedValue = uv;
      } else {
        delete field.checkedValue;
        delete field.uncheckedValue;
      }

      // readonlyInUpdate removed per user request (no longer "only read for changes")

      // Capture powerful System / Auto variable
      const autoType = modal.querySelector('#fe-auto-type').value;
      const hiddenSysInput = modal.querySelector('#fe-sys');

      if (autoType) {
        hiddenSysInput.value = autoType;
        if (autoType === 'COPY') {
          const copyFrom = modal.querySelector('#fe-auto-copy-from')?.value;
          field.autoValue = { type: 'COPY', source: copyFrom };
          field.systemVariable = 'COPY';
        } else if (autoType === 'CONSTANT') {
          const constVal = modal.querySelector('#fe-auto-constant')?.value || '';
          field.autoValue = { type: 'CONSTANT', value: constVal };
          field.defaultValue = constVal;
          field.systemVariable = 'CONSTANT';
        } else if (autoType === 'CUSTOM') {
          const customVal = modal.querySelector('#fe-auto-custom')?.value || '';
          field.autoValue = { type: 'CUSTOM', value: customVal };
          field.systemVariable = customVal;
        } else if (autoType === 'RANDOM_INT' || autoType === 'RANDOM_FLOAT') {
          field.autoValue = {
            type: autoType,
            min: modal.querySelector('#fe-auto-min')?.value || undefined,
            max: modal.querySelector('#fe-auto-max')?.value || undefined
          };
          field.systemVariable = autoType;
        } else if (['NOW', 'TODAY', 'NOW_ISO'].includes(autoType)) {
          const fmt = modal.querySelector('#fe-auto-format')?.value;
          field.autoValue = { type: autoType, format: fmt || undefined };
          field.systemVariable = autoType;
        } else if (autoType === 'SQL') {
          const q = modal.querySelector('#fe-auto-sql')?.value || '';
          field.autoValue = { type: 'sql', query: q.trim() };
          field.systemVariable = 'sql:' + q.trim();
        } else {
          field.systemVariable = autoType;
          field.autoValue = { type: autoType };
        }
      } else {
        delete field.systemVariable;
        delete field.autoValue;
      }

      field.placeholder = modal.querySelector('#fe-placeholder')?.value.trim() || undefined;
      if (!field.placeholder) delete field.placeholder;

      field.help = modal.querySelector('#fe-help')?.value.trim() || undefined;
      if (!field.help) delete field.help;

      // Depends + Lookup
      field.dependsOn = modal.querySelector('#fe-dependsOn').value || undefined;
      if (!field.dependsOn) delete field.dependsOn;

      const ltype = modal.querySelector('#fe-lookup-type').value;
      const lq = modal.querySelector('#fe-lookup-query');
      const lwin = modal.querySelector('#fe-lookup-win');
      const lval = modal.querySelector('#fe-lookup-val');
      const ldisp = modal.querySelector('#fe-lookup-disp');
      const staticOpt = modal.querySelector('#fe-static-options');

      if (ltype === 'static' && staticOpt) {
        const raw = staticOpt.value || '';
        const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        field.options = lines.map(line => {
          if (line.includes('|')) {
            const [v, d] = line.split('|');
            return { value: v.trim(), display: d.trim() };
          }
          return { value: line, display: line };
        });
        delete field.lookupQuery;
        delete field.lookupWindow;
        delete field.lookupValueField;
        delete field.lookupDisplayField;
        delete field.lookupConditions;
      } else if (ltype === 'query' || ltype === 'conditional') {
        field.lookupQuery = lq ? lq.value.trim() : undefined;
        if (lval && lval.value) field.lookupValueField = lval.value.trim();
        if (ldisp && ldisp.value) field.lookupDisplayField = ldisp.value.trim();
        delete field.lookupWindow;
        delete field.options;

        // Collect conditional queries (e.g. if City=Երևան use different table)
        const condList = modal.querySelector('#fe-cond-list');
        if (condList) {
          const conditions = [];
          condList.querySelectorAll('.flex').forEach(row => {
            const valInp = row.querySelector('.fe-cond-val');
            const qInp = row.querySelector('.fe-cond-query');
            const v = valInp ? valInp.value.trim() : '';
            const q = qInp ? qInp.value.trim() : '';
            if (v && q) conditions.push({ value: v, query: q });
          });
          if (conditions.length > 0) {
            field.lookupConditions = conditions;
          } else {
            delete field.lookupConditions;
          }
        }
      } else if (ltype === 'window') {
        field.lookupWindow = lwin ? lwin.value.trim() : undefined;
        delete field.lookupQuery;
        delete field.options;
        delete field.lookupConditions;
      } else {
        delete field.lookupQuery;
        delete field.lookupWindow;
        delete field.lookupValueField;
        delete field.lookupDisplayField;
        delete field.options;
        delete field.lookupConditions;
      }

      // Cleanup empty
      if (!field.validations || field.validations.length === 0) delete field.validations;
      if (!field.conditional) delete field.conditional;

      modal.remove();
      if (onSave) onSave(field);
    };

    modal.querySelector('#fe-cancel').onclick = () => modal.remove();
    modal.querySelector('#fe-close-x').onclick = () => modal.remove();
    modal.onclick = e => { if (e.target === modal) modal.remove(); };

    // set initial type
    if (field.type) typeSel.value = field.type;
    if (typeof updateCheckboxSpecialVisibility === 'function') updateCheckboxSpecialVisibility();
}

async function saveInsertUpdateConfig() {
    // Capture latest values from inputs (tables, keys)
    const updKey = document.getElementById('update-keyfield');
    const delTable = document.getElementById('delete-table');
    const delKey = document.getElementById('delete-keyfield');

    if (updKey && currentWindowConfig.update) currentWindowConfig.update.keyField = updKey.value.trim();
    if (!currentWindowConfig.delete) currentWindowConfig.delete = {};
    if (delTable && currentWindowConfig.delete) currentWindowConfig.delete.table = delTable.value.trim();
    if (delKey && currentWindowConfig.delete) currentWindowConfig.delete.keyField = delKey.value.trim();

    // Ensure insert/update table comes from main window config (no duplicate input anymore)
    const mainTable = currentWindowConfig.dataSource?.table || currentWindowConfig.table || '';
    if (mainTable) {
      if (!currentWindowConfig.insert) currentWindowConfig.insert = {};
      currentWindowConfig.insert.table = mainTable;
      if (!currentWindowConfig.update) currentWindowConfig.update = {};
      currentWindowConfig.update.table = mainTable;
    }

    // Rebuild from master in case flags changed
    if (typeof rebuildFormListsFromMaster === 'function') rebuildFormListsFromMaster();

    // Capture query
    const qEl = document.getElementById('admin-query');
    if (qEl) {
        const qval = qEl.value.trim();
        currentWindowConfig.query = qval;
        if (!currentWindowConfig.dataSource) currentWindowConfig.dataSource = {};
        currentWindowConfig.dataSource.query = qval;
    }

    // Grid, Details and Filters are mutated live by their list editors

    await saveFullConfig();

    // Stay in the detailed config view for this window (don't jump to list)
    renderAdminConfigUI();
}

function renderFieldsList() {
    const container = document.getElementById('fields-list');
    const fields = (currentWindowConfig?.form?.fields) || [];
    let html = '';
    fields.forEach(function(field, i) {
        html += 
            '<div class="bg-slate-800 rounded-2xl p-6 border border-slate-700 hover:border-blue-400 group">' +
            '<div class="flex justify-between items-start">' +
            '<div>' +
            '<div class="font-semibold">' + (field.title || field.field) + '</div>' +
            '<div class="text-xs text-slate-400">' + field.field + ' • ' + field.type + '</div>' +
            (field.lookupWindow ? '<div class="text-[10px] text-emerald-400 mt-0.5">→ ' + field.lookupWindow + '</div>' : '') +
            (field.dependsOn ? '<div class="text-[10px] text-amber-400">зависит от: ' + field.dependsOn + '</div>' : '') +
            '</div>' +
            '<div class="flex gap-2">' +
            '<button onclick="editField(' + i + ')" class="bg-blue-900 hover:bg-blue-700 px-4 py-1.5 rounded-xl text-sm">Редактировать</button>' +
            '<button onclick="deleteField(' + i + ')" class="bg-red-900 hover:bg-red-700 px-4 py-1.5 rounded-xl text-sm">Удалить</button>' +
            '</div>' +
            '</div>' +
            '</div>';
    });
    container.innerHTML = html || '<p class="text-slate-400 text-center py-10">Нет полей</p>';
}

function addNewField() {
    if (!currentWindowConfig.form) currentWindowConfig.form = { fields: [] };
    const newField = { 
        field: "new_field", 
        title: "Новое поле", 
        type: "text", 
        required: false 
    };
    currentWindowConfig.form.fields.push(newField);
    renderFieldsList();
    renderAdminRelations();
}

async function deleteField(index) {
    if (!currentWindowConfig.form) return;
    if (await customConfirm('Удалить поле?')) {
        currentWindowConfig.form.fields.splice(index, 1);
        renderFieldsList();
    }
}

function editField(index) {
    // stubbed to fix parse error
    showToast('Legacy field editor disabled to fix syntax. Use the main field lists in admin.', 'error');
}

function closeFieldEditor() {
    const modal = document.getElementById('field-editor-modal');
    if (modal) modal.remove();
}

function saveFieldEdit(index) {
    // stub
}


async function saveFullConfig() {
    try {
        if (!fullConfig) {
            fullConfig = await window.electronAPI.loadConfig();
        }

        // Pull latest form.table from admin input if present
        const tableInput = document.getElementById('admin-form-table');
        if (tableInput && currentWindowConfig.form) {
            currentWindowConfig.form.table = tableInput.value.trim();
            if (currentWindowConfig.insert) currentWindowConfig.insert.table = currentWindowConfig.form.table;
        }

        // Sync current edited window back (per-window insert/update/delete)
        if (currentWindowConfig && fullConfig && Array.isArray(fullConfig.windows)) {
            const idx = fullConfig.windows.findIndex(w => 
                (w.id && currentWindowConfig.id && w.id === currentWindowConfig.id) ||
                w.title === currentWindowConfig.title
            );
            if (idx >= 0) {
                fullConfig.windows[idx] = { 
                    ...fullConfig.windows[idx], 
                    query: currentWindowConfig.query,
                    dataSource: currentWindowConfig.dataSource,
                    insert: currentWindowConfig.insert,
                    update: currentWindowConfig.update,
                    delete: currentWindowConfig.delete,
                    grid: currentWindowConfig.grid,
                    fields: currentWindowConfig.fields || [], // unified master fields to avoid duplication between insert/update
                    details: currentWindowConfig.details,
                    filters: currentWindowConfig.filters,
                    form: currentWindowConfig.form,
                    formCustomButtons: currentWindowConfig.formCustomButtons || [],
                    rowFormatting: currentWindowConfig.rowFormatting || []
                };
            }
        }

        // Prune empty CRUD sections so read-only windows (no fields / no key) stay clean in saved config
        // Buttons in main UI now also hide based on real fields/keys (not object presence)
        if (currentWindowConfig && fullConfig && Array.isArray(fullConfig.windows)) {
            const idx2 = fullConfig.windows.findIndex(w => 
                (w.id && currentWindowConfig.id && w.id === currentWindowConfig.id) ||
                w.title === currentWindowConfig.title
            );
            if (idx2 >= 0) {
                const tw = fullConfig.windows[idx2];
                if (tw.insert && (!Array.isArray(tw.insert.fields) || tw.insert.fields.length === 0)) {
                    delete tw.insert;
                }
                if (tw.update && (!Array.isArray(tw.update.fields) || tw.update.fields.length === 0)) {
                    delete tw.update;
                }
                if (tw.form && (!Array.isArray(tw.form.fields) || tw.form.fields.length === 0)) {
                    delete tw.form;
                }
                if (tw.delete && !tw.delete.keyField && !tw.delete.table) {
                    delete tw.delete;
                }
            }
        }

        const success = await window.electronAPI.saveConfig(fullConfig);
        if (success) {
            showToast('✅ Конфигурация успешно сохранена!');
            refreshWindowList();
        }
    } catch (e) {
        showToast('Ошибка сохранения: ' + e.message, 'error');
    }
}

function reloadCurrentWindow() {
    if (currentWindowConfig) {
        const lw = window.loadWindow || (typeof loadWindow !== 'undefined' ? loadWindow : null);
        if (lw) lw(currentWindowConfig);
    }
}
window.reloadCurrentWindow = reloadCurrentWindow;

function updateMasterContextUI() {
    const banner = document.getElementById('master-context-banner');
    const textEl = document.getElementById('master-context-text');
    if (!banner || !textEl) return;

    if (masterContext && masterContext.value !== undefined) {
        const winTitle = (fullConfig && fullConfig.windows ? fullConfig.windows.find(w => (w.id||w.windowId)==masterContext.windowId) : null)?.title || masterContext.windowId;
        textEl.innerHTML = 'Активный мастер: <b>' + winTitle + '</b> (' + masterContext.keyField + '=' + masterContext.value + ')';
        banner.classList.remove('hidden');
        banner.classList.add('flex');
    } else {
        banner.classList.remove('flex');
        banner.classList.add('hidden');
    }
}

function clearMasterContext() {
    masterContext = null;
    pendingFormPrefill = null;
    updateMasterContextUI();
    // re-render buttons without context
    const btnCont = document.getElementById('relation-buttons');
    if (btnCont) btnCont.innerHTML = '';
}

function renderRelationButtons() {
    const container = document.getElementById('relation-buttons');
    if (!container || !currentWindowConfig) return;
    container.innerHTML = '';

    const rels = currentWindowConfig.relations || [];
    if (!selectedRow || rels.length === 0) return;

    rels.filter(r => r.type === 'master-detail').forEach(rel => {
        const targetName = rel.targetId || rel.targetWindow || 'деталь';
        const btn = document.createElement('button');
        btn.className = 'bg-violet-600 hover:bg-violet-500 px-3 py-1.5 rounded-2xl text-xs font-medium flex items-center gap-1.5 transition shadow-sm';
        btn.innerHTML = '<i class="fas fa-link"></i> <span>Добавить в ' + targetName + '</span>';
        btn.onclick = () => {
            const targetId = rel.targetId || rel.targetWindow;
            const targetWin = (fullConfig && fullConfig.windows ? fullConfig.windows : []).find(w => 
                (w.id || w.windowId) == targetId
            );
            if (!targetWin) { showToast('Целевое окно не найдено', 'error'); return; }

            pendingFormPrefill = {};
            const fk = rel.childForeignKey || rel.foreignKey;
            if (fk && masterContext && masterContext.value !== undefined) {
                pendingFormPrefill[fk] = masterContext.value;
            }

            const lw = window.loadWindow || (typeof loadWindow !== 'undefined' ? loadWindow : null); if (lw) lw(targetWin);
            setTimeout(() => showInsertForm(), 150);
        };
        container.appendChild(btn);
    });
}

function saveFormTable() {
    if (!currentWindowConfig.form) currentWindowConfig.form = {};
    const tableInput = document.getElementById('admin-form-table');
    if (tableInput) {
        currentWindowConfig.form.table = tableInput.value.trim();
    }
    // Also mirror to insert if present for compatibility
    if (currentWindowConfig.insert) {
        currentWindowConfig.insert.table = currentWindowConfig.form.table;
    }
    showToast('Таблица для вставки сохранена в памяти формы. Нажмите «Сохранить config.json» для записи на диск.');
    renderFieldsList();
    renderAdminRelations();
}

function renderAdminRelations() {
    const cont = document.getElementById('admin-relations-list');
    if (!cont) return;
    const rels = currentWindowConfig.relations || [];
    if (rels.length === 0) {
        cont.innerHTML = `<div class="text-slate-500 italic text-center py-2">Связей пока нет. Добавьте ниже, чтобы включить мастер-деталь и автосвязи.</div>`;
        return;
    }
    let h = '<div class="space-y-1">';
    rels.forEach((r, i) => {
        const targetName = r.targetId || r.targetWindow || '???';
        h += `
        <div class="flex items-center justify-between bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm">
            <div class="flex items-center gap-2">
                <span class="px-2 py-0.5 bg-violet-600/30 text-violet-300 rounded text-xs">MASTER → DETAIL</span>
                <span class="font-medium">${targetName}</span>
                <span class="text-slate-400 text-xs">(${r.parentKey || '?'} → ${r.childForeignKey || r.foreignKey || '?'})</span>
            </div>
            <button onclick="deleteRelation(${i})" class="text-red-400 hover:text-red-300 text-lg leading-none px-2">×</button>
        </div>`;
    });
    h += '</div>';
    cont.innerHTML = h;
}

function populateRelationTargetSelect() {
    const sel = document.getElementById('new-rel-target');
    if (!sel || !fullConfig || !fullConfig.windows) return;
    sel.innerHTML = '<option value="">— Выберите окно —</option>';
    fullConfig.windows.forEach(w => {
        if ((w.id || w.windowId) === (currentWindowConfig.id || currentWindowConfig.windowId)) return; // skip self
        const opt = document.createElement('option');
        opt.value = w.id || w.windowId || '';
        opt.textContent = w.title || w.id;
        sel.appendChild(opt);
    });
}

function addRelationFromForm() {
    if (!currentWindowConfig.relations) currentWindowConfig.relations = [];
    const target = document.getElementById('new-rel-target')?.value;
    const pKey = document.getElementById('new-rel-parent')?.value.trim();
    const cKey = document.getElementById('new-rel-child')?.value.trim();

    if (!target || !pKey || !cKey) {
        showToast('Заполните все поля связи', 'error');
        return;
    }

    currentWindowConfig.relations.push({
        type: 'master-detail',
        targetId: target,
        parentKey: pKey,
        childForeignKey: cKey
    });

    renderAdminRelations();
    clearNewRelationForm();
}

function clearNewRelationForm() {
    const t = document.getElementById('new-rel-target');
    const p = document.getElementById('new-rel-parent');
    const c = document.getElementById('new-rel-child');
    if (t) t.value = '';
    if (p) p.value = '';
    if (c) c.value = '';
}

async function deleteRelation(i) {
    if (!currentWindowConfig.relations) return;
    if (await customConfirm('Удалить связь?')) {
        currentWindowConfig.relations.splice(i, 1);
        renderAdminRelations();
    }
}

// ==================== MISSING FUNCTIONALITY ====================

async function deleteSelectedRow() {
    if (!selectedRow || !currentWindowConfig) { showToast('Выберите строку для удаления', 'error'); return; }

    const del = currentWindowConfig.delete || {};
    const ds = currentWindowConfig.dataSource || {};
    const table = del.table || ds.table;
    let keyField = del.keyField || ds.primaryKey;
    if (!table || !keyField) { showToast('Для удаления в конфиге окна должны быть указаны delete.table + delete.keyField (или dataSource)', 'error'); return; }

    let pkValue = selectedRow[keyField] ?? selectedRow[keyField.toUpperCase?.()] ?? selectedRow[keyField.toLowerCase?.()];
    if (pkValue === undefined || pkValue === null) {
        // try first column as fallback?
        const firstKey = Object.keys(selectedRow)[0];
        pkValue = selectedRow[firstKey];
        keyField = firstKey;
        if (pkValue === undefined) { showToast('Не удалось определить значение ключа для удаления', 'error'); return; }
    }

    if (!(await customConfirm('Удалить запись с ' + keyField + '=' + pkValue + ' ?'))) return;

    const sql = 'DELETE FROM ' + table + ' WHERE ' + keyField + ' = ?';
    const res = await window.electronAPI.executeQuery(sql, [pkValue]);
    if (res.success) {
        showToast('🗑️ Запись удалена');
        selectedRow = null;
        performSearch();
    } else {
        showToast('Ошибка удаления:\n' + res.error, 'error');
    }
}

async function newWindow() {
    // Quick ad-hoc query for current session only.
    // Use "Администрирование → + Новое окно" to add permanent windows (with ID, insert/update/delete config).
    const name = await customPrompt('Название временного окна:', 'Пользовательский запрос');
    if (!name) return;
    const q = await customPrompt('SQL SELECT запрос:', 'SELECT * FROM MERCHANTS LIMIT 20');
    if (!q) return;

    const customWin = {
        id: 'temp_' + Date.now(),
        title: name,
        query: q,
        filters: [],
        grid: null,
        dataSource: { query: q }
    };
    // Do NOT push to fullConfig — added windows should be created via Admin so they can be configured and saved
    const lw = window.loadWindow || (typeof loadWindow !== 'undefined' ? loadWindow : null); if (lw) lw(customWin);
}

let consoleVisible = false;
function toggleConsole() {
    const main = document.getElementById('current-window');
    let cons = document.getElementById('console-panel');
    if (!cons) {
        cons = document.createElement('div');
        cons.id = 'console-panel';
        cons.style.cssText = 'position:absolute;bottom:0;left:0;right:0;height:160px;background:#0b1120;border-top:1px solid #334155;color:#64748b;font-family:monospace;font-size:12px;padding:8px;overflow:auto;z-index:40';
        cons.innerHTML = '<div style="color:#64748b;margin-bottom:4px">Консоль (логи JS)</div><pre id="console-log" style="white-space:pre-wrap"></pre>';
        main.style.position = 'relative';
        main.appendChild(cons);
    }
    consoleVisible = !consoleVisible;
    cons.style.display = consoleVisible ? 'block' : 'none';
    if (consoleVisible) {
        // hook console once
        if (!window._consoleHooked) {
            window._consoleHooked = true;
            const logEl = () => document.getElementById('console-log');
            const origLog = console.log;
            console.log = (...a) => { origLog(...a); const el = logEl(); if (el) el.textContent += a.map(x=>typeof x==='object'?JSON.stringify(x):x).join(' ') + '\n'; };
            const origErr = console.error;
            console.error = (...a) => { origErr(...a); const el = logEl(); if (el) el.textContent += 'ERROR: ' + a.map(x=>typeof x==='object'?JSON.stringify(x):x).join(' ') + '\n'; };
        }
    }
}

// Export helpers using current results
function parseExportResult(result) {
    if (result && typeof result === 'object' && 'success' in result) {
        return result;
    }
    if (typeof result === 'string' && result) {
        return { success: true, path: result };
    }
    return { success: false, error: 'Неизвестный ответ экспорта' };
}

async function exportCurrentCsv() {
    if (!currentResults || !currentResults.length) { showToast('Нет данных для экспорта. Сначала выполните поиск.', 'error'); return; }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const fname = (currentWindowConfig && currentWindowConfig.id || 'data') + '_' + ts + '.csv';
    try {
        const res = parseExportResult(await window.electronAPI.exportCsv(currentResults, fname));
        if (res.success) showToast('CSV сохранён: ' + res.path);
        else showToast('Ошибка экспорта CSV: ' + (res.error || 'неизвестная ошибка'), 'error');
    } catch (e) { showToast('Ошибка экспорта CSV: ' + e.message, 'error'); }
}

async function exportCurrentXlsx() {
    if (!currentResults || !currentResults.length) { showToast('Нет данных для экспорта. Сначала выполните поиск.', 'error'); return; }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const fname = (currentWindowConfig && currentWindowConfig.id || 'data') + '_' + ts + '.xlsx';
    try {
        const res = parseExportResult(await window.electronAPI.exportXlsx(currentResults, fname));
        if (res.success) showToast('XLSX сохранён: ' + res.path);
        else showToast('Ошибка экспорта XLSX: ' + (res.error || 'неизвестная ошибка'), 'error');
    } catch (e) { showToast('Ошибка экспорта XLSX: ' + e.message, 'error'); }
}

// Robust single init trigger (prevents double init on load + DOMContentLoaded in packaged)
try {
  function __startInitOnce() {
    console.log('[INIT STARTER] __startInitOnce called, alreadyStarted=', !!window.__gtermInitStarted);
    if (window.__gtermInitStarted) { console.log('[INIT STARTER] skipped, already started'); return; }
    window.__gtermInitStarted = true;
    console.log('[INIT STARTER] flag set, will call init');
    if (typeof init === 'function') {
      console.log('[INIT STARTER] scheduling init() via Promise');
      Promise.resolve().then(() => {
        console.log('[INIT STARTER] Promise fired, calling init()');
        init().catch(console.error);
      });
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', __startInitOnce, { once: true });
  } else {
    __startInitOnce();
  }
  // Also cover 'load' as last resort (idempotent)
  window.addEventListener('load', __startInitOnce, { once: true });
} catch(e) {
  console.error('Error wiring init starter', e);
  // last resort
  setTimeout(() => { if (typeof init === 'function') init().catch(console.error); }, 0);
}

console.log('[RENDERER] renderer.js fully parsed and bottom code executed');

// Ensure critical functions are on global/window even if hoisting had issues from edits
// This fixes "not defined" errors for loadWindow and admin button clicks
try {
  if (typeof normalizeWindowConfig === 'function') window.normalizeWindowConfig = normalizeWindowConfig;
  if (typeof window !== 'undefined' && typeof window.openAdminWindow === 'function') {
    // already assigned
  } else if (typeof openAdminWindow === 'function') {
    window.openAdminWindow = openAdminWindow;
  }
  if (typeof selectAdminWindow === 'function') window.selectAdminWindow = selectAdminWindow;
  if (typeof renderAdminConfigUI === 'function') window.renderAdminConfigUI = renderAdminConfigUI;
  if (typeof loadWindow === 'function') window.loadWindow = loadWindow;
  if (typeof renderDetailsList === 'function') window.renderDetailsList = renderDetailsList;
  if (typeof renderGridList === 'function') window.renderGridList = renderGridList;
  if (typeof addDetailColumn === 'function') window.addDetailColumn = addDetailColumn;
  if (typeof editDetailColumn === 'function') window.editDetailColumn = editDetailColumn;
  if (typeof deleteDetailColumn === 'function') window.deleteDetailColumn = deleteDetailColumn;
  if (typeof autoFillDetailsFromQuery === 'function') window.autoFillDetailsFromQuery = autoFillDetailsFromQuery;
  if (typeof addGridColumn === 'function') window.addGridColumn = addGridColumn;
  if (typeof editGridColumn === 'function') window.editGridColumn = editGridColumn;
  if (typeof deleteGridColumn === 'function') window.deleteGridColumn = deleteGridColumn;
  if (typeof autoFillGridFromQuery === 'function') window.autoFillGridFromQuery = autoFillGridFromQuery;
  if (typeof addFilter === 'function') window.addFilter = addFilter;
  if (typeof editFilter === 'function') window.editFilter = editFilter;
  if (typeof deleteFilter === 'function') window.deleteFilter = deleteFilter;
  if (typeof addFieldToInsert === 'function') window.addFieldToInsert = addFieldToInsert;
  if (typeof renderFormButtonsList === 'function') window.renderFormButtonsList = renderFormButtonsList;
  if (typeof addFormButton === 'function') window.addFormButton = addFormButton;
  if (typeof editFormButton === 'function') window.editFormButton = editFormButton;
  if (typeof deleteFormButton === 'function') window.deleteFormButton = deleteFormButton;
  if (typeof showButtonEditor === 'function') window.showButtonEditor = showButtonEditor;
  if (typeof renderFormButtonsList === 'function') window.renderFormButtonsList = renderFormButtonsList;
  if (typeof addFormButton === 'function') window.addFormButton = addFormButton;
  if (typeof editFormButton === 'function') window.editFormButton = editFormButton;
  if (typeof deleteFormButton === 'function') window.deleteFormButton = deleteFormButton;
  if (typeof syncInsertUpdateFields === 'function') window.syncInsertUpdateFields = syncInsertUpdateFields;
  if (typeof renderUnifiedFieldsList === 'function') window.renderUnifiedFieldsList = renderUnifiedFieldsList;
  if (typeof addFieldToUpdate === 'function') window.addFieldToUpdate = addFieldToUpdate;
  if (typeof moveMasterFieldUp === 'function') window.moveMasterFieldUp = moveMasterFieldUp;
  if (typeof moveMasterFieldDown === 'function') window.moveMasterFieldDown = moveMasterFieldDown;
  if (typeof deleteMasterField === 'function') window.deleteMasterField = deleteMasterField;
  if (typeof editInsertField === 'function') window.editInsertField = editInsertField;
  if (typeof editUpdateField === 'function') window.editUpdateField = editUpdateField;
  if (typeof openFieldEditor === 'function') window.openFieldEditor = openFieldEditor;
  if (typeof showAdminGuide === 'function') window.showAdminGuide = showAdminGuide;
  if (typeof addNewWindow === 'function') window.addNewWindow = addNewWindow;
  if (typeof moveInsertFieldUp === 'function') window.moveInsertFieldUp = moveInsertFieldUp;
  if (typeof moveInsertFieldDown === 'function') window.moveInsertFieldDown = moveInsertFieldDown;
  if (typeof moveUpdateFieldUp === 'function') window.moveUpdateFieldUp = moveUpdateFieldUp;
  if (typeof moveUpdateFieldDown === 'function') window.moveUpdateFieldDown = moveUpdateFieldDown;

  // Critical for static inline onclick= in index.html (top bar etc). Without these the buttons do nothing or "not defined" after navigation.
  if (typeof toggleSidebar === 'function') window.toggleSidebar = toggleSidebar;
  if (typeof reloadCurrentWindow === 'function') window.reloadCurrentWindow = reloadCurrentWindow;
  if (typeof performSearch === 'function') window.performSearch = performSearch;
  if (typeof showInsertForm === 'function') window.showInsertForm = showInsertForm;
  if (typeof showUpdateForm === 'function') window.showUpdateForm = showUpdateForm;
  if (typeof deleteSelectedRow === 'function') window.deleteSelectedRow = deleteSelectedRow;
  if (typeof exportCurrentCsv === 'function') window.exportCurrentCsv = exportCurrentCsv;
  if (typeof exportCurrentXlsx === 'function') window.exportCurrentXlsx = exportCurrentXlsx;
  if (typeof toggleFilters === 'function') window.toggleFilters = toggleFilters;
  // logout is assigned inside init as window.logout = ...
  if (typeof window.logout === 'function') {
    // already set
  }
} catch (e) {
  console.warn('Could not attach some window globals', e);
}

// Last-resort wiring for the static top-bar buttons (in case init hasn't attached yet or multiple loads)
function __wireTopBar() {
  try {
    const t = document.getElementById('top-toggle-btn');
    if (t && !t.__wired) { t.__wired = true; t.onclick = () => { if (typeof toggleSidebar === 'function') toggleSidebar(); }; }
    const r = document.getElementById('reload-btn');
    if (r && !r.__wired) { r.__wired = true; r.onclick = () => { if (typeof reloadCurrentWindow === 'function') reloadCurrentWindow(); }; }
  } catch(_) {}
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', __wireTopBar, {once:true});
} else {
  __wireTopBar();
}
setTimeout(__wireTopBar, 300);
