// On-demand site checks that need extra requests: address variants, 404 handling, hreflang return links.
// Run only when the user presses the button; need access to all sites.

// All requests go through the service worker, which blocks private addresses, limits redirects,
// body size and time (see guardedFetch in background.js).
const net = { allowPrivate: false };
export function setNetContext(ctx) { Object.assign(net, ctx); }
const traceUrls = (urls) => chrome.runtime.sendMessage({ type: 'trace', urls, allowPrivate: net.allowPrivate }).then((r) => (r && r.list) || []);
const fetchText = (url, maxBytes = 2_000_000) => chrome.runtime.sendMessage({ type: 'fetchText', url, maxBytes, allowPrivate: net.allowPrivate }).then((r) => r || { error: 'no response' });

// Same rule as the worker: is this host local or private?
export function isPrivateHost(host, ip) {
  const h = (host || '').toLowerCase();
  const priv = (v) => /^(127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(v) || v === '::1' || /^f[cd]|^fe[89ab]/.test(v);
  return h === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h) || priv(h.replace(/^\[|\]$/g, '')) || (!!ip && priv(ip));
}
const norm = (u) => { try { const x = new URL(u); x.hash = ''; return x.href; } catch { return u || ''; } };

// http/https × www/bare for the site's home page.
export async function checkVariants(pageUrl) {
  const u = new URL(pageUrl);
  const bare = u.hostname.replace(/^www\./, '');
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(bare) || bare === 'localhost';
  const hosts = isIp ? [u.host] : [bare + (u.port ? ':' + u.port : ''), 'www.' + bare + (u.port ? ':' + u.port : '')];
  const starts = [];
  for (const proto of ['http:', 'https:']) for (const host of hosts) starts.push(`${proto}//${host}/`);
  const list = await traceUrls(starts);
  // Same page with/without trailing slash, in lower case, and index files.
  const pageVars = [];
  const path = u.pathname;
  if (path !== '/') {
    const alt = new URL(u.href); alt.hash = '';
    alt.pathname = path.endsWith('/') ? path.slice(0, -1) : (/\.[a-z0-9]{2,5}$/i.test(path) ? path : path + '/');
    if (alt.pathname !== path) pageVars.push({ kind: 'slash', url: alt.href });
    if (/[A-Z]/.test(path)) { const lc = new URL(u.href); lc.hash = ''; lc.pathname = path.toLowerCase(); pageVars.push({ kind: 'lower', url: lc.href }); }
    else if (/[a-z]/.test(path)) { const uc = new URL(u.href); uc.hash = ''; uc.pathname = path.replace(/[a-z]/, (c) => c.toUpperCase()); pageVars.push({ kind: 'upper', url: uc.href }); }
  }
  pageVars.push({ kind: 'index_php', url: u.origin + '/index.php' }, { kind: 'index_html', url: u.origin + '/index.html' });
  const pv = await traceUrls(pageVars.map((x) => x.url));
  const here = norm(pageUrl);
  const homeFinal = list.find((t) => t.final && t.final.status < 400);
  const home = homeFinal ? norm(homeFinal.final.url) : null;
  const pageRows = pv.map((t, i) => {
    const kind = pageVars[i].kind;
    const target = kind.startsWith('index') ? home : here;
    const st = t.final ? t.final.status : null;
    let verdict = 'ok';
    if (t.error && /TOO_MANY_REDIRECTS|redirect/i.test(t.error)) verdict = 'loop';
    else if (st == null) verdict = 'error';
    else if (st >= 400) verdict = 'absent';
    else if (!t.hops.length && st === 200) verdict = 'dup';
    else if (target && norm(t.final.url) !== target) verdict = 'elsewhere';
    else if (t.hops.some((h) => [302, 303, 307].includes(h.status) && !/Internal Redirect/i.test(h.statusLine))) verdict = 'temp';
    return { ...t, kind, verdict };
  });
  const finals = list.filter((t) => t.final && t.final.status < 400).map((t) => norm(t.final.url));
  const unique = [...new Set(finals)];
  const main = unique.length ? mode(finals) : null;
  const rows = list.map((t) => {
    const temp = t.hops.filter((h) => [302, 303, 307].includes(h.status) && !/Internal Redirect/i.test(h.statusLine));
    const internal = t.hops.some((h) => /Internal Redirect/i.test(h.statusLine));
    return { ...t, temp: temp.length, internal, toMain: t.final && norm(t.final.url) === main };
  });
  const issues = [];
  if (unique.length > 1) issues.push({ id: 'var_split', sev: 'crit', params: { n: unique.length } });
  if (rows.some((r) => r.temp)) issues.push({ id: 'var_temp', sev: 'warn' });
  if (rows.some((r) => r.hops.filter((h) => !/Internal Redirect/i.test(h.statusLine)).length > 1)) issues.push({ id: 'var_chain', sev: 'warn' });
  if (main && main.startsWith('http:') && rows.some((r) => r.startUrl.startsWith('https:') && r.final && r.final.status < 400)) issues.push({ id: 'var_http_main', sev: 'warn' });
  if (rows.some((r) => !r.final || r.error)) issues.push({ id: 'var_unreachable', sev: 'info' });
  if ([...list, ...pv].some((t) => t.error && /TOO_MANY_REDIRECTS|too many redirects/i.test(t.error))) issues.push({ id: 'var_loop', sev: 'crit' });
  const dups = pageRows.filter((r) => r.verdict === 'dup').map((r) => r.kind);
  if (dups.length) issues.push({ id: 'var_page_dup', sev: 'warn', params: { list: dups.join(', ') } });
  if (pageRows.some((r) => r.verdict === 'temp')) issues.push({ id: 'var_temp', sev: 'warn' });
  return { rows, main, unique, issues, pageRows };
}

function mode(arr) {
  const c = new Map();
  for (const x of arr) c.set(x, (c.get(x) || 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1])[0][0];
}

// Does a page that can't exist return 404/410?
export async function check404(pageUrl) {
  const u = new URL(pageUrl);
  const rnd = Math.random().toString(36).slice(2, 10);
  const probe = `${u.origin}/seolens-check-${rnd}-not-found`;
  const [t] = await traceUrls([probe]);
  const status = t && t.final ? t.final.status : null;
  const redirectedHome = !!(t && t.final && t.hops.length && /^\/?$/.test(new URL(t.final.url).pathname));
  let verdict = 'ok';
  if (status == null) verdict = 'error';
  else if (status === 200 && redirectedHome) verdict = 'home';
  else if (status >= 200 && status < 300) verdict = 'soft';
  else if (status !== 404 && status !== 410) verdict = 'other';
  // What the visitor sees on the 404 page: a blank page or a dead end is bad UX.
  let words = null; let links = null; let title = null;
  try {
    const r = await fetchText(probe, 1_000_000);
    if (r.text == null) throw new Error(r.error || 'no body');
    const doc = new DOMParser().parseFromString(r.text, 'text/html');
    doc.querySelectorAll('script,style,noscript').forEach((e) => e.remove());
    words = ((doc.body ? doc.body.textContent : '').match(/[\p{L}\p{N}]+/gu) || []).length;
    links = doc.querySelectorAll('a[href]').length;
    title = (doc.querySelector('title') || {}).textContent || '';
  } catch { /* ignore */ }
  const issues = [];
  if (verdict === 'soft' || verdict === 'home') issues.push({ id: 'soft_404', sev: 'crit' });
  else if (verdict === 'other') issues.push({ id: 'odd_404', sev: 'warn', params: { status } });
  if (verdict === 'ok' && words != null && (words < 10 || links < 2)) issues.push({ id: 'bare_404', sev: 'info' });
  return { probe, status, hops: t ? t.hops : [], finalUrl: t && t.final ? t.final.url : null, verdict, error: t && t.error, words, links, title, issues };
}

// hreflang: every alternate must answer 200, be indexable-looking and link back to this page.
export async function checkHreflang(pageUrl, canonical, alternates, myText) {
  const myShingles = myText ? shingles(myText) : null;
  const me = new Set([norm(pageUrl), canonical ? norm(canonical) : ''].filter(Boolean));
  const list = [...new Map(alternates.filter((a) => a.href).map((a) => [norm(a.href), a])).values()].slice(0, 30);
  const selfRef = list.some((a) => me.has(norm(a.href)));
  const out = [];
  const queue = [...list];
  const worker = async () => {
    while (queue.length) {
      const a = queue.shift();
      const href = norm(a.href);
      if (me.has(href)) { out.push({ lang: a.lang, href, self: true, status: null, back: true }); continue; }
      const row = { lang: a.lang, href, self: false, status: null, back: false, finalUrl: null, theirLang: null, noindex: false };
      try {
        const r = await fetchText(href, 2_000_000);
        if (!r.final || r.text == null) throw new Error(r.error || 'no response');
        const res = { status: r.final.status, url: r.final.url, redirected: !!r.redirected };
        row.status = res.status;
        row.finalUrl = res.url;
        row.redirected = res.redirected;
        const html = r.text;
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const alts = [...doc.querySelectorAll('link[rel~="alternate"][hreflang]')].map((l) => {
          try { return { lang: l.getAttribute('hreflang'), href: norm(new URL(l.getAttribute('href'), res.url).href) }; } catch { return null; }
        }).filter(Boolean);
        row.back = alts.some((x) => me.has(x.href));
        row.theirLang = (alts.find((x) => x.href === norm(res.url)) || {}).lang || null;
        const cl = doc.querySelector('link[rel~="canonical"]');
        row.canonical = cl ? norm(new URL(cl.getAttribute('href'), res.url).href) : null;
        row.canonicalElsewhere = !!(row.canonical && row.canonical !== norm(res.url));
        doc.querySelectorAll('script,style,noscript,template').forEach((e) => e.remove());
        row.similarity = myShingles ? jaccard(myShingles, shingles(doc.body ? doc.body.textContent : '')) : null;
        row.noindex = [...doc.querySelectorAll('meta[name]')].some((m) => /^(robots|googlebot)$/i.test(m.getAttribute('name')) && /noindex|none/i.test(m.getAttribute('content') || ''));
      } catch (e) {
        row.error = String(e.message || e);
      }
      out.push(row);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  out.sort((a, b) => (a.lang || '').localeCompare(b.lang || ''));
  const issues = [];
  if (!selfRef) issues.push({ id: 'hl_no_self', sev: 'warn' });
  const noBack = out.filter((r) => !r.self && !r.back && !r.error && r.status && r.status < 400);
  if (noBack.length) issues.push({ id: 'hl_no_back', sev: 'crit', params: { n: noBack.length } });
  const bad = out.filter((r) => !r.self && (r.error || (r.status && r.status >= 400)));
  if (bad.length) issues.push({ id: 'hl_bad_status', sev: 'crit', params: { n: bad.length } });
  const redir = out.filter((r) => r.redirected);
  if (redir.length) issues.push({ id: 'hl_redirect', sev: 'warn', params: { n: redir.length } });
  const noidx = out.filter((r) => r.noindex);
  if (noidx.length) issues.push({ id: 'hl_noindex', sev: 'warn', params: { n: noidx.length } });
  const canX = out.filter((r) => r.canonicalElsewhere);
  if (canX.length) issues.push({ id: 'hl_canonical', sev: 'crit', params: { n: canX.length } });
  const same = out.filter((r) => r.similarity != null && r.similarity > 0.8);
  if (same.length) issues.push({ id: 'hl_same_text', sev: 'warn', params: { n: same.length } });
  return { rows: out, selfRef, issues };
}

// Word 4-gram shingles for a rough "same text" check between language versions.
function shingles(text) {
  const w = ((text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, 3000);
  const set = new Set();
  for (let i = 0; i + 4 <= w.length; i++) set.add(w.slice(i, i + 4).join(' '));
  return set;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return Math.round((inter / (a.size + b.size - inter)) * 100) / 100;
}

// Where the canonical points: status, redirects, noindex, its own canonical.
export async function checkCanonicalTarget(href, pageUrl) {
  const r = await fetchText(href, 2_000_000);
  const trace = { startUrl: href, hops: r.hops || [], final: r.final || null, error: r.error || null };
  let noindex = null; let theirCanonical = null;
  if (r.text != null && r.final) {
    const doc = new DOMParser().parseFromString(r.text, 'text/html');
    noindex = [...doc.querySelectorAll('meta[name]')].some((m) => /^(robots|googlebot)$/i.test(m.getAttribute('name')) && /noindex|none/i.test(m.getAttribute('content') || ''));
    if (/noindex|none/i.test(r.xRobots || '')) noindex = true;
    const cl = doc.querySelector('link[rel~="canonical"]');
    try { theirCanonical = cl ? norm(new URL(cl.getAttribute('href'), r.final.url).href) : null; } catch { theirCanonical = null; }
  }
  const issues = [];
  const st = trace && trace.final ? trace.final.status : null;
  if (st == null) issues.push({ id: 'can_target_unreachable', sev: 'info', params: { err: trace.error || '—' } });
  else if (st === 403 || st === 429) issues.push({ id: 'can_target_denied', sev: 'info', params: { status: st } });
  else if (st >= 400) issues.push({ id: 'can_target_error', sev: 'crit', params: { status: st } });
  else if (trace.hops.length) issues.push({ id: 'can_target_redirect', sev: 'warn' });
  if (noindex) issues.push({ id: 'can_target_noindex', sev: 'crit' });
  if (theirCanonical && theirCanonical !== norm(href) && theirCanonical !== norm(trace && trace.final ? trace.final.url : href)) issues.push({ id: 'can_target_chain', sev: 'warn' });
  return { trace, noindex, theirCanonical, issues, self: norm(href) === norm(pageUrl) };
}

// ---------- Redirect chain of one address, on demand (no page reload needed) ----------
export async function traceChain(url) {
  const t0 = Date.now();
  const [r] = await traceUrls([url]);
  return { ...(r || { error: 'no response', hops: [] }), ms: Date.now() - t0 };
}

// ---------- Another page for comparison ----------
export async function fetchPage(url) {
  const t0 = Date.now();
  const r = await fetchText(url, 3_000_000);
  return { ...r, ms: Date.now() - t0 };
}

// ---------- A list of addresses (no crawling: only what the user pasted) ----------
export async function checkUrlList(urls, parse, onEach) {
  const queue = urls.slice(0, 50).map((u, i) => ({ u, i }));
  const out = new Array(queue.length);
  const worker = async () => {
    while (queue.length) {
      const { u, i } = queue.shift();
      const t0 = Date.now();
      const r = await fetchText(u, 1_500_000);
      const row = { url: u, ms: Date.now() - t0, error: r.error || null, hops: r.hops || [], final: r.final || null, xRobots: r.xRobots || '' };
      if (r.text && /html/i.test(r.contentType || '')) {
        const p = parse(r.text, (r.final && r.final.url) || u);
        Object.assign(row, { title: p.title, description: p.description, h1: p.h1[0] || null, h1count: p.h1.length, canonical: p.canonical, robots: p.robots, words: p.words });
      }
      out[i] = row;
      if (onEach) onEach(out.filter(Boolean).length, out.length);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return out;
}
