/* NotebookLM Assistant v3.1.0 — Tab Import App
 * Fixes (Task 6):
 *  - Robust escapeHtml (escapes quotes for attribute-context safety).
 *  - bg(cmd, params) helper: returns a Promise, unwraps { result } envelope,
 *    throws on { error } envelope or when the SW is asleep (port closed).
 *  - loadTabs() wrapped in try/catch; shows error message + retry button on failure.
 *  - All dynamic strings (tab.favIconUrl, tab.title, tab.url) escaped.
 *  - All async handlers wrapped in try/catch with user-visible error messages.
 *  - I18n initialized on startup; language selector wired up.
 */

const tabList = document.getElementById('tab-list');
const notebookSelect = document.getElementById('notebook-select');
const countEl = document.getElementById('count');
const statusEl = document.getElementById('status');

let tabs = [];

// ─── Helpers ───

/**
 * Escape a string for safe insertion into HTML text or attributes.
 * Escapes: & < > " '  (FIX-SPEC rule #3 — MUST escape quotes).
 */
function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  const d = document.createElement('div');
  d.textContent = String(text);
  // d.innerHTML now has <, >, & escaped. Add quote escaping for attribute safety.
  return d.innerHTML
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Send a command to the background service worker.
 * Returns a Promise that resolves with the result and rejects on:
 *  - chrome.runtime.sendMessage rejection (SW asleep, port closed)
 *  - response envelope `{ error: ... }`
 * Unwraps the `{ result: ... }` envelope (FIX-SPEC contract) if present,
 * otherwise returns the raw response (legacy/actual background behavior).
 */
async function bg(cmd, params = {}) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ cmd, params });
  } catch (e) {
    // SW asleep, port closed, receiving end does not exist, etc.
    throw new Error(e && e.message ? e.message : String(e));
  }
  if (response && typeof response === 'object' && !Array.isArray(response) &&
      Object.prototype.hasOwnProperty.call(response, 'error')) {
    throw new Error(typeof response.error === 'string' ? response.error : JSON.stringify(response.error));
  }
  // Unwrap { result: ... } envelope (FIX-SPEC contract).
  if (response && typeof response === 'object' && !Array.isArray(response) &&
      Object.prototype.hasOwnProperty.call(response, 'result') &&
      Object.keys(response).length === 1) {
    return response.result;
  }
  return response;
}

/** Localized string helper — falls back to the key if i18n is not loaded. */
function t(key, substitutions = {}) {
  if (typeof I18n !== 'undefined' && typeof I18n.get === 'function') {
    return I18n.get(key, substitutions);
  }
  return key;
}

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + type;
}

/** Render a status message that may contain a single inline action button.
 *  `msg` is treated as plain text (escaped) and `actionHtml` is inserted raw.
 */
function showStatusWithAction(msg, type, actionHtml) {
  statusEl.innerHTML = '<span class="status-msg">' + escapeHtml(msg) + '</span>' + (actionHtml || '');
  statusEl.className = 'status ' + type;
  return statusEl;
}

function updateCount() {
  const checked = document.querySelectorAll('.tab-cb:checked').length;
  if (tabs.length === 0 && checked === 0) {
    countEl.textContent = t('tabsCount', { COUNT: 0 });
  } else {
    countEl.textContent = t('tabsSelectedCount', { CURRENT: checked, TOTAL: tabs.length });
  }
}

// ─── Tab loading ───

async function loadTabs() {
  tabList.innerHTML = '';
  try {
    const resp = await bg('get-open-tabs', {});
    tabs = Array.isArray(resp) ? resp : [];
  } catch (e) {
    tabs = [];
    const msg = t('failedLoadTabs', { MSG: (e && e.message) ? e.message : String(e) });
    showStatusWithAction(msg, 'error',
      ' <button class="btn btn-retry" id="retry-load-tabs" type="button">' +
      escapeHtml(t('retry')) + '</button>');
    const retryBtn = document.getElementById('retry-load-tabs');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        statusEl.className = 'status';
        statusEl.textContent = '';
        loadTabs();
      });
    }
    updateCount();
    return;
  }

  // Read + clear any pending URLs passed via context menu (legacy integration).
  // Wrap in try/catch so a storage hiccup doesn't break tab rendering.
  try {
    const stored = await chrome.storage.local.get(['pendingUrls']);
    if (stored.pendingUrls) {
      await chrome.storage.local.remove(['pendingUrls']);
    }
  } catch (e) {
    console.warn('Failed to clear pendingUrls:', e);
  }

  tabList.innerHTML = '';

  if (!tabs.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = t('noTabsFound');
    tabList.appendChild(empty);
    updateCount();
    return;
  }

  tabs.forEach((tab, i) => {
    const li = document.createElement('li');
    li.className = 'tab-item';
    // Build structure with innerHTML; every dynamic value is escapeHtml'd.
    li.innerHTML = `
      <input type="checkbox" class="tab-cb" data-idx="${i}" checked>
      <img src="${escapeHtml(tab.favIconUrl || 'icons/icon16.png')}" alt="">
      <span class="title">${escapeHtml(tab.title)}</span>
      <span class="url">${escapeHtml(tab.url)}</span>
    `;
    // Fallback icon on load error (CSP-safe, no inline handler).
    // Guard against infinite recursion if the fallback icon itself fails.
    const img = li.querySelector('img');
    img.addEventListener('error', function () {
      if (!this.dataset.fallback) {
        this.dataset.fallback = '1';
        this.src = 'icons/icon16.png';
      }
    });
    li.querySelector('.tab-cb').addEventListener('change', updateCount);
    tabList.appendChild(li);
  });

  updateCount();
}

// ─── Notebook loading ───

async function loadNotebooks() {
  try {
    const notebooks = await bg('list-notebooks', {});
    if (Array.isArray(notebooks)) {
      notebooks.forEach(nb => {
        const opt = document.createElement('option');
        opt.value = nb.id;
        opt.textContent = `${nb.emoji || ''} ${nb.title}`.trim();
        notebookSelect.appendChild(opt);
      });
    }
  } catch (e) {
    showStatus(t('failedLoadNotebooks'), 'error');
  }
}

// ─── Selection helpers ───

function getSelectedUrls() {
  const selected = [];
  document.querySelectorAll('.tab-cb:checked').forEach(cb => {
    const idx = parseInt(cb.dataset.idx, 10);
    if (!Number.isNaN(idx) && tabs[idx]) {
      selected.push({ url: tabs[idx].url, title: tabs[idx].title });
    }
  });
  return selected;
}

// ─── Event handlers (all wrapped in try/catch) ───

// Select all / Deselect all (toggle behavior preserved).
document.getElementById('select-all').addEventListener('click', () => {
  try {
    const cbs = document.querySelectorAll('.tab-cb');
    const allChecked = Array.from(cbs).every(cb => cb.checked);
    cbs.forEach(cb => { cb.checked = !allChecked; });
    updateCount();
  } catch (e) {
    showStatus(t('importError', { MSG: (e && e.message) ? e.message : String(e) }), 'error');
  }
});

// Add selected directly to notebook.
document.getElementById('add-selected').addEventListener('click', async () => {
  try {
    const nbId = notebookSelect.value;
    if (!nbId) {
      showStatus(t('selectNotebookFirst'), 'error');
      return;
    }

    const urls = getSelectedUrls();
    if (!urls.length) {
      showStatus(t('noTabsSelected'), 'error');
      return;
    }

    showStatus(t('importing', { COUNT: urls.length }), 'info');

    try {
      await bg('add-sources', {
        notebookId: nbId,
        urls: urls.map(u => u.url)
      });
      showStatus(t('importDone', { COUNT: urls.length }), 'success');
    } catch (e) {
      showStatus(t('importError', { MSG: (e && e.message) ? e.message : String(e) }), 'error');
    }
  } catch (e) {
    showStatus(t('importError', { MSG: (e && e.message) ? e.message : String(e) }), 'error');
  }
});

// Add to queue.
document.getElementById('add-as-queue').addEventListener('click', async () => {
  try {
    const urls = getSelectedUrls();
    if (!urls.length) {
      showStatus(t('noTabsSelected'), 'error');
      return;
    }

    try {
      await bg('add-to-queue', { items: urls });
      showStatus(t('addedToQueue', { COUNT: urls.length }), 'success');
    } catch (e) {
      showStatus(t('importError', { MSG: (e && e.message) ? e.message : String(e) }), 'error');
    }
  } catch (e) {
    showStatus(t('importError', { MSG: (e && e.message) ? e.message : String(e) }), 'error');
  }
});

// ─── Language selector ───

function setupLanguageSelector() {
  const langSelect = document.getElementById('lang-select');
  if (!langSelect) return;
  if (typeof I18n !== 'undefined') {
    langSelect.value = I18n.getLanguage();
  }
  langSelect.addEventListener('change', async () => {
    try {
      if (typeof I18n !== 'undefined') {
        await I18n.setLanguage(langSelect.value);
        // Re-render dynamic content with new language.
        updateCount();
        // Re-render the empty-state message if present.
        const empty = tabList.querySelector('.empty-state');
        if (empty && tabs.length === 0) {
          empty.textContent = t('noTabsFound');
        }
      }
    } catch (e) {
      console.error('Failed to set language:', e);
    }
  });
}

// ─── Init ───

(async function init() {
  // Initialize i18n first (non-blocking on failure — fall back to keys).
  try {
    if (typeof I18n !== 'undefined') {
      await I18n.init();
    }
  } catch (e) {
    console.error('i18n init failed:', e);
  }

  setupLanguageSelector();

  // Render the initial count label with the current language (before tabs load).
  updateCount();

  // Load data — each function has its own try/catch.
  loadTabs();
  loadNotebooks();
})();
