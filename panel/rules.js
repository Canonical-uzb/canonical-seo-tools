// Rules: turn a collected page report into derived facts, issues with fixes, and a score.
import { parseRobots, matchRobots, BOTS, AI_BOTS } from './robots.js';
import { tokens, sharedWords, coverage } from './text.js';

export const SEV_WEIGHT = { crit: 15, warn: 5, info: 1 };

export const DEFAULTS = {
  titleMin: 30, titleMax: 60,
  descMin: 70, descMax: 160,
  h1Min: 20, h1Max: 70,
  thinWords: 300,
  bot: 'googlebot',
  template: 'Title: {title}\nH1: {h1}\nDescription: {description}\nURL: {url}\nCanonical: {canonical}\nRobots: {robots}',
  stopwords: '',
  myDomain: '',
  myDomainSubs: true,
  focus: '',
  theme: 'system',
  lang: 'auto',
  customLinks: '',
  hlHeadings: false,
  hlRel: false,
  hlNoindex: false,
  autoRun: false,
  heavyImageKb: 300,
  keepHistory: true,
  settingsVersion: 2,
  allowCT: true,
  serpGoogle: false,
  serpYandex: false,
  serpAds: true,
  serpToolbar: true,
};

let canvas;
export function pxWidth(text, font) {
  canvas = canvas || document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  return Math.round(ctx.measureText(text || '').width);
}
export const PX = { titleFont: '20px Arial', descFont: '14px Arial', titleMax: 600, descMax: 920 };

const norm = (s) => (s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const stripHash = (u) => { try { const x = new URL(u); x.hash = ''; return x.href; } catch { return u; } };

export function headerValues(list, name) {
  return (list || []).filter((h) => h.name === name).map((h) => h.value);
}

function parseLinkHeader(values) {
  const out = [];
  values.join(',').split(/,(?=\s*<)/).forEach((part) => {
    const m = part.match(/<([^>]+)>\s*;(.*)/);
    if (!m) return;
    const params = {};
    m[2].split(';').forEach((p) => { const kv = p.trim().match(/^([\w-]+)\s*=\s*"?([^"]*)"?$/); if (kv) params[kv[1].toLowerCase()] = kv[2]; });
    out.push({ url: m[1], rel: (params.rel || '').toLowerCase(), hreflang: params.hreflang || null });
  });
  return out;
}

// X-Robots-Tag: "googlebot: noindex", "noindex, nofollow", "unavailable_after: ..."
function parseXRobots(values) {
  const out = [];
  values.forEach((v) => {
    const m = v.match(/^\s*([a-z0-9_-]+)\s*:\s*(.+)$/i);
    if (m && !/^(noindex|nofollow|none|noarchive|nosnippet|max-|unavailable_after|noimageindex|notranslate|indexifembedded)/i.test(m[1])) {
      out.push({ bot: m[1].toLowerCase(), content: m[2] });
    } else {
      out.push({ bot: '*', content: v });
    }
  });
  return out;
}

function directivesFor(botId, robotsMeta, xRobots) {
  const bot = BOTS.find((b) => b.id === botId) || BOTS[0];
  const metas = robotsMeta.filter((m) => bot.metaNames.includes(m.name));
  const headers = xRobots.filter((x) => x.bot === '*' || x.bot === bot.token || (bot.id === 'googlebot' && x.bot === 'googlebot'));
  const all = [...metas.map((m) => ({ src: 'meta', name: m.name, content: m.content })), ...headers.map((x) => ({ src: 'header', name: x.bot, content: x.content }))];
  const tokensOf = (s) => s.toLowerCase().split(/\s*,\s*/).map((x) => x.trim());
  const flat = all.flatMap((d) => tokensOf(d.content).map((tk) => ({ ...d, token: tk })));
  const has = (tk) => flat.filter((f) => f.token === tk || f.token === 'none' && (tk === 'noindex' || tk === 'nofollow'));
  const rare = flat.filter((f) => /^(noimageindex|unavailable_after|indexifembedded|notranslate|noarchive|nosnippet|max-snippet|max-image-preview|max-video-preview)/.test(f.token));
  return { all, noindex: has('noindex'), nofollow: has('nofollow'), rare };
}

export function analyze(r, settings, nav) {
  const s = { ...DEFAULTS, ...settings };
  const issues = [];
  const add = (id, sev, group, params = {}) => issues.push({ id, sev, group, params });
  const d = { url: r.url };

  // ---------- headers: webRequest (preferred) or same-origin fetch ----------
  const navFinal = nav && nav.final ? nav.final : null;
  const respHeaders = navFinal && navFinal.headers && navFinal.headers.length ? navFinal.headers : (r.raw && r.raw.headers) || [];
  d.headersSource = navFinal && navFinal.headers && navFinal.headers.length ? 'webRequest' : (r.raw && r.raw.ok ? 'fetch' : 'none');
  d.headers = respHeaders;
  d.status = navFinal ? navFinal.status : (r.raw && r.raw.ok ? r.raw.status : null);
  d.hops = nav && nav.hops ? nav.hops : [];
  d.ttfb = nav && nav.ttfbMs != null ? nav.ttfbMs : r.perf.ttfb;
  d.encoding = headerValues(respHeaders, 'content-encoding')[0] || null;
  d.encodingName = ({ gzip: 'GZIP', 'x-gzip': 'GZIP', br: 'Brotli', zstd: 'Zstandard', deflate: 'Deflate' })[(d.encoding || '').toLowerCase().trim()] || (d.encoding ? d.encoding.toUpperCase() : null);
  // HTTP version from Navigation Timing (h3, h2, http/1.1); webRequest status line as a fallback.
  const proto = (r.perf && r.perf.protocol) || '';
  const sl = navFinal && navFinal.statusLine ? (navFinal.statusLine.match(/^HTTP\/([\d.]+)/) || [])[1] : null;
  d.httpVersion = /^h3/.test(proto) ? 'HTTP/3' : proto === 'h2' ? 'HTTP/2' : /^http\/1\.1$/.test(proto) ? 'HTTP/1.1' : /^http\/1\.0$/.test(proto) ? 'HTTP/1.0' : sl ? 'HTTP/' + sl : null;
  d.httpProto = proto || null;
  d.ip = navFinal && navFinal.ip ? navFinal.ip : null;

  // ---------- meta ----------
  const titles = r.head.titles;
  const title = titles[0] ? titles[0].text : '';
  const descs = r.head.descriptions;
  const desc = descs[0] ? descs[0].text : '';
  const h1s = r.headings.filter((h) => h.level === 1).map((h) => h.text);
  d.title = { text: title, len: title.length, px: pxWidth(title, PX.titleFont), count: titles.length };
  d.desc = { text: desc, len: desc.length, px: pxWidth(desc, PX.descFont), count: descs.length };
  d.h1 = h1s;

  if (!titles.length) add('title_missing', 'crit', 'meta');
  else if (!title) add('title_empty', 'crit', 'meta');
  else {
    if (title.length < s.titleMin) add('title_short', 'warn', 'meta', { n: title.length, min: s.titleMin });
    if (title.length > s.titleMax) add('title_long', 'warn', 'meta', { n: title.length, max: s.titleMax });
    if (d.title.px > PX.titleMax) add('title_px', 'info', 'meta', { px: d.title.px, max: PX.titleMax });
  }
  if (titles.length > 1) add('title_multiple', 'warn', 'meta', { n: titles.length });
  if (titles.length && !titles[0].inHead) add('title_not_head', 'warn', 'meta');

  if (!descs.length) add('desc_missing', 'warn', 'meta');
  else if (!desc) add('desc_empty', 'warn', 'meta');
  else {
    if (desc.length < s.descMin) add('desc_short', 'info', 'meta', { n: desc.length, min: s.descMin });
    if (desc.length > s.descMax) add('desc_long', 'info', 'meta', { n: desc.length, max: s.descMax });
  }
  if (descs.length > 1) add('desc_multiple', 'warn', 'meta', { n: descs.length });

  d.coinc = [];
  if (title && h1s[0] && norm(title) === norm(h1s[0])) { add('title_eq_h1', 'info', 'meta'); d.coinc.push('title_h1'); }
  if (title && desc && norm(title) === norm(desc)) { add('title_eq_desc', 'warn', 'meta'); d.coinc.push('title_desc'); }
  if (desc && h1s[0] && norm(desc) === norm(h1s[0])) { add('desc_eq_h1', 'info', 'meta'); d.coinc.push('desc_h1'); }
  d.shared = title && h1s[0] ? sharedWords(title, h1s[0]) : [];
  if (title && h1s[0] && !d.shared.length) add('title_h1_noshare', 'info', 'meta');
  d.titleCoverage = title ? coverage(title, r.text.mainText) : null;

  // viewport
  const vp = r.head.viewport;
  d.viewport = { raw: vp, checks: [] };
  if (!vp) add('viewport_missing', 'warn', 'meta');
  else {
    const vpl = vp.toLowerCase().replace(/\s/g, '');
    const width = /width=device-width/.test(vpl);
    const noScale = /user-scalable=(no|0)/.test(vpl);
    const ms = vpl.match(/maximum-scale=([\d.]+)/);
    const maxScaleLow = ms && parseFloat(ms[1]) < 2;
    d.viewport.checks = [
      { id: 'vp_width', ok: width },
      { id: 'vp_scalable', ok: !noScale },
      { id: 'vp_maxscale', ok: !maxScaleLow },
    ];
    if (!width) add('viewport_width', 'warn', 'meta');
    if (noScale || maxScaleLow) add('viewport_zoom', 'info', 'meta');
  }
  const icons = r.head.icons;
  d.favicon = icons.find((i) => i.rel.includes('icon') && !i.rel.includes('apple')) || null;
  d.appleIcon = icons.find((i) => i.rel.includes('apple-touch-icon')) || null;
  if (!d.favicon) add('favicon_missing', 'info', 'meta');
  if (!r.head.charset) add('charset_missing', 'info', 'meta');
  if (!r.head.lang) add('lang_missing', 'warn', 'meta');

  // ---------- indexing ----------
  const xr = parseXRobots(headerValues(respHeaders, 'x-robots-tag'));
  const dir = directivesFor(s.bot, r.head.robotsMeta, xr);
  d.xRobots = xr;
  d.directives = dir;

  const robotsParsed = parseRobots(r.robots.text || '');
  const bot = BOTS.find((b) => b.id === s.bot) || BOTS[0];
  const rm = matchRobots(robotsParsed, bot.token, r.url);
  d.robots = { fetch: r.robots, parsed: robotsParsed, match: rm, bot };
  const robotsErr = r.robots.status >= 500 || r.robots.status === 429;
  if (robotsErr) add('robots_5xx', 'crit', 'index', { status: r.robots.status });
  else if (r.robots.status === 404 || r.robots.status === 410) add('robots_missing', 'info', 'index');
  else if (r.robots.status === 0) add('robots_unreachable', 'info', 'index');
  if (!rm.allowed) add('robots_blocked', 'crit', 'index', { rule: rm.rule ? rm.rule.raw : '', bot: bot.label });

  // Resources closed in robots.txt: the bot can't render the page as users see it.
  d.blockedRes = [];
  if (r.robots.ok && r.robots.text && !r.robots.looksHtml) {
    for (const res of r.resources || []) {
      const m = matchRobots(robotsParsed, bot.token, res.url);
      if (!m.allowed) d.blockedRes.push({ ...res, rule: m.rule ? m.rule.raw : '' });
    }
  }
  d.resTotal = (r.resources || []).length;
  const blk = (k) => d.blockedRes.filter((x) => x.kind === k).length;
  const blkCode = blk('css') + blk('js');
  if (blkCode) add('res_blocked_code', 'warn', 'index', { n: blkCode, bot: bot.label });
  const blkOther = d.blockedRes.length - blkCode;
  if (blkOther) add('res_blocked_other', 'info', 'index', { n: blkOther, bot: bot.label });

  if (dir.noindex.length) add('noindex', 'crit', 'index', { src: dir.noindex.map((x) => x.src === 'meta' ? `<meta name="${x.name}">` : 'X-Robots-Tag').join(', ') });
  if (dir.nofollow.length) add('nofollow_page', 'warn', 'index');
  if (d.status && d.status >= 400) add('status_error', 'crit', 'index', { status: d.status });

  // canonical
  const can = r.head.canonicals;
  const linkHdr = parseLinkHeader(headerValues(respHeaders, 'link'));
  const hdrCanonical = linkHdr.filter((l) => l.rel.split(/\s+/).includes('canonical')).map((l) => { try { return new URL(l.url, r.url).href; } catch { return l.url; } });
  const rawCan = r.raw && r.raw.ok ? r.raw.canonicals : null;
  d.canonical = { list: can, header: hdrCanonical, raw: rawCan, state: 'none' };
  if (!can.length && !hdrCanonical.length) add('canonical_missing', 'warn', 'index');
  if (can.length > 1) add('canonical_multiple', 'crit', 'index', { n: can.length });
  if (can.length) {
    const c = can[0];
    if (!/^https?:\/\//i.test(c.raw)) add('canonical_relative', 'warn', 'index', { raw: c.raw });
    if (!c.inHead) add('canonical_body', 'crit', 'index');
    const self = stripHash(c.href) === stripHash(r.url);
    d.canonical.state = self ? 'self' : 'other';
    if (!self) {
      const onlyWww = c.href.replace('://www.', '://') === r.url.replace('://www.', '://');
      add('canonical_other', 'warn', 'index', { href: c.href, www: onlyWww });
    }
    if (hdrCanonical.length && stripHash(hdrCanonical[0]) !== stripHash(c.href)) add('canonical_header', 'warn', 'index', { hdr: hdrCanonical[0] });
    if (rawCan && rawCan.length && stripHash(rawCan[0]) !== stripHash(c.href)) add('canonical_js', 'warn', 'index', { raw: rawCan[0] });
    if (rawCan && !rawCan.length) add('canonical_js_added', 'info', 'index');
  }
  if (d.status === 200 && rawCanNoindex(r)) add('noindex_raw', 'warn', 'index');

  // summary
  const indexReasons = [];
  if (!rm.allowed) indexReasons.push('robots');
  if (dir.noindex.length) indexReasons.push('noindex');
  if (d.status && d.status >= 300) indexReasons.push('status');
  if (d.canonical.state === 'other') indexReasons.push('canonical');
  d.summary = {
    indexable: indexReasons.length === 0,
    indexReasons,
    followable: !dir.nofollow.length,
    crawlable: rm.allowed,
  };

  // sitemap
  const sm = r.sitemap;
  d.sitemap = sm;
  if (!sm.first.ok) add('sitemap_missing', 'info', 'index', { url: sm.checkedUrl, status: sm.first.status });
  else if (!sm.first.isXml) add('sitemap_invalid', 'warn', 'index', { url: sm.checkedUrl });
  if (sm.first.ok && sm.first.isXml && !sm.declared.length) add('sitemap_undeclared', 'info', 'index');
  if (sm.contains === false) add('sitemap_absent', 'info', 'index');

  // ---------- headings ----------
  const hs = r.headings;
  const h1Count = hs.filter((h) => h.level === 1).length;
  if (!h1Count) add('h1_missing', 'crit', 'headings');
  if (h1Count > 1) add('h1_multiple', 'warn', 'headings', { n: h1Count });
  if (hs.length && hs[0].level !== 1 && h1Count) add('h1_not_first', 'warn', 'headings', { tag: 'H' + hs[0].level });
  const flags = new Map();
  let prev = 0;
  const seen = new Map();
  hs.forEach((h) => {
    const f = [];
    if (prev && h.level > prev + 1) f.push('skip');
    if (!h.text) f.push('empty');
    const k = norm(h.text);
    if (k) { if (seen.has(k)) { f.push('dup'); flags.get(seen.get(k)).push('dup'); } else seen.set(k, h.idx); }
    flags.set(h.idx, f);
    prev = h.level;
  });
  for (const [, f] of flags) { const u = [...new Set(f)]; f.length = 0; f.push(...u); }
  d.headingFlags = flags;
  const skips = hs.filter((h) => flags.get(h.idx).includes('skip')).length;
  const empties = hs.filter((h) => flags.get(h.idx).includes('empty')).length;
  const dups = hs.filter((h) => flags.get(h.idx).includes('dup')).length;
  if (skips) add('h_skip', 'warn', 'headings', { n: skips });
  if (empties) add('h_empty', 'warn', 'headings', { n: empties });
  if (dups) add('h_dup', 'info', 'headings', { n: dups });
  if (h1s[0] && (h1s[0].length < s.h1Min || h1s[0].length > s.h1Max)) add('h1_length', 'info', 'headings', { n: h1s[0].length, min: s.h1Min, max: s.h1Max });

  // ---------- text ----------
  d.ratio = r.text.htmlBytes ? (r.text.fullChars / r.text.htmlBytes) * 100 : 0;
  if (r.text.mainWords < s.thinWords) add('thin', 'warn', 'text', { n: r.text.mainWords, min: s.thinWords });
  if (d.ratio && d.ratio < 10) add('ratio_low', 'info', 'text', { pct: d.ratio.toFixed(1) });

  // ---------- links ----------
  const VAGUE = new Set(['подробнее', 'тут', 'здесь', 'далее', 'ещё', 'еще', 'читать далее', 'читать', 'смотреть', 'перейти', 'по ссылке', 'ссылка', 'узнать больше', 'click here', 'here', 'read more', 'more', 'learn more', 'details', 'link', 'this']);
  d.links = r.links.items.map((l) => {
    const bad = [];
    const label = l.text || l.imgAlt || l.ariaLabel || l.title;
    if (l.raw == null) bad.push('nohref');
    else if (l.raw.trim() === '' || l.raw.trim() === '#') bad.push('hash');
    else if (/^javascript:/i.test(l.raw.trim())) bad.push('js');
    if (!label) bad.push('notext');
    if (label && VAGUE.has(norm(label))) bad.push('vague');
    const rel = l.rel.split(/\s+/).filter(Boolean);
    return { ...l, bad, relList: rel, nofollow: rel.includes('nofollow'), sponsored: rel.includes('sponsored'), ugc: rel.includes('ugc') };
  });
  const badCount = d.links.filter((l) => l.bad.some((b) => b !== 'vague')).length;
  const vagueCount = d.links.filter((l) => l.bad.includes('vague')).length;
  if (badCount) add('links_bad', 'warn', 'links', { n: badCount });
  if (vagueCount) add('links_vague', 'info', 'links', { n: vagueCount });

  // ---------- images ----------
  d.images = r.images.items.map((im) => {
    const f = [];
    if (im.alt === null) f.push('noalt');
    else if (im.alt.trim() === '') f.push('emptyalt');
    if (!im.title) f.push('notitle');
    if (!im.attrW || !im.attrH) f.push('nosize');
    if (im.broken) f.push('broken');
    if (im.renderW > 0 && im.naturalW > 0 && im.naturalW > im.renderW * im.dpr * 2) f.push('oversized');
    if (['webp', 'avif', 'svg', 'svg+xml'].includes(im.format)) f.push('modern');
    if (im.loading === 'lazy') f.push('lazy'); else f.push('eager');
    return { ...im, flags: f };
  });
  const noAlt = d.images.filter((i) => i.flags.includes('noalt')).length;
  const broken = d.images.filter((i) => i.flags.includes('broken')).length;
  const noSize = d.images.filter((i) => i.flags.includes('nosize') && !i.flags.includes('broken')).length;
  const over = d.images.filter((i) => i.flags.includes('oversized')).length;
  if (noAlt) add('img_noalt', 'warn', 'images', { n: noAlt });
  if (broken) add('img_broken', 'warn', 'images', { n: broken });
  if (noSize) add('img_nosize', 'info', 'images', { n: noSize });
  if (over) add('img_oversized', 'info', 'images', { n: over });

  // ---------- schema & social ----------
  const jl = r.schema.jsonld;
  const badJl = jl.filter((x) => !x.ok).length;
  if (badJl) add('jsonld_invalid', 'warn', 'schema', { n: badJl });
  d.schemaTypes = schemaTypes(r.schema);
  if (!jl.length && !r.schema.microdata.length && !r.schema.rdfa.length) add('schema_none', 'info', 'schema');
  const og = r.head.og;
  const ogMissing = ['og:title', 'og:type', 'og:image', 'og:url'].filter((k) => !og[k]);
  d.ogMissing = ogMissing;
  if (ogMissing.length) add('og_missing', 'info', 'schema', { list: ogMissing.join(', ') });
  if (!r.head.twitter['twitter:card']) add('twitter_missing', 'info', 'schema');

  // ---------- technical extras (one page) ----------
  const x = r.extras || {};
  // URL hygiene
  d.urlIssues = urlIssues(r.url);
  if (d.urlIssues.length) add('url_issues', 'info', 'index', { list: d.urlIssues.map((u) => u.id).join(', '), n: d.urlIssues.length });
  // canonical to another page + noindex: contradictory signals
  if (d.canonical.state === 'other' && dir.noindex.length) add('canonical_noindex', 'warn', 'index');
  // pagination: page 2+ with canonical to page 1
  const pageNo = pageNumber(r.url);
  d.pageNo = pageNo;
  if (pageNo > 1 && can.length && pageNumber(can[0].href) <= 1 && stripHash(can[0].href) !== stripHash(r.url)) add('pagination_canonical', 'warn', 'index', { n: pageNo });
  // Yandex Clean-param
  d.cleanParam = cleanParamFor(r.robots.text || '', r.url);
  if (d.cleanParam.stripped.length) add('clean_param_hit', 'info', 'index', { list: d.cleanParam.stripped.join(', ') });
  // title spam: one word repeated
  const tw = tokens(title).filter((w) => w.length > 2);
  const twc = {}; for (const w of tw) twc[w] = (twc[w] || 0) + 1;
  const spam = Object.entries(twc).filter(([, c]) => c >= 3).map(([w]) => w);
  if (spam.length) add('title_spam', 'warn', 'meta', { list: spam.join(', ') });
  // hidden external links, JS-only links
  d.hiddenLinks = x.hiddenLinks || [];
  if (d.hiddenLinks.length) add('links_hidden', 'crit', 'links', { n: d.hiddenLinks.length });
  d.fakeLinks = x.fakeLinks || [];
  if (d.fakeLinks.length) add('links_js', 'warn', 'links', { n: d.fakeLinks.length });
  d.nofollowInternal = d.links.filter((l) => l.type === 'internal' && l.nofollow).length;
  if (d.nofollowInternal) add('links_nofollow_internal', 'info', 'links', { n: d.nofollowInternal });
  // images: duplicate alt, heavy files
  const altCount = {};
  for (const im of d.images) { const a = (im.alt || '').trim().toLowerCase(); if (a) altCount[a] = (altCount[a] || 0) + 1; }
  d.dupAlts = Object.entries(altCount).filter(([, c]) => c >= 3).map(([alt, c]) => ({ alt, c })).sort((a, b) => b.c - a.c);
  if (d.dupAlts.length) add('img_dupalt', 'info', 'images', { alt: d.dupAlts[0].alt.slice(0, 40), c: d.dupAlts[0].c });
  d.heavyImages = d.images.filter((im) => im.bytes && im.bytes > s.heavyImageKb * 1024);
  d.heavyImages.forEach((im) => im.flags.push('heavy'));
  if (d.heavyImages.length) add('img_heavy', 'warn', 'images', { n: d.heavyImages.length, kb: s.heavyImageKb });
  // render-blocking
  d.blocking = x.blocking || { scripts: [], styles: [] };
  if (d.blocking.scripts.length) add('blocking_js', 'warn', 'speed', { n: d.blocking.scripts.length });
  if (d.blocking.styles.length > 4) add('blocking_css', 'info', 'speed', { n: d.blocking.styles.length });
  // mobile
  d.mobile = x.mobile || null;
  if (d.mobile) {
    if (d.mobile.overflow) add('mobile_overflow', 'warn', 'meta', { w: d.mobile.docWidth, vw: d.mobile.viewportWidth });
    if (d.mobile.textEls >= 5 && d.mobile.smallText / d.mobile.textEls > 0.2) add('mobile_small_text', 'warn', 'meta', { n: d.mobile.smallText });
    if (d.mobile.smallTaps >= 5) add('mobile_small_taps', 'info', 'meta', { n: d.mobile.smallTaps });
  }
  // meta refresh, insecure forms, HSTS, breadcrumbs
  if (x.metaRefresh != null) add('meta_refresh', 'warn', 'server', { v: x.metaRefresh });
  if ((x.insecureForms || []).length) add('form_insecure', 'warn', 'server', { n: x.insecureForms.length });
  d.hsts = headerValues(respHeaders, 'strict-transport-security')[0] || null;
  if (r.protocol === 'https:' && d.headersSource !== 'none' && !d.hsts) add('no_hsts', 'info', 'server');
  d.breadcrumbs = !!x.breadcrumbs || d.schemaTypes.some((t) => t.type === 'BreadcrumbList');
  if (!d.breadcrumbs && new URL(r.url).pathname.split('/').filter(Boolean).length >= 2) add('no_breadcrumbs', 'info', 'schema');
  // Product / Offer / BreadcrumbList structure
  d.productChecks = productChecks(r.schema.jsonld);
  for (const pc of d.productChecks.issues) add(pc.id, pc.sev, 'schema', pc.params || {});

  // ---------- false 404 on the current page ----------
  // 200 with a "not found" page (soft 404), or 404/410 on a page full of content (false 404).
  const nfRe = /(^|\b|\s)(404|страница не найдена|страницы не существует|не найдена|не существует|page not found|not found|nothing found|ничего не найдено|товар не найден|запись не найдена|sahifa topilmadi|error 404|ошибка 404)(\b|\s|$)/i;
  const h1t = (d.h1[0] || '');
  d.notFoundSignals = [title, h1t].filter((x) => nfRe.test(x));
  if (d.status && d.status < 300 && d.notFoundSignals.length) add('soft404_page', 'warn', 'index', { text: d.notFoundSignals[0].slice(0, 80) });
  if (d.status && (d.status === 404 || d.status === 410) && r.text.mainWords > 150 && !d.notFoundSignals.length) add('false404_page', 'crit', 'index', { status: d.status, n: r.text.mainWords });

  // ---------- content after JavaScript ----------
  const js = r.jsdiff || { ok: false };
  d.jsdiff = js;
  if (js.ok && js.totalWords >= 50) {
    if (js.share >= 50) add('js_content', 'crit', 'text', { p: js.share, n: js.jsWords });
    else if (js.share >= 20) add('js_content', 'warn', 'text', { p: js.share, n: js.jsWords });
    else if (js.share >= 5) add('js_content', 'info', 'text', { p: js.share, n: js.jsWords });
  }
  if (js.ok && js.headingsJs.some((h0) => h0.level === 1)) add('js_h1', 'crit', 'headings');
  else if (js.ok && js.headingsJs.length) add('js_headings', 'warn', 'headings', { n: js.headingsJs.length });
  const jsInternal = js.ok ? js.linksJs.filter((l) => l.internal).length : 0;
  if (jsInternal >= 3) add('js_links', 'warn', 'links', { n: jsInternal });
  if (js.ok && (js.outside.before || js.outside.after)) add('outside_html', 'info', 'server');
  // AI crawlers in robots.txt
  d.aiBots = AI_BOTS.map((b) => ({ ...b, ...matchRobots(robotsParsed, b.token, r.url) }));
  const aiBlocked = d.aiBots.filter((b) => !b.allowed);
  if (r.robots.ok && aiBlocked.length) add('ai_blocked', 'info', 'index', { list: aiBlocked.map((b) => b.label.split(' ')[0]).join(', ') });
  // structure
  const st = r.structure || {};
  d.structure = st;
  if ((st.sitewideHeadings || []).length >= 3) add('sitewide_headings', 'info', 'headings', { n: st.sitewideHeadings.length });
  if ((st.dupLinks || []).length) add('dup_links', 'info', 'links', { n: st.dupLinks.length });
  if ((st.dupIds || []).length) add('dup_ids', 'info', 'server', { n: st.dupIds.length });
  if (st.frames) add('frames', 'warn', 'server');
  if (st.flash) add('flash', 'warn', 'server');
  if (r.text.mainWords > 1500 && r.headings.filter((h0) => h0.level === 2).length >= 4 && !st.toc) add('no_toc', 'info', 'text');
  // charset: header vs meta
  const ctHdr = headerValues(respHeaders, 'content-type')[0] || '';
  const hdrCs = (ctHdr.match(/charset=([\w-]+)/i) || [])[1];
  const metaCs = ((r.head.charset || '').match(/(?:charset=)?([\w-]+)\s*$/i) || [])[1];
  d.charsets = { header: hdrCs || null, meta: metaCs || null };
  if (hdrCs && metaCs && hdrCs.toLowerCase().replace('utf8', 'utf-8') !== metaCs.toLowerCase().replace('utf8', 'utf-8')) add('charset_mismatch', 'warn', 'server', { h: hdrCs, m: metaCs });
  // Article: author and dates; Organization on the home page
  d.articles = articleChecks(r.schema.jsonld);
  for (const a of d.articles.issues) add(a.id, a.sev, 'schema', a.params || {});
  const isHome = /^\/?(index\.(php|html?))?$/.test(new URL(r.url).pathname);
  d.isHome = isHome;
  if (isHome && !d.schemaTypes.some((t0) => /^(Organization|LocalBusiness|Corporation|Store|OnlineStore|WebSite)$/.test(t0.type) || /Business|Store|Restaurant|Service/.test(t0.type))) add('no_org_schema', 'info', 'schema');
  // trust signals (E-E-A-T, commercial factors)
  d.trust = r.trust || null;
  if (d.trust && isHome) {
    const miss = [];
    if (!d.trust.phone) miss.push('phone');
    if (!d.trust.email) miss.push('email');
    if (!d.trust.contacts) miss.push('contacts');
    if (!d.trust.about) miss.push('about');
    if (!d.trust.privacy) miss.push('privacy');
    if (miss.length) add('trust_missing', 'info', 'schema', { list: miss.join(', ') });
  }

  // ---------- audit round 3: security headers, broken resources, robots, hreflang, language, sitemap, schema ----------
  const hv = (n) => headerValues(respHeaders, n)[0] || null;
  // technologies: DOM markers from the collector + response headers
  d.tech = techFromHeaders(respHeaders, r.tech || []);
  d.secHeaders = { csp: hv('content-security-policy'), xfo: hv('x-frame-options'), referrer: hv('referrer-policy'), permissions: hv('permissions-policy'), xcto: hv('x-content-type-options') };
  if (r.protocol === 'https:' && d.headersSource !== 'none') {
    const missSec = [];
    if (!d.secHeaders.xcto) missSec.push('X-Content-Type-Options');
    if (!d.secHeaders.xfo && !/frame-ancestors/i.test(d.secHeaders.csp || '')) missSec.push('X-Frame-Options / frame-ancestors');
    if (!d.secHeaders.referrer) missSec.push('Referrer-Policy');
    if (missSec.length) add('sec_headers', 'info', 'server', { list: missSec.join(', ') });
  }
  d.brokenRes = r.brokenRes || [];
  if (d.brokenRes.length) add('broken_resources', d.brokenRes.some((x) => /script|link|css/.test(x.type)) ? 'warn' : 'info', 'speed', { n: d.brokenRes.length });
  // robots.txt hygiene
  d.robotsLint = robotsLint(robotsParsed, r.robots.text || '');
  for (const x of d.robotsLint) add(x.id, x.sev, 'index', x.params || {});
  // language of the text vs <html lang>
  d.langGuess = guessLang(r.text.mainText || r.text.fullText || '');
  const declared = ((r.head.lang || '').toLowerCase().split('-')[0]) || null;
  if (declared && d.langGuess && d.langGuess.lang !== declared && d.langGuess.confidence >= 0.6) add('lang_mismatch', 'info', 'meta', { declared: r.head.lang, guess: d.langGuess.lang });
  // sitemap quality
  const smStats = r.sitemap && r.sitemap.stats;
  d.sitemapStats = smStats || null;
  if (smStats) {
    if (smStats.lastmodBad) add('sm_lastmod_bad', 'warn', 'index', { n: smStats.lastmodBad });
    if (smStats.lastmodFuture) add('sm_lastmod_future', 'warn', 'index', { n: smStats.lastmodFuture });
    if (smStats.foreign) add('sm_foreign', 'warn', 'index', { n: smStats.foreign });
    if (smStats.scheme) add('sm_scheme', 'warn', 'index', { n: smStats.scheme });
    if (smStats.dup) add('sm_dup', 'info', 'index', { n: smStats.dup });
    if (smStats.priorityBad) add('sm_priority', 'info', 'index', { n: smStats.priorityBad });
  }
  if (r.sitemap && r.sitemap.contains === true && d.canonical.state === 'other') add('sm_noncanonical', 'warn', 'index');
  if (r.sitemap && r.sitemap.contains === true && dir.noindex.length) add('sm_noindex', 'warn', 'index');
  // Schema.org required fields and @id references
  d.schemaReq = schemaRequired(r.schema.jsonld);
  const reqBad = d.schemaReq.rows.filter((x) => x.missing.length);
  if (reqBad.length) add('schema_required', 'warn', 'schema', { list: [...new Set(reqBad.map((x) => x.type))].join(', ') });
  if (d.schemaReq.badRefs.length) add('schema_bad_ref', 'info', 'schema', { list: d.schemaReq.badRefs.slice(0, 5).join(', ') });

  // ---------- server ----------
  d.hreflang = [...r.head.hreflang.map((h) => ({ ...h, src: 'html' })), ...linkHdr.filter((l) => l.hreflang).map((l) => ({ lang: l.hreflang, href: l.url, raw: l.url, inHead: true, src: 'header' }))];
  // hreflang: x-default and valid codes
  if (d.hreflang.length) {
    if (!d.hreflang.some((x) => (x.lang || '').toLowerCase() === 'x-default')) add('hl_no_xdefault', 'info', 'meta');
    const bad = d.hreflang.filter((x) => !validHreflang(x.lang)).map((x) => x.lang);
    if (bad.length) add('hl_bad_code', 'warn', 'meta', { list: [...new Set(bad)].slice(0, 5).join(', ') });
  }
  if (r.protocol === 'http:') add('no_https', 'warn', 'server');
  if (r.mixed.length) add('mixed', 'warn', 'server', { n: r.mixed.length });
  if (d.headersSource !== 'none' && !d.encoding && (r.raw.bytes || 0) > 1500) add('no_compression', 'warn', 'server');
  if (d.httpVersion && /^HTTP\/1/.test(d.httpVersion) && r.protocol === 'https:') add('old_http', 'info', 'server', { v: d.httpVersion });
  if (d.hops.length > 1) add('redirect_chain', 'warn', 'server', { n: d.hops.length });
  if (d.ttfb != null && d.ttfb > 800) add('ttfb_slow', 'info', 'server', { ms: d.ttfb });
  // Last-Modified / ETag and 304 Not Modified
  const cond = r.conditional || null;
  const lmHdr = headerValues(respHeaders, 'last-modified')[0] || (cond && cond.lastModified) || null;
  const etHdr = headerValues(respHeaders, 'etag')[0] || (cond && cond.etag) || null;
  d.cache = { lastModified: lmHdr, etag: etHdr, tested: !!(cond && cond.tested), status: cond ? cond.status : null, sent: cond ? cond.sent : [], error: cond ? cond.error : null };
  if (r.raw && r.raw.ok) {
    if (!lmHdr && !etHdr) add('no_last_modified', 'info', 'server');
    else if (d.cache.tested && d.cache.status !== 304) add('no_304', 'info', 'server', { status: d.cache.status });
  }

  // ---------- speed ----------
  const p = r.perf;
  d.cwv = {
    lcp: rate(p.lcp, 2500, 4000),
    inp: rate(p.inp, 200, 500),
    cls: rate(p.cls, 0.1, 0.25),
  };
  for (const k of ['lcp', 'inp', 'cls']) {
    const v = d.cwv[k];
    if (v === 'poor') add(k + '_poor', 'warn', 'speed', { v: k === 'cls' ? p[k] : p[k] + ' ms' });
    else if (v === 'ni') add(k + '_ni', 'info', 'speed', { v: k === 'cls' ? p[k] : p[k] + ' ms' });
  }

  // ---------- score ----------
  const order = { crit: 0, warn: 1, info: 2 };
  issues.sort((a, b) => order[a.sev] - order[b.sev]);
  const penalty = issues.reduce((a, i) => a + SEV_WEIGHT[i.sev], 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));
  return { issues, score, d, settings: s };
}

function rawCanNoindex(r) {
  if (!r.raw || !r.raw.ok) return false;
  const rawNo = (r.raw.robots || []).some((m) => /noindex|none/i.test(m.content));
  const domNo = r.head.robotsMeta.some((m) => /noindex|none/i.test(m.content));
  return rawNo && !domNo;
}

function rate(v, good, poor) {
  if (v == null) return 'na';
  if (v <= good) return 'good';
  if (v <= poor) return 'ni';
  return 'poor';
}

// ---------- helpers for technical extras ----------
export function urlIssues(url) {
  let u; try { u = new URL(url); } catch { return []; }
  const out = [];
  const path = u.pathname;
  let decoded = path; try { decoded = decodeURIComponent(path); } catch { /* keep */ }
  if (/[A-Z]/.test(path)) out.push({ id: 'upper' });
  if (/_/.test(path)) out.push({ id: 'underscore' });
  if (/[^\x00-\x7F]/.test(url.replace(/^[^/]*\/\/[^/]+/, ''))) out.push({ id: 'nonascii' });
  if (/\/\//.test(path)) out.push({ id: 'double_slash' });
  const segs = decoded.split('/').filter(Boolean);
  if (segs.some((sg, i) => i > 0 && sg === segs[i - 1])) out.push({ id: 'repeat' });
  if (url.length > 115) out.push({ id: 'long', n: url.length });
  if (segs.length > 5) out.push({ id: 'deep', n: segs.length });
  if (/\.(php|aspx?|jsp|cgi)$/i.test(path) && u.search) out.push({ id: 'dynamic' });
  const params = [...u.searchParams.keys()];
  if (params.some((p) => /^utm_|^gclid$|^yclid$|^fbclid$|^_openstat$/i.test(p))) out.push({ id: 'tracking' });
  if (params.length >= 3) out.push({ id: 'params', n: params.length });
  if (/\s|%20/.test(path)) out.push({ id: 'space' });
  if (params.some((p) => /^(phpsessid|sid|sessionid|session_id|jsessionid)$/i.test(p)) || /;jsessionid=/i.test(path)) out.push({ id: 'session' });
  return out;
}

export function pageNumber(url) {
  try {
    const u = new URL(url);
    for (const k of ['page', 'p', 'pg', 'PAGEN_1', 'paged', 'start']) {
      const v = u.searchParams.get(k);
      if (v && /^\d+$/.test(v)) return k === 'start' ? (Number(v) > 0 ? 2 : 1) : Number(v);
    }
    const m = u.pathname.match(/\/(?:page|p|stranica)[/-]?(\d+)\/?$/i);
    return m ? Number(m[1]) : 1;
  } catch { return 1; }
}

export function cleanParamFor(robotsText, url) {
  const rules = [];
  for (const line of (robotsText || '').split(/\r?\n/)) {
    const m = line.match(/^\s*clean-param\s*:\s*(\S+)(?:\s+(\S+))?/i);
    if (m) rules.push({ params: m[1].split('&'), prefix: m[2] || '/' , raw: line.trim() });
  }
  let u; try { u = new URL(url); } catch { return { rules, stripped: [] }; }
  const stripped = [];
  for (const r of rules) {
    const prefixRe = new RegExp('^' + r.prefix.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'));
    if (!prefixRe.test(u.pathname)) continue;
    for (const p of r.params) if (u.searchParams.has(p)) stripped.push(p);
  }
  return { rules, stripped: [...new Set(stripped)] };
}

const CURRENCIES = new Set('AED AMD AUD AZN BGN BRL BYN CAD CHF CNY CZK DKK EUR GBP GEL HKD HUF IDR ILS INR JPY KGS KRW KZT MDL MXN NOK NZD PLN RON RSD RUB SAR SEK SGD THB TJS TMT TRY UAH USD UZS VND ZAR'.split(' '));
const AVAIL = /^(https?:\/\/schema\.org\/)?(InStock|OutOfStock|PreOrder|BackOrder|Discontinued|InStoreOnly|LimitedAvailability|OnlineOnly|PreSale|SoldOut|Reserved|MadeToOrder)$/;

export function productChecks(jsonld) {
  const nodes = [];
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 8) return;
    if (Array.isArray(o)) { o.forEach((v) => walk(v, depth + 1)); return; }
    if (o['@type']) nodes.push(o);
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  jsonld.filter((j) => j.ok).forEach((j) => walk(j.data));
  const is = (n, t) => [].concat(n['@type']).some((x) => String(x).replace(/^https?:\/\/schema\.org\//, '') === t);
  const products = nodes.filter((n) => is(n, 'Product'));
  const issues = [];
  const rows = [];
  const names = new Set();
  for (const p of products) {
    const offers = [].concat(p.offers || []).filter(Boolean);
    const row = { name: String(p.name || '—').slice(0, 80), offers: offers.length, price: null, currency: null, availability: null, problems: [] };
    if (!p.name) row.problems.push('no_name');
    if (!p.image) row.problems.push('no_image');
    if (!offers.length && !p.aggregateRating && !p.review) row.problems.push('no_offer');
    for (const o of offers) {
      const price = o.price != null ? o.price : (o.lowPrice != null ? o.lowPrice : (o.priceSpecification && o.priceSpecification.price));
      const cur = o.priceCurrency || (o.priceSpecification && o.priceSpecification.priceCurrency);
      row.price = price; row.currency = cur; row.availability = o.availability || null;
      if (price == null || price === '') row.problems.push('no_price');
      else if (!/^\d+(\.\d+)?$/.test(String(price).trim())) row.problems.push('bad_price');
      if (!cur) row.problems.push('no_currency');
      else if (!CURRENCIES.has(String(cur).toUpperCase()) || String(cur) !== String(cur).toUpperCase()) row.problems.push('bad_currency');
      if (!o.availability) row.problems.push('no_availability');
      else if (!AVAIL.test(String(o.availability))) row.problems.push('bad_availability');
    }
    row.problems = [...new Set(row.problems)];
    names.add(row.name);
    rows.push(row);
  }
  if (products.length > 1 && names.size > 1) issues.push({ id: 'product_multiple', sev: 'warn', params: { n: products.length } });
  const crit = ['no_offer', 'no_price', 'bad_price', 'no_currency', 'bad_currency', 'bad_availability'];
  const probs = new Set(rows.flatMap((r) => r.problems));
  for (const pr of probs) issues.push({ id: 'product_' + pr, sev: crit.includes(pr) ? 'warn' : 'info' });
  const crumbs = nodes.filter((n) => is(n, 'BreadcrumbList'));
  for (const b of crumbs) {
    const items = [].concat(b.itemListElement || []);
    if (!items.length || items.some((it) => it.position == null || !(it.name || (it.item && it.item.name)))) { issues.push({ id: 'breadcrumb_bad', sev: 'warn' }); break; }
  }
  return { products: rows, issues };
}

// Article / BlogPosting / NewsArticle: author and dates.
export function articleChecks(jsonld) {
  const nodes = [];
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 8) return;
    if (Array.isArray(o)) { o.forEach((v) => walk(v, depth + 1)); return; }
    if (o['@type']) nodes.push(o);
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  jsonld.filter((j) => j.ok).forEach((j) => walk(j.data));
  const arts = nodes.filter((n) => [].concat(n['@type']).some((t) => /^(Article|BlogPosting|NewsArticle|TechArticle|Report|ScholarlyArticle)$/.test(String(t))));
  const issues = [];
  const rows = arts.map((a) => {
    const author = a.author ? [].concat(a.author).map((x) => (typeof x === 'string' ? x : x.name || '')).filter(Boolean).join(', ') : '';
    const pub = a.datePublished || '';
    const mod = a.dateModified || '';
    const last = Date.parse(mod || pub);
    const ageDays = Number.isFinite(last) ? Math.round((Date.now() - last) / 864e5) : null;
    return { headline: String(a.headline || a.name || '—').slice(0, 100), author, datePublished: pub, dateModified: mod, ageDays };
  });
  if (rows.some((r) => !r.author)) issues.push({ id: 'article_no_author', sev: 'info' });
  if (rows.some((r) => !r.datePublished)) issues.push({ id: 'article_no_date', sev: 'info' });
  const old = rows.find((r) => r.ageDays != null && r.ageDays > 730);
  if (old) issues.push({ id: 'article_old', sev: 'info', params: { y: Math.floor(old.ageDays / 365) } });
  return { rows, issues };
}

// ---------- helpers: robots lint, hreflang codes, language guess, schema required fields ----------
export function robotsLint(parsed, text) {
  const out = [];
  for (const g of parsed.groups) {
    const allow = new Set(g.rules.filter((x) => x.type === 'allow').map((x) => x.value));
    const conflict = g.rules.filter((x) => x.type === 'disallow' && x.value && allow.has(x.value)).map((x) => x.value);
    if (conflict.length) out.push({ id: 'robots_conflict', sev: 'info', params: { agent: g.agents.join(', '), list: conflict.slice(0, 3).join(', ') } });
    const noSlash = g.rules.filter((x) => (x.type === 'allow' || x.type === 'disallow') && x.value && !/^[/*]/.test(x.value)).map((x) => x.value);
    if (noSlash.length) out.push({ id: 'robots_noslash', sev: 'warn', params: { list: noSlash.slice(0, 3).join(', ') } });
  }
  if (parsed.groups.some((g) => g.rules.some((x) => x.type === 'host'))) out.push({ id: 'robots_host', sev: 'info' });
  if (parsed.groups.some((g) => g.rules.some((x) => x.type === 'crawl-delay'))) out.push({ id: 'robots_crawldelay', sev: 'info' });
  const unknown = parsed.other.filter((x) => !['sitemap', 'user-agent'].includes(x.key)).map((x) => x.key);
  if (unknown.length) out.push({ id: 'robots_unknown', sev: 'info', params: { list: [...new Set(unknown)].slice(0, 5).join(', ') } });
  if (text && new Blob([text]).size > 500 * 1024) out.push({ id: 'robots_big', sev: 'warn' });
  return out;
}

export function validHreflang(code) {
  if (!code) return false;
  if (code.toLowerCase() === 'x-default') return true;
  if (!/^[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?$/i.test(code)) return false;
  try { Intl.getCanonicalLocales(code); return true; } catch { return false; }
}

const LANG_WORDS = {
  ru: ['и', 'в', 'не', 'на', 'что', 'как', 'это', 'для', 'по', 'вы', 'мы', 'или', 'так', 'его', 'все', 'уже', 'при', 'от', 'если', 'только'],
  uk: ['і', 'й', 'та', 'що', 'як', 'це', 'для', 'не', 'на', 'ви', 'ми', 'або', 'його', 'всі', 'вже', 'від', 'якщо', 'тільки', 'щоб', 'є'],
  en: ['the', 'and', 'of', 'to', 'in', 'is', 'for', 'that', 'with', 'on', 'you', 'are', 'this', 'it', 'as', 'be', 'or', 'by', 'your', 'from'],
  uz: ['va', 'bilan', 'uchun', 'bu', 'ham', 'esa', 'yoki', 'emas', 'kerak', 'boʻlib', 'boʻladi', 'qilish', 'siz', 'biz', 'ular', 'har', 'eng', 'juda', 'agar', 'lekin'],
  tt: ['һәм', 'белән', 'өчен', 'бу', 'дә', 'да', 'генә', 'яки', 'түгел', 'кирәк', 'булып', 'була', 'сез', 'без', 'алар', 'һәр', 'иң', 'бик', 'әгәр', 'ләкин'],
  kk: ['және', 'мен', 'үшін', 'бұл', 'да', 'де', 'немесе', 'емес', 'керек', 'болып', 'болады', 'сіз', 'біз', 'олар', 'әр', 'ең', 'өте', 'егер', 'бірақ', 'туралы'],
  de: ['und', 'der', 'die', 'das', 'ist', 'nicht', 'mit', 'für', 'auf', 'ein', 'eine', 'sie', 'wir', 'zu', 'von', 'den', 'dem', 'auch', 'oder', 'wie'],
  tr: ['ve', 'bir', 'bu', 'için', 'ile', 'da', 'de', 'çok', 'daha', 'gibi', 'ama', 'veya', 'olan', 'olarak', 'siz', 'biz', 'en', 'her', 'ne', 'mi'],
};
export function guessLang(text) {
  const words = (text || '').toLowerCase().replace(/[‘’`']/g, 'ʻ').match(/[\p{L}ʻ]+/gu) || [];
  if (words.length < 40) return null;
  const sample = words.slice(0, 3000);
  const scores = Object.entries(LANG_WORDS).map(([lang, list]) => {
    const set = new Set(list.map((w) => w.replace(/['’]/g, 'ʻ')));
    return [lang, sample.filter((w) => set.has(w)).length];
  }).sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  if (!best[1]) return null;
  return { lang: best[0], confidence: Math.round((1 - (second ? second[1] : 0) / best[1]) * 100) / 100, hits: best[1] };
}

// Required (or strongly recommended by Google) properties per type.
const REQUIRED = {
  Article: [['headline'], ['image'], ['datePublished'], ['author']],
  NewsArticle: [['headline'], ['image'], ['datePublished'], ['author']],
  BlogPosting: [['headline'], ['image'], ['datePublished'], ['author']],
  Organization: [['name'], ['url', 'logo']],
  LocalBusiness: [['name'], ['address']],
  FAQPage: [['mainEntity']],
  Question: [['name'], ['acceptedAnswer']],
  HowTo: [['name'], ['step']],
  Review: [['itemReviewed'], ['reviewRating'], ['author']],
  AggregateRating: [['ratingValue'], ['ratingCount', 'reviewCount']],
  Event: [['name'], ['startDate'], ['location']],
  VideoObject: [['name'], ['thumbnailUrl'], ['uploadDate']],
  Recipe: [['name'], ['image']],
  JobPosting: [['title'], ['datePosted'], ['description'], ['hiringOrganization']],
  BreadcrumbList: [['itemListElement']],
  WebSite: [['name', 'url']],
  Person: [['name']],
  Offer: [['price', 'priceSpecification'], ['priceCurrency', 'priceSpecification']],
};
const LB_TYPES = /(Store|Restaurant|Hotel|Dentist|Clinic|Agency|Shop|Salon|AutoRepair|Bakery|Cafe|Bar)$/;
export function schemaRequired(jsonld) {
  const nodes = [];
  const ids = new Set();
  const refs = [];
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 10) return;
    if (Array.isArray(o)) { o.forEach((v) => walk(v, depth + 1)); return; }
    if (o['@id'] && Object.keys(o).length > 1) ids.add(o['@id']);
    if (o['@id'] && Object.keys(o).length === 1) refs.push(o['@id']);
    if (o['@type']) nodes.push(o);
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  jsonld.filter((j) => j.ok).forEach((j) => walk(j.data));
  const rows = [];
  for (const n of nodes) {
    for (const raw of [].concat(n['@type'])) {
      const type = String(raw).replace(/^https?:\/\/schema\.org\//, '');
      const req = REQUIRED[type] || (LB_TYPES.test(type) ? REQUIRED.LocalBusiness : null);
      if (!req) continue;
      const missing = req.filter((alts) => !alts.some((k) => n[k] != null && n[k] !== '' && !(Array.isArray(n[k]) && !n[k].length))).map((alts) => alts.join(' / '));
      rows.push({ type, name: String(n.name || n.headline || n.title || '').slice(0, 60), missing });
    }
  }
  const badRefs = [...new Set(refs.filter((id) => !ids.has(id)))];
  return { rows: rows.slice(0, 60), badRefs };
}

export function schemaTypes(schema) {
  const types = new Map();
  const addT = (t, src) => { if (!t) return; (Array.isArray(t) ? t : [t]).forEach((x) => { const k = String(x).replace(/^https?:\/\/schema\.org\//, ''); types.set(k, (types.get(k) || new Set()).add(src)); }); };
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 8) return;
    if (Array.isArray(o)) { o.forEach((x) => walk(x, depth + 1)); return; }
    if (o['@type']) addT(o['@type'], 'JSON-LD');
    if (o['@graph']) walk(o['@graph'], depth + 1);
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  schema.jsonld.filter((x) => x.ok).forEach((x) => walk(x.data));
  const walkMd = (it) => { addT(it.type.split(/\s+/).filter(Boolean), 'Microdata'); Object.values(it.props).flat().forEach((v) => { if (v && typeof v === 'object' && v.type !== undefined) walkMd(v); }); };
  schema.microdata.forEach(walkMd);
  schema.rdfa.forEach((x) => addT(x.type.split(/\s+/).filter(Boolean), 'RDFa'));
  return [...types.entries()].map(([type, src]) => ({ type, src: [...src] }));
}

export function wordsOf(text) { return tokens(text).length; }

// Server, CDN and hosting platform from response headers, merged with what the page itself shows.
export function techFromHeaders(headers, found) {
  const out = found.map((x) => ({ ...x }));
  const has = (n) => out.some((x) => x.name.toLowerCase() === n.toLowerCase());
  const push = (name, cat, ver) => { if (!has(name)) out.push({ name, cat, ver: ver || null }); };
  const hv = (n) => headerValues(headers, n).join(', ');
  const server = hv('server');
  if (server) {
    const m = server.match(/^([A-Za-z][\w.-]*)(?:\/([\d.]+))?/);
    const known = { nginx: 'nginx', apache: 'Apache', litespeed: 'LiteSpeed', 'microsoft-iis': 'IIS', cloudflare: 'Cloudflare', openresty: 'OpenResty', caddy: 'Caddy', 'ddos-guard': 'DDoS-Guard', qrator: 'Qrator', gws: 'Google Web Server', 'yandex': 'Yandex', envoy: 'Envoy', vercel: 'Vercel', netlify: 'Netlify', gunicorn: 'Gunicorn', kestrel: 'Kestrel' };
    if (m) push(known[m[1].toLowerCase()] || m[1], /cloudflare|ddos|qrator/i.test(m[1]) ? 'cdn' : 'server', m[2]);
  }
  const pb = hv('x-powered-by');
  if (pb) pb.split(/,\s*/).forEach((p0) => { const m = p0.match(/^([A-Za-z][\w. -]*?)(?:\/([\d.]+))?$/); if (m) push(m[1].trim(), 'framework', m[2]); });
  const map = [
    ['cf-ray', 'Cloudflare', 'cdn'], ['x-vercel-id', 'Vercel', 'cdn'], ['x-nf-request-id', 'Netlify', 'cdn'],
    ['x-amz-cf-id', 'Amazon CloudFront', 'cdn'], ['x-served-by', null, null], ['x-fastly-request-id', 'Fastly', 'cdn'],
    ['x-litespeed-cache', 'LiteSpeed Cache', 'cache'], ['x-varnish', 'Varnish', 'cache'], ['x-akamai-transformed', 'Akamai', 'cdn'],
    ['x-bitrix-composite', '1C-Bitrix', 'cms'], ['x-drupal-cache', 'Drupal', 'cms'], ['x-generator', null, null],
    ['x-shopify-stage', 'Shopify', 'shop'], ['x-wix-request-id', 'Wix', 'cms'], ['x-github-request-id', 'GitHub Pages', 'cdn'],
    ['x-cdn', null, null], ['x-ngenix-cache', 'NGENIX', 'cdn'], ['x-cache-status', null, null],
  ];
  for (const [hn, name, cat] of map) {
    const v = hv(hn);
    if (!v) continue;
    if (name) push(name, cat);
    else if (hn === 'x-generator') push(v.split(/[ /]/)[0], 'cms');
    else if (hn === 'x-cdn') push(v, 'cdn');
  }
  if (/PHPSESSID/.test(hv('set-cookie'))) push('PHP', 'framework');
  return out;
}
