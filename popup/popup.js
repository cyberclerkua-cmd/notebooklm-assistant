/* NotebookLM Assistant v3.0 — Popup Logic */

// ─── Helpers ───
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);
const bg = (cmd, params = {}) => chrome.runtime.sendMessage({ cmd, params });

// i18n helper — returns the key itself if I18n isn't ready / key missing
function t(key, substitutions = {}) {
  if (typeof I18n !== 'undefined' && typeof I18n.get === 'function') {
    return I18n.get(key, substitutions);
  }
  return key;
}

function showStatus(elId, msg, type, duration = 4000) {
  const el = $(elId);
  if (!el) return;
  el.textContent = msg;
  el.className = `status show ${type}`;
  if (duration > 0) setTimeout(() => { el.className = 'status'; }, duration);
}

// Escapes <, >, &, " and ' so the output is safe in BOTH text content AND
// double-quoted attribute values (e.g. data-url="${escapeHtml(u)}").
function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return new Date(ts).toLocaleDateString();
}

// Source type → icon mapping
const sourceIcons = {
  google_docs: 'ms-description',
  google_other: 'ms-cloud',
  pdf: 'ms-picture_as_pdf',
  pasted_text: 'ms-edit_note',
  web_page: 'ms-language',
  generated_text: 'ms-auto_fix_high',
  youtube: 'ms-smart_display',
  uploaded_file: 'ms-upload_file',
  image: 'ms-image',
  word_doc: 'ms-article',
  unknown: 'ms-help_outline'
};

// ─── State ───
let currentNotebookId = null;
let parseTimer = null;

// ═══════════════════════════════════════
// TAB NAVIGATION
// ═══════════════════════════════════════
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $(`#panel-${tab.dataset.tab}`).classList.add('active');

    // Lazy-load data when tab activated
    if (tab.dataset.tab === 'queue') loadQueue();
    if (tab.dataset.tab === 'organize') loadSources();
    if (tab.dataset.tab === 'history') loadHistory();
    if (tab.dataset.tab === 'parsers') checkYouTubeTab();
  });
});

// ═══════════════════════════════════════
// THEME
// ═══════════════════════════════════════
async function initTheme() {
  const data = await chrome.storage.sync.get(['theme']);
  const theme = data.theme || 'light';
  applyTheme(theme);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const headerSel = $('#theme-select');
  if (headerSel) headerSel.value = theme;
  $('#settings-theme').value = theme;
  // Sync to content script
  chrome.tabs.query({ url: 'https://notebooklm.google.com/*' }, tabs => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { cmd: 'set-theme', theme }).catch(() => {});
    });
  });
}

// Theme only controlled from Settings tab
$('#settings-theme').addEventListener('change', async (e) => {
  const theme = e.target.value;
  try {
    await chrome.storage.sync.set({ theme });
  } catch (err) {
    showStatus('#home-status', `Error saving theme: ${escapeHtml(err.message)}`, 'error');
    return;
  }
  applyTheme(theme);
});

// ═══════════════════════════════════════
// i18n
// ═══════════════════════════════════════
async function initI18n() {
  if (typeof I18n !== 'undefined') {
    await I18n.init();
  }
}

// ═══════════════════════════════════════
// ACCOUNTS
// ═══════════════════════════════════════
async function loadAccounts() {
  const select = $('#account-select');
  select.innerHTML = '<option value="">Loading...</option>';
  try {
    const accounts = await bg('list-accounts');
    select.innerHTML = '';
    if (Array.isArray(accounts) && accounts.length > 0) {
      // Read the persisted active account (DO NOT hardcode 0 anymore)
      let activeAuthuser = 0;
      try {
        const active = await bg('get-active-account');
        if (active && typeof active.authuser === 'number') {
          activeAuthuser = active.authuser;
        }
      } catch (_) {
        // Background may be older version (no get-active-account); fall back to 0
      }

      accounts.forEach(acc => {
        const opt = document.createElement('option');
        opt.value = acc.authuser;
        opt.textContent = `${acc.name || acc.email} (${acc.email})`;
        select.appendChild(opt);
      });

      // Select the persisted account if present in the list, else the first one
      const exists = accounts.some(a => Number(a.authuser) === Number(activeAuthuser));
      const selectedAuthuser = exists ? Number(activeAuthuser) : Number(accounts[0].authuser);
      select.value = String(selectedAuthuser);

      // Sync background's in-memory currentAuthuser with the persisted value
      try {
        await bg('set-active-account', { authuser: selectedAuthuser });
      } catch (_) {
        // Background may not yet support set-active-account; fall back silently
        try {
          await bg('set-authuser', { authuser: selectedAuthuser });
        } catch (_) { /* ignore */ }
      }
      await loadNotebooks();
    } else {
      select.innerHTML = '<option value="">No accounts found</option>';
    }
  } catch (e) {
    select.innerHTML = '<option value="">Error loading accounts</option>';
    showStatus('#home-status', `Error: ${escapeHtml(e.message)}`, 'error');
  }
}

$('#account-select').addEventListener('change', async (e) => {
  const authuser = parseInt(e.target.value) || 0;
  try {
    try {
      await bg('set-active-account', { authuser });
    } catch (_) {
      // Fall back to legacy command if background doesn't support the new one
      await bg('set-authuser', { authuser });
    }
    await loadNotebooks();
  } catch (err) {
    showStatus('#home-status', `Error: ${escapeHtml(err.message)}`, 'error');
  }
});

// ═══════════════════════════════════════
// NOTEBOOKS
// ═══════════════════════════════════════
async function loadNotebooks() {
  const select = $('#notebook-select');
  select.innerHTML = '<option value="">Loading...</option>';
  try {
    const notebooks = await bg('list-notebooks');
    select.innerHTML = '<option value="">Select notebook...</option>';
    if (Array.isArray(notebooks)) {
      notebooks.forEach(nb => {
        const opt = document.createElement('option');
        opt.value = nb.id;
        opt.textContent = `${nb.emoji || ''} ${nb.title}`.trim();
        select.appendChild(opt);
      });
    }
    // Restore last selected
    const stored = await chrome.storage.local.get(['lastNotebookId']);
    if (stored.lastNotebookId) {
      select.value = stored.lastNotebookId;
      // Verify the option actually exists in the list
      if (select.value === stored.lastNotebookId) {
        currentNotebookId = stored.lastNotebookId;
      } else {
        // Notebook was deleted or belongs to different account
        currentNotebookId = null;
        await chrome.storage.local.remove(['lastNotebookId']);
      }
    }
  } catch (e) {
    select.innerHTML = '<option value="">Error — are you logged in?</option>';
  }
}

$('#notebook-select').addEventListener('change', async (e) => {
  currentNotebookId = e.target.value;
  try {
    await chrome.storage.local.set({ lastNotebookId: currentNotebookId });
  } catch (err) {
    showStatus('#home-status', `Error: ${escapeHtml(err.message)}`, 'error');
  }
});

$('#refresh-notebooks').addEventListener('click', loadNotebooks);

// ─── Create notebook ───
$('#create-notebook').addEventListener('click', async () => {
  const title = $('#new-notebook-title').value.trim();
  if (!title) return;
  showStatus('#home-status', 'Creating...', 'info', 0);
  try {
    const result = await bg('create-notebook', { title });
    if (result && result.id) {
      showStatus('#home-status', `Created: ${title}`, 'success');
      $('#new-notebook-title').value = '';
      loadNotebooks();
    } else {
      showStatus('#home-status', 'Could not create notebook', 'error');
    }
  } catch (e) {
    showStatus('#home-status', `Error: ${escapeHtml(e.message)}`, 'error');
  }
});

// ═══════════════════════════════════════
// HOME — ADD ACTIONS
// ═══════════════════════════════════════
function requireNotebook() {
  if (!currentNotebookId) {
    showStatus('#home-status', 'Please select a notebook first', 'warning');
    return false;
  }
  return true;
}

// Add current page
$('#add-current-page').addEventListener('click', async () => {
  if (!requireNotebook()) return;
  showStatus('#home-status', t('statusAdding'), 'info', 0);
  try {
    const tab = await bg('get-current-tab');
    await bg('add-source', { notebookId: currentNotebookId, url: tab.url });
    showStatus('#home-status', `${t('statusAdded')} ${escapeHtml(tab.title || '')}`, 'success');
  } catch (e) {
    showStatus('#home-status', `Error: ${escapeHtml(e.message)}`, 'error');
  }
});

// Add as PDF
$('#add-as-pdf').addEventListener('click', async () => {
  if (!requireNotebook()) return;
  showStatus('#home-status', 'Capturing PDF...', 'info', 0);
  try {
    const tab = await bg('get-current-tab');
    await bg('add-as-pdf', { notebookId: currentNotebookId, tabId: tab.id, title: tab.title });
    showStatus('#home-status', `PDF saved: ${escapeHtml(tab.title || '')}`, 'success');
  } catch (e) {
    showStatus('#home-status', `Error: ${escapeHtml(e.message)}`, 'error');
  }
});

// Add single URL
$('#add-single-url').addEventListener('click', async () => {
  if (!requireNotebook()) return;
  const url = $('#single-url').value.trim();
  if (!url) return;
  showStatus('#home-status', t('statusAdding'), 'info', 0);
  try {
    await bg('add-source', { notebookId: currentNotebookId, url });
    showStatus('#home-status', t('statusAdded'), 'success');
    $('#single-url').value = '';
  } catch (e) {
    showStatus('#home-status', `Error: ${escapeHtml(e.message)}`, 'error');
  }
});

// Bulk import — add directly
$('#bulk-add').addEventListener('click', async () => {
  if (!requireNotebook()) return;
  const urls = $('#bulk-urls').value.trim().split('\n').map(u => u.trim()).filter(u => u);
  if (!urls.length) return;
  showStatus('#home-status', `Adding ${urls.length} URLs...`, 'info', 0);
  try {
    await bg('add-sources', { notebookId: currentNotebookId, urls });
    showStatus('#home-status', `Added ${urls.length} sources!`, 'success');
    $('#bulk-urls').value = '';
  } catch (e) {
    showStatus('#home-status', `Error: ${escapeHtml(e.message)}`, 'error');
  }
});

// Bulk import — add to queue
$('#bulk-queue').addEventListener('click', async () => {
  const urls = $('#bulk-urls').value.trim().split('\n').map(u => u.trim()).filter(u => u);
  if (!urls.length) return;
  try {
    await bg('add-to-queue', { items: urls.map(url => ({ url })) });
    showStatus('#home-status', `${urls.length} URLs added to queue`, 'success');
    $('#bulk-urls').value = '';
  } catch (e) {
    showStatus('#home-status', `Error: ${escapeHtml(e.message)}`, 'error');
  }
});

// Open the full-page tab manager (app/app.html)
$('#import-tabs').addEventListener('click', () => {
  try {
    chrome.tabs.create({ url: chrome.runtime.getURL('app/app.html') });
  } catch (e) {
    showStatus('#home-status', `Error: ${escapeHtml(e.message)}`, 'error');
  }
});

// ═══════════════════════════════════════
// PARSERS — YouTube Comments
// ═══════════════════════════════════════
async function checkYouTubeTab() {
  const info = $('#yt-info');
  let tab;
  try {
    tab = await bg('get-current-tab');
  } catch (e) {
    info.style.display = 'block';
    info.innerHTML = `<i class="ms ms-info" style="font-size:14px;vertical-align:middle"></i> ${escapeHtml(t('statusError') + ': ' + e.message)}`;
    $('#start-parse').disabled = true;
    return;
  }
  if (tab && tab.url && tab.url.includes('youtube.com/watch')) {
    info.style.display = 'block';
    info.innerHTML = `<i class="ms ms-smart_display" style="font-size:14px;vertical-align:middle"></i> ${escapeHtml(tab.title)}`;
    $('#start-parse').disabled = false;
  } else {
    info.style.display = 'block';
    info.innerHTML = '<i class="ms ms-info" style="font-size:14px;vertical-align:middle"></i> Navigate to a YouTube video tab to parse comments';
    $('#start-parse').disabled = true;
  }
}

$('#start-parse').addEventListener('click', async () => {
  if (!requireNotebook()) return;
  let tab;
  try {
    tab = await bg('get-current-tab');
  } catch (e) {
    showStatus('#home-status', `Error: ${escapeHtml(e.message)}`, 'error');
    return;
  }
  if (!tab || !tab.url || !tab.url.includes('youtube.com/watch')) return;

  // Extract video ID
  const vMatch = tab.url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (!vMatch) return;

  // Save settings
  try {
    await chrome.storage.local.set({
      commentsMode: $('#comments-mode').value,
      commentsLimit: parseInt($('#comments-limit').value) || 1000,
      commentsIncludeReplies: $('#comments-replies').checked
    });
  } catch (e) {
    showStatus('#home-status', `Error: ${escapeHtml(e.message)}`, 'error');
    return;
  }

  try {
    const result = await bg('parse-comments', {
      notebookId: currentNotebookId,
      videoId: vMatch[1],
      tabId: tab.id
    });

    if (result && result.error) {
      showStatus('#home-status', `Error: ${escapeHtml(String(result.error))}`, 'error');
      return;
    }

    // Show progress
    $('#parse-progress').style.display = 'flex';
    $('#start-parse').style.display = 'none';
    startParsePolling();
  } catch (e) {
    showStatus('#home-status', `Error: ${escapeHtml(e.message)}`, 'error');
  }
});

$('#cancel-parse').addEventListener('click', async () => {
  try {
    await bg('cancel-parse');
  } catch (e) {
    showStatus('#home-status', `Error: ${escapeHtml(e.message)}`, 'error');
  }
  stopParsePolling();
  $('#parse-progress').style.display = 'none';
  $('#start-parse').style.display = '';
});

function startParsePolling() {
  stopParsePolling();
  parseTimer = setInterval(async () => {
    const fill = $('#parse-fill');
    const text = $('#parse-text');
    let status;
    try {
      status = await bg('get-parse-status');
    } catch (e) {
      // Background unreachable — keep polling, surface error
      text.textContent = `Error: ${escapeHtml(e.message)}`;
      return;
    }
    if (!status || !status.progress) return;

    if (!status.active && status.progress.phase === 'done') {
      stopParsePolling();
      fill.style.width = '100%';
      const r = status.result || {};
      const sentParts = r.sentPartCount !== undefined ? r.sentPartCount : r.partCount;
      text.innerHTML = `<span style="color:var(--success,#16a34a)">✓ Done!</span> ${r.commentCount || 0} comments, ${sentParts}/${r.partCount || 0} parts added to notebook`;
      showStatus('#home-status', `✓ ${r.commentCount || 0} comments added to notebook (${sentParts} part${sentParts !== 1 ? 's' : ''})`, 'success');
      setTimeout(() => {
        $('#parse-progress').style.display = 'none';
        $('#start-parse').style.display = '';
      }, 6000);
      return;
    }

    if (!status.active && (status.progress.phase === 'error' || status.progress.phase === 'cancelled')) {
      stopParsePolling();
      const errMsg = status.error ? (status.error.message || 'Unknown error') : 'Cancelled';
      if (status.progress.phase === 'error') {
        text.innerHTML = `<span style="color:var(--danger,#dc2626)">✗ Error: ${escapeHtml(errMsg)}</span>`;
        showStatus('#home-status', `✗ Comments not added: ${escapeHtml(errMsg)}`, 'error');
      } else {
        text.textContent = 'Cancelled';
      }
      setTimeout(() => {
        $('#parse-progress').style.display = 'none';
        $('#start-parse').style.display = '';
      }, 5000);
      return;
    }

    // Update progress
    const fetched = status.progress.fetched || 0;
    const total = status.progress.total || 0;
    const pct = total > 0 ? Math.min(Math.round(fetched / total * 100), 95) : 0;
    fill.style.width = (status.progress.phase === 'sending' ? '90%' : status.progress.phase === 'formatting' ? '85%' : pct + '%');

    const phases = {
      fetching: `Fetching comments... ${fetched}${total ? '/' + total : ''}`,
      fetching_replies: `Fetching replies... ${fetched}`,
      formatting: 'Formatting to Markdown...',
      sending: 'Sending to NotebookLM...'
    };
    text.textContent = phases[status.progress.phase] || status.progress.phase;
  }, 1000);
}

function stopParsePolling() {
  if (parseTimer) { clearInterval(parseTimer); parseTimer = null; }
}

// Restore in-progress parse UI on popup reopen (MV3 service-worker may keep
// a long parse running across popup close/reopen cycles).
async function restoreParseProgress() {
  let status;
  try {
    status = await bg('get-parse-status');
  } catch (_) {
    return;
  }
  if (!status || !status.active || !status.progress) return;
  // A parse is in progress — show the progress UI and resume polling
  const progressEl = $('#parse-progress');
  const startBtn = $('#start-parse');
  if (!progressEl || !startBtn) return;
  progressEl.style.display = 'flex';
  startBtn.style.display = 'none';
  startParsePolling();
}

// ═══════════════════════════════════════
// PARSERS — RSS / Sitemap
// ═══════════════════════════════════════
// Shared helper: wire up the "Add selected to queue" button inside #rss-results
function wireRssAddSelected(container) {
  const btn = container.querySelector('#rss-add-selected');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    try {
      const checked = container.querySelectorAll('.rss-cb:checked');
      const items = Array.from(checked).map(cb => ({
        url: cb.dataset.url || '',
        title: cb.dataset.title || ''
      })).filter(it => it.url);
      if (!items.length) return;
      btn.disabled = true;
      await bg('add-to-queue', { items });
      showStatus('#home-status', `${items.length} RSS items added to queue`, 'success');
      btn.disabled = false;
    } catch (err) {
      showStatus('#home-status', `Error: ${escapeHtml(err.message)}`, 'error');
      btn.disabled = false;
    }
  });
}

// Render an RSS feed's items into #rss-results with checkboxes + add-to-queue button
function renderRssItems(container, feed) {
  const items = (feed && Array.isArray(feed.items)) ? feed.items : [];
  if (!items.length) {
    container.innerHTML = `<div class="text-muted text-center">${escapeHtml(t('rssNoItems'))}</div>`;
    return;
  }
  const countText = t('rssItemsFound', { COUNT: items.length });
  container.innerHTML = `
    ${feed.title ? `<div style="margin-bottom:4px;font-weight:600">${escapeHtml(feed.title)}</div>` : ''}
    ${feed.description ? `<div style="margin-bottom:6px;font-size:12px;color:var(--text-secondary)">${escapeHtml(feed.description)}</div>` : ''}
    <div style="margin-bottom:6px;font-size:12px;color:var(--text-secondary)">${escapeHtml(countText)}</div>
    ${items.map(item => `
      <div class="result-item">
        <input type="checkbox" class="rss-cb" data-url="${escapeHtml(item.url || '')}" data-title="${escapeHtml(item.title || '')}" checked>
        <i class="ms ms-rss_feed" style="font-size:14px;color:var(--accent)"></i>
        <span class="title">${escapeHtml(item.title || item.url || '')}</span>
      </div>
    `).join('')}
    <button class="btn btn-primary btn-full mt-8" id="rss-add-selected">
      <i class="ms ms-add"></i> ${escapeHtml(t('addToQueue'))}
    </button>
  `;
  wireRssAddSelected(container);
}

$('#rss-parse').addEventListener('click', async () => {
  const url = $('#rss-url').value.trim();
  if (!url) return;
  const container = $('#rss-results');

  // Validate URL first
  let origin;
  try {
    origin = new URL(url).origin + '/*';
  } catch (_) {
    container.innerHTML = '<div class="text-muted text-center">Invalid URL</div>';
    return;
  }

  // chrome.permissions.request() MUST run in the direct user-gesture chain.
  // Do NOT await anything else before this — check + request permission first.
  let hasPermission = false;
  try {
    hasPermission = await chrome.permissions.contains({ origins: [origin] });
  } catch (_) {
    hasPermission = false;
  }

  if (!hasPermission) {
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [origin] });
    } catch (_) {
      granted = false;
    }
    if (!granted) {
      container.innerHTML = `<div class="text-muted text-center">${escapeHtml(t('rssPermissionNeeded'))}</div>`;
      return;
    }
  }

  container.innerHTML = '<div class="text-muted text-center">Parsing...</div>';
  try {
    const feed = await bg('parse-rss', { url });
    renderRssItems(container, feed);
  } catch (e) {
    container.innerHTML = `<div class="text-muted text-center">Error: ${escapeHtml(e.message)}</div>`;
  }
});

$('#rss-detect').addEventListener('click', async () => {
  const container = $('#rss-results');
  container.innerHTML = '<div class="text-muted text-center">Detecting...</div>';
  let tab;
  try {
    tab = await bg('get-current-tab');
  } catch (e) {
    container.innerHTML = `<div class="text-muted text-center">Error: ${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!tab) {
    container.innerHTML = '<div class="text-muted text-center">No active tab</div>';
    return;
  }
  let feeds;
  try {
    feeds = await bg('detect-rss', { tabId: tab.id });
  } catch (e) {
    container.innerHTML = `<div class="text-muted text-center">Error: ${escapeHtml(e.message)}</div>`;
    return;
  }

  if (!feeds || !feeds.length) {
    container.innerHTML = '<div class="text-muted text-center">No RSS feeds found on this page</div>';
    return;
  }

  // Render detected feeds as a synthetic feed list with checkboxes + add-to-queue button
  container.innerHTML = `
    <div style="margin-bottom:6px;font-size:12px;color:var(--text-secondary)">${feeds.length} feeds found</div>
    ${feeds.map(f => `
      <div class="result-item">
        <input type="checkbox" class="rss-cb" data-url="${escapeHtml(f.url || '')}" data-title="${escapeHtml(f.title || '')}" checked>
        <i class="ms ms-rss_feed" style="font-size:14px;color:var(--accent)"></i>
        <span class="title">${escapeHtml(f.title || '')}</span>
        <span class="url">${escapeHtml(f.url || '')}</span>
      </div>
    `).join('')}
    <button class="btn btn-primary btn-full mt-8" id="rss-add-selected">
      <i class="ms ms-add"></i> ${escapeHtml(t('addToQueue'))}
    </button>
  `;
  wireRssAddSelected(container);
});

// ═══════════════════════════════════════
// PARSERS — YouTube Playlist / Links
// ═══════════════════════════════════════
$('#yt-extract').addEventListener('click', async () => {
  const container = $('#yt-results');
  container.innerHTML = '<div class="text-muted text-center">Extracting...</div>';
  let tab;
  try {
    tab = await bg('get-current-tab');
  } catch (e) {
    container.innerHTML = `<div class="text-muted text-center">Error: ${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!tab) {
    container.innerHTML = '<div class="text-muted text-center">No active tab</div>';
    return;
  }
  let urls;
  try {
    urls = await bg('extract-yt-urls', { tabId: tab.id });
  } catch (e) {
    container.innerHTML = `<div class="text-muted text-center">Error: ${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!Array.isArray(urls) || !urls.length) {
    container.innerHTML = '<div class="text-muted text-center">No YouTube links found</div>';
    return;
  }

  container.innerHTML = `
    <div style="margin-bottom:6px;font-size:12px;color:var(--text-secondary)">${urls.length} videos found</div>
    ${urls.map(u => `
      <div class="result-item">
        <input type="checkbox" class="yt-cb" data-url="${escapeHtml(u)}" checked>
        <i class="ms ms-smart_display" style="font-size:14px;color:var(--danger)"></i>
        <span class="title">${escapeHtml(u)}</span>
      </div>
    `).join('')}
    <button class="btn btn-primary btn-full mt-8" id="yt-add-selected">
      <i class="ms ms-add"></i> ${escapeHtml(t('addToQueue'))}
    </button>
  `;

  container.querySelector('#yt-add-selected')?.addEventListener('click', async () => {
    const btn = container.querySelector('#yt-add-selected');
    try {
      const checked = container.querySelectorAll('.yt-cb:checked');
      const items = Array.from(checked).map(cb => ({ url: cb.dataset.url })).filter(it => it.url);
      if (items.length) {
        btn.disabled = true;
        await bg('add-to-queue', { items });
        showStatus('#home-status', `${items.length} videos added to queue`, 'success');
        btn.disabled = false;
      }
    } catch (err) {
      showStatus('#home-status', `Error: ${escapeHtml(err.message)}`, 'error');
      btn.disabled = false;
    }
  });
});

$('#extract-links').addEventListener('click', async () => {
  const container = $('#links-results');
  container.innerHTML = '<div class="text-muted text-center">Extracting...</div>';
  let tab;
  try {
    tab = await bg('get-current-tab');
  } catch (e) {
    container.innerHTML = `<div class="text-muted text-center">Error: ${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!tab) {
    container.innerHTML = '<div class="text-muted text-center">No active tab</div>';
    return;
  }
  let links;
  try {
    links = await bg('extract-links', { tabId: tab.id });
  } catch (e) {
    container.innerHTML = `<div class="text-muted text-center">Error: ${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!Array.isArray(links) || !links.length) {
    container.innerHTML = '<div class="text-muted text-center">No links found</div>';
    return;
  }

  container.innerHTML = `
    <div style="margin-bottom:6px;font-size:12px;color:var(--text-secondary)">${links.length} links found</div>
    ${links.slice(0, 50).map(l => `
      <div class="result-item">
        <input type="checkbox" class="link-cb" data-url="${escapeHtml(l.url || '')}">
        <i class="ms ms-link" style="font-size:14px"></i>
        <span class="title">${escapeHtml(l.title || '')}</span>
      </div>
    `).join('')}
    ${links.length > 50 ? `<div class="text-muted text-center">...and ${links.length - 50} more</div>` : ''}
    <button class="btn btn-primary btn-full mt-8" id="links-add-selected">
      <i class="ms ms-add"></i> ${escapeHtml(t('addToQueue'))}
    </button>
  `;

  container.querySelector('#links-add-selected')?.addEventListener('click', async () => {
    const btn = container.querySelector('#links-add-selected');
    try {
      const checked = container.querySelectorAll('.link-cb:checked');
      const items = Array.from(checked).map(cb => ({ url: cb.dataset.url })).filter(it => it.url);
      if (items.length) {
        btn.disabled = true;
        await bg('add-to-queue', { items });
        showStatus('#home-status', `${items.length} links added to queue`, 'success');
        btn.disabled = false;
      }
    } catch (err) {
      showStatus('#home-status', `Error: ${escapeHtml(err.message)}`, 'error');
      btn.disabled = false;
    }
  });
});

// ═══════════════════════════════════════
// QUEUE
// ═══════════════════════════════════════
async function loadQueue() {
  const list = $('#queue-list');
  const count = $('#queue-count');
  let queue;
  try {
    queue = await bg('get-queue');
  } catch (e) {
    count.textContent = '0';
    list.innerHTML = `<div class="text-muted text-center" style="padding:16px">Error: ${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!Array.isArray(queue)) queue = [];
  count.textContent = queue.length;

  if (!queue.length) {
    list.innerHTML = '<div class="text-muted text-center" style="padding:16px">Queue is empty</div>';
    return;
  }

  list.innerHTML = queue.map((item, i) => `
    <div class="queue-item" data-idx="${i}">
      <i class="ms ms-link" style="font-size:14px;color:var(--accent)"></i>
      <span class="title" title="${escapeHtml(item.url || '')}">${escapeHtml(item.title || item.url || '')}</span>
      <button class="remove" data-idx="${i}" title="Remove">&times;</button>
    </div>
  `).join('');

  // Remove individual items via background (atomic; avoids stale-closure
  // direct-write race that previously could lose items added concurrently).
  list.querySelectorAll('.remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.idx);
      if (Number.isNaN(idx)) return;
      try {
        await bg('remove-from-queue', { index: idx });
        // Re-render from the authoritative queue stored in background
        loadQueue();
      } catch (e) {
        showStatus('#queue-status', `Error: ${escapeHtml(e.message)}`, 'error');
      }
    });
  });
}

$('#process-queue').addEventListener('click', async () => {
  if (!requireNotebook()) return;
  showStatus('#queue-status', 'Processing queue...', 'info', 0);
  try {
    const result = await bg('process-queue', { notebookId: currentNotebookId });
    const processed = (result && typeof result.processed === 'number') ? result.processed : 0;
    const errors = (result && typeof result.errors === 'number') ? result.errors : 0;
    showStatus('#queue-status', `Done! ${processed} added, ${errors} errors`, errors ? 'warning' : 'success');
    loadQueue();
  } catch (e) {
    showStatus('#queue-status', `Error: ${escapeHtml(e.message)}`, 'error');
  }
});

$('#clear-queue').addEventListener('click', async () => {
  if (!confirm('Clear all queue items?')) return;
  try {
    await bg('clear-queue');
    loadQueue();
  } catch (e) {
    showStatus('#queue-status', `Error: ${escapeHtml(e.message)}`, 'error');
  }
});

// ═══════════════════════════════════════
// ORGANIZE — Sources
// ═══════════════════════════════════════
let currentSources = [];

async function loadSources() {
  if (!currentNotebookId) {
    $('#sources-list').innerHTML = '<div class="text-muted text-center" style="padding:16px">Select a notebook first</div>';
    return;
  }

  $('#sources-list').innerHTML = '<div class="text-muted text-center" style="padding:16px">Loading sources...</div>';

  try {
    const nb = await bg('get-notebook', { notebookId: currentNotebookId });
    currentSources = nb.sources || [];
    renderSources();
  } catch (e) {
    $('#sources-list').innerHTML = `<div class="text-muted text-center" style="padding:16px">Error: ${escapeHtml(e.message)}</div>`;
  }
}

function renderSources() {
  const list = $('#sources-list');
  if (!currentSources.length) {
    list.innerHTML = '<div class="text-muted text-center" style="padding:16px">No sources in this notebook</div>';
    return;
  }

  list.innerHTML = currentSources.map(s => `
    <div class="source-item" data-source-id="${escapeHtml(s.id || '')}">
      <input type="checkbox" class="source-cb" data-id="${escapeHtml(s.id || '')}">
      <i class="ms ${sourceIcons[s.type] || 'ms-help_outline'}"></i>
      <span class="title" title="${escapeHtml(s.url || '')}">${escapeHtml(s.title || '')}</span>
      <span class="type">${escapeHtml(s.type || '')}</span>
      ${s.canSync ? '<i class="ms ms-cloud_sync sync-badge" title="Drive source"></i>' : ''}
    </div>
  `).join('');

  // Update delete count on checkbox changes
  list.querySelectorAll('.source-cb').forEach(cb => {
    cb.addEventListener('change', updateDeleteCount);
  });
}

function updateDeleteCount() {
  const checked = $$('.source-cb:checked').length;
  const delBtn = $('#delete-selected');
  const countEl = $('#del-count');
  delBtn.style.display = checked > 0 ? '' : 'none';
  countEl.textContent = checked;
}

$('#refresh-sources').addEventListener('click', loadSources);

$('#select-all-sources').addEventListener('click', () => {
  const cbs = $$('.source-cb');
  const allChecked = Array.from(cbs).every(cb => cb.checked);
  cbs.forEach(cb => { cb.checked = !allChecked; });
  updateDeleteCount();
});

$('#delete-selected').addEventListener('click', async () => {
  const ids = Array.from($$('.source-cb:checked')).map(cb => cb.dataset.id);
  if (!ids.length || !currentNotebookId) return;
  if (!confirm(`Delete ${ids.length} sources?`)) return;

  showStatus('#organize-status', 'Deleting...', 'info', 0);
  try {
    await bg('delete-sources', { notebookId: currentNotebookId, sourceIds: ids });
    showStatus('#organize-status', `Deleted ${ids.length} sources`, 'success');
    loadSources();
  } catch (e) {
    showStatus('#organize-status', `Error: ${escapeHtml(e.message)}`, 'error');
  }
});

$('#sync-drive').addEventListener('click', async () => {
  if (!currentNotebookId) return;
  showStatus('#organize-status', 'Syncing Drive sources...', 'info', 0);
  try {
    const result = await bg('sync-drive-sources', { notebookId: currentNotebookId });
    const r = (result && result.results) || {};
    showStatus('#organize-status', `Sync: ${r.synced || 0} updated, ${r.fresh || 0} up-to-date, ${r.skipped || 0} skipped`, 'success');
  } catch (e) {
    showStatus('#organize-status', `Error: ${escapeHtml(e.message)}`, 'error');
  }
});

$('#export-sources').addEventListener('click', () => {
  if (!currentSources.length) return;
  const text = currentSources.map(s => `${s.title}\t${s.type}\t${s.url || ''}`).join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'notebooklm-sources.txt';
  a.click();
  URL.revokeObjectURL(url);
});

// ═══════════════════════════════════════
// HISTORY
// ═══════════════════════════════════════
async function loadHistory() {
  const list = $('#history-list');
  let history;
  try {
    history = await bg('get-history');
  } catch (e) {
    list.innerHTML = `<div class="text-muted text-center" style="padding:16px">Error: ${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!Array.isArray(history) || !history.length) {
    list.innerHTML = '<div class="text-muted text-center" style="padding:16px">No history yet</div>';
    return;
  }

  renderHistory(history);
}

function renderHistory(history) {
  const list = $('#history-list');
  list.innerHTML = history.map(h => {
    const iconMap = {
      add_source: 'ms-add_link',
      add_text: 'ms-edit_note',
      add_pdf: 'ms-picture_as_pdf',
      delete_source: 'ms-delete',
      delete_sources: 'ms-delete_sweep',
      error: 'ms-error'
    };
    const iconCls = iconMap[h.action] || 'ms-info';
    const detail = h.url || h.title || `${h.count || 1} sources`;
    return `
      <div class="history-item">
        <i class="ms ${iconCls}"></i>
        <div class="details">${escapeHtml(detail)}</div>
        <span class="time">${timeAgo(h.timestamp)}</span>
      </div>
    `;
  }).join('');
}

// Debounced history search (avoids spamming background with get-history
// on every keystroke).
let historySearchTimer = null;
$('#history-search').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  if (historySearchTimer) clearTimeout(historySearchTimer);
  historySearchTimer = setTimeout(async () => {
    let history;
    try {
      history = await bg('get-history');
    } catch (err) {
      $('#history-list').innerHTML = `<div class="text-muted text-center" style="padding:16px">Error: ${escapeHtml(err.message)}</div>`;
      return;
    }
    if (!Array.isArray(history)) history = [];
    const filtered = q ? history.filter(h =>
      (h.url || '').toLowerCase().includes(q) ||
      (h.title || '').toLowerCase().includes(q) ||
      (h.action || '').toLowerCase().includes(q)
    ) : history;
    renderHistory(filtered);
  }, 250);
});

$('#clear-history').addEventListener('click', async () => {
  if (!confirm('Clear all history?')) return;
  try {
    await bg('clear-history');
    loadHistory();
  } catch (e) {
    showStatus('#home-status', `Error: ${escapeHtml(e.message)}`, 'error');
  }
});

// ═══════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════
async function loadSettings() {
  let sync, local;
  try {
    sync = await chrome.storage.sync.get(['theme', 'language', 'enableBulkDelete', 'enableSyncDrive', 'enableNotifications']);
    local = await chrome.storage.local.get(['addDelay']);
  } catch (e) {
    showStatus('#home-status', `Error loading settings: ${escapeHtml(e.message)}`, 'error');
    return;
  }

  $('#settings-theme').value = sync.theme || 'light';
  $('#settings-lang').value = sync.language || 'en';
  $('#settings-delay').value = local.addDelay || 2000;
  $('#settings-bulk-delete').checked = sync.enableBulkDelete !== false;
  $('#settings-sync-drive').checked = sync.enableSyncDrive !== false;
  $('#settings-notifications').checked = sync.enableNotifications !== false;
}

// Auto-save all settings on change
['#settings-lang', '#settings-delay', '#settings-bulk-delete', '#settings-sync-drive', '#settings-notifications'].forEach(sel => {
  $(sel).addEventListener('change', saveSettings);
});

async function saveSettings() {
  try {
    await chrome.storage.sync.set({
      theme: $('#settings-theme').value,
      language: $('#settings-lang').value,
      enableBulkDelete: $('#settings-bulk-delete').checked,
      enableSyncDrive: $('#settings-sync-drive').checked,
      enableNotifications: $('#settings-notifications').checked
    });
    await chrome.storage.local.set({
      addDelay: parseInt($('#settings-delay').value) || 2000
    });
  } catch (e) {
    showStatus('#home-status', `Error saving settings: ${escapeHtml(e.message)}`, 'error');
    return;
  }

  // Apply language
  if (typeof I18n !== 'undefined') {
    try {
      await I18n.setLanguage($('#settings-lang').value);
    } catch (_) { /* ignore */ }
  }
}

// Backup
$('#backup-settings').addEventListener('click', async () => {
  try {
    const sync = await chrome.storage.sync.get(null);
    const local = await chrome.storage.local.get(null);
    const backup = { sync, local, version: '3.1.0', date: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nlm-assistant-backup-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showStatus('#home-status', 'Backup downloaded', 'success');
  } catch (e) {
    showStatus('#home-status', `Error: ${escapeHtml(e.message)}`, 'error');
  }
});

// Restore
$('#restore-settings').addEventListener('click', () => {
  $('#restore-file').click();
});

// Allowed keys for each storage area (defense-in-depth against crafted backups)
const ALLOWED_SYNC_KEYS = new Set([
  'theme', 'language', 'addDelay', 'enableBulkDelete', 'enableSyncDrive',
  'settingsNotifications', 'activeAccount'
]);
const ALLOWED_LOCAL_KEYS = new Set([
  'queue', 'history', 'commentsMode', 'commentsLimit', 'commentsReplies',
  'toolbarPosition', 'toolbarCollapsed', 'toolbarHidden'
]);

function filterAllowedKeys(obj, allowed) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of Object.keys(obj)) {
    if (allowed.has(k)) out[k] = obj[k];
  }
  return out;
}

$('#restore-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  // Always reset so the same file can be re-selected later
  e.target.value = '';
  if (!file) return;

  let backup;
  try {
    const text = await file.text();
    backup = JSON.parse(text);
  } catch (err) {
    showStatus('#home-status', `Invalid backup file: ${escapeHtml(err.message)}`, 'error');
    return;
  }

  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
    showStatus('#home-status', 'Invalid backup file: expected an object', 'error');
    return;
  }

  // Confirm overwrite before touching storage
  if (!confirm(t('confirmRestore'))) {
    return;
  }

  // Schema-validate: only allow known keys; reject anything else silently
  const syncPayload = filterAllowedKeys(backup.sync, ALLOWED_SYNC_KEYS);
  const localPayload = filterAllowedKeys(backup.local, ALLOWED_LOCAL_KEYS);

  try {
    if (Object.keys(syncPayload).length) {
      await chrome.storage.sync.set(syncPayload);
    }
    if (Object.keys(localPayload).length) {
      await chrome.storage.local.set(localPayload);
    }
    await loadSettings();
    await initTheme();
    showStatus('#home-status', 'Settings restored!', 'success');
  } catch (err) {
    showStatus('#home-status', `Restore failed: ${escapeHtml(err.message)}`, 'error');
  }
});

// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await initTheme();
  } catch (e) {
    console.error('initTheme failed:', e);
  }
  try {
    await initI18n();
  } catch (e) {
    console.error('initI18n failed:', e);
  }
  try {
    await loadSettings();
  } catch (e) {
    console.error('loadSettings failed:', e);
  }
  try {
    await loadAccounts();
  } catch (e) {
    console.error('loadAccounts failed:', e);
  }
  // Resume progress UI if a YouTube-comments parse is in progress on the
  // background service worker (MV3 SW outlives popup close/reopen).
  try {
    await restoreParseProgress();
  } catch (e) {
    console.error('restoreParseProgress failed:', e);
  }
});

// Catch unhandled promise rejections so they don't disappear silently.
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled rejection in popup:', event.reason);
});