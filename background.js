/* NotebookLM Assistant v3.1.0 — Background Service Worker
 * Integrates: RPC API, PDF capture, YouTube comments, queue, history, hotkeys,
 *             multi-account persistence (MV3-safe), RSS parsing, crash-safe
 *             queue scheduling via chrome.alarms.
 *
 * v3.1.0 changes:
 *   - currentAuthuser persisted to chrome.storage.sync (key: activeAccount)
 *   - NotebookLMAPI.tokens tracks tokensAuthuser (cache per account)
 *   - parse-comments race fixed (synchronous parseState.active=true + parseId)
 *   - parseState mirrored to chrome.storage.session for SW-restart awareness
 *   - contextMenus.removeAll() before create() in onInstalled
 *   - processQueue rewritten to use chrome.alarms (crash-safe) + retry tracking
 *   - generatePdf wrapped in 30s Promise.race timeout + finally detach
 *   - notify() helper respects settingsNotifications setting
 *   - add-as-pdf hotkey shows start/done/error notifications
 *   - extractYouTubeUrls covers shorts/mobile/music/embed + iframes
 *   - queue items tracked by unique id (no more O(n²) indexOf)
 *   - new commands: remove-from-queue, parse-rss, get-active-account,
 *     set-active-account, retry-failed
 */

importScripts('lib/youtube-comments-api.js', 'lib/comments-to-md.js');

// ─── Fetch with timeout ───
async function fetchWithTimeout(url, options = {}, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return resp;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ─── NotebookLM RPC API (reverse-engineered, no public API) ───
const NotebookLMAPI = {
  tokens: {},
  tokensAuthuser: null,  // tracks which account the cached tokens belong to

  async getTokens(authuser = 0) {
    // Return cached tokens if they belong to the same account and are still valid.
    if (this.tokensAuthuser === authuser && this.tokens && this.tokens.SNlM0e && this.tokens.cfb2h) {
      return this.tokens;
    }

    const url = `https://notebooklm.google.com/?authuser=${authuser}`;
    const resp = await fetchWithTimeout(url, { credentials: 'include' });
    const html = await resp.text();

    const cfb2h = html.match(/"cfb2h":"([^"]+)"/);
    const snlm0e = html.match(/"SNlM0e":"([^"]+)"/);
    if (!cfb2h || !snlm0e) throw new Error('Could not extract NLM tokens. Are you logged in?');

    this.tokens = {
      cfb2h: cfb2h[1],
      SNlM0e: snlm0e[1],
      authuser
    };
    this.tokensAuthuser = authuser;
    return this.tokens;
  },

  extractNotebookIdFromUrl(url) {
    const match = url && url.match(/\/notebook\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  },

  // ─── Core RPC method ───
  async rpc(rpcId, params, sourcePath = '/') {
    if (!this.tokens.cfb2h) throw new Error('Not authenticated');

    const au = this.tokens.authuser || 0;
    const url = new URL('https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute');
    url.searchParams.set('rpcids', rpcId);
    url.searchParams.set('source-path', sourcePath);
    url.searchParams.set('f.sid', this.tokens.cfb2h);
    url.searchParams.set('hl', 'en');
    url.searchParams.set('authuser', au);
    url.searchParams.set('_reqid', Math.floor(Math.random() * 900000 + 100000));

    const body = new URLSearchParams({
      'f.req': JSON.stringify([[[rpcId, JSON.stringify(params), null, 'generic']]]),
      'at': this.tokens.SNlM0e
    });

    const resp = await fetchWithTimeout(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      credentials: 'include',
      body
    });

    if (!resp.ok) throw new Error(`RPC ${rpcId} failed: ${resp.status}`);
    return resp.text();
  },

  // ─── List Google accounts ───
  async listAccounts() {
    try {
      const resp = await fetchWithTimeout(
        'https://accounts.google.com/ListAccounts?json=standard&source=ogb&md=1&cc=1&mn=1&mo=1&gpsia=1&fwput=860&listPages=1&origin=https%3A%2F%2Fwww.google.com',
        { credentials: 'include' }
      );
      const text = await resp.text();

      // Response format: postMessage('...' , 'https://...')
      const match = text.match(/postMessage\('([^']*)'\s*,\s*'https:/);
      if (!match) {
        // Fallback: try direct JSON parse (older format)
        try {
          const clean = text.replace(/^[^[]*/, '');
          const data = JSON.parse(clean);
          if (Array.isArray(data) && Array.isArray(data[0])) {
            return data[0]
              .filter(acc => acc[3] && acc[3].includes('@'))
              .map((acc, idx) => ({ email: acc[3], name: acc[2] || '', photo: acc[4] || '', authuser: idx }));
          }
        } catch (e2) {}
        return [];
      }

      // Decode hex-escaped characters
      const decoded = match[1]
        .replace(/\\x5b/g, '[')
        .replace(/\\x5d/g, ']')
        .replace(/\\x22/g, '"');

      const parsed = JSON.parse(decoded);
      const accounts = parsed[1] || [];

      return accounts
        .filter(acc => acc[3] && acc[3].includes('@'))
        .map((acc, idx) => ({
          email: acc[3] || '',
          name: acc[2] || '',
          photo: acc[4] || '',
          authuser: idx
        }));
    } catch (e) {
      console.error('listAccounts error:', e);
      return [];
    }
  },

  // ─── Notebooks ───
  async listNotebooks() {
    const resp = await this.rpc('wXbhsf', [null, 1, null, [2]]);
    return this._parseNotebookList(resp);
  },

  _parseNotebookList(text) {
    try {
      const lines = text.split('\n');
      const dataLine = lines.find(l => l.includes('wrb.fr'));
      if (!dataLine) return [];
      const parsed = JSON.parse(dataLine);
      const inner = JSON.parse(parsed[0][2]);
      if (!inner || !inner[0]) return [];
      return inner[0]
        .filter(item => item && item.length >= 3)
        .map(item => ({
          id: item[2],
          title: (item[0] || '').trim() || 'Untitled',
          sources: Array.isArray(item[1]) ? item[1].length : 0,
          emoji: item[3] || ''
        }))
        .filter(nb => nb.id);
    } catch (e) {
      console.error('parseNotebookList error:', e);
      return [];
    }
  },

  async createNotebook(title, emoji) {
    const resp = await this.rpc('CCqFvf', [title]);
    // Extract notebook ID (UUID format) from response
    const uuidMatch = resp.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
    const id = uuidMatch ? uuidMatch[0] : this.extractNotebookIdFromUrl(resp);
    if (!id) throw new Error('Failed to create notebook');
    return { id, title, emoji };
  },

  // ─── Sources ───
  async addSource(notebookId, url) {
    return this.addSources(notebookId, [url]);
  },

  // YouTube URL detection — covers watch, shorts, embed, youtu.be,
  // m.youtube.com, music.youtube.com, youtube-nocookie.com.
  isYouTubeUrl(u) {
    if (!u) return false;
    return /^(https?:)?\/\/(www\.|m\.|music\.)?youtube(-nocookie)?\.com\/(watch|shorts|embed)\b/i.test(u)
      || /^(https?:)?\/\/youtu\.be\//i.test(u);
  },

  async addSources(notebookId, urls) {
    // Separate YouTube and regular URLs — they have different source formats
    const regularUrls = urls.filter(u => !this.isYouTubeUrl(u));
    const youtubeUrls = urls.filter(u => this.isYouTubeUrl(u));

    // Add regular URLs
    if (regularUrls.length) {
      const sources = regularUrls.map(u =>
        [null, null, [u], null, null, null, null, null]
      );
      await this.rpc('izAoDd', [sources, notebookId, [2], null, null], `/notebook/${notebookId}`);
    }

    // Add YouTube URLs (different format: 11-element array, URL at position [7])
    for (const u of youtubeUrls) {
      const source = [
        [null, null, null, null, null, null, null, [u], null, null, 1]
      ];
      await this.rpc('izAoDd', [
        source, notebookId, [2],
        [1, null, null, null, null, null, null, null, null, null, [1]]
      ], `/notebook/${notebookId}`);
    }
  },

  async addTextSource(notebookId, text, title = 'Imported content') {
    const source = [[[null, title, text]]];
    return this.rpc('izAoDd', [source, notebookId, [2], null, null], `/notebook/${notebookId}`);
  },

  // ─── PDF upload (3-step SCOTTY protocol) ───
  async registerPdfSource(notebookId, filename) {
    const resp = await this.rpc(
      'o4cbdc',
      [[[filename]], notebookId, [2], [1,null,null,null,null,null,null,null,null,null,[1]]],
      `/notebook/${notebookId}`
    );
    const lines = resp.split('\n');
    const dataLine = lines.find(l => l.includes('wrb.fr'));
    if (!dataLine) throw new Error('No response from registerPdfSource');
    const parsed = JSON.parse(dataLine);
    const inner = JSON.parse(parsed[0][2]);
    return inner[0][0][0];  // sourceId
  },

  async getUploadUrl(notebookId, filename, sourceId, byteLength) {
    const au = this.tokens.authuser || 0;
    const url = `https://notebooklm.google.com/upload/_/?authuser=${au}`;
    const metadata = JSON.stringify({
      PROJECT_ID: notebookId,
      SOURCE_NAME: filename,
      SOURCE_ID: sourceId
    });

    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'x-goog-upload-command': 'start',
        'x-goog-upload-header-content-length': byteLength.toString(),
        'x-goog-upload-protocol': 'resumable'
      },
      credentials: 'include',
      body: metadata
    });

    if (!resp.ok) throw new Error(`Failed to get upload URL: ${resp.status}`);
    const uploadUrl = resp.headers.get('x-goog-upload-url');
    if (!uploadUrl) throw new Error('No upload URL in response');
    return uploadUrl;
  },

  async uploadPdfBytes(uploadUrl, pdfBytes) {
    const resp = await fetchWithTimeout(uploadUrl, {
      method: 'POST',
      headers: {
        'x-goog-upload-command': 'upload, finalize',
        'x-goog-upload-offset': '0',
        'content-type': 'application/x-www-form-urlencoded;charset=utf-8'
      },
      body: pdfBytes
    });
    if (!resp.ok) throw new Error(`PDF upload failed: ${resp.status}`);
    return resp.text();
  },

  async addPdfSource(notebookId, pdfBase64, filename) {
    const sourceId = await this.registerPdfSource(notebookId, filename);
    const binStr = atob(pdfBase64);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
    const uploadUrl = await this.getUploadUrl(notebookId, filename, sourceId, bytes.byteLength);
    await this.uploadPdfBytes(uploadUrl, bytes);
    return { sourceId, filename };
  },

  // ─── Get notebook details + sources ───
  async getNotebook(notebookId) {
    const resp = await this.rpc('rLM1Ne', [notebookId, null, [2], null, 0], `/notebook/${notebookId}`);
    return this._parseNotebookDetails(resp);
  },

  _parseNotebookDetails(text) {
    try {
      const lines = text.split('\n');
      const dataLine = lines.find(l => l.includes('wrb.fr'));
      if (!dataLine) return { sources: [] };
      const parsed = JSON.parse(dataLine);
      const inner = JSON.parse(parsed[0][2]);
      if (!inner || !inner[0]) return { sources: [] };

      const nb = inner[0];
      const sourcesArr = Array.isArray(nb[1]) ? nb[1] : [];
      const typeNames = {
        1:'google_docs',2:'google_other',3:'pdf',4:'pasted_text',5:'web_page',
        8:'generated_text',9:'youtube',11:'uploaded_file',13:'image',14:'word_doc'
      };

      const sources = sourcesArr
        .filter(s => s && Array.isArray(s[0]) && s[0][0])
        .map(s => {
          const id = s[0][0];
          const title = s[1] || 'Untitled';
          const meta = Array.isArray(s[2]) ? s[2] : [];
          const typeCode = meta[4] || 0;
          const driveDocId = Array.isArray(meta[0]) ? meta[0][0] : null;
          const url = Array.isArray(meta[7]) ? meta[7][0] : null;
          return {
            id, title,
            type: typeNames[typeCode] || 'unknown',
            typeCode, url, driveDocId,
            canSync: driveDocId != null && (typeCode === 1 || typeCode === 2)
          };
        });

      return { id: nb[2] || null, title: nb[0] || '', sources };
    } catch (e) {
      console.error('parseNotebookDetails error:', e);
      return { sources: [] };
    }
  },

  // ─── Delete sources (batch, max 20 per call) ───
  async deleteSource(notebookId, sourceId) {
    return this.rpc('tGMBJ', [[[sourceId]]], `/notebook/${notebookId}`);
  },

  async deleteSources(notebookId, sourceIds) {
    const batchSize = 20;
    let deleted = 0;
    for (let i = 0; i < sourceIds.length; i += batchSize) {
      const batch = sourceIds.slice(i, i + batchSize).map(id => [id]);
      await this.rpc('tGMBJ', [batch], `/notebook/${notebookId}`);
      deleted += batch.length;
    }
    return { deleted };
  },

  // ─── Drive sync ───
  async checkSourceFreshness(sourceId, notebookId) {
    try {
      const resp = await this.rpc('yR9Yof', [null, [sourceId], [2]], `/notebook/${notebookId}`);
      const lines = resp.split('\n');
      const dataLine = lines.find(l => l.includes('wrb.fr'));
      if (!dataLine) return null;
      const parsed = JSON.parse(dataLine);
      const inner = JSON.parse(parsed[0][2]);
      if (!inner || !inner[0]) return null;
      return inner[0][0] === 1;  // 1 = fresh, 0 = stale
    } catch (e) {
      return null;
    }
  },

  async syncDriveSource(sourceId, notebookId) {
    return this.rpc('FLmJqe', [null, [sourceId], [2]], `/notebook/${notebookId}`);
  },

  getNotebookUrl(notebookId, authuser = 0) {
    return `https://notebooklm.google.com/notebook/${notebookId}?authuser=${authuser}`;
  }
};

// ─── PDF generation via Chrome Debugger (with 30s timeout) ───
async function generatePdf(tabId) {
  await chrome.debugger.attach({ tabId }, '1.3');
  let pendingTimer = null;
  try {
    const printPromise = chrome.debugger.sendCommand({ tabId }, 'Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
      marginTop: 0.4,
      marginBottom: 0.4,
      marginLeft: 0.4,
      marginRight: 0.4
    });
    const timeoutPromise = new Promise((_, reject) => {
      pendingTimer = setTimeout(
        () => reject(new Error('PDF generation timeout')),
        30000
      );
    });
    const result = await Promise.race([printPromise, timeoutPromise]);
    return result.data;  // base64
  } finally {
    if (pendingTimer) clearTimeout(pendingTimer);
    // Ensure debugger is always detached, even on timeout/error.
    try {
      await chrome.debugger.detach({ tabId });
    } catch (_) {
      // Already detached or attach failed — ignore.
    }
  }
}

async function addAsPdf(notebookId, tabId, title) {
  const pdfBase64 = await generatePdf(tabId);
  const safeBase = (title || 'page').replace(/[^a-zA-Z0-9_\- ]/g, '').trim() || 'page';
  const filename = safeBase.substring(0, 80) + '.pdf';
  await NotebookLMAPI.addPdfSource(notebookId, pdfBase64, filename);
  return { success: true, filename };
}

// ─── YouTube comments parsing (state machine) ───
let parseState = {
  active: false,
  parseId: null,
  videoId: null,
  progress: { fetched: 0, total: null, phase: 'idle' },
  cancelToken: null,
  error: null,
  result: null
};

// Mirror parseState to session storage so a SW restart is detectable.
// Note: a parse in progress will not resume automatically after SW death —
// the user must re-trigger it. This checkpoint is for observability only
// (get-parse-status can report "interrupted" state immediately after restart).
async function checkpointParseState() {
  try {
    await chrome.storage.session.set({
      parseStateCheckpoint: {
        active: parseState.active,
        parseId: parseState.parseId,
        videoId: parseState.videoId,
        phase: parseState.progress && parseState.progress.phase,
        error: parseState.error,
        result: parseState.result,
        ts: Date.now()
      }
    });
  } catch (_) { /* non-fatal */ }
}

async function doParseComments(notebookId, videoId, tabId, authuser, parseId) {
  const cancelToken = { cancelled: false };
  parseState = {
    active: true,
    parseId,
    videoId,
    progress: { fetched: 0, total: null, phase: 'fetching' },
    cancelToken, error: null, result: null
  };
  await checkpointParseState();

  try {
    // Phase 1: metadata from DOM
    const metadata = await YouTubeCommentsAPI.getVideoMetadataFromDOM(tabId, videoId);
    parseState.progress.total = metadata.commentCount;
    await checkpointParseState();
    if (cancelToken.cancelled) return;

    // Load settings
    const settings = await chrome.storage.local.get(['commentsMode', 'commentsLimit', 'commentsIncludeReplies']);
    const mode = settings.commentsMode || 'top';
    const includeReplies = settings.commentsIncludeReplies !== undefined ? settings.commentsIncludeReplies : (mode === 'top');
    const maxComments = mode === 'top' ? 0 : (settings.commentsLimit || 1000);

    // Phase 2: fetch via InnerTube
    const comments = await YouTubeCommentsAPI.fetchAllComments(videoId, {
      progressCallback: ({ fetched, phase }) => {
        parseState.progress.fetched = fetched;
        if (phase === 'fetching_replies') parseState.progress.phase = 'fetching_replies';
      },
      cancelToken, tabId, mode, maxComments, includeReplies
    });
    if (cancelToken.cancelled) return;

    // Phase 3: format to Markdown
    parseState.progress.phase = 'formatting';
    await checkpointParseState();
    const langStore = await chrome.storage.sync.get(['language']);
    const lang = langStore.language || 'en';
    const parts = CommentsToMd.format(metadata, comments, { lang });
    if (cancelToken.cancelled) return;

    // Phase 4: send to NLM — use captured authuser (not the global, which may
    // have been reset by SW restart).
    parseState.progress.phase = 'sending';
    await checkpointParseState();
    console.log(`[YT-Comments] Phase 4: sending ${parts.length} part(s) to notebook ${notebookId}`);
    await NotebookLMAPI.getTokens(authuser);
    for (let i = 0; i < parts.length; i++) {
      if (cancelToken.cancelled) return;
      console.log(`[YT-Comments] Sending part ${i + 1}/${parts.length}: title="${parts[i].title}", text length=${parts[i].text.length}`);
      try {
        const resp = await NotebookLMAPI.addTextSource(notebookId, parts[i].text, parts[i].title);
        // Check for error markers in the RPC response
        if (resp && (resp.includes('"error"') || resp.includes('er\"'))) {
          console.warn(`[YT-Comments] Part ${i + 1} response may contain error:`, resp.substring(0, 300));
        } else {
          console.log(`[YT-Comments] Part ${i + 1} sent OK, response length=${resp?.length || 0}`);
        }
      } catch (partErr) {
        console.error(`[YT-Comments] Failed to send part ${i + 1}:`, partErr);
        throw partErr;
      }
    }

    parseState.progress.phase = 'done';
    parseState.result = {
      commentCount: comments.length,
      totalComments: metadata.commentCount,
      partCount: parts.length,
      videoTitle: metadata.title
    };
    await checkpointParseState();
  } catch (e) {
    console.error('doParseComments error:', e);
    parseState.progress.phase = 'error';
    parseState.error = { code: e.code || 'UNKNOWN', message: e.message };
    await checkpointParseState();
  } finally {
    parseState.active = false;
    await checkpointParseState();
  }
}

// ─── State ───
let currentAuthuser = 0;

// Read active account from chrome.storage.sync (MV3-safe).
// Falls back to in-memory currentAuthuser (which itself defaults to 0).
async function getActiveAuthuser() {
  try {
    const data = await chrome.storage.sync.get(['activeAccount']);
    if (typeof data.activeAccount === 'number') {
      currentAuthuser = data.activeAccount;  // keep in-memory in sync
      return data.activeAccount;
    }
  } catch (_) { /* storage read failure — fall through to in-memory */ }
  return currentAuthuser;
}

// Persist active account to both chrome.storage.sync and in-memory.
async function setActiveAuthuser(authuser) {
  currentAuthuser = authuser;
  await chrome.storage.sync.set({ activeAccount: authuser });
}

// On SW startup: restore currentAuthuser from chrome.storage.sync.
// (chrome.storage is async, so we kick off the read immediately; downstream
// code that needs the persisted value uses getActiveAuthuser() which always
// re-reads and falls back gracefully.)
chrome.storage.sync.get(['activeAccount'], (result) => {
  currentAuthuser = (typeof result.activeAccount === 'number') ? result.activeAccount : 0;
});

// ─── Notifications helper (respects settingsNotifications) ───
async function notify(id, options) {
  try {
    const data = await chrome.storage.sync.get(['settingsNotifications']);
    // Default to true if unset (preserves existing behavior on first install).
    const enabled = data.settingsNotifications !== false;
    if (!enabled) return;
    const opts = {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: options.title || 'NotebookLM Assistant',
      message: options.message || ''
    };
    // chrome.notifications.create supports (id, options, callback). Use the
    // callback form to surface lastError instead of an unhandled rejection.
    chrome.notifications.create(id, opts, () => {
      if (chrome.runtime.lastError) {
        console.warn('notifications.create error:', chrome.runtime.lastError.message);
      }
    });
  } catch (e) {
    console.warn('notify error:', e);
  }
}

// ─── Queue management ───
// Queue item shape:
//   { id, url, title, addedAt, status, errorCount, lastError? }
//   status: 'pending' | 'error' | 'failed'
//   errorCount: number (after 3 retries → 'failed')

function makeQueueId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

async function getQueue() {
  const data = await chrome.storage.local.get(['queue']);
  const queue = data.queue || [];
  // Backfill missing fields for legacy items.
  for (const item of queue) {
    if (!item.id) item.id = makeQueueId();
    if (!item.status) item.status = 'pending';
    if (typeof item.errorCount !== 'number') item.errorCount = 0;
  }
  return queue;
}

async function addToQueue(items) {
  const queue = await getQueue();
  const now = Date.now();
  const newItems = items.map(item => ({
    id: makeQueueId(),
    url: item.url || item,
    title: item.title || '',
    addedAt: now,
    status: 'pending',
    errorCount: 0
  }));
  queue.push(...newItems);
  await chrome.storage.local.set({ queue });
  updateBadge(queue.length);
  return queue;
}

async function clearQueue() {
  await chrome.storage.local.set({ queue: [] });
  updateBadge(0);
}

// ─── Crash-safe queue processing via chrome.alarms ───
//
// Design:
//   - processQueue(notebookId) sets queueProcessing=true + queueNotebookId in
//     chrome.storage.session, then creates a one-shot alarm.
//   - chrome.alarms.onAlarm fires for each alarm; the handler processes ONE
//     pending queue item, marks it success/error, removes success items,
//     and re-arms a new alarm if more pending items remain.
//   - Errored items stay in the queue with status='error' and an
//     incrementing errorCount. After 3 retries, status becomes 'failed'
//     (kept for user inspection). 'retry-failed' command resets them.
//   - clearQueue still clears everything (including failed).
//   - On SW startup, we re-arm an alarm if queueProcessing was true (resume
//     after SW death).

const QUEUE_ALARM_PREFIX = 'process-queue-';
const MAX_QUEUE_RETRIES = 3;

async function processQueue(notebookId) {
  const queue = await getQueue();
  const pendingCount = queue.filter(i => i.status === 'pending').length;
  if (pendingCount === 0) {
    return { processed: 0, errors: 0, pending: 0 };
  }

  // Check session flag to prevent concurrent processing.
  const session = await chrome.storage.session.get(['queueProcessing']);
  if (session.queueProcessing) {
    return { error: 'Queue processing already in progress' };
  }

  await chrome.storage.session.set({
    queueProcessing: true,
    queueNotebookId: notebookId
  });

  const settings = await chrome.storage.local.get(['addDelay']);
  const delay = settings.addDelay || 2000;
  const delayInMinutes = Math.max(delay / 60000, 1 / 60);  // chrome.alarms min ~1 min

  // Create a one-shot alarm. Use a unique timestamp suffix so multiple
  // process-queue calls don't collide.
  const alarmName = QUEUE_ALARM_PREFIX + Date.now();
  await chrome.alarms.create(alarmName, { delayInMinutes });
  // Track the active alarm name so the onAlarm handler can verify it's ours.
  await chrome.storage.session.set({ queueAlarmName: alarmName });

  return { started: true, queueLength: pendingCount, delay };
}

// Process one pending queue item, then re-arm if more remain.
async function processOneQueueItem(alarmName) {
  const session = await chrome.storage.session.get([
    'queueProcessing', 'queueNotebookId', 'queueAlarmName'
  ]);
  if (!session.queueProcessing) return;

  const notebookId = session.queueNotebookId;
  if (!notebookId) {
    await chrome.storage.session.remove(['queueProcessing', 'queueNotebookId', 'queueAlarmName']);
    return;
  }

  const queue = await getQueue();
  // Find the first pending item by index (O(n) scan, not O(n²)).
  const idx = queue.findIndex(i => i.status === 'pending');
  if (idx === -1) {
    // No more pending items — clear processing flag.
    await chrome.storage.session.remove([
      'queueProcessing', 'queueNotebookId', 'queueAlarmName'
    ]);
    return;
  }

  const item = queue[idx];

  try {
    await NotebookLMAPI.getTokens(await getActiveAuthuser());
    await NotebookLMAPI.addSource(notebookId, item.url);
    await addHistory({ action: 'add_source', url: item.url, title: item.title, notebookId });
    // Success — remove this item from the queue.
    queue.splice(idx, 1);
    await chrome.storage.local.set({ queue });
    updateBadge(queue.length);
  } catch (e) {
    console.error('processQueue item error:', e);
    item.errorCount = (item.errorCount || 0) + 1;
    item.lastError = e.message;
    if (item.errorCount >= MAX_QUEUE_RETRIES) {
      item.status = 'failed';
    } else {
      item.status = 'error';
    }
    await chrome.storage.local.set({ queue });
    await addHistory({ action: 'error', url: item.url, error: e.message, notebookId });
  }

  // Re-arm if more pending items remain.
  const morePending = queue.some(i => i.status === 'pending');
  if (morePending) {
    const settings = await chrome.storage.local.get(['addDelay']);
    const delay = settings.addDelay || 2000;
    const delayInMinutes = Math.max(delay / 60000, 1 / 60);
    const nextAlarmName = QUEUE_ALARM_PREFIX + Date.now();
    await chrome.alarms.create(nextAlarmName, { delayInMinutes });
    await chrome.storage.session.set({ queueAlarmName: nextAlarmName });
  } else {
    // Done — clear session flags.
    await chrome.storage.session.remove([
      'queueProcessing', 'queueNotebookId', 'queueAlarmName'
    ]);
  }
}

// Reset all failed items back to pending so process-queue will retry them.
async function retryFailed() {
  const queue = await getQueue();
  let resetCount = 0;
  for (const item of queue) {
    if (item.status === 'failed' || item.status === 'error') {
      item.status = 'pending';
      item.errorCount = 0;
      delete item.lastError;
      resetCount++;
    }
  }
  await chrome.storage.local.set({ queue });
  updateBadge(queue.length);
  return { reset: resetCount, queue };
}

// ─── History ───
async function addHistory(entry) {
  const data = await chrome.storage.local.get(['history']);
  const history = data.history || [];
  history.unshift({ ...entry, timestamp: Date.now() });
  if (history.length > 500) history.length = 500;
  await chrome.storage.local.set({ history });
}

async function getHistory() {
  const data = await chrome.storage.local.get(['history']);
  return data.history || [];
}

async function clearHistory() {
  await chrome.storage.local.set({ history: [] });
}

// ─── Badge ───
function updateBadge(count) {
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#4285f4' });
}

// ─── Drive sync orchestrator ───
async function syncDriveSources(notebookId) {
  const nb = await NotebookLMAPI.getNotebook(notebookId);
  const driveSources = nb.sources.filter(s => s.canSync);
  if (!driveSources.length) return { success: true, results: { total: 0 } };

  const results = { total: driveSources.length, fresh: 0, synced: 0, skipped: 0, errors: 0 };
  for (const source of driveSources) {
    try {
      const isFresh = await NotebookLMAPI.checkSourceFreshness(source.id, notebookId);
      if (isFresh === null) results.skipped++;
      else if (isFresh) results.fresh++;
      else {
        await NotebookLMAPI.syncDriveSource(source.id, notebookId);
        results.synced++;
      }
    } catch (e) {
      results.errors++;
    }
  }
  return { success: true, results };
}

// ─── Extract YouTube URLs from tab (covers watch / shorts / embed / m. / music. / youtu.be + iframes) ───
async function extractYouTubeUrls(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      function normalizeYouTube(rawHref) {
        try {
          const u = new URL(rawHref);
          const host = u.hostname.toLowerCase();
          const isYT = host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com') || host === 'youtu.be';
          if (!isYT) return null;
          // watch?v=
          const v = u.searchParams.get('v');
          if (v) return `https://www.youtube.com/watch?v=${v}`;
          // /shorts/<id>
          const shortsMatch = u.pathname.match(/^\/shorts\/([A-Za-z0-9_-]+)/);
          if (shortsMatch) return `https://www.youtube.com/watch?v=${shortsMatch[1]}`;
          // /embed/<id>
          const embedMatch = u.pathname.match(/^\/embed\/([A-Za-z0-9_-]+)/);
          if (embedMatch) return `https://www.youtube.com/watch?v=${embedMatch[1]}`;
          // youtu.be/<id>
          if (host === 'youtu.be') {
            const id = u.pathname.split('/').filter(Boolean)[0];
            if (id) return `https://www.youtube.com/watch?v=${id}`;
          }
          return null;
        } catch (e) { return null; }
      }

      const links = new Set();
      // Scan all <a> elements.
      document.querySelectorAll('a[href]').forEach(a => {
        const norm = normalizeYouTube(a.href);
        if (norm) links.add(norm);
      });
      // Scan iframes for embedded YouTube URLs (youtube.com/embed/...).
      document.querySelectorAll('iframe[src]').forEach(iframe => {
        const norm = normalizeYouTube(iframe.src);
        if (norm) links.add(norm);
      });
      return [...links];
    }
  });
  // Aggregate across all frames.
  const all = [];
  for (const r of results) {
    if (Array.isArray(r.result)) all.push(...r.result);
  }
  return [...new Set(all)];
}

// ─── Extract all links from tab ───
async function extractAllLinks(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const links = [];
      document.querySelectorAll('a[href]').forEach(a => {
        try {
          const u = new URL(a.href);
          if (u.protocol === 'http:' || u.protocol === 'https:') {
            links.push({ url: a.href, title: a.textContent.trim().substring(0, 100) || a.href });
          }
        } catch (e) {}
      });
      return [...new Map(links.map(l => [l.url, l])).values()];
    }
  });
  return results[0]?.result || [];
}

// ─── Extract open tabs ───
async function getOpenTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs
    .filter(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')))
    .map(t => ({ url: t.url, title: t.title || t.url, favIconUrl: t.favIconUrl || '', tabId: t.id }));
}

// ─── RSS/Sitemap detection ───
async function detectRssFeed(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const feeds = [];
      document.querySelectorAll('link[type="application/rss+xml"], link[type="application/atom+xml"]').forEach(l => {
        feeds.push({ url: l.href, title: l.title || 'RSS Feed', type: l.type });
      });
      return feeds;
    }
  });
  return results[0]?.result || [];
}

// ─── RSS/Atom XML parser (regex-based, no DOMParser in service worker) ───
function decodeXmlEntities(text) {
  if (!text) return '';
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Extract the text content of an XML element, including CDATA sections.
function _extractXmlText(rawTagBody) {
  if (!rawTagBody) return '';
  // Find all CDATA sections and plain-text segments.
  let result = '';
  const cdataRe = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let lastIndex = 0;
  let m;
  while ((m = cdataRe.exec(rawTagBody)) !== null) {
    if (m.index > lastIndex) {
      result += rawTagBody.slice(lastIndex, m.index);
    }
    result += m[1];  // CDATA inner content (already literal)
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < rawTagBody.length) {
    result += rawTagBody.slice(lastIndex);
  }
  // If no CDATA was found, the whole body is plain text that needs entity decoding.
  // If CDATA was found, the non-CDATA parts still need decoding.
  return decodeXmlEntities(result);
}

// Find first matching tag's inner content (handles CDATA + entities).
function _firstTag(xmlText, tagName) {
  // Match either <tag>...</tag> or <tag attr="...">...</tag> (non-greedy).
  const re = new RegExp('<' + tagName + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tagName + '>', 'i');
  const m = xmlText.match(re);
  return m ? _extractXmlText(m[1]) : '';
}

// Find ALL matching tags' inner content.
function _allTags(xmlText, tagName) {
  const out = [];
  const re = new RegExp('<' + tagName + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tagName + '>', 'gi');
  let m;
  while ((m = re.exec(xmlText)) !== null) {
    out.push(_extractXmlText(m[1]));
  }
  return out;
}

function parseRssXml(xmlText) {
  if (!xmlText || typeof xmlText !== 'string') {
    throw new Error('Empty or invalid XML');
  }

  const trimmed = xmlText.trim();

  // Detect feed format.
  const isAtom = /<feed[\s>]/i.test(trimmed) && /<\w*:?(entry|feed)\b/i.test(trimmed);
  const isRss = /<rss[\s>]/i.test(trimmed) || /<channel[\s>]/i.test(trimmed);

  if (!isAtom && !isRss) {
    throw new Error('Not a recognized RSS 2.0 or Atom 1.0 feed');
  }

  let title = '';
  let description = '';
  const items = [];

  if (isRss) {
    title = _firstTag(trimmed, 'title');
    description = _firstTag(trimmed, 'description');

    // Extract each <item> block.
    const itemRe = /<item\b[\s\S]*?<\/item>/gi;
    let im;
    while ((im = itemRe.exec(trimmed)) !== null) {
      const block = im[0];
      const itemTitle = _firstTag(block, 'title');
      const link = _firstTag(block, 'link');
      const desc = _firstTag(block, 'description');
      const pub = _firstTag(block, 'pubDate') || _firstTag(block, 'date');
      items.push({
        url: link || '',
        title: itemTitle || '',
        description: desc || '',
        pubDate: pub || ''
      });
    }
  } else {
    // Atom 1.0
    title = _firstTag(trimmed, 'title');
    description = _firstTag(trimmed, 'subtitle');

    const entryRe = /<entry\b[\s\S]*?<\/entry>/gi;
    let em;
    while ((em = entryRe.exec(trimmed)) !== null) {
      const block = em[0];
      const itemTitle = _firstTag(block, 'title');
      const pub = _firstTag(block, 'published') || _firstTag(block, 'updated');
      const summary = _firstTag(block, 'summary') || _firstTag(block, 'content');

      // Atom <link href="..." /> may have no inner text. Extract href.
      let link = '';
      const linkMatch = block.match(/<link\b[^>]*\bhref\s*=\s*"([^"]+)"/i);
      if (linkMatch) link = linkMatch[1];
      if (!link) link = _firstTag(block, 'link');

      items.push({
        url: link || '',
        title: itemTitle || '',
        description: summary || '',
        pubDate: pub || ''
      });
    }
  }

  return { title, description, items };
}

// ─── Context menu (safe re-init pattern) ───
function initContextMenus() {
  chrome.contextMenus.removeAll(async () => {
    if (chrome.runtime.lastError) {
      console.warn('contextMenus.removeAll error:', chrome.runtime.lastError.message);
    }
    try {
      chrome.contextMenus.create({
        id: 'add-to-nlm',
        title: chrome.i18n.getMessage('contextMenuAdd') || 'Add to NotebookLM',
        contexts: ['page', 'link']
      }, () => {
        if (chrome.runtime.lastError) {
          console.warn('contextMenus.create(add-to-nlm):', chrome.runtime.lastError.message);
        }
      });
      chrome.contextMenus.create({
        id: 'add-as-pdf',
        title: chrome.i18n.getMessage('contextMenuPdf') || 'Save as PDF to NotebookLM',
        contexts: ['page']
      }, () => {
        if (chrome.runtime.lastError) {
          console.warn('contextMenus.create(add-as-pdf):', chrome.runtime.lastError.message);
        }
      });
    } catch (e) {
      console.error('initContextMenus error:', e);
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  initContextMenus();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.linkUrl || info.pageUrl;
  if (info.menuItemId === 'add-to-nlm') {
    await addToQueue([{ url, title: tab?.title || '' }]);
    await notify('queue-add', { message: `Added to queue: ${url}` });
  } else if (info.menuItemId === 'add-as-pdf') {
    if (!tab) return;
    await chrome.storage.local.set({ pendingPdf: { tabId: tab.id, title: tab.title, url: tab.url } });
    await notify('pdf-pending', { message: 'Open popup to select notebook and save PDF' });
  }
});

// ─── Keyboard shortcuts ───
chrome.commands.onCommand.addListener(async (command) => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    if (command === 'add-current-page') {
      await addToQueue([{ url: tab.url, title: tab.title }]);
      await notify('queue-add', { message: `Added to queue: ${tab.url}` });
    } else if (command === 'add-as-pdf') {
      await chrome.storage.local.set({ pendingPdf: { tabId: tab.id, title: tab.title, url: tab.url } });
      await notify('pdf-start', { title: 'NotebookLM', message: 'Generating PDF and uploading...' });
    }
  } catch (e) {
    console.error('onCommand error:', e);
    await notify('cmd-error', { message: 'Command failed: ' + e.message });
  }
});

// ─── Alarms listener (drives crash-safe queue processing) ───
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm || !alarm.name || !alarm.name.startsWith(QUEUE_ALARM_PREFIX)) return;
  try {
    await processOneQueueItem(alarm.name);
  } catch (e) {
    console.error('onAlarm queue processing error:', e);
    // Clear processing flag so the user can retry.
    try {
      await chrome.storage.session.remove([
        'queueProcessing', 'queueNotebookId', 'queueAlarmName'
      ]);
    } catch (_) {}
  }
});

// ─── Message handler ───
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request, sender).then(sendResponse).catch(e => sendResponse({ error: e.message }));
  return true;
});

async function handleMessage(request, sender) {
  const { cmd, params } = request;
  const au = await getActiveAuthuser();

  switch (cmd) {
    // ── Auth ──
    case 'list-accounts': {
      const accounts = await NotebookLMAPI.listAccounts();
      // Cache for get-active-account.
      await chrome.storage.session.set({ lastAccounts: accounts });
      return accounts;
    }

    case 'set-authuser':
      await setActiveAuthuser(params.authuser);
      await NotebookLMAPI.getTokens(params.authuser);
      return { success: true };

    case 'get-tokens':
      await NotebookLMAPI.getTokens(params.authuser != null ? params.authuser : au);
      return { success: true };

    // ── Account persistence (new) ──
    case 'get-active-account': {
      const authuser = await getActiveAuthuser();
      let accounts = [];
      try {
        const session = await chrome.storage.session.get(['lastAccounts']);
        accounts = session.lastAccounts || [];
      } catch (_) {}
      // If no cached accounts, try to fetch fresh.
      if (!accounts.length) {
        accounts = await NotebookLMAPI.listAccounts();
        await chrome.storage.session.set({ lastAccounts: accounts });
      }
      return { result: { authuser, accounts } };
    }

    case 'set-active-account': {
      const newAuthuser = params.authuser;
      if (typeof newAuthuser !== 'number') {
        return { error: 'authuser must be a number' };
      }
      await setActiveAuthuser(newAuthuser);
      // Re-fetch tokens for the new account so subsequent RPCs work immediately.
      await NotebookLMAPI.getTokens(newAuthuser);
      return { result: { authuser: newAuthuser } };
    }

    // ── Notebooks ──
    case 'list-notebooks':
      await NotebookLMAPI.getTokens(au);
      return await NotebookLMAPI.listNotebooks();

    case 'create-notebook':
      await NotebookLMAPI.getTokens(au);
      return await NotebookLMAPI.createNotebook(params.title, params.emoji);

    // ── Sources ──
    case 'add-source': {
      await NotebookLMAPI.getTokens(au);
      const result = await NotebookLMAPI.addSource(params.notebookId, params.url);
      await addHistory({ action: 'add_source', url: params.url, notebookId: params.notebookId });
      return { success: true };
    }

    case 'add-sources': {
      await NotebookLMAPI.getTokens(au);
      await NotebookLMAPI.addSources(params.notebookId, params.urls);
      for (const u of params.urls) {
        await addHistory({ action: 'add_source', url: u, notebookId: params.notebookId });
      }
      return { success: true, count: params.urls.length };
    }

    case 'add-text-source': {
      await NotebookLMAPI.getTokens(au);
      await NotebookLMAPI.addTextSource(params.notebookId, params.text, params.title);
      await addHistory({ action: 'add_text', title: params.title, notebookId: params.notebookId });
      return { success: true };
    }

    case 'add-as-pdf': {
      await NotebookLMAPI.getTokens(au);
      try {
        const r = await addAsPdf(params.notebookId, params.tabId, params.title);
        await addHistory({ action: 'add_pdf', title: params.title, notebookId: params.notebookId });
        await notify('pdf-done', { message: 'PDF added to notebook' });
        return r;
      } catch (e) {
        await notify('pdf-error', { message: 'PDF failed: ' + e.message });
        throw e;
      }
    }

    // ── Notebook details ──
    case 'get-notebook':
      await NotebookLMAPI.getTokens(au);
      return await NotebookLMAPI.getNotebook(params.notebookId);

    case 'get-sources':
      await NotebookLMAPI.getTokens(au);
      return await NotebookLMAPI.getNotebook(params.notebookId);

    // ── Delete ──
    case 'delete-source':
      await NotebookLMAPI.getTokens(au);
      await NotebookLMAPI.deleteSource(params.notebookId, params.sourceId);
      await addHistory({ action: 'delete_source', sourceId: params.sourceId, notebookId: params.notebookId });
      return { success: true };

    case 'delete-sources':
      await NotebookLMAPI.getTokens(au);
      const delResult = await NotebookLMAPI.deleteSources(params.notebookId, params.sourceIds);
      await addHistory({ action: 'delete_sources', count: params.sourceIds.length, notebookId: params.notebookId });
      return { success: true, ...delResult };

    // ── Drive sync ──
    case 'sync-drive-sources':
      await NotebookLMAPI.getTokens(au);
      return await syncDriveSources(params.notebookId);

    // ── YouTube comments ──
    case 'parse-comments': {
      // Atomic check + set BEFORE any await to fix the race (Bug B).
      if (parseState.active) return { error: 'Parse already in progress' };
      parseState.active = true;
      const parseId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      parseState.parseId = parseId;
      // Fire-and-forget — doParseComments updates parseState as it runs.
      // Capture the active authuser locally so SW-restart can't swap accounts
      // mid-parse (Bug T).
      const capturedAuthuser = au;
      try {
        await NotebookLMAPI.getTokens(capturedAuthuser);
      } catch (e) {
        parseState.active = false;
        parseState.error = { code: 'AUTH', message: e.message };
        return { error: e.message };
      }
      // Synchronous launch — doParseComments sets the full parseState first.
      doParseComments(params.notebookId, params.videoId, params.tabId, capturedAuthuser, parseId);
      return { started: true, parseId };
    }

    case 'get-parse-status':
      return {
        active: parseState.active,
        parseId: parseState.parseId,
        videoId: parseState.videoId,
        progress: parseState.progress,
        error: parseState.error,
        result: parseState.result
      };

    case 'cancel-parse':
      if (parseState.cancelToken) {
        parseState.cancelToken.cancelled = true;
        parseState.progress.phase = 'cancelled';
        parseState.active = false;
        await checkpointParseState();
      }
      return { success: true };

    // ── Queue ──
    case 'get-queue':
      return await getQueue();

    case 'add-to-queue':
      return await addToQueue(params.items);

    case 'clear-queue':
      await clearQueue();
      return { success: true };

    case 'remove-from-queue': {
      // Atomic re-read → mutate → write to fix popup race (Bug C1).
      const data = await chrome.storage.local.get(['queue']);
      const queue = data.queue || [];
      const idx = typeof params.index === 'number' ? params.index : -1;
      if (idx < 0 || idx >= queue.length) {
        return { error: 'Invalid index' };
      }
      queue.splice(idx, 1);
      await chrome.storage.local.set({ queue });
      updateBadge(queue.length);
      return { result: { queue } };
    }

    case 'process-queue':
      await NotebookLMAPI.getTokens(au);
      return await processQueue(params.notebookId);

    case 'retry-failed':
      return await retryFailed();

    // ── History ──
    case 'get-history':
      return await getHistory();

    case 'clear-history':
      await clearHistory();
      return { success: true };

    // ── Tab helpers ──
    case 'get-open-tabs':
      return await getOpenTabs();

    case 'extract-yt-urls':
      return await extractYouTubeUrls(params.tabId);

    case 'extract-links':
      return await extractAllLinks(params.tabId);

    case 'detect-rss':
      return await detectRssFeed(params.tabId);

    case 'get-current-tab': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab ? { url: tab.url, title: tab.title, id: tab.id, favIconUrl: tab.favIconUrl } : null;
    }

    case 'open-tab':
      await chrome.tabs.create({ url: params.url });
      return { success: true };

    // ── RSS parsing (new) ──
    case 'parse-rss': {
      const url = params && params.url;
      if (!url || typeof url !== 'string') {
        return { error: 'Missing or invalid url' };
      }
      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch (e) {
        return { error: 'Invalid URL: ' + e.message };
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return { error: 'Only http(s) URLs are supported' };
      }
      let xmlText;
      try {
        const resp = await fetchWithTimeout(url, {}, 30000);
        if (!resp.ok) {
          return { error: `Feed fetch failed: ${resp.status}` };
        }
        xmlText = await resp.text();
      } catch (e) {
        return { error: 'Feed fetch failed: ' + e.message };
      }
      try {
        const parsed = parseRssXml(xmlText);
        if (!parsed.items || parsed.items.length === 0) {
          return { error: 'No items found in feed' };
        }
        return { result: parsed };
      } catch (e) {
        return { error: 'Feed parse failed: ' + e.message };
      }
    }

    default:
      return { error: `Unknown command: ${cmd}` };
  }
}

// ─── SW startup: restore badge + resume queue processing if interrupted ───
getQueue().then(q => updateBadge(q.length));

// If the SW died mid-queue, resume processing on startup.
(async () => {
  try {
    const session = await chrome.storage.session.get(['queueProcessing', 'queueNotebookId']);
    if (session.queueProcessing && session.queueNotebookId) {
      const queue = await getQueue();
      const hasPending = queue.some(i => i.status === 'pending');
      if (hasPending) {
        const settings = await chrome.storage.local.get(['addDelay']);
        const delay = settings.addDelay || 2000;
        const delayInMinutes = Math.max(delay / 60000, 1 / 60);
        const nextAlarmName = QUEUE_ALARM_PREFIX + Date.now();
        await chrome.alarms.create(nextAlarmName, { delayInMinutes });
        await chrome.storage.session.set({ queueAlarmName: nextAlarmName });
        console.log('[SW startup] Resumed interrupted queue processing');
      } else {
        // Nothing to do — clear stale session flags.
        await chrome.storage.session.remove([
          'queueProcessing', 'queueNotebookId', 'queueAlarmName'
        ]);
      }
    }
  } catch (e) {
    console.warn('[SW startup] resume queue check failed:', e);
  }
})();
