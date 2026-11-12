// Canonical — side panel controller.
import { docFor } from './docs.js';
import { snapshot, lastSnapshot, listSnapshots, saveSnapshot, clearHistory, historyUsage, diffSnapshots } from './history.js';
import { checkVariants, check404, checkHreflang, checkCanonicalTarget, setNetContext, isPrivateHost, traceChain, fetchPage, checkUrlList } from './checks.js';
import { readability, pageType, typeTips, imageSavings, parsePage, wordGap } from './analysis.js';
import { buildHtmlReport } from './report.js';
import { CT_ORIGINS, baseDomain, findSubdomains, probeHost } from './subdomains.js';
import { t, setLang, currentLang, LANGS } from './i18n.js';
import { analyze, DEFAULTS, PX, pxWidth, schemaTypes } from './rules.js';
import { BOTS } from './robots.js';
import * as DOM from './domain.js';
import qrcode from './vendor/qrcode.js';
import { loadTab, saveTab, dropTab } from './cache.js';
import { frequency, focusKeyword } from './text.js';
import { downloadCsv, downloadJson, downloadXlsx, sheetsFor, reportText, fileBase, issueText, download } from './export.js';
import { SERVICES, fillTemplate, parseCustomLinks, searchOperators, yandexRecrawl } from './services.js';

const TABS = ['overview', 'meta', 'index', 'headings', 'text', 'links', 'images', 'schema', 'server', 'domain', 'speed', 'tools', 'settings'];

const S = {
  tabId: null,
  url: '',
  report: null,
  nav: null,
  res: null,
  settings: { ...DEFAULTS },
  tab: 'overview',
  linkFilter: 'all',
  imgFilter: 'all',
  linkQuery: '',
  headQuery: '',
  snippet: 'desktop',
  freqStop: true,
  busy: false,
  error: null,
  allSites: false,
  selection: '',
};

// ---------- DOM helpers ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}
const $ = (sel) => document.querySelector(sel);
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString(currentLang() === 'ru' ? 'ru-RU' : 'en-US'));
const kb = (b) => (b == null ? '—' : b < 1024 ? b + ' B' : (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB');

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 2200);
}

async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg || t('copied')); } catch { toast(t('copy_failed')); }
}

function badge(sev, label) { return h('span', { class: 'badge b-' + sev }, label); }
function stateBadge(ok, yes, no) { return badge(ok ? 'ok' : 'crit', ok ? (yes || t('yes')) : (no || t('no'))); }

function card(title, ...body) {
  return h('section', { class: 'card' }, title ? h('h3', null, title) : null, ...body);
}

function kvTable(rows) {
  return h('dl', { class: 'kv' }, rows.filter(Boolean).map(([k, v]) => [h('dt', null, k), h('dd', null, v == null || v === '' ? h('span', { class: 'muted' }, '—') : v)]));
}

function table(cols, rows, opts = {}) {
  return h('div', { class: 'tablewrap' },
    h('table', { class: 'tbl' + (opts.compact ? ' compact' : '') },
      h('thead', null, h('tr', null, cols.map((c) => h('th', null, c)))),
      h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: cols.length, class: 'muted' }, opts.empty || t('nothing_found'))))));
}

function btn(label, onclick, cls = '') { return h('button', { type: 'button', class: 'btn ' + cls, onclick }, label); }

function chips(options, current, onpick) {
  return h('div', { class: 'chips', role: 'group' }, options.map(([id, label, n]) =>
    h('button', { type: 'button', class: 'chip', 'aria-pressed': String(id === current), onclick: () => onpick(id) }, label, n != null ? h('span', { class: 'chip-n' }, n) : null)));
}

function lenMeter(len, min, max) {
  const cls = !len ? 'crit' : len < min || len > max ? 'warn' : 'ok';
  return badge(cls, `${len} / ${min}–${max}`);
}

function openUrl(url) { chrome.tabs.create({ url, active: true }); }

function extLink(label, url) {
  return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'ext' }, label);
}

// Small stroke icons (24x24 grid, currentColor).
const ICONS = {
  globe: ['c:12,12,9', 'M3 12h18', 'M12 3c2.6 2.6 3.9 5.6 3.9 9s-1.3 6.4-3.9 9c-2.6-2.6-3.9-5.6-3.9-9S9.4 5.6 12 3z'],
  copy: ['r:9,9,11,11,2', 'M5 15V6a2 2 0 0 1 2-2h9'],
  desktop: ['r:3,4,18,12,2', 'M8 20h8', 'M12 16v4'],
  mobile: ['r:7,2,10,20,2.5', 'M11 18h2'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
};
function icon(name, size = 16) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, String(v));
  for (const d of ICONS[name]) {
    let el;
    if (d.startsWith('c:')) { const [cx, cy, r] = d.slice(2).split(','); el = document.createElementNS(NS, 'circle'); el.setAttribute('cx', cx); el.setAttribute('cy', cy); el.setAttribute('r', r); }
    else if (d.startsWith('r:')) { const [x, y, w, hh, rx] = d.slice(2).split(','); el = document.createElementNS(NS, 'rect'); Object.entries({ x, y, width: w, height: hh, rx }).forEach(([k, v]) => el.setAttribute(k, v)); }
    else { el = document.createElementNS(NS, 'path'); el.setAttribute('d', d); }
    svg.append(el);
  }
  return svg;
}

// Local analyses computed once per result: page type, readability, image savings.
function local() {
  if (!S.res || !S.report) return null;
  if (S.res._local) return S.res._local;
  const r = S.report; const d = S.res.d;
  const types = (() => { try { return schemaTypes(r.schema).map((x) => x.type); } catch { return []; } })();
  const pt = pageType(r, d, types);
  const out = {
    types, pageType: pt, tips: typeTips(pt.type, r, d, types),
    readability: readability(r.text.mainText || '', r.text.paragraphs || [], d.langGuess && d.langGuess.lang, r.text.blocks),
    savings: imageSavings(r.images.items),
  };
  Object.defineProperty(S.res, '_local', { value: out, enumerable: false });
  return out;
}

function updateBadge() {
  if (S.res && S.tabId != null) chrome.runtime.sendMessage({ type: 'badge', tabId: S.tabId, score: S.res.score }).catch(() => {});
}

function downloadHtmlReport() {
  if (!S.res) return;
  const L = local();
  const html = buildHtmlReport(S.report, S.res, { pageType: L.pageType, readability: L.readability, savings: L.savings, version: chrome.runtime.getManifest().version });
  download(new Blob([html], { type: 'text/html;charset=utf-8' }), fileBase(S.url) + '_report.html');
  toast(t('html_saved'));
}

// Copy what the current tab shows (the overview copies the full report).
function tabText() {
  if (S.tab === 'overview') return reportText(S.report, S.res, false);
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:-10000px;top:0;width:600px;white-space:normal';
  const clone = $('#main').cloneNode(true);
  clone.querySelectorAll('button, input, select, textarea, .restored, .notice, svg').forEach((el) => el.remove());
  clone.querySelectorAll('details').forEach((d) => d.setAttribute('open', ''));
  // Key/value lists read better as "key: value" lines.
  clone.querySelectorAll('dl.kv').forEach((dl) => {
    const lines = [...dl.querySelectorAll('dt')].map((dt) => { const dd = dt.nextElementSibling; return `${dt.textContent.trim()}: ${dd ? dd.innerText.replace(/\s*\n\s*/g, ' ').trim() : ''}`; });
    const div = document.createElement('div'); div.style.whiteSpace = 'pre-wrap'; div.textContent = lines.join('\n'); dl.replaceWith(div);
  });
  box.append(clone);
  document.body.append(box);
  const body = clone.innerText.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  box.remove();
  return `${t('report_title')}: ${S.url}\n${t('tab_' + S.tab)} · ${new Date().toLocaleString()}\n\n${body}\n`;
}

// ---------- settings ----------
async function loadSettings() {
  try {
    const got = await chrome.storage.sync.get('settings');
    const saved = got.settings || {};
    // v2: result numbering on Google/Yandex is off until the user turns it on.
    if ((saved.settingsVersion || 1) < 2) { saved.serpGoogle = false; saved.serpYandex = false; saved.settingsVersion = 2; chrome.storage.sync.set({ settings: { ...DEFAULTS, ...saved } }).catch(() => {}); }
    S.settings = { ...DEFAULTS, ...saved };
  } catch { S.settings = { ...DEFAULTS }; }
  applyTheme();
  applyLang();
}

let saveTimer;
function saveSettings(patch, rerender = true) {
  Object.assign(S.settings, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.sync.set({ settings: S.settings }).catch(() => {}), 300);
  if (S.report && rerender) { S.res = analyze(S.report, S.settings, S.nav); mergeExtraIssues(); render(); }
}

function applyTheme() {
  const th = S.settings.theme;
  if (th === 'light' || th === 'dark') document.documentElement.setAttribute('data-theme', th);
  else document.documentElement.removeAttribute('data-theme');
}

function applyLang() {
  const ui = chrome.i18n.getUILanguage().toLowerCase().slice(0, 2);
  const l = S.settings.lang === 'auto' ? (LANGS.some(([c]) => c === ui) ? ui : (['be', 'kk', 'ky'].includes(ui) ? 'ru' : 'en')) : S.settings.lang;
  setLang(l);
  document.documentElement.lang = l;
}

// ---------- page access ----------
function supported(url) {
  if (!/^https?:\/\//i.test(url || '')) return 'scheme';
  if (/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(url)) return 'store';
  return null;
}

async function activeTab() {
  const p = new URLSearchParams(location.search);
  if (p.get('tabId')) {
    const tab = await chrome.tabs.get(Number(p.get('tabId')));
    return tab;
  }
  if (S.tabId != null) { try { return await chrome.tabs.get(S.tabId); } catch { /* closed: fall back */ } }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function exec(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args, world: 'ISOLATED' });
  return res ? res.result : null;
}

async function ensureCollector(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/collector.js'], world: 'ISOLATED' });
}

async function run() {
  if (S.busy) { run.again = true; return; }
  S.busy = true;
  S.error = null;
  render();
  try {
    S.allSites = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    const tab = await activeTab();
    if (!tab) throw Object.assign(new Error('notab'), { code: 'notab' });
    S.tabId = tab.id;
    const tabUrl = tab.url || tab.pendingUrl || '';
    S.url = tabUrl;
    // Without host access Chrome hides the tab URL; then try to read the page anyway (activeTab may allow it).
    const why = tabUrl ? supported(tabUrl) : null;
    if (why) throw Object.assign(new Error(why), { code: why });
    if (tab.status === 'loading') await waitComplete(tab.id);
    await ensureCollector(tab.id);
    const report = await exec(tab.id, () => globalThis.__seoLens.collect());
    if (!report) throw Object.assign(new Error('empty'), { code: 'empty' });
    if (!/html|xml/.test(report.contentType || '')) throw Object.assign(new Error('nothtml'), { code: 'nothtml' });
    const navResp = await chrome.runtime.sendMessage({ type: 'getNav', tabId: tab.id, url: report.url }).catch(() => null);
    S.report = report;
    S.url = report.url;
    S.nav = navResp && navResp.rec ? navResp.rec : null;
    S.selection = report.text.selection || S.selection;
    S.res = analyze(report, S.settings, S.nav);
    mergeExtraIssues();
    // Changes since the last check of this URL (stored locally, small snapshots only).
    if (S.settings.keepHistory) {
      const snap = snapshot(report, S.res);
      const prev = await lastSnapshot(snap.url);
      S.diff = { ready: true, data: diffSnapshots(prev, snap) };
      await saveSnapshot(snap);
      S.history = await listSnapshots(snap.url);
    } else { S.diff = null; S.history = null; }
    S.stale = false;
    S.cacheOff = false;
    updateBadge();
    S.restoredAt = null;
    reapplyHighlights();
  } catch (e) {
    const msg = String(e && e.message || e);
    S.error = e.code || (/chrome:\/\/|chrome-extension:\/\/|extensions gallery|cannot be scripted|about:/i.test(msg) ? 'scheme' : /Cannot access|permission|host/i.test(msg) ? 'access' : 'generic');
    if (S.error === 'scheme' && !S.url && !S.allSites) S.error = 'access';
    S.errorText = msg;
    S.report = S.report && S.report.url === S.url ? S.report : null;
    if (!S.report) S.res = null;
  } finally {
    S.busy = false;
    render();
    if (run.again) { run.again = false; run(); }
  }
}

function waitComplete(tabId) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(fn); resolve(); };
    const fn = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    chrome.tabs.onUpdated.addListener(fn);
    setTimeout(done, 15000);
  });
}

async function highlight(kind, on) {
  if (S.tabId == null) return;
  try {
    await ensureCollector(S.tabId);
    await exec(S.tabId, (k, o) => globalThis.__seoLens.highlight(k, o), [kind, on]);
  } catch { toast(t('err_access_short')); }
}

function reapplyHighlights() {
  if (S.settings.hlHeadings) highlight('headings', true);
  if (S.settings.hlRel) highlight('rel', true);
  if (S.settings.hlNoindex) highlight('noindex', true);
}

async function scrollTo(kind, idx) {
  if (S.tabId == null) return;
  try {
    await ensureCollector(S.tabId);
    const r = await exec(S.tabId, (k, i) => globalThis.__seoLens.scrollTo(k, i), [kind, idx]);
    if (!r || !r.ok) toast(t('el_gone'));
    else if (!r.visible) toast(t('el_hidden'));
  } catch { toast(t('err_access_short')); }
}

async function readSelection() {
  if (S.tabId == null) return;
  try {
    await ensureCollector(S.tabId);
    S.selection = (await exec(S.tabId, () => globalThis.__seoLens.selection())) || '';
  } catch { /* ignore */ }
  render();
}

async function requestAllSites() {
  const ok = await chrome.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
  S.allSites = ok;
  if (ok) { toast(t('perm_granted')); if (S.tabId != null) chrome.tabs.reload(S.tabId); }
  render();
}

// ---------- render ----------
function render() {
  document.title = 'Canonical';
  scheduleSave();
  renderStatus();
  renderTabs();
  const main = $('#main');
  main.replaceChildren();
  if (S.tab === 'settings') { main.append(viewSettings()); return; }
  if (S.tab === 'tools' && S.url && !S.report) { main.append(viewTools()); return; }
  if (S.tab === 'domain' && S.url) { main.append(viewDomain()); return; }
  if (S.error && !S.report) { main.append(viewError()); return; }
  if (!S.report) {
    main.append(S.busy ? h('p', { class: 'muted pad' }, t('loading'))
      : h('div', { class: 'notice slim' }, h('h3', null, t('idle_title')), h('p', null, t('idle_text')), h('div', { class: 'row' }, btn(t('check_page'), () => run(), 'primary'))));
    return;
  }
  if (S.restoredAt && !S.stale) main.append(h('p', { class: 'muted small restored' }, t('restored_note', { time: new Date(S.restoredAt).toLocaleTimeString(currentLang() === 'en' ? 'en-US' : 'ru-RU', { hour: '2-digit', minute: '2-digit' }) })));
  if (S.stale) main.append(h('div', { class: 'notice' }, h('p', null, t('stale_text')), h('div', { class: 'row' }, btn(t('refresh'), () => run(), 'primary'))));
  const views = { overview: viewOverview, meta: viewMeta, index: viewIndex, headings: viewHeadings, text: viewText, links: viewLinks, images: viewImages, schema: viewSchema, server: viewServer, domain: viewDomain, speed: viewSpeed, tools: viewTools };
  main.append(views[S.tab]());
}

function isDark() {
  const th = S.settings.theme;
  if (th === 'dark') return true;
  if (th === 'light') return false;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

// Language and a one-click light/dark switch, at the right of the first row
// (as close to Chrome's own panel header as an extension can get).
function topControls() {
  const dark = isDark();
  return h('div', { class: 'topctl' },
    h('label', { class: 'langpick', title: t('lang_label') }, icon('globe', 17),
      h('select', { 'aria-label': t('lang_label'), onchange: (e) => { saveSettings({ lang: e.target.value }, false); applyLang(); render(); } },
        [['auto', t('lang_auto')], ...LANGS].map(([v, l]) => h('option', { value: v, selected: S.settings.lang === v || null }, l)))),
    h('button', { type: 'button', class: 'themebtn', title: t('theme_toggle'), 'aria-label': t('theme_toggle'), onclick: () => { saveSettings({ theme: isDark() ? 'light' : 'dark' }, false); applyTheme(); renderStatus(); } }, dark ? '☀' : '☾'));
}

function renderStatus() {
  const bar = $('#status');
  bar.replaceChildren();
  const status = S.res ? S.res.d.status : null;
  bar.append(
    h('div', { class: 'urlrow' },
      status ? badge(status < 300 ? 'ok' : status < 400 ? 'warn' : 'crit', String(status)) : null,
      h('span', { class: 'url', title: S.url }, S.url || '—'),
      topControls()),
    h('div', { class: 'actions' },
      btn(S.busy ? t('analyzing') : t('refresh'), () => run(), 'primary'),
      h('button', { type: 'button', class: 'btn iconbtn', title: t('copy_tab_title'), 'aria-label': t('copy_tab_title'), onclick: () => S.res && copy(tabText(), t('copied_tab', { tab: t('tab_' + S.tab) })) }, icon('copy', 16)),
      btn('Markdown', () => S.res && copy(reportText(S.report, S.res, true)), ''),
      btn('HTML', () => downloadHtmlReport(), ''),
      btn('Excel', () => S.res && downloadXlsx(sheetsFor(S.report, S.res), fileBase(S.url)), ''),
      btn('JSON', () => S.res && downloadJson({ report: S.report, nav: S.nav, issues: S.res.issues, score: S.res.score }, fileBase(S.url)), '')));
  bar.querySelectorAll('.btn').forEach((b, i) => { if (i > 0) b.disabled = !S.res; });
  bar.querySelector('.btn').disabled = S.busy;
}

function renderTabs() {
  const nav = $('#tabs');
  nav.replaceChildren(...TABS.map((id) => {
    let n = null;
    if (S.res && S.res.issues) {
      const c = S.res.issues.filter((i) => i.group === id && i.sev !== 'info').length;
      if (c && id !== 'overview') n = c;
    }
    return h('button', { type: 'button', class: 'tab', 'aria-selected': String(S.tab === id), onclick: () => { S.tab = id; render(); window.scrollTo(0, 0); } },
      t('tab_' + id), n ? h('span', { class: 'tab-n' }, n) : null);
  }));
}

function viewError() {
  const code = S.error;
  const box = h('div', { class: 'notice' }, h('h3', null, t('err_' + code + '_title')), h('p', null, t('err_' + code + '_text')));
  if (code === 'access') box.append(h('div', { class: 'row' }, btn(t('perm_button'), requestAllSites, 'primary')));
  if (code === 'generic') box.append(h('pre', { class: 'mono small' }, S.errorText || ''));
  return box;
}

function permBanner() {
  if (S.allSites) return null;
  return h('div', { class: 'notice slim' },
    h('p', null, t('perm_text')),
    btn(t('perm_button'), requestAllSites, 'primary'));
}

// ---------- Overview ----------
function viewOverview() {
  const { d, issues, score } = S.res;
  const r = S.report;
  const counts = { crit: 0, warn: 0, info: 0 };
  issues.forEach((i) => counts[i.sev]++);
  const scoreCls = score >= 85 ? 'ok' : score >= 60 ? 'warn' : 'crit';
  const reason = (k) => t('reason_' + k);
  const sum = d.summary;
  const modErr = (r.moduleErrors || []).length ? h('div', { class: 'notice slim' }, h('p', { class: 'small' }, t('module_errors', { list: r.moduleErrors.map((m) => m.module).join(', ') }))) : null;
  return h('div', null,
    modErr,
    permBanner(),
    h('section', { class: 'card hero' },
      h('div', { class: 'score s-' + scoreCls }, h('b', null, String(score)), h('span', null, '/100')),
      h('div', { class: 'hero-side' },
        h('div', { class: 'sevcounts' }, badge('crit', `${t('sev_crit')}: ${counts.crit}`), badge('warn', `${t('sev_warn')}: ${counts.warn}`), badge('info', `${t('sev_info')}: ${counts.info}`)),
        h('div', { class: 'facts' },
          h('span', null, t('words_main') + ': ', h('b', null, fmt(r.text.mainWords))),
          h('span', null, t('links') + ': ', h('b', null, fmt(r.links.total))),
          h('span', null, t('images') + ': ', h('b', null, fmt(r.images.total))),
          h('span', null, 'LCP: ', h('b', null, r.perf.lcp != null ? fmt(r.perf.lcp) + ' ms' : '—')),
          d.ip ? h('span', null, 'IP: ', h('b', null, d.ip)) : null))),
    card(t('sum_title'),
      h('ul', { class: 'summary' },
        h('li', null, stateBadge(sum.indexable), h('b', null, t('sum_indexable')), h('span', { class: 'muted' }, sum.indexable ? t('reason_none') : sum.indexReasons.map(reason).join('; '))),
        h('li', null, stateBadge(sum.followable), h('b', null, t('sum_followable')), h('span', { class: 'muted' }, sum.followable ? t('reason_follow_ok') : t('reason_nofollow'))),
        h('li', null, stateBadge(sum.crawlable), h('b', null, t('sum_crawlable')), h('span', { class: 'muted' }, sum.crawlable ? t('reason_robots_ok', { bot: d.robots.bot.label }) : t('reason_robots_rule', { rule: d.robots.match.rule ? d.robots.match.rule.raw : '' }))))),
    snippetCard(),
    pageTypeCard(),
    card(t('hl_title'), highlightToggles()),
    card(t('issues_title') + ` (${issues.length})`,
      chips([['all', t('if_all'), issues.length], ['crit', t('sev_crit'), counts.crit], ['warn', t('sev_warn'), counts.warn], ['info', t('sev_info'), counts.info]], S.issueFilter || 'all', (v) => { S.issueFilter = v; render(); }),
      issuesList(issues.filter((i) => !S.issueFilter || S.issueFilter === 'all' || i.sev === S.issueFilter))));
}

function historyCard() {
  if (!S.settings.keepHistory || !S.diff) return null;
  const df = S.diff.data;
  const when = (iso) => { try { return new Date(iso).toLocaleString(currentLang() === 'en' ? 'en-GB' : currentLang()); } catch { return iso; } };
  const cut = (v) => { const x = v == null ? '—' : String(v); return x.length > 120 ? x.slice(0, 120) + '…' : x || '∅'; };
  const scores = (S.history || []).map((x) => x.score);
  const body = [];
  if (!df) body.push(h('p', { class: 'muted small' }, t('hist_first')));
  else {
    body.push(h('p', { class: 'muted small' }, t('hist_since', { at: when(df.at) })));
    if (!df.changes.length && !df.added.length && !df.fixed.length) body.push(h('p', { class: 'ok-text small' }, t('hist_nochange')));
    if (df.changes.length) body.push(table([t('x_field'), t('hist_before'), t('hist_after')], df.changes.map((c) => h('tr', null, h('td', null, t('hf2_' + c.field)), h('td', { class: 'small' }, cut(c.before)), h('td', { class: 'small' }, cut(c.after)))), { compact: true }));
    if (df.added.length) body.push(h('details', { open: true }, h('summary', null, t('hist_added', { n: df.added.length })), h('ul', { class: 'small' }, df.added.map((i) => h('li', null, badge(i.sev, t('sev_' + i.sev)), ' ', issueText(i).msg)))));
    if (df.fixed.length) body.push(h('details', null, h('summary', null, t('hist_fixed', { n: df.fixed.length })), h('ul', { class: 'small' }, df.fixed.map((i) => h('li', null, badge('ok', '✓'), ' ', issueText(i).msg)))));
  }
  if (scores.length > 1) body.push(h('p', { class: 'small' }, t('hist_scores') + ': ', h('span', { class: 'mono' }, scores.join(' → '))));
  return card(t('hist_title'), ...body);
}

function issuesList(list) {
  if (!list.length) return h('p', { class: 'ok-text' }, t('no_issues'));
  return h('ul', { class: 'issues' }, list.map((i) => {
    const x = issueText(i);
    return h('li', { class: 'issue i-' + i.sev },
      h('div', { class: 'issue-head' }, badge(i.sev, t('sev_' + i.sev)), h('span', { class: 'issue-group' }, t('tab_' + i.group))),
      h('p', { class: 'issue-msg' }, x.msg),
      h('p', { class: 'issue-fix' }, h('b', null, t('x_fix') + ': '), x.fix, docFor(i.id) ? h('a', { href: docFor(i.id), class: 'doclink', onclick: (e) => { e.preventDefault(); chrome.tabs.create({ url: docFor(i.id), active: false }); toast(t('doc_opened')); } }, ' ' + t('doc_link') + ' ↗') : null),
      i.group !== 'overview' ? h('button', { type: 'button', class: 'link', onclick: () => { S.tab = i.group; render(); } }, t('open_tab')) : null);
  }));
}

function highlightToggles() {
  const tog = (key, kind, label) => h('label', { class: 'switch' },
    h('input', { type: 'checkbox', checked: S.settings[key] || null, onchange: (e) => { saveSettings({ [key]: e.target.checked }, false); highlight(kind, e.target.checked); } }),
    h('span', null, label));
  return h('div', { class: 'toggles' },
    tog('hlHeadings', 'headings', t('hl_headings')),
    tog('hlRel', 'rel', t('hl_rel')),
    tog('hlNoindex', 'noindex', t('hl_noindex')),
    h('p', { class: 'muted small' }, t('hl_note')));
}

function truncPx(text, font, max) {
  if (pxWidth(text, font) <= max) return text;
  let lo = 0; let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pxWidth(text.slice(0, mid) + ' …', font) <= max) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo).replace(/\s+\S*$/, '') + ' …';
}

function snippetCard() {
  const r = S.report; const d = S.res.d;
  let u; try { u = new URL(r.url); } catch { u = null; }
  const crumbs = u ? [u.hostname.replace(/^www\./, ''), ...u.pathname.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } })].join(' › ') : r.url;
  const mobile = S.snippet === 'mobile';
  const titleMax = mobile ? 2 * 300 : PX.titleMax;
  const descMax = mobile ? 2 * 330 : PX.descMax;
  const title = d.title.text || r.url;
  const desc = d.desc.text || r.text.firstParagraph || '';
  const fav = d.favicon ? d.favicon.href : null;
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': t('snippet_title') }, [['desktop', t('snippet_desktop')], ['mobile', t('snippet_mobile')], ['yandex', t('snippet_yandex')]].map(([id, label]) =>
    h('button', { type: 'button', class: 'seg-btn', title: label, 'aria-label': label, 'aria-pressed': String(S.snippet === id), onclick: () => { S.snippet = id; render(); } }, id === 'yandex' ? h('span', { class: 'seg-letter' }, 'Я') : icon(id, 16))));
  if (S.snippet === 'yandex') {
    const cut = (txt, n) => (txt.length > n ? txt.slice(0, n).replace(/\s+\S*$/, '') + '…' : txt);
    return h('section', { class: 'card' },
      h('div', { class: 'cardhead' }, h('h3', null, t('snippet_title_y')), seg),
      h('div', { class: 'serp serp-y' },
        h('div', { class: 'serp-site' },
          fav ? h('img', { src: fav, alt: '', width: '16', height: '16', class: 'serp-fav' }) : h('span', { class: 'serp-fav ph' }),
          h('div', { class: 'serp-crumbs' }, u ? u.hostname.replace(/^www\./, '') + (u.pathname !== '/' ? ' › ' + crumbs.split(' › ').slice(1).join(' › ') : '') : r.url)),
        h('div', { class: 'serp-title' }, cut(title, 60)),
        h('div', { class: 'serp-desc' }, cut(desc, 240))),
      h('p', { class: 'muted small' }, t('snippet_note_y', { tl: title.length, dl: desc.length })));
  }
  return h('section', { class: 'card' },
    h('div', { class: 'cardhead' }, h('h3', null, t('snippet_title')), seg),
    h('div', { class: 'serp' + (mobile ? ' serp-m' : '') },
      h('div', { class: 'serp-site' },
        fav ? h('img', { src: fav, alt: '', width: '18', height: '18', class: 'serp-fav' }) : h('span', { class: 'serp-fav ph' }),
        h('div', null, h('div', { class: 'serp-name' }, (r.head.og['og:site_name'] || (u ? u.hostname.replace(/^www\./, '') : ''))), h('div', { class: 'serp-crumbs' }, crumbs))),
      h('div', { class: 'serp-title' }, truncPx(title, PX.titleFont, titleMax)),
      h('div', { class: 'serp-desc' }, truncPx(desc, PX.descFont, descMax))),
    h('p', { class: 'muted small' }, t('snippet_note', { tpx: d.title.px, tmax: PX.titleMax, dpx: d.desc.px, dmax: PX.descMax })));
}

// ---------- Meta ----------
function viewMeta() {
  const r = S.report; const d = S.res.d; const st = S.res.settings;
  const og = r.head.og; const tw = r.head.twitter;
  const coincLabel = { title_h1: t('coinc_title_h1'), title_desc: t('coinc_title_desc'), desc_h1: t('coinc_desc_h1') };
  const tagBlock = (label, info, min, max, pxMax, all) => h('section', { class: 'card' },
    h('div', { class: 'cardhead' }, h('h3', null, label),
      info.text ? h('button', { type: 'button', class: 'btn iconbtn small', title: t('copy'), 'aria-label': t('copy') + ' ' + label, onclick: () => copy(info.text) }, icon('copy', 15)) : null),
    h('p', { class: 'big-text' }, info.text || h('span', { class: 'muted' }, t('missing'))),
    h('div', { class: 'row' }, lenMeter(info.len, min, max), badge(info.px > pxMax ? 'warn' : 'ok', `${info.px} px / ${pxMax}`)),
    all.length > 1 ? h('div', null, h('p', { class: 'warn-text' }, t('dup_values', { n: all.length })), h('ol', { class: 'small' }, all.map((x) => h('li', null, x.text || '∅')))) : null);
  const ogRows = Object.entries(og).map(([k, v]) => [k, Array.isArray(v) ? v.join(' | ') : v]);
  const twRows = Object.entries(tw).map(([k, v]) => [k, Array.isArray(v) ? v.join(' | ') : v]);
  return h('div', null,
    tagBlock('Title', d.title, st.titleMin, st.titleMax, PX.titleMax, r.head.titles),
    tagBlock('Description', d.desc, st.descMin, st.descMax, PX.descMax, r.head.descriptions),
    card(t('coinc_title'),
      d.coinc.length ? h('ul', { class: 'small' }, d.coinc.map((c) => h('li', { class: 'warn-text' }, coincLabel[c]))) : h('p', { class: 'ok-text' }, t('coinc_none')),
      kvTable([
        [t('shared_title_h1'), d.shared.length ? d.shared.join(', ') : (d.h1[0] ? t('none_shared') : '—')],
        [t('title_coverage'), d.titleCoverage ? `${d.titleCoverage.found} / ${d.titleCoverage.total}` + (d.titleCoverage.missing.length ? ` (${t('missing_words')}: ${d.titleCoverage.missing.join(', ')})` : '') : '—'],
      ])),
    card(t('other_meta'), kvTable([
      ['Author', r.head.author],
      ['Publisher', r.head.publisher],
      ['Generator', r.head.generator.join(', ')],
      ['Charset', r.head.charset ? `${r.head.charset} (${r.head.documentCharset})` : null],
      ['Doctype', r.head.doctype],
      ['Favicon', d.favicon ? extLink(d.favicon.href, d.favicon.href) : null],
      ['Apple touch icon', d.appleIcon ? extLink(d.appleIcon.href, d.appleIcon.href) : null],
      ['Theme-color', r.head.themeColor],
      [t('lang_detected'), d.langGuess ? `${d.langGuess.lang} (${Math.round(d.langGuess.confidence * 100)}%)` + (r.head.lang ? ` · lang="${r.head.lang}"` : '') : null],
      ...Object.entries((r.structure && r.structure.geo) || {}).map(([k, v]) => [k, v]),
      ['lang', r.head.lang],
      ['dir', r.head.dir],
    ])),
    mobileCard(d),
    card('Viewport',
      h('p', { class: 'mono small' }, r.head.viewport || t('missing')),
      d.viewport.checks.length ? h('ul', { class: 'checks' }, d.viewport.checks.map((c) => h('li', null, stateBadge(c.ok, '✓', '✗'), t(c.id)))) : null),
    card('Hreflang', d.hreflang.length ? table(['hreflang', 'URL', t('source')], d.hreflang.map((x) => h('tr', null, h('td', { class: 'mono' }, x.lang), h('td', null, extLink(x.href, x.href)), h('td', null, x.src === 'header' ? 'HTTP' : (x.inHead ? 'head' : 'body')))), { compact: true }) : h('p', { class: 'muted' }, t('none_found')),
      d.hreflang.length ? btn(t('copy_list'), () => copy(d.hreflang.map((x) => `${x.lang}\t${x.href}`).join('\n')), 'small') : null,
      d.hreflang.length ? hreflangCheck() : null),
    card('Open Graph', ogRows.length ? kvTable(ogRows) : h('p', { class: 'muted' }, t('none_found')), d.ogMissing.length ? h('p', { class: 'warn-text small' }, t('og_missing_list', { list: d.ogMissing.join(', ') })) : null),
    card('Twitter Card', twRows.length ? kvTable(twRows) : h('p', { class: 'muted' }, t('none_found'))),
    card(t('template_title'),
      h('pre', { class: 'mono small pre' }, fillCopyTemplate()),
      h('div', { class: 'row' }, btn(t('copy'), () => copy(fillCopyTemplate()), 'primary'), btn(t('edit_template'), () => { S.tab = 'settings'; render(); }, ''))));
}

function fillCopyTemplate() {
  const r = S.report; const d = S.res.d;
  const vals = {
    title: d.title.text, h1: d.h1[0] || '', description: d.desc.text,
    url: r.url, canonical: (r.head.canonicals[0] || {}).href || '',
    robots: r.head.robotsMeta.map((m) => `${m.name}: ${m.content}`).join('; '),
  };
  return (S.settings.template || DEFAULTS.template).replace(/\{(\w+)\}/g, (m, k) => (k in vals ? vals[k] : m));
}

// ---------- Indexing ----------
function viewIndex() {
  const r = S.report; const d = S.res.d;
  const rb = d.robots;
  const sm = d.sitemap;
  const dir = d.directives;
  const robotsStatus = rb.fetch.status;
  const ops = searchOperators(r.url);
  return h('div', null,
    card(t('robots_meta_title'),
      h('div', { class: 'row' }, h('label', { class: 'small' }, t('bot') + ': '),
        h('select', { onchange: (e) => saveSettings({ bot: e.target.value }) }, BOTS.map((b) => h('option', { value: b.id, selected: b.id === S.settings.bot || null }, b.label)))),
      dir.all.length ? table([t('source'), t('name'), t('value')], dir.all.map((x) => h('tr', null, h('td', null, x.src === 'meta' ? 'meta' : 'X-Robots-Tag'), h('td', { class: 'mono' }, x.name), h('td', { class: 'mono' }, x.content))), { compact: true }) : h('p', { class: 'muted' }, t('no_directives')),
      dir.rare.length ? h('p', { class: 'small' }, t('rare_directives') + ': ', h('span', { class: 'mono' }, dir.rare.map((x) => x.token).join(', '))) : null,
      r.raw.ok && r.raw.noindexTags ? h('p', { class: 'small warn-text' }, t('noindex_tags', { n: r.raw.noindexTags })) : null),
    card('robots.txt',
      kvTable([
        ['URL', extLink(rb.fetch.url, rb.fetch.url)],
        [t('status_code'), robotsStatus ? badge(robotsStatus === 200 ? 'ok' : robotsStatus >= 500 || robotsStatus === 429 ? 'crit' : 'warn', String(robotsStatus)) : badge('warn', t('unreachable'))],
        [t('robots_group'), rb.match.agent ? h('span', { class: 'mono' }, 'User-agent: ' + rb.match.agent) : t('robots_no_group')],
        [t('robots_verdict'), stateBadge(rb.match.allowed, t('allowed'), t('disallowed'))],
        [t('robots_rule'), rb.match.rule ? h('span', { class: 'mono' }, `${rb.match.rule.raw}  (${t('line')} ${rb.match.rule.line})`) : t('robots_no_rule')],
        ['Clean-param', d.cleanParam.rules.length ? h('div', null, d.cleanParam.rules.map((c) => h('div', { class: 'mono small' }, c.raw)), d.cleanParam.stripped.length ? h('div', { class: 'small' }, t('clean_param_stripped', { list: d.cleanParam.stripped.join(', ') })) : null) : null],
        ['Sitemap', rb.parsed.sitemaps.length ? h('div', null, rb.parsed.sitemaps.map((s) => h('div', null, extLink(s, s)))) : null],
      ]),
      rb.fetch.looksHtml ? h('p', { class: 'warn-text small' }, t('robots_html')) : null,
      robotsStatus >= 500 || robotsStatus === 429 ? h('p', { class: 'crit-text' }, t('r.robots_5xx', { status: robotsStatus })) : null,
      rb.fetch.text ? h('details', null, h('summary', null, t('show_file')), h('pre', { class: 'mono small pre scroll' }, rb.fetch.text.slice(0, 20000))) : null),
    card(t('res_title'),
      h('p', { class: 'muted small' }, t('res_hint', { bot: rb.bot.label, n: d.resTotal })),
      !rb.fetch.text ? h('p', { class: 'muted' }, t('res_no_robots'))
        : d.blockedRes.length ? h('div', null,
          table([t('res_kind'), 'URL', t('robots_rule')], d.blockedRes.slice(0, 300).map((x) => h('tr', null,
            h('td', null, badge(x.kind === 'css' || x.kind === 'js' ? 'warn' : 'info', t('res_k_' + x.kind))),
            h('td', { class: 'url-cell' }, x.url),
            h('td', { class: 'mono small' }, x.rule))), { compact: true }),
          btn(t('copy_table'), () => copy(d.blockedRes.map((x) => `${x.kind}\t${x.url}\t${x.rule}`).join('\n')), 'small'))
          : h('p', { class: 'ok-text' }, t('res_none'))),
    card('sitemap.xml',
      kvTable([
        ['URL', extLink(sm.checkedUrl, sm.checkedUrl)],
        [t('declared_in_robots'), sm.declared.length ? t('yes') + ` (${sm.declared.length})` : t('no')],
        [t('status_code'), sm.first.status ? String(sm.first.status) : t('unreachable')],
        [t('valid_xml'), sm.first.ok ? stateBadge(sm.first.isXml) : '—'],
        [t('sitemap_type'), sm.first.type ? (sm.first.type === 'sitemapindex' ? t('sitemap_index') : 'urlset') : '—'],
        [sm.first.type === 'sitemapindex' ? t('sitemap_children') : t('sitemap_urls'), sm.count ? fmt(sm.count) : '—'],
        ...(d.sitemapStats ? [[t('sm_lastmod_row'), `${fmt(d.sitemapStats.lastmod)} / ${fmt(d.sitemapStats.urls)}` + (d.sitemapStats.newest ? ` · ${d.sitemapStats.oldest} … ${d.sitemapStats.newest}` : '')]] : []),
        [t('url_in_sitemap'), sm.contains === true ? badge('ok', t('yes')) : sm.contains === false ? badge('warn', t('no')) : (sm.first.isXml ? h('span', { class: 'muted' }, t('not_found_checked', { n: sm.checkedFiles })) : '—')],
      ]),
      sm.children.length ? h('details', null, h('summary', null, t('show_list') + ` (${sm.children.length})`), h('ul', { class: 'small scroll' }, sm.children.map((c) => h('li', null, extLink(c, c))))) : null),
    quickFilesCard(r),
    aiBotsCard(d),
    urlCard(r, d),
    card('Canonical',
      kvTable([
        [t('canonical_dom'), d.canonical.list.length ? h('div', null, d.canonical.list.map((c) => h('div', null, extLink(c.href, c.href), !c.inHead ? badge('crit', 'body') : null, !/^https?:/i.test(c.raw) ? badge('warn', t('relative')) : null))) : null],
        [t('canonical_state'), d.canonical.state === 'self' ? badge('ok', t('canonical_self')) : d.canonical.state === 'other' ? badge('warn', t('canonical_other_short')) : badge('warn', t('missing'))],
        [t('canonical_http'), d.canonical.header.length ? d.canonical.header.join(', ') : null],
        [t('canonical_raw'), d.canonical.raw ? (d.canonical.raw.length ? d.canonical.raw.join(', ') : t('canonical_raw_none')) : t('raw_unavailable')],
      ]),
      d.canonical.list.length ? canonicalTargetCheck(d.canonical.list[0].href) : null),
    card(t('pagination_title'), kvTable([
      ['rel="prev"', r.head.prev ? extLink(r.head.prev, r.head.prev) : null],
      ['rel="next"', r.head.next ? extLink(r.head.next, r.head.next) : null],
      [t('page_number'), d.pageNo > 1 ? String(d.pageNo) : null],
      ['RSS / Atom', r.head.feeds.length ? h('div', null, r.head.feeds.map((f) => h('div', null, extLink(f.title || f.href, f.href)))) : null],
    ])),
    card(t('operators_title'),
      h('div', { class: 'btnrow' }, ops.map((o) => btn(o.label, () => openUrl(o.url || o.make(S.res.d.title.text || ''))))),
      h('div', { class: 'btnrow' },
        btn(t('yandex_recrawl'), () => { copy(r.url, t('url_copied')); openUrl(yandexRecrawl(r.url)); }),
        btn('Wayback Machine', () => openUrl('https://web.archive.org/web/*/' + r.url)))));
}

// ---------- Headings ----------
function viewHeadings() {
  const r = S.report; const d = S.res.d;
  const counts = [1, 2, 3, 4, 5, 6].map((l) => r.headings.filter((x) => x.level === l).length);
  const q = S.headQuery.toLowerCase();
  const list = r.headings.filter((x) => !q || x.text.toLowerCase().includes(q));
  const errs = S.res.issues.filter((i) => i.group === 'headings');
  return h('div', null,
    d.structure && d.structure.sitewideHeadings && d.structure.sitewideHeadings.length ? card(t('sitewide_title'), h('p', { class: 'muted small' }, t('sitewide_hint')), table(['', t('text'), t('where')], d.structure.sitewideHeadings.map((x) => h('tr', null, h('td', { class: 'mono' }, 'H' + x.level), h('td', null, x.text || '∅'), h('td', { class: 'mono small' }, '<' + x.where + '>'))), { compact: true })) : null,
    card(null,
      h('div', { class: 'hcounts' }, counts.map((c, i) => h('div', { class: 'hc' + (i === 0 && c !== 1 ? ' hc-bad' : '') }, h('span', null, 'H' + (i + 1)), h('b', null, String(c))))),
      errs.length ? issuesList(errs) : h('p', { class: 'ok-text' }, t('headings_ok'))),
    card(t('tree_title'),
      h('div', { class: 'row' },
        h('input', { type: 'search', class: 'input', placeholder: t('search'), value: S.headQuery, oninput: (e) => { S.headQuery = e.target.value; const pos = e.target.selectionStart; render(); const inp = document.querySelector('#main input[type=search]'); if (inp) { inp.focus(); inp.setSelectionRange(pos, pos); } } }),
        btn(t('copy'), () => copy(r.headings.map((x) => '  '.repeat(x.level - 1) + `H${x.level} ${x.text}`).join('\n')), 'small'),
        btn('CSV', () => downloadCsv([[t('level'), t('text'), t('x_flags')], ...r.headings.map((x) => ['H' + x.level, x.text, (d.headingFlags.get(x.idx) || []).map((f) => t('hf_' + f)).join(', ')])], fileBase(r.url) + '_headings'), 'small')),
      list.length ? h('ul', { class: 'tree' }, list.map((x) => {
        const f = d.headingFlags.get(x.idx) || [];
        return h('li', { class: 'tree-item', style: `--lvl:${x.level - 1}` },
          h('button', { type: 'button', class: 'tree-btn', title: t('scroll_to'), onclick: () => scrollTo('h', x.idx) },
            h('span', { class: 'htag h' + x.level }, 'H' + x.level),
            h('span', { class: 'htext' + (x.text ? '' : ' muted') }, x.text || t('empty_heading'))),
          f.map((fl) => badge(fl === 'dup' ? 'info' : 'warn', t('hf_' + fl))),
          x.hidden ? badge('info', t('hidden')) : null);
      })) : h('p', { class: 'muted' }, t('nothing_found'))));
}

// ---------- Text ----------
function freqRows(fr) {
  return [[t('word'), t('count'), '%'], ...fr.topWords.map((w) => [w.word, w.count, w.pct.toFixed(2)]), [], [t('phrase'), t('count'), '%'], ...fr.topBi.map((w) => [w.word, w.count, w.pct.toFixed(2)])];
}
function viewText() {
  const r = S.report; const d = S.res.d; const tx = r.text;
  const extra = (S.settings.stopwords || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  const fr = frequency(tx.mainText, { extraStop: extra, useStop: S.freqStop, top: 30 });
  const thin = tx.mainWords < S.settings.thinWords;
  const kw = S.settings.focus;
  const fk = kw ? focusKeyword(kw, {
    mainText: tx.mainText, url: r.url, title: d.title.text, description: d.desc.text, h1: d.h1,
    h2: r.headings.filter((x) => x.level === 2).map((x) => x.text), firstParagraph: tx.firstParagraph,
    alts: r.images.items.map((i) => i.alt || '').filter(Boolean),
  }) : null;
  const sel = S.selection || '';
  const selWords = (sel.match(/[\p{L}\p{N}]+/gu) || []).length;
  return h('div', null,
    jsCard(d),
    readabilityCard(),
    card(t('text_volume'),
      table([t('scope'), t('words'), t('chars'), t('chars_nospace')], [
        h('tr', null, h('td', null, t('main_text'), h('div', { class: 'muted small' }, tx.mainSource)), h('td', null, fmt(tx.mainWords)), h('td', null, fmt(tx.mainChars)), h('td', null, fmt(tx.mainCharsNoSpaces))),
        h('tr', null, h('td', null, t('whole_page')), h('td', null, fmt(tx.fullWords)), h('td', null, fmt(tx.fullChars)), h('td', null, fmt(tx.fullCharsNoSpaces))),
      ], { compact: true }),
      kvTable([
        ['Text/HTML ratio', h('span', null, d.ratio.toFixed(1) + '%', ' ', badge(d.ratio < 10 ? 'warn' : 'ok', d.ratio < 10 ? t('low') : t('normal')))],
        [t('html_size'), kb(tx.htmlBytes)],
        [t('thin_check'), thin ? badge('warn', t('thin_yes', { n: S.settings.thinWords })) : badge('ok', t('thin_no'))],
      ])),
    card(t('focus_title'),
      h('div', { class: 'row' },
        h('input', { type: 'text', class: 'input', placeholder: t('focus_placeholder'), value: kw, onchange: (e) => saveSettings({ focus: e.target.value.trim() }) }),
        btn(t('check'), () => { const v = document.querySelector('#main .input[type=text]').value.trim(); saveSettings({ focus: v }); }, 'primary')),
      fk ? h('div', null,
        h('div', { class: 'row' }, badge(fk.score >= 70 ? 'ok' : fk.score >= 40 ? 'warn' : 'crit', `${t('focus_score')}: ${fk.score}/100`),
          h('span', { class: 'small' }, t('occurrences') + ': ', h('b', null, String(fk.count)), ' · ', t('density') + ': ', h('b', null, fk.density.toFixed(2) + '%'))),
        h('ul', { class: 'checks' }, fk.checks.map((c) => h('li', null, stateBadge(c.ok, '✓', '✗'), t('fk_' + c.id)))),
        btn(t('wordstat_btn'), () => openUrl('https://wordstat.yandex.ru/?region=all&view=table&words=' + encodeURIComponent(kw)), 'small')) : h('p', { class: 'muted small' }, t('focus_hint'))),
    h('section', { class: 'card' },
      h('div', { class: 'cardhead' }, h('h3', null, t('freq_title')),
        h('div', { class: 'headbtns' },
          h('button', { type: 'button', class: 'btn iconbtn small', title: t('copy_table'), 'aria-label': t('copy_table'), onclick: () => copy(freqRows(fr).map((row) => row.join('\t')).join('\n')) }, icon('copy', 15)),
          h('button', { type: 'button', class: 'btn iconbtn small', title: t('download_csv'), 'aria-label': t('download_csv'), onclick: () => downloadCsv(freqRows(fr), fileBase(r.url) + '_words') }, icon('download', 15)))),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: S.freqStop || null, onchange: (e) => { S.freqStop = e.target.checked; render(); } }), h('span', null, t('use_stopwords'))),
      h('div', { class: 'cols2' },
        table([t('word'), '×', '%'], fr.topWords.map((w) => h('tr', null, h('td', null, w.word), h('td', null, String(w.count)), h('td', null, w.pct.toFixed(2)))), { compact: true }),
        table([t('phrase'), '×', '%'], fr.topBi.map((w) => h('tr', null, h('td', null, w.word), h('td', null, String(w.count)), h('td', null, w.pct.toFixed(2)))), { compact: true, empty: t('no_phrases') })),
      ),
    card(t('selection_title'),
      sel ? h('div', null,
        h('p', { class: 'small quote' }, sel.length > 300 ? sel.slice(0, 300) + '…' : sel),
        kvTable([[t('chars'), fmt(sel.length)], [t('chars_nospace'), fmt(sel.replace(/\s/g, '').length)], [t('words'), fmt(selWords)]])) : h('p', { class: 'muted small' }, t('selection_hint')),
      btn(t('read_selection'), readSelection, 'small')),
    card(t('copy_texts'),
      h('div', { class: 'btnrow' },
        btn(t('copy_page_text'), () => copy(tx.fullText)),
        btn(t('copy_main_text'), () => copy(tx.mainText)),
        btn(t('copy_headings'), () => copy(r.headings.map((x) => x.text).join('\n'))),
        btn(t('copy_anchors'), () => copy(r.links.items.map((l) => l.text).filter(Boolean).join('\n'))))));
}

// ---------- Links ----------
function viewLinks() {
  const r = S.report; const d = S.res.d;
  const L = d.links;
  const by = (f) => L.filter(f).length;
  const filters = {
    all: () => true,
    internal: (l) => l.type === 'internal',
    external: (l) => l.type === 'external',
    subdomain: (l) => l.type === 'subdomain',
    nofollow: (l) => l.nofollow || l.sponsored || l.ugc,
    bad: (l) => l.bad.length > 0,
  };
  const q = S.linkQuery.toLowerCase();
  const list = L.filter(filters[S.linkFilter]).filter((l) => !q || (l.href || '').toLowerCase().includes(q) || (l.text || '').toLowerCase().includes(q));
  const shown = list.slice(0, 500);
  const my = (S.settings.myDomain || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  const mine = my ? L.filter((l) => l.host && (l.host === my || l.host === 'www.' + my || (S.settings.myDomainSubs && l.host.endsWith('.' + my.replace(/^www\./, ''))))) : [];
  const exportRows = () => [['URL', t('anchor'), t('type'), 'rel', 'title', t('x_flags')], ...list.map((l) => [l.href || l.raw || '', l.text || l.imgAlt || '', t('lt_' + l.type), l.rel, l.title, l.bad.map((b) => t('lb_' + b)).join(', ')])];
  return h('div', null,
    linkProblemsCard(d),
    d.structure && d.structure.dupLinks && d.structure.dupLinks.length ? card(t('duplinks_title'), h('p', { class: 'muted small' }, t('duplinks_hint')), table([t('text'), 'URL', t('count')], d.structure.dupLinks.map((x) => h('tr', null, h('td', null, x.text || '∅'), h('td', { class: 'url-cell' }, x.href), h('td', null, String(x.c)))), { compact: true })) : null,
    card(null,
      h('div', { class: 'facts' },
        h('span', null, t('total') + ': ', h('b', null, fmt(r.links.total))),
        h('span', null, t('lt_internal') + ': ', h('b', null, by(filters.internal))),
        h('span', null, t('lt_external') + ': ', h('b', null, by(filters.external))),
        h('span', null, 'nofollow: ', h('b', null, by((l) => l.nofollow))),
        h('span', null, 'sponsored: ', h('b', null, by((l) => l.sponsored))),
        h('span', null, 'ugc: ', h('b', null, by((l) => l.ugc))))),
    card(t('my_domain_title'),
      h('div', { class: 'row' },
        h('input', { type: 'text', class: 'input', placeholder: 'example.com', value: S.settings.myDomain, onchange: (e) => saveSettings({ myDomain: e.target.value.trim() }) }),
        h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: S.settings.myDomainSubs || null, onchange: (e) => saveSettings({ myDomainSubs: e.target.checked }) }), h('span', null, t('with_subdomains')))),
      my ? (mine.length ? table([t('anchor'), 'URL', 'rel'], mine.map((l) => h('tr', { class: 'clickable', onclick: () => scrollTo('l', l.idx) }, h('td', null, l.text || l.imgAlt || '—'), h('td', { class: 'url-cell' }, l.href), h('td', null, l.rel ? badge(l.nofollow || l.sponsored || l.ugc ? 'warn' : 'info', l.rel) : badge('ok', 'dofollow')))), { compact: true }) : h('p', { class: 'warn-text' }, t('my_domain_none'))) : h('p', { class: 'muted small' }, t('my_domain_hint'))),
    card(t('links_list'),
      chips([['all', t('all'), L.length], ['internal', t('lt_internal'), by(filters.internal)], ['external', t('lt_external'), by(filters.external)], ['subdomain', t('lt_subdomain'), by(filters.subdomain)], ['nofollow', 'rel', by(filters.nofollow)], ['bad', t('bad_links'), by(filters.bad)]], S.linkFilter, (v) => { S.linkFilter = v; render(); }),
      h('div', { class: 'row' },
        h('input', { type: 'search', class: 'input', placeholder: t('search_links'), value: S.linkQuery, oninput: (e) => { S.linkQuery = e.target.value; const pos = e.target.selectionStart; render(); const inp = document.querySelector('#main input[type=search]'); if (inp) { inp.focus(); inp.setSelectionRange(pos, pos); } } }),
        btn('CSV', () => downloadCsv(exportRows(), fileBase(r.url) + '_links'), 'small'),
        btn('Excel', () => downloadXlsx([[t('tab_links'), exportRows()]], fileBase(r.url) + '_links'), 'small')),
      h('p', { class: 'muted small' }, t('click_to_find') + (list.length > 500 ? ' · ' + t('shown_first', { n: 500, total: list.length }) : '')),
      table([t('anchor'), 'URL', 'rel'], shown.map((l) => h('tr', { class: 'clickable', onclick: () => scrollTo('l', l.idx) },
        h('td', null, l.text || (l.imgAlt != null ? (l.imgAlt ? h('span', { class: 'muted' }, '[img] ' + l.imgAlt) : h('span', { class: 'empty-val' }, '[img] ' + t('no_alt'))) : h('span', { class: 'empty-val' }, t('no_text'))), l.bad.map((b) => badge(b === 'vague' ? 'info' : 'warn', t('lb_' + b)))),
        h('td', { class: 'url-cell' }, l.href || h('span', { class: 'empty-val' }, l.raw == null ? t('no_href') : l.raw)),
        h('td', null, l.relList.filter((x) => ['nofollow', 'sponsored', 'ugc'].includes(x)).map((x) => badge('warn', x))))), { compact: true })));
}

// ---------- Images ----------
function viewImages() {
  const r = S.report; const d = S.res.d;
  const I = d.images;
  const has = (f) => (i) => i.flags.includes(f);
  const filters = {
    all: () => true, noalt: has('noalt'), emptyalt: has('emptyalt'), notitle: has('notitle'), nosize: has('nosize'),
    broken: has('broken'), oversized: has('oversized'), heavy: has('heavy'), lazy: has('lazy'), eager: has('eager'), modern: has('modern'),
  };
  const list = I.filter(filters[S.imgFilter]);
  const shown = list.slice(0, 300);
  const exportRows = () => [['src', 'alt', 'title', t('natural'), t('rendered'), t('weight_kb'), 'loading', t('x_flags')], ...list.map((i) => [i.src, i.alt ?? t('no_attr'), i.title || '', `${i.naturalW}×${i.naturalH}`, `${i.renderW}×${i.renderH}`, i.bytes ? Math.round(i.bytes / 1024) : '', i.loading, i.flags.filter((f) => !['eager', 'lazy', 'modern'].includes(f)).map((f) => t('if_' + f)).join(', ')])];
  return h('div', null,
    card(null, h('div', { class: 'facts' },
      h('span', null, '<img>: ', h('b', null, fmt(r.images.total))),
      h('span', null, t('bg_images') + ': ', h('b', null, fmt(r.images.background.length))),
      h('span', null, 'inline SVG: ', h('b', null, fmt(r.images.svgInline))))),
    savingsCard(),
    d.dupAlts.length ? card(t('dupalt_title'), table(['alt', t('count')], d.dupAlts.slice(0, 20).map((a) => h('tr', null, h('td', null, a.alt), h('td', null, String(a.c)))), { compact: true })) : null,
    card(t('images_list'),
      chips(Object.keys(filters).map((k) => [k, t('if_' + k), I.filter(filters[k]).length]), S.imgFilter, (v) => { S.imgFilter = v; render(); }),
      h('div', { class: 'row' },
        btn(t('copy_img_urls'), () => copy(list.map((i) => i.src).filter(Boolean).join('\n')), 'small'),
        btn('CSV', () => downloadCsv(exportRows(), fileBase(r.url) + '_images'), 'small'),
        btn('Excel', () => downloadXlsx([[t('tab_images'), exportRows()]], fileBase(r.url) + '_images'), 'small')),
      h('p', { class: 'muted small' }, t('click_to_find') + ' · ' + t('weight_note') + (list.length > 300 ? ' · ' + t('shown_first', { n: 300, total: list.length }) : '')),
      h('ul', { class: 'imglist' }, shown.map((i) => h('li', { class: 'img-item' },
        h('button', { type: 'button', class: 'thumb', onclick: () => scrollTo('i', i.idx), title: t('scroll_to') }, i.src ? h('img', { src: i.src, alt: '', loading: 'lazy' }) : null),
        h('div', { class: 'img-meta' },
          h('div', { class: 'url-cell small' }, i.src || t('no_src')),
          h('div', { class: 'small' }, h('b', null, 'alt: '), i.alt === null ? h('span', { class: 'empty-val' }, t('no_attr')) : (i.alt.trim() ? i.alt : h('span', { class: 'empty-val' }, t('empty')))),
          h('div', { class: 'small' }, h('b', null, 'title: '), i.title ? i.title : h('span', { class: 'empty-val' }, t('no_attr'))),
          h('div', { class: 'small muted' }, `${t('natural')} ${i.naturalW}×${i.naturalH} · ${t('rendered')} ${i.renderW}×${i.renderH}` + (i.bytes ? ` · ${kb(i.bytes)}` : '') + (i.format ? ` · ${i.format}` : '') + (i.loading ? ` · ${i.loading}` : '')),
          h('div', null, i.flags.filter((f) => !['eager', 'lazy', 'modern', 'notitle'].includes(f)).map((f) => badge(f === 'broken' || f === 'noalt' ? 'warn' : 'info', t('if_' + f))))))))),
    r.images.background.length ? card(t('bg_images'), h('details', null, h('summary', null, t('show_list') + ` (${r.images.background.length})`),
      table([t('element'), 'URL'], r.images.background.slice(0, 200).map((b) => h('tr', null, h('td', { class: 'mono small' }, b.el), h('td', { class: 'url-cell' }, b.src))), { compact: true }))) : null);
}

// ---------- Schema ----------
function jsonTree(value, depth = 0) {
  if (value === null || typeof value !== 'object') {
    return h('span', { class: 'jv' + (typeof value === 'string' ? ' js' : '') }, typeof value === 'string' ? `"${value.length > 200 ? value.slice(0, 200) + '…' : value}"` : String(value));
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
  return h('details', { open: depth < 2 || null, class: 'jt' },
    h('summary', null, Array.isArray(value) ? `[${entries.length}]` : (value['@type'] ? `{ @type: ${[].concat(value['@type']).join(', ')} }` : (typeof value.type === 'string' && value.type ? `{ ${value.type.replace(/^https?:\/\/schema\.org\//, '')} }` : `{${entries.length}}`))),
    h('ul', null, entries.map(([k, v]) => h('li', null, h('span', { class: 'jk' }, String(k)), ': ', jsonTree(v, depth + 1)))));
}

function viewSchema() {
  const r = S.report; const d = S.res.d;
  const jl = r.schema.jsonld;
  const og = r.head.og;
  const ogImg = Array.isArray(og['og:image']) ? og['og:image'][0] : og['og:image'];
  return h('div', null,
    card(t('schema_types'), d.schemaTypes.length ? h('ul', { class: 'typelist' }, d.schemaTypes.map((s) => h('li', null, h('b', null, s.type), h('span', { class: 'muted small' }, s.src.join(', '))))) : h('p', { class: 'muted' }, t('schema_none_found'))),
    d.schemaReq && d.schemaReq.rows.length ? card(t('schema_req_title'), table([t('type'), t('name'), t('schema_missing')], d.schemaReq.rows.map((x) => h('tr', null, h('td', { class: 'mono' }, x.type), h('td', { class: 'small' }, x.name || '—'), h('td', null, x.missing.length ? x.missing.map((m) => badge('warn', m)) : badge('ok', 'OK')))), { compact: true }), d.schemaReq.badRefs.length ? h('p', { class: 'warn-text small' }, t('r.schema_bad_ref', { list: d.schemaReq.badRefs.slice(0, 5).join(', ') })) : null) : null,
    productCard(d),
    articleCard(d),
    trustCard(d),
    card(t('validate_in'), h('div', { class: 'btnrow' }, btn('Google Rich Results Test ↗', () => openUrl('https://search.google.com/test/rich-results?url=' + encodeURIComponent(r.url)), 'primary'), btn('Schema.org Validator ↗', () => openUrl('https://validator.schema.org/#url=' + encodeURIComponent(r.url)), 'primary'))),
    card(`JSON-LD (${jl.length})`, jl.length ? jl.map((b) => h('div', { class: 'jsonblock' },
      h('div', { class: 'row' }, h('b', null, t('block') + ' ' + (b.idx + 1)), b.ok ? badge('ok', 'OK') : badge('crit', t('json_error'))),
      b.ok ? jsonTree(b.data) : h('div', null, h('p', { class: 'crit-text small' }, b.error), h('pre', { class: 'mono small pre' }, b.snippet)))) : h('p', { class: 'muted' }, t('none_found'))),
    card(`Microdata (${r.schema.microdata.length})`, r.schema.microdata.length ? r.schema.microdata.map((m) => jsonTree(m)) : h('p', { class: 'muted' }, t('none_found'))),
    card(`RDFa (${r.schema.rdfa.length})`, r.schema.rdfa.length ? r.schema.rdfa.map((m) => jsonTree(m)) : h('p', { class: 'muted' }, t('none_found'))),
    card(t('social_preview'),
      h('div', { class: 'ogcard' },
        ogImg ? h('img', { src: ogImg, alt: '', class: 'og-img' }) : h('div', { class: 'og-img ph' }, t('no_og_image')),
        h('div', { class: 'og-body' },
          h('div', { class: 'og-site' }, (og['og:site_name'] || r.host).toString().toUpperCase()),
          h('div', { class: 'og-title' }, og['og:title'] || d.title.text || '—'),
          h('div', { class: 'og-desc' }, og['og:description'] || d.desc.text || ''))),
      d.ogMissing.length ? h('p', { class: 'warn-text small' }, t('og_missing_list', { list: d.ogMissing.join(', ') })) : h('p', { class: 'ok-text small' }, t('og_complete')),
      !r.head.twitter['twitter:card'] ? h('p', { class: 'muted small' }, t('r.twitter_missing')) : null));
}

// ---------- Server ----------
function viewServer() {
  const r = S.report; const d = S.res.d;
  const hops = d.hops;
  const fin = S.nav && S.nav.final;
  const chain = hops.length || fin ? table([t('step'), t('status_code'), 'URL', 'IP'], [
    ...hops.map((x, i) => h('tr', null, h('td', null, String(i + 1)), h('td', null, badge(x.status >= 400 ? 'crit' : 'warn', String(x.status)), / Internal Redirect/i.test(x.statusLine) ? h('div', { class: 'small muted' }, t('hsts_internal')) : null), h('td', { class: 'url-cell' }, x.url), h('td', { class: 'mono small' }, x.ip || '—'))),
    fin ? h('tr', null, h('td', null, String(hops.length + 1)), h('td', null, badge(fin.status < 300 ? 'ok' : fin.status < 400 ? 'warn' : 'crit', String(fin.status))), h('td', { class: 'url-cell' }, fin.url), h('td', { class: 'mono small' }, fin.ip || '—')) : null,
  ], { compact: true }) : null;
  return h('div', null,
    card(t('redirects_title'),
      chain || h('p', { class: 'muted small' }, t('chain_hint')),
      chainCheck(),
      chain ? btn(t('copy_table'), () => copy([...hops.map((x) => `${x.status}\t${x.url}\t${x.ip || ''}`), fin ? `${fin.status}\t${fin.url}\t${fin.ip || ''}` : ''].join('\n')), 'small') : null,
      r.perf.redirectCount ? h('p', { class: 'small muted' }, t('nav_redirects', { n: r.perf.redirectCount })) : null),
    card(t('timing_title'), kvTable([
      ['TTFB', d.ttfb != null ? fmt(d.ttfb) + ' ms' : null],
      ['DOMContentLoaded', r.perf.dcl != null ? fmt(r.perf.dcl) + ' ms' : null],
      ['Load', r.perf.load != null ? fmt(r.perf.load) + ' ms' : null],
      [t('server_ip'), d.ip ? h('span', { class: 'mono' }, d.ip) : h('span', { class: 'muted small' }, S.allSites ? t('ip_reload') : t('ip_need_perm'))],
      [t('compression'), d.encoding ? h('span', null, badge('ok', d.encodingName), h('span', { class: 'mono small' }, ' content-encoding: ' + d.encoding)) : badge('warn', t('compression_none'))],
      [t('http_version'), d.httpVersion ? badge(/^HTTP\/[23]/.test(d.httpVersion) ? 'ok' : 'warn', d.httpVersion) : null],
      ['HTTPS', stateBadge(r.protocol === 'https:')],
      [t('charset_hdr_meta'), d.charsets.header || d.charsets.meta ? h('span', null, `${d.charsets.header || '—'} / ${d.charsets.meta || '—'}`, d.charsets.header && d.charsets.meta && d.charsets.header.toLowerCase() !== d.charsets.meta.toLowerCase() ? badge('warn', t('mismatch')) : null) : null],
      ['Expires', headerValuesOf(d.headers, 'expires') || null],
      ['Cache-Control', headerValuesOf(d.headers, 'cache-control') || null],
      ['Frames / iframe', d.structure ? `${d.structure.frames} / ${d.structure.iframes.length}` + (d.structure.flash ? ' · Flash: ' + d.structure.flash : '') : null],
      [t('dup_ids'), d.structure && d.structure.dupIds.length ? h('span', { class: 'mono small' }, d.structure.dupIds.map((x) => `#${x.id}×${x.c}`).join(', ')) : null],
      ['X-Content-Type-Options', d.secHeaders.xcto || null],
      ['X-Frame-Options', d.secHeaders.xfo || null],
      ['Referrer-Policy', d.secHeaders.referrer || null],
      ['Permissions-Policy', d.secHeaders.permissions ? h('span', { class: 'mono small' }, d.secHeaders.permissions.slice(0, 160)) : null],
      ['Content-Security-Policy', d.secHeaders.csp ? h('span', { class: 'mono small' }, d.secHeaders.csp.slice(0, 200) + (d.secHeaders.csp.length > 200 ? '…' : '')) : null],
      ['HSTS', d.hsts ? h('span', { class: 'mono small' }, d.hsts) : (r.protocol === 'https:' ? badge('info', t('none')) : null)],
      ['Meta refresh', r.extras && r.extras.metaRefresh != null ? badge('warn', r.extras.metaRefresh) : null],
      [t('insecure_forms'), r.extras && r.extras.insecureForms.length ? badge('warn', r.extras.insecureForms.join(', ')) : null],
      [t('requests'), fmt(r.perf.requests)],
      [t('page_weight'), kb(r.perf.pageBytes)],
      [t('dom_nodes'), fmt(r.perf.domNodes)],
    ])),
    variantsCard(),
    card(t('cache_title'), kvTable([
      ['Last-Modified', d.cache.lastModified ? h('span', { class: 'mono' }, d.cache.lastModified) : badge('info', t('none'))],
      ['ETag', d.cache.etag ? h('span', { class: 'mono' }, d.cache.etag) : badge('info', t('none'))],
      [t('cache_304'), !d.cache.lastModified && !d.cache.etag ? h('span', { class: 'muted small' }, t('cache_not_tested'))
        : d.cache.tested ? (d.cache.status === 304 ? badge('ok', t('cache_304_yes')) : badge('warn', t('cache_304_no', { status: d.cache.status })))
        : h('span', { class: 'muted small' }, d.cache.error || t('cache_not_tested'))],
    ]), d.cache.sent.length ? h('p', { class: 'muted small' }, t('cache_sent', { list: d.cache.sent.join(', ') })) : null),
    card(t('mixed_title') + ` (${r.mixed.length})`, r.mixed.length ? h('ul', { class: 'small scroll' }, r.mixed.map((u) => h('li', { class: 'url-cell' }, u))) : h('p', { class: 'ok-text' }, r.protocol === 'https:' ? t('mixed_none') : t('mixed_http'))),
    card(t('headers_title'),
      h('p', { class: 'muted small' }, t('headers_source_' + d.headersSource)),
      d.headers.length ? table([t('x_header'), t('x_value')], d.headers.map((x) => h('tr', null, h('td', { class: 'mono small' }, x.name), h('td', { class: 'mono small wrap' }, x.value))), { compact: true }) : null,
      d.headers.length ? btn(t('copy'), () => copy(d.headers.map((x) => `${x.name}: ${x.value}`).join('\n')), 'small') : null));
}

// ---------- Speed & tech ----------
function viewSpeed() {
  const r = S.report; const d = S.res.d; const p = r.perf;
  const metric = (name, val, unit, rateKey, good, poor, note) => h('div', { class: 'metric m-' + rateKey },
    h('div', { class: 'metric-name' }, name),
    h('div', { class: 'metric-val' }, val == null ? '—' : fmt(val) + (unit ? ' ' + unit : '')),
    h('div', { class: 'metric-rate' }, t('rate_' + rateKey)),
    h('div', { class: 'metric-th muted small' }, `${t('good')} ≤ ${good} · ${t('poor')} > ${poor}`),
    note ? h('div', { class: 'small muted' }, note) : null);
  return h('div', null,
    card('Core Web Vitals',
      h('div', { class: 'metrics' },
        metric('LCP', p.lcp, 'ms', d.cwv.lcp, '2500 ms', '4000 ms', p.lcpEl ? t('lcp_element') + ': ' + p.lcpEl : null),
        metric('INP', p.inp, 'ms', d.cwv.inp, '200 ms', '500 ms', p.inp == null ? t('inp_hint') : t('interactions', { n: p.interactions })),
        metric('CLS', p.cls, '', d.cwv.cls, '0.1', '0.25')),
      h('p', { class: 'muted small' }, t('cwv_note'))),
    d.brokenRes.length ? card(t('broken_res_title') + ` (${d.brokenRes.length})`, table([t('status_code'), t('type'), 'URL'], d.brokenRes.map((x) => h('tr', null, h('td', null, badge('crit', String(x.status))), h('td', { class: 'mono small' }, x.type), h('td', { class: 'url-cell' }, x.url))), { compact: true })) : null,
    card(t('blocking_title'),
      h('p', { class: 'muted small' }, t('blocking_hint')),
      d.blocking.scripts.length ? h('div', null, h('p', { class: 'small' }, h('b', null, 'JS: '), String(d.blocking.scripts.length)), h('ul', { class: 'small scroll' }, d.blocking.scripts.map((u) => h('li', { class: 'url-cell' }, u)))) : h('p', { class: 'ok-text small' }, t('blocking_js_none')),
      h('p', { class: 'small' }, h('b', null, 'CSS: '), String(d.blocking.styles.length)),
      d.blocking.styles.length ? h('ul', { class: 'small scroll' }, d.blocking.styles.map((u) => h('li', { class: 'url-cell' }, u))) : null),
    techCard(d),
    card(t('counters_title'), r.counters.length ? table([t('service'), 'ID'], r.counters.map((c) => h('tr', null, h('td', null, c.name), h('td', { class: 'mono small' }, c.ids.length ? c.ids.join(', ') : t('counter_noid')))), { compact: true }) : h('p', { class: 'muted' }, t('counters_none')),
      r.head.generator.length ? h('p', { class: 'small' }, 'Generator: ', h('b', null, r.head.generator.join(', '))) : null));
}

// ---------- Page type, readability, image savings ----------
function pageTypeCard() {
  const L = local(); if (!L) return null;
  const pt = L.pageType;
  return card(t('pt_title'),
    h('div', { class: 'row' }, badge('info', t('pt_' + pt.type)), badge(pt.intent === 'transactional' ? 'ok' : 'info', t('intent_' + pt.intent)), h('span', { class: 'muted small' }, t('pt_conf_' + pt.confidence) + (pt.why.length ? ' · ' + pt.why.join(', ') : ''))),
    L.tips.length ? h('ul', { class: 'checks' }, L.tips.map((x) => h('li', { class: 'row' }, stateBadge(x.ok, '✓', '✗'), h('span', null, t('tip_' + x.id))))) : h('p', { class: 'muted small' }, t('pt_no_tips')));
}

function readabilityCard() {
  const L = local(); if (!L) return null;
  const rd = L.readability;
  if (!rd.enough) return card(t('read_title'), h('p', { class: 'muted small' }, t('read_short')));
  const sev = rd.score >= 60 ? 'ok' : rd.score >= 40 ? 'info' : rd.score >= 25 ? 'warn' : 'crit';
  const total = rd.sentences || 1;
  const bar = h('div', { class: 'distbar' }, ['short', 'medium', 'long', 'veryLong'].map((k) => h('span', { class: 'db-' + k, style: `width:${(rd.buckets[k] / total) * 100}%`, title: `${t('read_b_' + k)}: ${rd.buckets[k]}` })));
  return card(t('read_title'),
    h('p', { class: 'muted small' }, t('read_hint')),
    h('div', { class: 'row' }, badge(sev, `${rd.score}/100 · ${t('read_' + rd.level)}`)),
    kvTable([
      [t('read_avg_sentence'), String(rd.avgSentence)],
      [t('read_avg_paragraph'), rd.avgParagraph != null ? String(rd.avgParagraph) : null],
      [t('read_long_sentences'), rd.longSentences.length ? badge('warn', String(rd.longSentences.length)) : badge('ok', '0')],
      [t('read_long_paragraphs'), rd.longParagraphs.length ? badge('warn', String(rd.longParagraphs.length)) : badge('ok', '0')],
      [t('read_water'), badge(rd.stopShare > 45 ? 'warn' : 'ok', rd.stopShare + '%')],
      [t('read_complex'), rd.complexShare + '%'],
      [t('read_repeats'), rd.repeats.length ? h('span', null, rd.repeats.map((w) => `${w.word} (${w.pct.toFixed(1)}%)`).join(', ')) : badge('ok', t('none'))],
    ]),
    h('div', null, bar, h('div', { class: 'distlegend small muted' }, ['short', 'medium', 'long', 'veryLong'].map((k) => h('span', null, h('i', { class: 'db-' + k }), `${t('read_b_' + k)}: ${rd.buckets[k]}`)))),
    rd.longSentences.length ? h('details', null, h('summary', null, t('read_show_long', { n: rd.longSentences.length })),
      h('ol', { class: 'small longlist' }, rd.longSentences.slice(0, 50).map((x) => h('li', null, h('span', { class: 'muted mono' }, `${x.words} · `), x.text)))) : null,
    rd.longParagraphs.length ? h('details', null, h('summary', null, t('read_show_longp', { n: rd.longParagraphs.length })),
      h('ol', { class: 'small longlist' }, rd.longParagraphs.slice(0, 30).map((x) => h('li', null, h('span', { class: 'muted mono' }, `${x.words} · `), x.text.slice(0, 300) + (x.text.length > 300 ? '…' : ''))))) : null);
}

function savingsCard() {
  const L = local(); if (!L) return null;
  const sv = L.savings;
  const lcpLazy = S.report.perf && S.report.perf.lcpLazy;
  const reasonText = (x) => x.id === 'resize' ? t('sav_resize', { w: x.w }) : t('sav_' + x.id);
  return card(t('sav_title'),
    h('p', { class: 'muted small' }, t('sav_hint')),
    lcpLazy ? h('p', { class: 'crit-text small' }, t('sav_lcp_lazy')) : null,
    sv.rows.length ? h('div', null,
      h('p', { class: 'small' }, t('sav_total_line', { kb: Math.round(sv.total / 1024), n: sv.rows.filter((x) => x.save > 0).length })),
      table([t('image'), t('sav_now'), t('sav_save'), t('sav_what')], sv.rows.slice(0, 60).map((x) => h('tr', { class: 'clickable', onclick: () => scrollTo('i', x.idx), title: t('click_to_scroll') },
        h('td', { class: 'url-cell' }, (x.src || '').split('/').pop().slice(0, 60) || '—', h('div', { class: 'small muted' }, `${x.naturalW}×${x.naturalH} → ${x.renderW}×${x.renderH} · ${x.format || '?'}`)),
        h('td', { class: 'mono small' }, kb(x.bytes)),
        h('td', { class: 'mono small' }, x.save ? '−' + kb(x.save) : '—'),
        h('td', { class: 'small' }, x.reasons.map((rr) => h('div', null, reasonText(rr)))))), { compact: true })) : h('p', { class: 'ok-text small' }, t('sav_none')));
}

// ---------- Compare with a competitor ----------
function compareCard() {
  const x = extra();
  const c = x.compare;
  const mine = S.report; const d = S.res.d;
  const body = [h('p', { class: 'muted small' }, t('cmp_hint'))];
  const input = h('input', { type: 'url', class: 'input', id: 'cmp-url', placeholder: 'https://competitor.example/page', value: S.cmpUrl || '' , oninput: (e) => { S.cmpUrl = e.target.value; } });
  body.push(h('div', { class: 'row' }, input, btn(x.busy.compare ? t('checking') : t('cmp_btn'), () => {
    const u = (S.cmpUrl || '').trim();
    if (!/^https?:\/\//i.test(u)) { toast(t('cmp_bad_url')); return; }
    runExtra('compare', async () => {
      const r = await fetchPage(u);
      if (r.error || !r.text) return { error: r.error || ('HTTP ' + (r.final && r.final.status)) };
      return { url: (r.final && r.final.url) || u, status: r.final && r.final.status, ms: r.ms, hops: r.hops.length, page: parsePage(r.text, (r.final && r.final.url) || u) };
    }).then(() => reveal('cmp-res'));
  }, 'primary')));
  if (c && c.error) body.push(h('p', { class: 'crit-text small' }, c.error));
  if (c && c.page) {
    const p = c.page;
    const myTypes = local().types;
    const myInt = d.links.filter((l) => l.type === 'internal').length;
    const row = (label, a, b, better) => h('tr', null, h('td', { class: 'small muted' }, label), h('td', { class: 'small' + (better === 'a' ? ' win' : '') }, a == null || a === '' ? '—' : a), h('td', { class: 'small' + (better === 'b' ? ' win' : '') }, b == null || b === '' ? '—' : b));
    const more = (a, b) => (a > b * 1.15 ? 'a' : b > a * 1.15 ? 'b' : null);
    const myH2 = mine.headings.filter((x0) => x0.level === 2).length; const thH2 = p.headings.filter((x0) => x0.level === 2).length;
    body.push(h('div', { id: 'cmp-res', class: 'stack' },
      table(['', t('cmp_mine'), t('cmp_theirs')], [
        row('URL', h('span', { class: 'url-cell' }, mine.url), h('span', { class: 'url-cell' }, extLink(c.url, c.url))),
        row(t('status_code'), String(d.status || '—'), String(c.status || '—')),
        row('Title', `${d.title.text || '—'} (${d.title.len})`, `${p.title || '—'} (${(p.title || '').length})`),
        row('Description', `${(d.desc.text || '—').slice(0, 160)} (${d.desc.len})`, `${(p.description || '—').slice(0, 160)} (${(p.description || '').length})`),
        row('H1', (d.h1 || []).join(' | '), p.h1.join(' | ')),
        row(t('cmp_h2'), String(myH2), String(thH2), more(myH2, thH2)),
        row(t('words_main'), fmt(mine.text.mainWords), fmt(p.words), more(mine.text.mainWords, p.words)),
        row(t('images'), `${mine.images.total} (${t('cmp_noalt')}: ${d.images.filter((i) => i.flags.includes('noalt')).length})`, `${p.images} (${t('cmp_noalt')}: ${p.imagesNoAlt})`),
        row(t('cmp_internal'), String(myInt), String(p.internal), more(myInt, p.internal)),
        row(t('tab_schema'), myTypes.slice(0, 8).join(', '), p.schema.slice(0, 8).join(', '), more(myTypes.length, p.schema.length)),
        row('Canonical', d.canonical.list[0] ? d.canonical.list[0].href : '', p.canonical),
        row('hreflang', String(d.hreflang.length), String(p.hreflang)),
        row('Open Graph', Object.keys(mine.head.og || {}).length ? t('yes') : t('no'), p.og ? t('yes') : t('no')),
        row(t('cmp_html'), kb(mine.text.htmlBytes), kb(p.htmlBytes)),
        row(t('cmp_time'), d.ttfb != null ? d.ttfb + ' ms (TTFB)' : '—', c.ms + ' ms'),
      ], { compact: true }),
      (() => {
        const gap = wordGap(mine.text.mainText || '', p.mainText || '');
        return h('div', { class: 'stack' }, h('h4', null, t('cmp_gap_title')), h('p', { class: 'muted small' }, t('cmp_gap_hint')),
          gap.length ? table([t('word'), t('cmp_theirs'), t('cmp_mine')], gap.map((g) => h('tr', null, h('td', null, g.word), h('td', { class: 'mono small' }, String(g.theirs)), h('td', { class: 'mono small' }, String(g.mine)))), { compact: true }) : h('p', { class: 'ok-text small' }, t('cmp_gap_none')));
      })(),
      h('details', null, h('summary', null, t('cmp_headings', { n: p.headings.length })), h('ul', { class: 'small' }, p.headings.slice(0, 80).map((x0) => h('li', { style: `margin-left:${(x0.level - 1) * 12}px` }, h('b', null, 'H' + x0.level + ' '), x0.text))))));
  }
  return card(t('cmp_title'), ...body);
}

// ---------- Check a list of addresses ----------
function urlListCard() {
  const x = extra();
  const L = x.urls;
  const body = [h('p', { class: 'muted small' }, t('ul_hint'))];
  body.push(h('textarea', { class: 'input area', rows: '5', id: 'ul-input', placeholder: 'https://site.uz/\nhttps://site.uz/page', oninput: (e) => { S.ulText = e.target.value; } }, S.ulText || ''));
  body.push(h('div', { class: 'btnrow', id: 'ul-res' },
    btn(x.busy.urls ? t('ul_progress', { n: S.ulDone || 0, total: S.ulTotal || 0 }) : t('ul_btn'), () => {
      const urls = [...new Set((S.ulText || '').split(/\s+/).map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u)))];
      if (!urls.length) { toast(t('ul_empty')); return; }
      if (urls.length > 50) toast(t('ul_limit'));
      S.ulDone = 0; S.ulTotal = Math.min(urls.length, 50);
      runExtra('urls', () => checkUrlList(urls, parsePage, (n, total) => {
        S.ulDone = n; S.ulTotal = total;
        const b = document.querySelector('#ul-res .btn'); if (b) b.textContent = t('ul_progress', { n, total });
      })).then(() => reveal('ul-res'));
    }, 'primary'),
    L && L.length ? btn(t('download_csv'), () => downloadCsv([['URL', t('status_code'), t('var_hops'), t('var_final'), 'ms', 'Title', 'Description', 'H1', 'H1 ×', 'Canonical', 'Meta robots', 'X-Robots-Tag', t('words')],
      ...L.map((r0) => [r0.url, r0.final ? r0.final.status : r0.error, r0.hops.length, r0.final ? r0.final.url : '', r0.ms, r0.title || '', r0.description || '', r0.h1 || '', r0.h1count ?? '', r0.canonical || '', r0.robots || '', r0.xRobots || '', r0.words ?? ''])], fileBase(S.url) + '_urls'), 'small') : null));
  if (L && L.error) body.push(h('p', { class: 'crit-text small' }, L.error));
  if (Array.isArray(L)) {
    const canonState = (r0) => { if (!r0.canonical || !r0.final) return null; const a = r0.canonical.replace(/\/$/, ''); const b = r0.final.url.replace(/\/$/, ''); return a === b ? 'self' : 'other'; };
    body.push(table(['URL', t('status_code'), 'Title / H1', t('ul_flags')], L.map((r0) => {
      const st = r0.final ? r0.final.status : null;
      const flags = [];
      if (r0.hops.length) flags.push(badge('warn', t('ul_redirects', { n: r0.hops.length })));
      if (/noindex/i.test(r0.robots || '') || /noindex/i.test(r0.xRobots || '')) flags.push(badge('crit', 'noindex'));
      if (canonState(r0) === 'other') flags.push(badge('warn', 'canonical →'));
      if (st && st < 300 && r0.words !== undefined && !r0.title) flags.push(badge('warn', t('ul_no_title')));
      if (r0.h1count === 0) flags.push(badge('warn', t('ul_no_h1')));
      if (r0.h1count > 1) flags.push(badge('info', 'H1×' + r0.h1count));
      return h('tr', null,
        h('td', { class: 'url-cell' }, extLink(r0.url, r0.url), r0.hops.length && r0.final ? h('div', { class: 'small muted' }, '→ ' + r0.final.url) : null),
        h('td', null, st ? badge(st < 300 ? 'ok' : st < 400 ? 'warn' : 'crit', String(st)) : badge('crit', r0.error ? r0.error.slice(0, 40) : '—'), h('div', { class: 'small muted' }, r0.ms + ' ms')),
        h('td', { class: 'small' }, r0.title || '—', r0.h1 ? h('div', { class: 'muted' }, 'H1: ' + r0.h1) : null),
        h('td', null, flags.length ? flags : badge('ok', 'OK')));
    }), { compact: true }));
  }
  return card(t('ul_title'), ...body);
}

// ---------- Tools ----------
function viewTools() {
  const url = S.url;
  const custom = parseCustomLinks(S.settings.customLinks);
  return h('div', null,
    searchCard(),
    S.report ? compareCard() : null,
    urlListCard(),
    shareCard(url),
    SERVICES.map((g) => card(t(g.group), h('div', { class: 'btnrow' }, g.items.map((it) => btn(it.name, () => openUrl(fillTemplate(it.url, url))))))),
    card(t('svc_custom'),
      custom.length ? h('div', { class: 'btnrow' }, custom.map((it) => btn(it.name, () => openUrl(fillTemplate(it.url, url))))) : h('p', { class: 'muted small' }, t('svc_custom_hint')),
      btn(t('edit_links'), () => { S.tab = 'settings'; render(); }, 'small')));
}

// ---------- JS-dependent content, AI bots, articles, trust ----------
function headerValuesOf(list, name) { return (list || []).filter((x) => x.name === name).map((x) => x.value).join(', '); }

function jsCard(d) {
  const js = d.jsdiff;
  if (!js || !js.ok) return card(t('js_title'), h('p', { class: 'muted' }, t('js_unavailable')));
  const sev = js.share >= 50 ? 'crit' : js.share >= 20 ? 'warn' : js.share >= 5 ? 'info' : 'ok';
  const visible = 100 - js.share;
  return card(t('js_title'),
    h('p', { class: 'muted small' }, t('js_hint')),
    h('div', { class: 'jsbar', title: `${visible}%` }, h('span', { class: 'jsbar-raw', style: `width:${visible}%` }), h('span', { class: 'jsbar-js', style: `width:${js.share}%` })),
    h('div', { class: 'row small' }, badge(sev === 'ok' ? 'ok' : sev, t('js_share', { p: js.share })), h('span', null, t('js_words', { js: fmt(js.jsWords), total: fmt(js.totalWords) }))),
    h('div', { class: 'btnrow' },
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: S.hlJs || null, onchange: (e) => { S.hlJs = e.target.checked; highlight('js', S.hlJs); } }), h('span', null, t('js_highlight'))),
      btn(t('js_view_raw'), () => openUrl(chrome.runtime.getURL('panel/nojs.html?tabId=' + S.tabId)), 'primary')),
    js.blocks.length ? h('details', { open: js.share >= 20 || null }, h('summary', null, t('js_blocks', { n: js.blocks.length })),
      h('ul', { class: 'jslist' }, js.blocks.slice(0, 100).map((b) => h('li', { onclick: () => scrollTo('j', b.idx), title: t('click_to_scroll') }, h('span', { class: 'mono small muted' }, `<${b.tag}> ${b.words} ${t('words_short')}`), ' ', b.text)))) : h('p', { class: 'ok-text small' }, t('js_all_raw')),
    js.headingsJs.length ? h('details', null, h('summary', null, t('js_headings_list', { n: js.headingsJs.length })), h('ul', { class: 'small' }, js.headingsJs.map((x) => h('li', null, h('b', null, 'H' + x.level + ' '), x.text)))) : null,
    js.linksJs.length ? h('details', null, h('summary', null, t('js_links_list', { n: js.linksJs.length, i: js.linksJs.filter((l) => l.internal).length })), h('ul', { class: 'small scroll' }, js.linksJs.slice(0, 200).map((l) => h('li', { class: 'url-cell' }, (l.text || '∅') + ' — ' + l.href)))) : null,
    js.outside.before || js.outside.after ? h('p', { class: 'warn-text small' }, t('r.outside_html'), ' ', h('span', { class: 'mono' }, (js.outside.before || js.outside.after).slice(0, 80))) : null);
}

function aiBotsCard(d) {
  if (!d.aiBots) return null;
  return card(t('ai_title'),
    h('p', { class: 'muted small' }, t('ai_hint')),
    table([t('bot'), t('robots_verdict'), t('robots_rule')], d.aiBots.map((b) => h('tr', null,
      h('td', null, b.label),
      h('td', null, stateBadge(b.allowed, t('allowed'), t('disallowed'))),
      h('td', { class: 'mono small' }, b.rule ? b.rule.raw : (b.agent ? 'User-agent: ' + b.agent : '—')))), { compact: true }));
}

function articleCard(d) {
  const a = d.articles;
  if (!a || !a.rows.length) return null;
  return card(t('article_title'), table([t('headline'), t('author'), t('published'), t('modified')], a.rows.map((x) => h('tr', null,
    h('td', null, x.headline), h('td', null, x.author || badge('info', t('none'))),
    h('td', { class: 'mono small' }, x.datePublished || '—'),
    h('td', { class: 'mono small' }, x.dateModified || '—', x.ageDays != null && x.ageDays > 730 ? h('div', null, badge('info', t('years_old', { y: Math.floor(x.ageDays / 365) }))) : null))), { compact: true }));
}

function trustCard(d) {
  const tr = d.trust;
  if (!tr) return null;
  const link = (u) => (u ? extLink(u.replace(/^https?:\/\/[^/]+/, '') || '/', u) : badge('info', t('not_found')));
  return card(t('trust_title'),
    h('p', { class: 'muted small' }, t('trust_hint')),
    kvTable([
      [t('trust_phone'), tr.phone ? h('span', null, tr.phone, tr.phoneLink ? null : h('span', { class: 'muted small' }, ' ' + t('trust_no_tel'))) : badge('info', t('not_found'))],
      ['Email', tr.email || badge('info', t('not_found'))],
      [t('trust_address'), stateBadge(tr.address, t('yes'), t('not_found'))],
      [t('trust_contacts'), link(tr.contacts)],
      [t('trust_about'), link(tr.about)],
      [t('trust_privacy'), link(tr.privacy)],
      [t('trust_delivery'), link(tr.delivery)],
      [t('trust_reviews'), link(tr.reviews)],
      [t('trust_author'), stateBadge(tr.author, t('yes'), t('not_found'))],
      [t('trust_date'), tr.timeTag || tr.dateText || badge('info', t('not_found'))],
    ]));
}

// ---------- Technical extras: cards ----------
function mobileCard(d) {
  const m = d.mobile;
  if (!m) return null;
  return card(t('mobile_title'),
    h('p', { class: 'muted small' }, t('mobile_hint', { w: m.viewportWidth })),
    kvTable([
      [t('mobile_overflow'), m.overflow ? badge('warn', t('mobile_overflow_yes', { w: m.docWidth, vw: m.viewportWidth })) : badge('ok', t('no'))],
      m.overflowEls.length ? [t('mobile_wide'), h('div', { class: 'mono small' }, m.overflowEls.map((e) => h('div', null, `${e.tag} → ${e.width}px`)))] : null,
      [t('mobile_small_text'), m.textEls ? `${m.smallText} / ${m.textEls}` : '—'],
      m.smallSample.length ? [t('examples'), h('div', { class: 'small' }, m.smallSample.map((x) => h('div', null, `${x.size}px — ${x.text}`)))] : null,
      [t('mobile_small_taps'), m.tapTotal ? `${m.smallTaps} / ${m.tapTotal}` : '—'],
      m.tapSample.length ? [t('examples'), h('div', { class: 'small' }, m.tapSample.map((x) => h('div', null, `${x.tag} ${x.w}×${x.h} — ${x.text || '∅'}`)))] : null,
    ]));
}

function urlCard(r, d) {
  return card(t('url_title'),
    h('p', { class: 'mono small url-cell' }, r.url),
    d.urlIssues.length ? h('ul', { class: 'checks' }, d.urlIssues.map((u) => h('li', null, badge('info', '!'), ' ', t('u_' + u.id, { n: u.n })))) : h('p', { class: 'ok-text small' }, t('url_ok')));
}

function canonicalTargetCheck(href) {
  const x = extra();
  const c = x.canonical;
  const wrap = [btn(x.busy.canonical ? t('checking') : t('can_check_btn'), () => runExtra('canonical', () => checkCanonicalTarget(href, S.url)), 'primary')];
  if (c && c.error && !c.trace) wrap.push(h('p', { class: 'crit-text small' }, c.error));
  if (c && c.trace) {
    wrap.push(kvTable([
      ['URL', h('span', { class: 'url-cell small' }, href)],
      [t('status_code'), c.trace.final ? badge(c.trace.final.status === 200 && !c.trace.hops.length ? 'ok' : c.trace.final.status < 400 ? 'warn' : 'crit', String(c.trace.final.status)) : badge('crit', c.trace.error || t('unreachable'))],
      c.trace.hops.length ? [t('var_hops'), hopText(c.trace) + ' → ' + (c.trace.final ? c.trace.final.url : '')] : null,
      ['noindex', c.noindex == null ? '—' : stateBadge(!c.noindex, t('no'), t('yes'))],
      [t('can_own'), c.theirCanonical ? h('span', { class: 'url-cell small' }, c.theirCanonical) : '—'],
    ]));
    wrap.push(issuesList(c.issues.map((i) => ({ ...i, group: 'index', params: i.params || {} }))));
  }
  return h('div', { class: 'stack' }, ...wrap);
}

function linkProblemsCard(d) {
  if (!d.hiddenLinks.length && !d.fakeLinks.length && !d.nofollowInternal) return null;
  return card(t('link_problems'),
    d.hiddenLinks.length ? h('div', null, h('p', { class: 'crit-text small' }, t('r.links_hidden', { n: d.hiddenLinks.length })),
      table([t('text'), 'URL', t('why')], d.hiddenLinks.slice(0, 100).map((l) => h('tr', null, h('td', null, l.text || '∅'), h('td', { class: 'url-cell' }, l.href), h('td', { class: 'mono small' }, l.why))), { compact: true })) : null,
    d.fakeLinks.length ? h('div', null, h('p', { class: 'warn-text small' }, t('r.links_js', { n: d.fakeLinks.length })),
      table(['tag', t('text'), t('code')], d.fakeLinks.slice(0, 100).map((l) => h('tr', null, h('td', { class: 'mono' }, l.tag), h('td', null, l.text || '∅'), h('td', { class: 'mono small wrap' }, l.code))), { compact: true })) : null,
    d.nofollowInternal ? h('p', { class: 'small' }, t('r.links_nofollow_internal', { n: d.nofollowInternal })) : null);
}

function productCard(d) {
  const pc = d.productChecks;
  const rows = [];
  if (pc.products.length) {
    rows.push(table([t('name'), t('price'), t('currency'), 'availability', t('problems')], pc.products.map((p) => h('tr', null,
      h('td', null, p.name), h('td', { class: 'mono' }, p.price == null ? '—' : String(p.price)), h('td', { class: 'mono' }, p.currency || '—'),
      h('td', { class: 'mono small' }, p.availability ? String(p.availability).replace(/^https?:\/\/schema\.org\//, '') : '—'),
      h('td', null, p.problems.length ? p.problems.map((x) => badge('warn', t('pp_' + x))) : badge('ok', 'OK')))), { compact: true }));
  }
  rows.push(kvTable([[t('breadcrumbs'), stateBadge(d.breadcrumbs, t('yes'), t('no'))]]));
  if (pc.issues.some((i) => i.id === 'breadcrumb_bad')) rows.push(h('p', { class: 'warn-text small' }, t('r.breadcrumb_bad')));
  return card(t('product_title'), ...rows);
}

function searchCard() {
  const q = S.search || { query: '', regex: false, cs: false, scope: 'raw', res: null };
  S.search = q;
  const doSearch = async () => {
    if (!q.query) return;
    if (S.tabId == null) { toast(t('search_need_page')); return; }
    try {
      await ensureCollector(S.tabId);
      q.res = await exec(S.tabId, (a, b, c) => globalThis.__seoLens.search(a, b, c), [q.query, q.regex, q.cs]);
    } catch (e) { q.res = { error: String(e.message || e) }; }
    render();
  };
  const body = [
    h('p', { class: 'muted small' }, t('search_hint')),
    h('div', { class: 'row' },
      h('input', { type: 'text', class: 'input', placeholder: t('search_ph'), value: q.query, oninput: (e) => { q.query = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') doSearch(); } }),
      btn(t('search_btn'), doSearch, 'primary')),
    h('div', { class: 'row' },
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: q.regex || null, onchange: (e) => { q.regex = e.target.checked; } }), h('span', null, t('search_regex'))),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: q.cs || null, onchange: (e) => { q.cs = e.target.checked; } }), h('span', null, t('search_case')))),
  ];
  const res = q.res;
  if (res && res.error) body.push(h('p', { class: 'crit-text small' }, res.error));
  if (res && !res.error) {
    const pick = { raw: res.raw, dom: res.dom, text: res.text }[q.scope];
    body.push(chips([['raw', t('search_raw'), res.raw ? res.raw.count : '—'], ['dom', t('search_dom'), res.dom.count], ['text', t('search_text'), res.text.count]], q.scope, (v) => { q.scope = v; render(); }));
    if (!pick) body.push(h('p', { class: 'muted small' }, t('raw_unavailable')));
    else if (!pick.count) body.push(h('p', { class: 'muted' }, t('search_none')));
    else {
      body.push(h('ol', { class: 'search-hits' }, pick.hits.map((x) => h('li', null,
        q.scope !== 'text' ? h('span', { class: 'muted small' }, t('line') + ' ' + x.line + ': ') : null,
        h('span', { class: 'mono small' }, x.before), h('mark', { class: 'mono small' }, x.match), h('span', { class: 'mono small' }, x.after)))));
      if (pick.count > pick.hits.length) body.push(h('p', { class: 'muted small' }, t('search_more', { n: pick.count - pick.hits.length })));
    }
  }
  return card(t('search_title'), ...body);
}

// ---------- On-demand checks: address variants, 404, hreflang ----------
function extra() {
  if (!S.extra || S.extra.url !== S.url) S.extra = { url: S.url, busy: {} };
  return S.extra;
}

// Results of on-demand checks also go to the issue list and the score.
function mergeExtraIssues() {
  if (!S.res || !S.extra || S.extra.url !== S.url) return;
  const groups = { variants: 'server', e404: 'server', hreflang: 'meta', canonical: 'index' };
  S.res.issues = S.res.issues.filter((i) => !i.extra);
  for (const [k, g] of Object.entries(groups)) {
    const r = S.extra[k];
    if (r && r.issues) for (const i of r.issues) S.res.issues.push({ ...i, group: g, params: i.params || {}, extra: true });
  }
  const order = { crit: 0, warn: 1, info: 2 };
  S.res.issues.sort((a, b) => order[a.sev] - order[b.sev]);
  let score = 100;
  for (const i of S.res.issues) score -= i.sev === 'crit' ? 15 : i.sev === 'warn' ? 5 : 1;
  S.res.score = Math.max(0, score);
}

async function needAllSites() {
  if (S.allSites) return true;
  const ok = await chrome.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
  S.allSites = ok;
  if (!ok) toast(t('extra_need_perm'));
  return ok;
}

async function runExtra(key, fn) {
  if (!(await needAllSites())) return;
  // Private/local targets are allowed only when the page under test is itself local.
  let host = ''; try { host = new URL(S.url).hostname; } catch { host = ''; }
  setNetContext({ allowPrivate: isPrivateHost(host, S.res && S.res.d.ip) });
  const x = extra();
  x.busy[key] = true; delete x[key]; render();
  try { x[key] = await fn(); } catch (e) { x[key] = { error: String(e.message || e) }; }
  x.busy[key] = false;
  mergeExtraIssues();
  updateBadge();
  render();
}

function chainCheck() {
  const x = extra();
  const c = x.chain;
  const rows = [];
  if (c && c.hops) {
    c.hops.forEach((hp, i) => rows.push(h('tr', null, h('td', null, String(i + 1)), h('td', null, badge(hp.status >= 400 ? 'crit' : 'warn', String(hp.status)), /Internal Redirect/i.test(hp.statusLine || '') ? h('div', { class: 'small muted' }, t('hsts_internal')) : null), h('td', { class: 'url-cell' }, hp.url), h('td', { class: 'mono small' }, hp.ip || '—'))));
    if (c.final) rows.push(h('tr', null, h('td', null, String(c.hops.length + 1)), h('td', null, badge(c.final.status < 300 ? 'ok' : c.final.status < 400 ? 'warn' : 'crit', String(c.final.status))), h('td', { class: 'url-cell' }, c.final.url), h('td', { class: 'mono small' }, c.final.ip || '—')));
  }
  return h('div', { class: 'stack', id: 'res-chain' },
    h('div', { class: 'btnrow' }, btn(x.busy.chain ? t('checking') : t('chain_btn'), () => runExtra('chain', () => traceChain(S.url)).then(() => reveal('res-chain')), 'primary')),
    c && c.error && !rows.length ? h('p', { class: 'crit-text small' }, c.error) : null,
    rows.length ? table([t('step'), t('status_code'), 'URL', 'IP'], rows, { compact: true }) : null,
    c && c.hops ? h('p', { class: c.hops.length > 1 ? 'warn-text small' : 'muted small' }, c.hops.length ? t('chain_n', { n: c.hops.length, ms: c.ms }) : t('chain_none', { ms: c.ms })) : null);
}

function hopText(tr) {
  const parts = [];
  for (const hp of tr.hops) parts.push(`${hp.status}${/Internal Redirect/i.test(hp.statusLine) ? ' HSTS' : ''}`);
  return parts.join(' → ');
}

function variantsCard() {
  const x = extra();
  const v = x.variants; const e = x.e404;
  // Each check has its own button with its result right below it, so a new result is never pushed out of sight.
  const body = [h('p', { class: 'muted small' }, t('var_hint'))];
  body.push(h('div', { class: 'btnrow', id: 'res-variants' }, btn(x.busy.variants ? t('checking') : t('var_btn'), () => runExtra('variants', () => checkVariants(S.url)).then(() => reveal('res-variants')), 'primary')));
  if (v && v.error) body.push(h('p', { class: 'crit-text small' }, v.error));
  if (v && v.rows) {
    body.push(table([t('var_start'), t('var_hops'), t('var_final')], v.rows.map((r) => h('tr', null,
      h('td', { class: 'url-cell' }, r.startUrl),
      h('td', { class: 'small' }, r.hops.length ? hopText(r) : '—', r.temp ? h('div', null, badge('warn', t('var_temp_badge'))) : null),
      h('td', { class: 'url-cell' }, r.error ? badge('crit', r.error) : r.final ? h('span', null, badge(r.final.status < 300 ? (r.toMain ? 'ok' : 'warn') : r.final.status < 400 ? 'warn' : 'crit', String(r.final.status)), ' ', r.final.url) : '—'))), { compact: true }));
    body.push(v.unique.length === 1 ? h('p', { class: 'ok-text small' }, t('var_ok', { url: v.main })) : null);
    if (v.pageRows && v.pageRows.length) {
      body.push(h('h4', null, t('var_page_title')));
      body.push(table([t('var_kind'), t('var_hops'), t('var_final')], v.pageRows.map((r) => h('tr', null,
        h('td', null, t('vk_' + r.kind), h('div', { class: 'url-cell small muted' }, r.startUrl)),
        h('td', { class: 'small' }, r.hops.length ? hopText(r) : '—'),
        h('td', null, badge(r.verdict === 'ok' || r.verdict === 'absent' ? 'ok' : r.verdict === 'dup' || r.verdict === 'temp' || r.verdict === 'elsewhere' ? 'warn' : 'crit', t('vv_' + r.verdict)), r.final ? h('div', { class: 'small muted' }, `${r.final.status} ${r.final.url}`) : null))), { compact: true }));
    }
    body.push(issuesList(v.issues.map((i) => ({ ...i, group: 'server', params: i.params || {} }))));
  }
  body.push(h('div', { class: 'btnrow sub-sep', id: 'res-e404' }, btn(x.busy.e404 ? t('checking') : t('e404_btn'), () => runExtra('e404', () => check404(S.url)).then(() => reveal('res-e404')), 'primary')));
  if (e && e.error && !e.probe) body.push(h('p', { class: 'crit-text small' }, e.error));
  if (e && e.probe) {
    body.push(kvTable([
      [t('e404_probe'), h('span', { class: 'url-cell small' }, e.probe)],
      [t('status_code'), e.status != null ? badge(e.verdict === 'ok' ? 'ok' : e.verdict === 'other' ? 'warn' : 'crit', String(e.status)) : badge('crit', e.error || t('unreachable'))],
      [t('e404_verdict'), t('e404_' + e.verdict)],
      e.hops.length ? [t('var_hops'), hopText(e) + ' → ' + (e.finalUrl || '')] : null,
      e.words != null ? [t('e404_page'), t('e404_page_stats', { w: e.words, l: e.links, title: e.title || '—' })] : null,
    ].filter(Boolean)));
    if (e.issues && e.issues.length) body.push(issuesList(e.issues.map((i) => ({ ...i, group: 'server', params: i.params || {} }))));
  }
  return card(t('var_title'), ...body);
}

function reveal(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function hreflangCheck() {
  const x = extra();
  const r = x.hreflang;
  const d = S.res.d;
  const canon = d.canonical && d.canonical.list && d.canonical.list[0] ? d.canonical.list[0].href : null;
  const wrap = [btn(x.busy.hreflang ? t('checking') : t('hl_check_btn'), () => runExtra('hreflang', () => checkHreflang(S.url, canon, d.hreflang, S.report.text.mainText || S.report.text.fullText)), 'primary')];
  if (r && r.error && !r.rows) wrap.push(h('p', { class: 'crit-text small' }, r.error));
  if (r && r.rows) {
    wrap.push(table(['hreflang', 'URL', t('status_code'), t('hl_back')], r.rows.map((row) => h('tr', null,
      h('td', { class: 'mono' }, row.lang),
      h('td', { class: 'url-cell' }, row.href, row.redirected ? h('div', { class: 'small muted' }, '→ ' + row.finalUrl) : null, row.canonicalElsewhere ? h('div', null, badge('crit', 'canonical → ' + row.canonical)) : null, row.similarity != null && row.similarity > 0.8 ? h('div', null, badge('warn', t('hl_same_badge', { p: Math.round(row.similarity * 100) }))) : null),
      h('td', null, row.self ? h('span', { class: 'muted small' }, t('hl_self')) : row.error ? badge('crit', t('unreachable')) : badge(row.status < 300 && !row.redirected ? 'ok' : row.status < 400 ? 'warn' : 'crit', String(row.status)), row.noindex ? h('div', null, badge('warn', 'noindex')) : null),
      h('td', null, row.self || row.error || row.status >= 400 ? '—' : stateBadge(row.back, t('yes'), t('no'))))), { compact: true }));
    wrap.push(issuesList(r.issues.map((i) => ({ ...i, group: 'meta', params: i.params || {} }))));
  }
  return h('div', { class: 'stack' }, ...wrap);
}

// ---------- Domain tab: DNS, IP, WHOIS (RDAP), SSL, blacklists, neighbours, other zones ----------
function domState() {
  let host = ''; try { host = new URL(S.url).hostname.toLowerCase(); } catch { host = ''; }
  const base = baseDomain(host);
  if (!S.dom || S.dom.host !== host) S.dom = { host, base, busy: {} };
  return S.dom;
}

async function domRun(key, fn) {
  const D = domState();
  if (!D.host || isPrivateHost(D.host)) { toast(t('dom_private')); return; }
  if (!(await needAllSites())) return;
  D.busy[key] = true; delete D[key]; render();
  try { D[key] = await fn(D); } catch (e) { D[key] = { error: String(e.message || e) }; }
  D.busy[key] = false;
  if (S.tab === 'domain') render();
}

// One click: DNS records, propagation, IP owner, blacklists, RDAP, certificate.
async function domMain(D) {
  const [dns, prop, rdap] = await Promise.all([
    DOM.dnsRecords(D.host, D.base),
    DOM.propagation(D.host),
    DOM.rdapDomain(D.base).catch((e) => ({ error: String(e.message || e) })),
  ]);
  const aRec = (dns.rows.find((x) => x.type === 'A') || { answers: [] }).answers.filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  // The address the browser connected to, unless it is private (a proxy, VPN or local mapping); otherwise DNS.
  const seen = S.res && S.res.d.ip && /^\d+\.\d+\.\d+\.\d+$/.test(S.res.d.ip) && !isPrivateHost(S.res.d.ip) ? S.res.d.ip : null;
  const ip = seen || aRec[0] || null;
  const [info, bl, ssl] = await Promise.all([
    ip ? DOM.ipInfo(ip).catch((e) => ({ error: String(e.message || e) })) : null,
    ip ? DOM.dnsbl(ip) : null,
    S.settings.allowCT && /^https:/.test(S.url) ? DOM.sslFromCT(D.host).catch((e) => ({ error: String(e.message || e) })) : null,
  ]);
  return { dns, prop, rdap, ip, ips: aRec, info, bl, ssl };
}

const dateOnly = (s) => (s ? String(s).slice(0, 10) : null);
function ageText(days) {
  if (days == null) return null;
  const y = Math.floor(days / 365); const m = Math.floor((days % 365) / 30);
  return t('dom_age_val', { y, m, d: fmt(days) });
}

function viewDomain() {
  const D = domState();
  if (!D.host) return h('p', { class: 'muted pad' }, t('subs_need_page'));
  const m = D.main;
  const out = [];
  out.push(card(t('dom_title', { domain: D.base }),
    h('p', { class: 'muted small' }, t('dom_hint')),
    h('div', { class: 'btnrow' }, btn(D.busy.main ? t('checking') : t('dom_btn'), () => domRun('main', domMain), 'primary')),
    m && m.error ? h('p', { class: 'crit-text small' }, m.error) : null,
    m && !m.error ? kvTable([
      ['IP', m.ip ? h('span', { class: 'mono' }, m.ip, m.ips.length > 1 ? h('span', { class: 'muted small' }, ` (+${m.ips.length - 1}: ${m.ips.slice(1).join(', ')})`) : null) : badge('warn', t('dom_no_ip'))],
      [t('dom_country'), m.info && !m.info.error ? [m.info.countryCode ? flag(m.info.countryCode) + ' ' : '', m.info.country || '—', m.info.city ? ', ' + m.info.city : ''].join('') : (m.info && m.info.error) || null],
      [t('dom_hosting'), m.info && !m.info.error ? h('span', null, m.info.org || m.info.isp || m.info.network || '—', m.info.domain ? h('span', { class: 'muted small' }, ' · ' + m.info.domain) : null) : null],
      ['ASN', m.info && m.info.asn ? 'AS' + m.info.asn : null],
      [t('dom_registrar'), m.rdap && !m.rdap.error ? m.rdap.registrar : (m.rdap && h('span', { class: 'muted small' }, t('dom_rdap_fail') + ' ' + m.rdap.error))],
      [t('dom_created'), m.rdap && m.rdap.created ? h('span', null, dateOnly(m.rdap.created), ' · ', ageText(m.rdap.ageDays)) : null],
      [t('dom_expires'), m.rdap && m.rdap.expires ? h('span', null, dateOnly(m.rdap.expires), ' ', badge(m.rdap.daysLeft < 0 ? 'crit' : m.rdap.daysLeft < 30 ? 'crit' : m.rdap.daysLeft < 60 ? 'warn' : 'ok', t('dom_days_left', { n: m.rdap.daysLeft }))) : null],
      [t('dom_status'), m.rdap && m.rdap.status && m.rdap.status.length ? h('span', { class: 'mono small' }, m.rdap.status.join(', ')) : null],
      ['NS', m.rdap && m.rdap.nameservers && m.rdap.nameservers.length ? h('span', { class: 'mono small' }, m.rdap.nameservers.join(', ')) : null],
      ['DNSSEC', m.rdap && m.rdap.dnssec != null ? stateBadge(m.rdap.dnssec, t('yes'), t('no')) : null],
      [t('dom_ssl'), sslCell(m.ssl)],
    ]) : null));
  if (m && !m.error) {
    out.push(card(t('dom_dns_title'),
      table([t('type'), t('name'), t('value')], m.dns.rows.map((r0) => h('tr', null,
        h('td', { class: 'mono' }, r0.type), h('td', { class: 'mono small' }, r0.name),
        h('td', { class: 'mono small wrap' }, r0.error ? badge('warn', r0.error) : r0.answers.length ? r0.answers.map((a) => h('div', null, a)) : h('span', { class: 'muted' }, '—')))), { compact: true }),
      kvTable([
        ['SPF', m.dns.spf ? h('span', { class: 'mono small' }, m.dns.spf) : badge('warn', t('none'))],
        ['DMARC', m.dns.dmarc ? h('span', { class: 'mono small' }, m.dns.dmarc) : badge('warn', t('none'))],
      ])));
    const sets = new Set(m.prop.filter((x) => x.answers.length).map((x) => x.answers.join(',')));
    out.push(card(t('dom_prop_title'),
      h('p', { class: 'muted small' }, t('dom_prop_hint')),
      table(['DNS', 'A'], m.prop.map((x) => h('tr', null, h('td', null, x.resolver), h('td', { class: 'mono small' }, x.error ? badge('warn', x.error) : x.answers.join(', ') || '—'))), { compact: true }),
      sets.size <= 1 ? h('p', { class: 'ok-text small' }, t('dom_prop_same')) : h('p', { class: 'warn-text small' }, t('dom_prop_diff'))));
    if (m.bl) {
      const listed = m.bl.rows.filter((x) => x.state === 'listed');
      out.push(card(t('dom_bl_title', { ip: m.ip }),
        h('p', { class: 'muted small' }, t('dom_bl_hint')),
        table(['DNSBL', t('dom_bl_state')], m.bl.rows.map((x) => h('tr', null, h('td', { class: 'mono small' }, x.zone),
          h('td', null, x.state === 'clean' ? badge('ok', t('dom_bl_clean')) : x.state === 'listed' ? badge('crit', t('dom_bl_listed') + ' ' + x.code) : x.state === 'refused' ? badge('info', t('dom_bl_refused')) : badge('warn', x.error || '?')))), { compact: true }),
        listed.length ? h('p', { class: 'crit-text small' }, t('dom_bl_found', { n: listed.length })) : null));
    }
  }
  // Neighbours on the same IP
  const nb = D.neigh;
  out.push(card(t('dom_neigh_title'),
    h('p', { class: 'muted small' }, t('dom_neigh_hint')),
    btn(D.busy.neigh ? t('checking') : t('dom_neigh_btn'), () => domRun('neigh', async () => {
      const ip = (D.main && D.main.ip) || (S.res && S.res.d.ip) || (await DOM.doh(D.host, 'A')).answers.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
      if (!ip) throw new Error(t('dom_no_ip'));
      return { ip, ...(await DOM.reverseIp(ip)) };
    }), ''),
    nb && nb.error ? h('p', { class: 'crit-text small' }, nb.error) : null,
    nb && nb.hosts ? h('div', null, h('p', { class: 'small' }, t('dom_neigh_found', { n: nb.total, ip: nb.ip })),
      nb.total > 50 ? h('p', { class: 'muted small' }, t('dom_neigh_shared')) : null,
      h('ul', { class: 'small scroll' }, nb.hosts.map((x) => h('li', null, extLink(x, 'https://' + x + '/')))),
      btn(t('copy'), () => copy(nb.hosts.join('\n')), 'small')) : null));
  // Same name in other zones
  const z = D.zones;
  out.push(card(t('dom_zones_title'),
    h('p', { class: 'muted small' }, t('dom_zones_hint')),
    btn(D.busy.zones ? t('checking') : t('dom_zones_btn', { name: D.base.split('.')[0] }), () => domRun('zones', () => DOM.otherZones(D.base)), ''),
    z && z.error ? h('p', { class: 'crit-text small' }, z.error) : null,
    z && z.rows ? h('div', { class: 'zones' }, z.rows.map((x) => h('span', { class: 'zone z-' + x.state, title: t('dom_z_' + x.state) },
      x.state === 'taken' ? extLink(x.name, 'http://' + x.name + '/') : x.name, ' ', badge(x.state === 'free' ? 'ok' : x.state === 'taken' ? 'info' : 'warn', t('dom_z_' + x.state))))) : null,
    z && z.rows ? h('p', { class: 'muted small' }, t('dom_zones_note')) : null));
  out.push(subdomainsCard(S.url));
  const rep = SERVICES.filter((g) => g.group === 'svc_g_reputation' || g.group === 'svc_g_traffic' || g.group === 'svc_g_domain');
  out.push(card(t('dom_links_title'), h('p', { class: 'muted small' }, t('dom_links_hint')),
    rep.map((g) => h('div', null, h('h4', null, t(g.group)), h('div', { class: 'btnrow' }, g.items.map((it) => btn(it.name, () => openUrl(fillTemplate(it.url, S.url)))))))));
  return h('div', null, ...out);
}

function flag(cc) {
  if (!/^[A-Za-z]{2}$/.test(cc || '')) return '';
  return String.fromCodePoint(...cc.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function sslCell(ssl) {
  if (!/^https:/.test(S.url)) return badge('warn', t('dom_ssl_http'));
  if (!S.settings.allowCT) return h('span', { class: 'muted small' }, t('net_ct_off'));
  if (!ssl) return h('span', { class: 'muted small' }, t('dom_ssl_none'));
  if (ssl.error) return h('span', { class: 'muted small' }, ssl.error);
  return h('span', null, ssl.issuer, ' · ', `${ssl.from} … ${ssl.until} `, badge(ssl.daysLeft < 7 ? 'crit' : ssl.daysLeft < 21 ? 'warn' : 'ok', t('dom_days_left', { n: ssl.daysLeft })));
}

// ---------- Technologies (Speed tab) ----------
function techCard(d) {
  const list = d.tech || [];
  const order = ['cms', 'shop', 'framework', 'library', 'server', 'cdn', 'cache', 'service'];
  const sorted = [...list].sort((a, b) => order.indexOf(a.cat) - order.indexOf(b.cat));
  return card(t('tech_title'),
    h('p', { class: 'muted small' }, t('tech_hint')),
    sorted.length ? table([t('tech_name'), t('type'), t('tech_ver')], sorted.map((x) => h('tr', null,
      h('td', null, x.name), h('td', { class: 'small' }, t('tech_c_' + (x.cat || 'service'))), h('td', { class: 'mono small' }, x.ver || '—'))), { compact: true })
      : h('p', { class: 'muted' }, t('tech_none')));
}

// ---------- Quick links to service files (Index tab) ----------
function quickFilesCard(r) {
  let origin = ''; try { origin = new URL(r.url).origin; } catch { origin = ''; }
  return card(t('quick_files'),
    h('div', { class: 'btnrow' }, ['/robots.txt', '/sitemap.xml', '/.well-known/security.txt', '/favicon.ico'].map((p0) => btn(p0, () => openUrl(origin + p0), 'small'))));
}

// ---------- Share + QR (Tools tab) ----------
function shareLinks(url, title) {
  const u = encodeURIComponent(url); const tt = encodeURIComponent(title || '');
  return [
    ['Telegram', `https://t.me/share/url?url=${u}&text=${tt}`],
    ['WhatsApp', `https://wa.me/?text=${encodeURIComponent((title ? title + ' ' : '') + url)}`],
    ['VK', `https://vk.com/share.php?url=${u}&title=${tt}`],
    ['Facebook', `https://www.facebook.com/sharer/sharer.php?u=${u}`],
    ['X', `https://x.com/intent/post?url=${u}&text=${tt}`],
    ['LinkedIn', `https://www.linkedin.com/sharing/share-offsite/?url=${u}`],
    ['Email', `mailto:?subject=${tt}&body=${u}`],
  ];
}

function qrSvg(text) {
  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return { svg: q.createSvgTag({ cellSize: 4, margin: 4, scalable: true }), n: q.getModuleCount(), q };
}

function qrPng(q, scale = 10, margin = 4) {
  const n = q.getModuleCount();
  const size = (n + margin * 2) * scale;
  const c = document.createElement('canvas'); c.width = size; c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, size, size); g.fillStyle = '#000';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) g.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
  return c.toDataURL('image/png');
}

function downloadData(url, name) {
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
}

function shareCard(url) {
  if (!/^https?:/.test(url || '')) return null;
  const title = S.res && S.res.d.title ? (S.res.d.title.text || '') : '';
  let qr = null; try { qr = qrSvg(url); } catch { qr = null; }
  const box = h('div', { class: 'qrbox' });
  if (qr) {
    // The SVG comes from our own generator (paths only); parse it instead of using innerHTML.
    const doc = new DOMParser().parseFromString(qr.svg, 'image/svg+xml');
    box.append(document.importNode(doc.documentElement, true));
  }
  const base = fileBase(url);
  return card(t('share_title'),
    h('div', { class: 'btnrow' }, shareLinks(url, title).map(([n, u]) => btn(n, () => openUrl(u)))),
    btn(t('copy_url'), () => copy(url, t('url_copied')), 'small'),
    h('h4', null, t('qr_title')),
    qr ? box : h('p', { class: 'muted small' }, t('qr_too_long')),
    qr ? h('div', { class: 'btnrow' },
      btn('PNG', () => downloadData(qrPng(qr.q), base + '_qr.png'), 'small'),
      btn('SVG', () => downloadData(URL.createObjectURL(new Blob([qr.svg], { type: 'image/svg+xml' })), base + '_qr.svg'), 'small')) : null);
}

// ---------- Subdomains (Certificate Transparency) ----------
function subdomainsCard(url) {
  let host = ''; try { host = new URL(url).hostname; } catch { host = ''; }
  const domain = baseDomain(host);
  const sd = S.subs && S.subs.domain === domain ? S.subs : null;
  const body = [h('p', { class: 'muted small' }, t('subs_hint'))];
  body.push(h('div', { class: 'btnrow' },
    btn(sd && sd.loading ? t('subs_loading') : t('subs_find', { domain: domain || '—' }), () => loadSubdomains(domain), 'primary'),
    sd && sd.items && sd.items.length ? markProbe(btn(sd.probing ? t('subs_probing', { n: sd.probed, total: sd.items.length }) : t('subs_probe'), () => probeSubdomains(), '')) : null,
    sd && sd.items && sd.items.length ? btn(t('copy'), () => copy(sd.items.map((x) => x.host).join('\n')), '') : null));
  if (sd && sd.error) body.push(h('p', { class: 'crit-text small' }, t('subs_error') + ' ' + sd.error));
  if (sd && sd.items) {
    body.push(h('p', { class: 'small' }, t('subs_found', { n: sd.items.length, source: sd.source })));
    const filterVal = sd.filter || '';
    body.push(h('input', { type: 'text', class: 'input', placeholder: t('subs_filter'), value: filterVal, oninput: (e) => { sd.filter = e.target.value; renderSubsTable(); } }));
    body.push(h('div', { id: 'subs-table' }));
    queueMicrotask(renderSubsTable);
  }
  if (!domain) return card(t('subs_title'), h('p', { class: 'muted' }, t('subs_need_page')));
  return card(t('subs_title'), ...body);
}

function markProbe(b) { b.dataset.subsProbe = '1'; return b; }

function renderSubsTable() {
  const box = document.getElementById('subs-table');
  const sd = S.subs;
  if (!box || !sd || !sd.items) return;
  const f = (sd.filter || '').toLowerCase();
  const rows = sd.items.filter((x) => !f || x.host.includes(f));
  const st = (x) => {
    const p = sd.probes[x.host];
    if (!p) return h('span', { class: 'muted small' }, '—');
    if (!p.ok) return p.blocked ? badge('info', t('subs_blocked')) : badge('crit', t('subs_down'));
    const kind = p.status < 300 ? 'ok' : p.status < 400 ? 'warn' : 'crit';
    return h('span', null, badge(kind, String(p.status)), p.redirected ? h('div', { class: 'small muted url-cell' }, '→ ' + p.finalUrl) : null);
  };
  box.replaceChildren(table([t('subs_host'), t('subs_cert'), t('status_code')], rows.slice(0, 1000).map((x) => h('tr', null,
    h('td', { class: 'url-cell' }, extLink(x.host, 'https://' + x.host + '/'), x.wildcard ? h('span', { class: 'small muted' }, ' (*.)') : null),
    h('td', { class: 'small mono' }, x.lastSeen || '—'),
    h('td', null, st(x)))), { compact: true }));
}

async function loadSubdomains(domain) {
  if (!domain) return;
  if (!S.settings.allowCT) { toast(t('net_ct_off')); return; }
  chrome.runtime.sendMessage({ type: 'logExternal', url: 'https://crt.sh/?q=%25.' + domain }).catch(() => {});
  // Ask for the two CT services only (inside the click gesture).
  const ok = await chrome.permissions.request({ origins: CT_ORIGINS }).catch(() => false);
  if (!ok) { toast(t('subs_perm_denied')); return; }
  S.subs = { domain, loading: true, items: null, probes: {}, probed: 0 };
  render();
  try {
    const r = await findSubdomains(domain);
    Object.assign(S.subs, r, { loading: false });
  } catch (e) {
    Object.assign(S.subs, { loading: false, error: String(e.message || e) });
  }
  if (S.tab === 'tools' || S.tab === 'domain') render();
}

async function probeSubdomains() {
  const sd = S.subs;
  if (!sd || !sd.items || sd.probing) return;
  if (!S.allSites) {
    const ok = await chrome.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
    S.allSites = ok;
    if (!ok) { toast(t('subs_probe_perm')); return; }
  }
  sd.probing = true; sd.probed = 0; sd.probes = {};
  render();
  const queue = sd.items.filter((x) => !(sd.filter && !x.host.includes(sd.filter.toLowerCase()))).slice(0, 300).map((x) => x.host);
  const total = queue.length;
  const worker = async () => {
    while (queue.length) {
      const host = queue.shift();
      sd.probes[host] = await probeHost(host);
      sd.probed++;
      renderSubsTable();
      const b = [...document.querySelectorAll('#main .btn')].find((x) => x.dataset.subsProbe);
      if (b) b.textContent = t('subs_probing', { n: sd.probed, total });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  sd.probing = false;
  if (S.tab === 'tools' || S.tab === 'domain') render();
}

// ---------- Settings ----------
async function showNetLog() {
  const r = await chrome.runtime.sendMessage({ type: 'getLog' }).catch(() => null);
  S.netLog = (r && r.log) || [];
  render();
}

function viewSettings() {
  historyUsage().then((u) => { const el = document.getElementById('hist-usage'); if (el) el.textContent = t('hist_usage', { n: u.urls, kb: Math.round(u.bytes / 1024), max: Math.round(u.quota / 1048576) }); });
  const st = S.settings;
  const num = (key, label) => h('label', { class: 'field' }, h('span', null, label),
    h('input', { type: 'number', class: 'input num', min: '0', max: '5000', value: String(st[key]), onchange: (e) => saveSettings({ [key]: Math.max(0, parseInt(e.target.value, 10) || 0) }) }));
  const sw = (key, label) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: st[key] || null, onchange: (e) => saveSettings({ [key]: e.target.checked }, false) }), h('span', null, label));
  const pair = (a, b, label) => h('div', { class: 'field-row' }, h('span', { class: 'field-label' }, label), num(a, t('min')), num(b, t('max')));
  return h('div', null,
    card(t('hist_settings'),
      sw('keepHistory', t('hist_keep')),
      h('p', { class: 'muted small', id: 'hist-usage' }, t('hist_usage_loading')),
      h('div', { class: 'btnrow' }, btn(t('hist_clear'), async () => { await clearHistory(); S.diff = null; S.history = null; toast(t('hist_cleared')); render(); }, 'danger'))),
    card(t('net_title'),
      sw('allowCT', t('net_allow_ct')),
      h('p', { class: 'muted small' }, t('net_hint')),
      h('div', { class: 'btnrow' }, btn(t('net_show'), () => showNetLog(), ''), btn(t('net_clear'), async () => { await chrome.runtime.sendMessage({ type: 'clearLog' }).catch(() => {}); S.netLog = []; render(); }, '')),
      S.netLog ? (S.netLog.length ? table([t('net_time'), 'URL', t('status_code')], S.netLog.slice().reverse().slice(0, 200).map((x) => h('tr', null, h('td', { class: 'mono small' }, new Date(x.at).toLocaleTimeString()), h('td', { class: 'url-cell' }, x.url), h('td', null, x.blocked ? badge('info', t('net_blocked') + ': ' + x.blocked) : x.error ? badge('crit', x.error.slice(0, 40)) : typeof x.status !== 'number' ? badge('info', String(x.status || '—')) : badge(x.status < 400 ? 'ok' : 'warn', String(x.status))))), { compact: true }) : h('p', { class: 'muted small' }, t('net_empty'))) : null),
    card(t('set_run'),
      sw('autoRun', t('set_autorun')),
      h('p', { class: 'muted small' }, t('set_autorun_hint'))),
    card(t('set_serp'),
      h('p', { class: 'muted small' }, t('set_serp_hint')),
      sw('serpGoogle', t('serp_google')),
      sw('serpYandex', t('serp_yandex')),
      sw('serpAds', t('serp_ads')),
      sw('serpToolbar', t('serp_toolbar')),
      S.allSites ? null : h('div', { class: 'notice slim' }, h('p', null, t('serp_need_perm')), h('div', { class: 'row' }, btn(t('perm_button'), requestAllSites, 'primary')))),
    card(t('set_thresholds'),
      pair('titleMin', 'titleMax', 'Title'),
      pair('descMin', 'descMax', 'Description'),
      pair('h1Min', 'h1Max', 'H1'),
      h('div', { class: 'field-row' }, h('span', { class: 'field-label' }, t('thin_words')), num('thinWords', t('words'))),
      h('div', { class: 'field-row' }, h('span', { class: 'field-label' }, t('heavy_image')), num('heavyImageKb', 'KB')),
      btn(t('reset_thresholds'), () => saveSettings({ titleMin: DEFAULTS.titleMin, titleMax: DEFAULTS.titleMax, descMin: DEFAULTS.descMin, descMax: DEFAULTS.descMax, h1Min: DEFAULTS.h1Min, h1Max: DEFAULTS.h1Max, thinWords: DEFAULTS.thinWords, heavyImageKb: DEFAULTS.heavyImageKb }) || render(), 'small')),
    card(t('set_bot'),
      h('select', { onchange: (e) => saveSettings({ bot: e.target.value }) }, BOTS.map((b) => h('option', { value: b.id, selected: b.id === st.bot || null }, b.label)))),
    card(t('template_title'),
      h('p', { class: 'muted small' }, t('template_vars')),
      h('textarea', { class: 'input area', rows: '6', onchange: (e) => saveSettings({ template: e.target.value }, false) }, st.template),
      btn(t('reset'), () => { saveSettings({ template: DEFAULTS.template }, false); render(); }, 'small')),
    card(t('set_stopwords'),
      h('p', { class: 'muted small' }, t('set_stopwords_hint')),
      h('textarea', { class: 'input area', rows: '4', onchange: (e) => saveSettings({ stopwords: e.target.value }, false) }, st.stopwords)),
    card(t('svc_custom'),
      h('p', { class: 'muted small' }, t('custom_links_hint')),
      h('textarea', { class: 'input area', rows: '4', placeholder: 'Ahrefs | https://ahrefs.com/backlink-checker?input={domain}', onchange: (e) => saveSettings({ customLinks: e.target.value }, false) }, st.customLinks)),
    card(t('set_data'),
      h('div', { class: 'btnrow' },
        btn(t('export_settings'), () => downloadJson(st, 'canonical_settings')),
        h('label', { class: 'btn' }, t('import_settings'), h('input', { type: 'file', accept: 'application/json', hidden: true, onchange: importSettings })),
        btn(t('reset_all'), () => { S.settings = { ...DEFAULTS }; chrome.storage.sync.set({ settings: S.settings }); applyTheme(); applyLang(); if (S.report) S.res = analyze(S.report, S.settings, S.nav); render(); toast(t('reset_done')); }, 'danger')),
      h('p', { class: 'muted small' }, t('privacy_note'))));
}

async function importSettings(e) {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    const obj = JSON.parse(await f.text());
    const clean = {};
    for (const k of Object.keys(DEFAULTS)) if (k in obj && typeof obj[k] === typeof DEFAULTS[k]) clean[k] = obj[k];
    S.settings = { ...DEFAULTS, ...clean };
    await chrome.storage.sync.set({ settings: S.settings });
    applyTheme(); applyLang();
    if (S.report) S.res = analyze(S.report, S.settings, S.nav);
    render();
    toast(t('import_done'));
  } catch { toast(t('import_failed')); }
}

// ---------- keep results until the page reloads (see cache.js) ----------
let saveTimer2;
function snapshotState() {
  if (!S.report || S.tabId == null || S.cacheOff) return null;
  const strip = (o, keys) => { if (!o) return o; const c = { ...o }; keys.forEach((k) => delete c[k]); return c; };
  return {
    url: S.url, report: S.report, nav: S.nav, tab: S.tab, diff: S.diff, history: S.history,
    extra: S.extra ? { ...S.extra, busy: {} } : null,
    dom: S.dom ? { ...S.dom, busy: {} } : null,
    subs: S.subs && !S.subs.loading ? strip(S.subs, ['probing']) : null,
  };
}
function scheduleSave() { clearTimeout(saveTimer2); saveTimer2 = setTimeout(flushSave, 250); }
async function flushSave() {
  clearTimeout(saveTimer2);
  const st = snapshotState();
  if (!st) return;
  try { await saveTab(S.tabId, structuredClone(st)); } catch { /* not cloneable or storage error: skip */ }
}
async function restoreState(tabId, currentUrl) {
  const st = await loadTab(tabId);
  if (!st || !st.report) return false;
  Object.assign(S, { url: st.url, report: st.report, nav: st.nav, tab: st.tab || 'overview', diff: st.diff, history: st.history, extra: st.extra, dom: st.dom, subs: st.subs });
  S.res = analyze(S.report, S.settings, S.nav);
  mergeExtraIssues();
  S.restoredAt = st.at;
  // Same document, but an in-page (SPA) navigation changed the address: keep the data, mark it stale.
  if (currentUrl && currentUrl.split('#')[0] !== String(st.url).split('#')[0]) S.stale = true;
  return true;
}

// Firefox sidebar: show the newly active tab (its saved result, if any).
async function switchToTab(id) {
  Object.assign(S, { tabId: id, report: null, res: null, nav: null, extra: null, dom: null, subs: null, diff: null, history: null, error: null, stale: false, restoredAt: null, cacheOff: false });
  try { const tb = await chrome.tabs.get(id); S.url = tb.url || ''; } catch { S.url = ''; }
  await restoreState(id, S.url).catch(() => false);
  render();
  if (S.settings.autoRun && !S.report) run();
}

// ---------- wiring ----------
let rerunTimer;
function scheduleRun(delay = 300) { clearTimeout(rerunTimer); rerunTimer = setTimeout(run, delay); }

// Manual mode (default): nothing is read from the page until the user presses Refresh.
// Tab switches and navigations only mark the shown data as stale.
function pageChanged(delay) {
  if (S.settings.autoRun) { scheduleRun(delay); return; }
  if (S.report && !S.stale) { S.stale = true; render(); }
}
// The panel belongs to one tab (?tabId=N), so only that tab's navigations matter.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId !== S.tabId) return;
  // Reload or navigation: the saved result no longer matches the page; drop it and stop saving.
  if (info.status === 'loading') { S.cacheOff = true; clearTimeout(saveTimer2); dropTab(tabId); }
  if (info.status === 'complete') pageChanged(400);
  if (info.url && tabId === S.tabId && S.settings.autoRun) { S.url = info.url; renderStatus(); }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.selection && changes.selection.newValue) {
    S.selection = changes.selection.newValue.text || '';
    S.tab = 'text';
    render();
  }
});

(async function init() {
  await loadSettings();
  const qTab = Number(new URLSearchParams(location.search).get('tabId'));
  // In the side panel (not opened as a normal tab), close as soon as the user leaves its tab.
  const asTab = await chrome.tabs.getCurrent().catch(() => null);
  if (!asTab && qTab) {
    const win = await chrome.windows.getCurrent().catch(() => null);
    const closePanel = async () => {
      chrome.runtime.sendMessage({ type: 'panelClosed', tabId: qTab }).catch(() => {});
      await Promise.race([flushSave(), new Promise((r) => setTimeout(r, 400))]);
      window.close();
    };
    // The panel is enabled only for its own tab, so Chrome hides it on other tabs and shows it again
    // when the user comes back, until the user closes it. If it is still visible on another tab
    // (an old global panel left over), close it there.
    chrome.tabs.onActivated.addListener((info) => {
      if ((win && info.windowId !== win.id) || info.tabId === qTab) return;
      flushSave();
      setTimeout(() => { if (document.visibilityState === 'visible') closePanel(); }, 500);
    });
    chrome.tabs.onRemoved.addListener((id) => { if (id === qTab) closePanel(); });
    chrome.tabs.onDetached.addListener((id) => { if (id === qTab) closePanel(); });
  }
  if (qTab) {
    S.tabId = qTab;
    try { const tb = await chrome.tabs.get(qTab); S.url = tb.url || ''; } catch { /* no access yet */ }
    await restoreState(qTab, S.url).catch(() => false);
  } else if (!asTab) {
    // Firefox sidebar: one panel per window that follows the active tab; each tab keeps its own result.
    const win = await chrome.windows.getCurrent().catch(() => null);
    const [tb] = await chrome.tabs.query(win ? { active: true, windowId: win.id } : { active: true, lastFocusedWindow: true }).catch(() => []);
    if (tb) { S.tabId = tb.id; S.url = tb.url || ''; await restoreState(tb.id, S.url).catch(() => false); }
    chrome.tabs.onActivated.addListener(async (info) => {
      if (win && info.windowId !== win.id) return;
      await flushSave();
      await switchToTab(info.tabId);
    });
  }
  const foot = document.getElementById('foot');
  if (foot) foot.textContent = 'Canonical SEO Tools ' + chrome.runtime.getManifest().version;
  S.allSites = await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
  try {
    const got = await chrome.storage.session.get('selection');
    if (got.selection && Date.now() - got.selection.at < 10000) { S.selection = got.selection.text; S.tab = 'text'; }
  } catch { /* ignore */ }
  render();
  if (S.settings.autoRun && !S.report) run();
})();
