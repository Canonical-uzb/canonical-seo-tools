// Canonical — service worker.
// Records the main-frame redirect chain and response headers per tab (read-only webRequest),
// answers the side panel, and owns the context menu.

const nav = new Map(); // tabId -> record of the last main-frame navigation
const pending = new Map(); // requestId -> record being built

const strip = (u) => { try { const x = new URL(u); x.hash = ''; return x.href; } catch { return u; } };

async function persist(tabId, rec) {
  nav.set(tabId, rec);
  try { await chrome.storage.session.set({ ['nav_' + tabId]: rec }); } catch { /* session storage unavailable */ }
}

async function recall(tabId) {
  if (nav.has(tabId)) return nav.get(tabId);
  try {
    const key = 'nav_' + tabId;
    const got = await chrome.storage.session.get(key);
    if (got[key]) { nav.set(tabId, got[key]); return got[key]; }
  } catch { /* ignore */ }
  return null;
}

// Cookies and credentials never leave the worker: they are dropped before anything is stored or shown.
const SENSITIVE_HEADERS = new Set(['set-cookie', 'set-cookie2', 'cookie', 'authorization', 'proxy-authorization', 'www-authenticate', 'proxy-authenticate']);
const headersToObj = (list = []) => list
  .filter((h) => !SENSITIVE_HEADERS.has((h.name || '').toLowerCase()))
  .map((h) => ({ name: h.name.toLowerCase(), value: h.value || '' }));

// Firefox has no sidePanel API: there the panel is the sidebar (sidebar_action in its manifest).
const IS_FIREFOX = typeof browser !== 'undefined' && !!(browser.sidebarAction);
// Firefox rejects 'extraHeaders' in webRequest listener options.
const RESP_SPEC = IS_FIREFOX ? ['responseHeaders'] : ['responseHeaders', 'extraHeaders'];

// The panel lives only in the tab where it was opened: no global panel, a tab-specific one per click.
function openPanel(tabId, toggle) {
  if (IS_FIREFOX) {
    // Must run synchronously inside the click.
    (toggle ? browser.sidebarAction.toggle() : browser.sidebarAction.open()).catch(() => {});
    return;
  }
  // Both calls must start inside the user gesture, before any await.
  chrome.sidePanel.setOptions({ tabId, path: 'panel/panel.html?tabId=' + tabId, enabled: true }).catch(() => {});
  chrome.sidePanel.open({ tabId }).catch(() => {});
}

chrome.action.onClicked.addListener((tab) => { if (tab && tab.id != null) openPanel(tab.id, true); });

// Global (all-tabs) panel off: older versions enabled it through the manifest and Chrome keeps that setting.
// With it off, the panel exists only in tabs where it was opened and hides when you switch away.
function disableGlobalPanel() {
  if (!chrome.sidePanel) return;
  chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
}
disableGlobalPanel();

chrome.runtime.onInstalled.addListener(() => {
  disableGlobalPanel();
  // Migrate old settings: SERP numbering becomes opt-in.
  chrome.storage.sync.get('settings').then(({ settings }) => {
    if (settings && (settings.settingsVersion || 1) < 2) chrome.storage.sync.set({ settings: { ...settings, serpGoogle: false, serpYandex: false, settingsVersion: 2 } });
  }).catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'seolens-count', title: chrome.i18n.getMessage('menuCount'), contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'seolens-open', title: chrome.i18n.getMessage('menuOpen'), contexts: ['page', 'link'] });
  });
});

chrome.runtime.onStartup.addListener(disableGlobalPanel);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  // sidePanel.open must run inside the click gesture: call it before any await.
  openPanel(tab.id);
  if (info.menuItemId !== 'seolens-count') return;
  const text = info.selectionText || '';
  chrome.storage.session.set({ selection: { text, at: Date.now() } }).catch(() => {});
  chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [info.frameId || 0] },
    func: showCountBadge,
    args: [text, chrome.i18n.getUILanguage().toLowerCase().startsWith('ru')],
  }).catch(() => {});
});

// Runs in the page: a small badge next to the selection with the counts.
function showCountBadge(fallbackText, ru) {
  const sel = window.getSelection();
  let text = sel ? String(sel) : '';
  const el = document.activeElement;
  if (!text && el && typeof el.selectionStart === 'number' && el.value) text = el.value.slice(el.selectionStart, el.selectionEnd);
  if (!text) text = fallbackText || '';
  const chars = text.length;
  const noSpace = text.replace(/\s/g, '').length;
  const words = (text.match(/[\p{L}\p{N}]+/gu) || []).length;
  let rect = null;
  try { if (sel && sel.rangeCount) rect = sel.getRangeAt(0).getBoundingClientRect(); } catch (e) { rect = null; }
  if ((!rect || !rect.width) && el && el.getBoundingClientRect) rect = el.getBoundingClientRect();
  document.getElementById('seolens-count-badge')?.remove();
  const b = document.createElement('div');
  b.id = 'seolens-count-badge';
  b.textContent = ru ? `${chars} симв. · ${noSpace} без пробелов · ${words} слов` : `${chars} chars · ${noSpace} no spaces · ${words} words`;
  const top = rect ? Math.max(8, rect.top - 40) : 16;
  const left = rect ? Math.min(Math.max(8, rect.left), window.innerWidth - 320) : 16;
  b.style.cssText = `position:fixed;z-index:2147483647;top:${top}px;left:${left}px;background:#0f6b5a;color:#fff;font:600 13px/1.4 system-ui,sans-serif;padding:7px 11px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.25);pointer-events:none;white-space:nowrap`;
  document.documentElement.appendChild(b);
  setTimeout(() => b.remove(), 5000);
}

// ---------- webRequest: main frame only, observe only ----------
const filter = { urls: ['<all_urls>'], types: ['main_frame'] };

chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId < 0) return;
  if (!pending.has(d.requestId)) {
    pending.set(d.requestId, { tabId: d.tabId, startUrl: d.url, startedAt: d.timeStamp, hops: [], final: null, error: null });
  }
}, filter);

chrome.webRequest.onBeforeRedirect.addListener((d) => {
  const rec = pending.get(d.requestId);
  if (!rec) return;
  rec.hops.push({
    url: d.url,
    status: d.statusCode,
    statusLine: d.statusLine || '',
    ip: d.ip || '',
    fromCache: !!d.fromCache,
    redirectUrl: d.redirectUrl,
    headers: headersToObj(d.responseHeaders),
  });
}, filter, RESP_SPEC);

chrome.webRequest.onHeadersReceived.addListener((d) => {
  const rec = pending.get(d.requestId);
  if (!rec) return;
  rec.lastHeaders = headersToObj(d.responseHeaders);
  rec.headersAt = d.timeStamp;
}, filter, RESP_SPEC);

chrome.webRequest.onCompleted.addListener((d) => {
  const rec = pending.get(d.requestId);
  if (!rec) return;
  pending.delete(d.requestId);
  rec.final = {
    url: d.url,
    status: d.statusCode,
    statusLine: d.statusLine || '',
    ip: d.ip || '',
    fromCache: !!d.fromCache,
    headers: headersToObj(d.responseHeaders) || rec.lastHeaders || [],
  };
  rec.ttfbMs = rec.headersAt ? Math.round(rec.headersAt - rec.startedAt) : null;
  delete rec.lastHeaders;
  persist(rec.tabId, rec);
}, filter, RESP_SPEC);

chrome.webRequest.onErrorOccurred.addListener((d) => {
  const rec = pending.get(d.requestId);
  if (!rec) return;
  pending.delete(d.requestId);
  rec.error = d.error;
  persist(rec.tabId, rec);
}, filter);

chrome.tabs.onRemoved.addListener((tabId) => {
  nav.delete(tabId);
  chrome.storage.session.remove('nav_' + tabId).catch(() => {});
  dropCachedResult(tabId);
});

// ---------- saved check results (panel/cache.js) ----------
// A tab's last check stays until the page reloads or navigates away, or the tab closes.
function cacheDb(fn) {
  const req = indexedDB.open('canonical-cache', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('tabs');
  req.onsuccess = () => { const db = req.result; try { const t = db.transaction('tabs', 'readwrite'); fn(t.objectStore('tabs')); t.oncomplete = () => db.close(); t.onerror = () => db.close(); } catch { db.close(); } };
}
function dropCachedResult(tabId) { cacheDb((s) => s.delete(tabId)); }
chrome.webNavigation.onCommitted.addListener((d) => { if (d.frameId === 0) { dropCachedResult(d.tabId); chrome.action.setBadgeText({ tabId: d.tabId, text: '' }).catch(() => {}); } });
// Tab ids start over after a browser restart, so old results must not survive it.
chrome.runtime.onStartup.addListener(() => cacheDb((s) => s.clear()));

// ---------- on-demand requests for the panel (address variants, 404, canonical, hreflang) ----------
// The worker fetches a URL and records every redirect hop through webRequest.
// Guards: http/https only, no localhost / private / link-local / metadata addresses (also after
// redirects and by the resolved IP, against DNS rebinding), at most 10 redirects, a timeout that
// covers reading the body, a byte limit on the body, and at most 6 requests at a time.
// Private addresses are allowed only when the analysed page itself is on a private host.
const traces = new Map(); // normalized start URL -> trace record
const byReq = new Map();  // requestId -> trace record
const traceFilter = { urls: ['<all_urls>'], types: ['xmlhttprequest', 'other'], tabId: -1 };
const ownOrigin = chrome.runtime.getURL('').replace(/\/$/, '');
const MAX_REDIRECTS = 10;

function ipv4Private(ip) {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function ipPrivate(ip) {
  if (!ip) return false;
  const v = ip.replace(/^\[|\]$/g, '').toLowerCase();
  if (ipv4Private(v)) return true;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Private(mapped[1]);
  return v === '::' || v === '::1' || /^f[cd][0-9a-f]{2}:/.test(v) || /^fe[89ab][0-9a-f]:/.test(v);
}
function hostBlocked(hostname) {
  const h = (hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true;
  if (h === 'metadata.google.internal' || h === 'metadata') return true;
  return ipPrivate(h);
}
function urlBlocked(url, allowPrivate) {
  let u; try { u = new URL(url); } catch { return 'bad url'; }
  if (!/^https?:$/.test(u.protocol)) return 'scheme';
  if (!allowPrivate && hostBlocked(u.hostname)) return 'private address';
  return null;
}

function abortTrace(t, reason) {
  if (t.blocked) return;
  t.blocked = reason;
  try { t.ctl.abort(); } catch { /* ignore */ }
}
function traceBefore(d) {
  if (byReq.has(d.requestId)) return;
  if (d.initiator && d.initiator !== ownOrigin) return;
  const t = traces.get(d.url);
  if (t && !t.requestId) { t.requestId = d.requestId; byReq.set(d.requestId, t); }
}
function traceRedirect(d) {
  const t = byReq.get(d.requestId);
  if (!t) return;
  t.hops.push({ url: d.url, status: d.statusCode, statusLine: d.statusLine || '', redirectUrl: d.redirectUrl, ip: d.ip || '' });
  if (!t.allowPrivate && ipPrivate(d.ip)) return abortTrace(t, 'private address');
  const why = urlBlocked(d.redirectUrl, t.allowPrivate);
  if (why) return abortTrace(t, 'redirect to ' + why);
  if (t.hops.length > MAX_REDIRECTS) abortTrace(t, 'too many redirects');
}
function traceStarted(d) {
  const t = byReq.get(d.requestId);
  if (t && !t.allowPrivate && ipPrivate(d.ip)) abortTrace(t, 'private address');
}
function traceDone(d) {
  const t = byReq.get(d.requestId);
  if (t) { t.final = { url: d.url, status: d.statusCode, ip: d.ip || '' }; byReq.delete(d.requestId); }
}
function traceError(d) {
  const t = byReq.get(d.requestId);
  if (t) { t.error = d.error; byReq.delete(d.requestId); }
}
function traceListeners(on) {
  const pairs = [
    [chrome.webRequest.onBeforeRequest, traceBefore, []],
    [chrome.webRequest.onBeforeRedirect, traceRedirect, ['responseHeaders']],
    [chrome.webRequest.onResponseStarted, traceStarted, []],
    [chrome.webRequest.onCompleted, traceDone, ['responseHeaders']],
    [chrome.webRequest.onErrorOccurred, traceError, null],
  ];
  for (const [ev, fn, extra] of pairs) {
    if (on && !ev.hasListener(fn)) extra ? ev.addListener(fn, traceFilter, extra) : ev.addListener(fn, traceFilter);
    if (!on && ev.hasListener(fn)) ev.removeListener(fn);
  }
}

// Simple semaphore: at most 6 worker requests at once.
let running = 0;
const waiting = [];
async function slot() {
  if (running < 6) { running++; return; }
  await new Promise((r) => waiting.push(r));
  running++;
}
function release() { running--; const next = waiting.shift(); if (next) next(); }

// Reads at most maxBytes of the body, then stops the download.
async function readLimited(res, maxBytes) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = []; let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); size += value.length;
  }
  try { await reader.cancel(); } catch { /* ignore */ }
  const all = new Uint8Array(Math.min(size, maxBytes));
  let off = 0;
  for (const c of chunks) { const part = c.subarray(0, Math.max(0, all.length - off)); all.set(part, off); off += part.length; if (off >= all.length) break; }
  const cs = ((res.headers.get('content-type') || '').match(/charset=([\w-]+)/i) || [])[1] || 'utf-8';
  try { return new TextDecoder(cs).decode(all); } catch { return new TextDecoder().decode(all); }
}

// Journal of the extension's own outgoing requests (checks, CT lookups): kept for this browser session only.
const netLog = [];
function logNet(entry) {
  netLog.push({ at: Date.now(), ...entry });
  if (netLog.length > 300) netLog.splice(0, netLog.length - 300);
  chrome.storage.session.set({ netLog }).catch(() => {});
}
chrome.storage.session.get('netLog').then((g) => { if (Array.isArray(g.netLog) && !netLog.length) netLog.push(...g.netLog); }).catch(() => {});

// One guarded request. maxBytes = 0: headers only (body cancelled).
async function guardedFetch(url, { allowPrivate = false, maxBytes = 0, timeout = 12000 } = {}) {
  let start;
  try { start = new URL(url).href; } catch { return { startUrl: url, error: 'bad url', hops: [] }; }
  const t = { startUrl: start, hops: [], final: null, error: null, requestId: null, allowPrivate, ctl: new AbortController(), blocked: null };
  const pre = urlBlocked(start, allowPrivate);
  if (pre) { logNet({ url: start, blocked: pre }); return { startUrl: start, hops: [], final: null, error: 'blocked: ' + pre, blocked: pre }; }
  await slot();
  traces.set(start, t);
  traceListeners(true);
  const timer = setTimeout(() => abortTrace(t, 'timeout'), timeout);
  const out = { startUrl: start, hops: t.hops, final: null, error: null };
  try {
    const res = await fetch(start, { redirect: 'follow', credentials: 'omit', cache: 'no-store', signal: t.ctl.signal });
    if (t.blocked) throw new Error(t.blocked);
    if (maxBytes > 0) {
      out.text = await readLimited(res, maxBytes);
      out.contentType = res.headers.get('content-type') || '';
      out.xRobots = res.headers.get('x-robots-tag') || '';
    } else {
      try { await res.body?.cancel(); } catch { /* ignore */ }
    }
    if (t.blocked) throw new Error(t.blocked);
    out.final = t.final || { url: res.url, status: res.status };
    out.final.url = res.url;
    out.final.status = res.status;
    out.redirected = res.redirected;
  } catch (e) {
    out.error = t.blocked ? 'blocked: ' + t.blocked : (t.error || String(e.message || e));
    if (t.blocked) out.blocked = t.blocked;
    delete out.text;
  } finally {
    clearTimeout(timer);
    traces.delete(start);
    if (t.requestId) byReq.delete(t.requestId);
    if (!traces.size) traceListeners(false);
    release();
  }
  logNet({ url: start, status: out.final ? out.final.status : null, error: out.blocked ? null : out.error, blocked: out.blocked || null });
  return out;
}

// ---------- messages from the panel ----------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Only our own extension pages talk to the worker.
  const own = chrome.runtime.getURL('');
  if (sender.id !== chrome.runtime.id || !(sender.url || '').startsWith(own)) return false;
  if (msg && msg.type === 'panelClosed' && Number.isInteger(msg.tabId)) {
    // The panel closed itself because the user left its tab: keep it off there until the next click.
    if (chrome.sidePanel) chrome.sidePanel.setOptions({ tabId: msg.tabId, enabled: false }).catch(() => {});
    reply({ ok: true });
    return false;
  }
  if (msg && msg.type === 'badge' && Number.isInteger(msg.tabId)) {
    // The last score on the toolbar icon of that tab; cleared when the page reloads or navigates.
    const n = Math.max(0, Math.min(100, Number(msg.score) || 0));
    const color = n >= 85 ? '#1d7a43' : n >= 60 ? '#b26b00' : '#b3261e';
    chrome.action.setBadgeText({ tabId: msg.tabId, text: String(n) }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId: msg.tabId, color }).catch(() => {});
    if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ tabId: msg.tabId, color: '#ffffff' }).catch(() => {});
    reply({ ok: true });
    return false;
  }
  if (msg && msg.type === 'trace' && Array.isArray(msg.urls)) {
    Promise.all(msg.urls.slice(0, 10).map((u) => guardedFetch(u, { allowPrivate: !!msg.allowPrivate }))).then((list) => reply({ list }));
    return true;
  }
  if (msg && msg.type === 'getLog') { reply({ log: netLog.slice() }); return false; }
  if (msg && msg.type === 'clearLog') { netLog.length = 0; chrome.storage.session.remove('netLog').catch(() => {}); reply({ ok: true }); return false; }
  if (msg && msg.type === 'logExternal' && typeof msg.url === 'string') { logNet({ url: msg.url.slice(0, 300), status: 'CT' }); reply({ ok: true }); return false; }
  if (msg && msg.type === 'fetchText' && typeof msg.url === 'string') {
    const maxBytes = Math.min(Math.max(Number(msg.maxBytes) || 2_000_000, 10_000), 5_000_000);
    guardedFetch(msg.url, { allowPrivate: !!msg.allowPrivate, maxBytes, timeout: 15000 }).then((r) => reply(r));
    return true;
  }
  if (msg && msg.type === 'getNav' && Number.isInteger(msg.tabId)) {
    recall(msg.tabId).then((rec) => {
      if (rec && msg.url && rec.final && strip(rec.final.url) !== strip(msg.url)) {
        reply({ rec: null, stale: true });
      } else {
        reply({ rec });
      }
    });
    return true;
  }
  return false;
});

// ---------- search results helper (Google / Yandex) ----------
// Injected only on search result pages, only when the user granted access to all sites.
const SERP_RE = /^https:\/\/(?:www\.)?(?:google\.[a-z.]+\/search|(?:yandex\.[a-z.]+|ya\.ru)\/(?:search|yandsearch))/i;
async function injectSerp(details) {
  if (details.frameId !== 0 || !SERP_RE.test(details.url)) return;
  const ok = await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
  if (!ok) return;
  const { settings = {} } = await chrome.storage.sync.get('settings').catch(() => ({}));
  const g = /google\./i.test(details.url);
  // Off by default: works only after the user turns it on in settings.
  if (g && settings.serpGoogle !== true) return;
  if (!g && settings.serpYandex !== true) return;
  chrome.scripting.executeScript({ target: { tabId: details.tabId }, files: ['content/serp.js'] }).catch(() => {});
}
chrome.webNavigation.onCompleted.addListener(injectSerp);
chrome.webNavigation.onHistoryStateUpdated.addListener(injectSerp);
