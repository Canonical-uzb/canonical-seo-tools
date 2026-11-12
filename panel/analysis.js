// Local analyses on top of the collected report: readability, page type and intent,
// image savings, parsing another page for comparison or a list check.
import { tokens, STOP, stem, frequency } from './text.js';

// ---------- Readability ----------
const VOWELS_RU = /[аеёиоуыэюя]/g;
const VOWELS_EN = /[aeiouy]+/g;
function syllables(word, ru) {
  const w = word.toLowerCase();
  if (ru) return Math.max(1, (w.match(VOWELS_RU) || []).length);
  const m = w.replace(/e$/, '').match(VOWELS_EN);
  return Math.max(1, m ? m.length : 1);
}

export function splitSentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…])\s+(?=[A-ZА-ЯЁ0-9«"(])/u)
    .map((s) => s.trim())
    .filter((s) => (s.match(/[\p{L}\p{N}]+/gu) || []).length >= 3);
}

// Flesch reading ease. Russian uses Oborneva's coefficients (1.3 and 60.1), English the classic ones.
export function readability(text, paragraphs, lang, blocks) {
  const ru = lang ? lang === 'ru' || lang === 'uk' : /[а-яё]/i.test(text);
  // Block edges (paragraphs, list items, headings) also end sentences.
  const useBlocks = blocks && blocks.length >= 3;
  const sentences = useBlocks ? blocks.flatMap((b) => splitSentences(b)) : splitSentences(text);
  const words = useBlocks ? sentences.flatMap((x) => x.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []) : (String(text || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []);
  if (!sentences.length || words.length < 50) return { enough: false, words: words.length };
  const syl = words.reduce((n, w) => n + syllables(w, ru), 0);
  const asl = words.length / sentences.length;
  const asw = syl / words.length;
  const raw = ru ? 206.835 - 1.3 * asl - 60.1 * asw : 206.835 - 1.015 * asl - 84.6 * asw;
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const wc = (s) => (s.match(/[\p{L}\p{N}]+/gu) || []).length;
  const longS = sentences.map((s) => ({ text: s, words: wc(s) })).filter((x) => x.words > 25).sort((a, b) => b.words - a.words);
  const paras = (paragraphs || []).map((p) => ({ text: p, words: wc(p) }));
  const longP = paras.filter((p) => p.words > 120).sort((a, b) => b.words - a.words);
  const toks = tokens(text);
  const stopShare = toks.length ? toks.filter((w) => STOP.has(w)).length / toks.length : 0;
  const complex = words.filter((w) => syllables(w, ru) >= (ru ? 5 : 4)).length / words.length;
  const fr = frequency(text, { top: 10 });
  const repeats = fr.topWords.filter((w) => w.pct >= 3 && w.count >= 4);
  const buckets = { short: 0, medium: 0, long: 0, veryLong: 0 };
  for (const s of sentences) { const n = wc(s); if (n <= 10) buckets.short++; else if (n <= 20) buckets.medium++; else if (n <= 30) buckets.long++; else buckets.veryLong++; }
  return {
    enough: true, score, level: score >= 60 ? 'easy' : score >= 40 ? 'medium' : score >= 25 ? 'hard' : 'veryhard',
    sentences: sentences.length, words: words.length, avgSentence: +asl.toFixed(1),
    avgParagraph: paras.length ? Math.round(paras.reduce((n, p) => n + p.words, 0) / paras.length) : null, paragraphs: paras.length,
    longSentences: longS, longParagraphs: longP, stopShare: Math.round(stopShare * 100), complexShare: Math.round(complex * 100),
    repeats, buckets,
  };
}

// ---------- Page type and search intent ----------
const TYPE_RULES = [
  ['product', { schema: /^(Product|ProductGroup|Offer|IndividualProduct)$/, og: /product/, url: /\/(product|products|item|tovar|p)\/|[?&](product_id|sku)=/i, dom: 'product' }],
  ['category', { schema: /^(CollectionPage|ItemList|OfferCatalog)$/, url: /\/(catalog|category|categories|collection|collections|shop|c)\/|\/katalog/i, dom: 'category' }],
  ['article', { schema: /^(Article|BlogPosting|NewsArticle|TechArticle|Report)$/, og: /article/, url: /\/(blog|news|article|articles|post|posts|stati|novosti)\//i, dom: 'article' }],
  ['faq', { schema: /^(FAQPage|QAPage)$/, url: /\/(faq|help|voprosy|support)\b/i }],
  ['contacts', { schema: /^(ContactPage)$/, url: /\/(contact|contacts|kontakty|aloqa)\b/i, dom: 'contacts' }],
  ['about', { schema: /^(AboutPage)$/, url: /\/(about|about-us|o-nas|o-kompanii|company)\b/i }],
  ['service', { schema: /^(Service|LocalBusiness|ProfessionalService|HomeAndConstructionBusiness|AutoRepair)$/, url: /\/(services?|uslugi|xizmat)/i }],
];

export function pageType(r, d, schemaTypes) {
  const types = schemaTypes || [];
  let path = '/';
  try { path = new URL(r.url).pathname; } catch { /* keep */ }
  const og = String((r.head.og && r.head.og['og:type']) || '').toLowerCase();
  const text = (r.text.mainText || '').slice(0, 20000);
  const dom = {
    product: /(в корзину|купить|add to cart|buy now|savatga|артикул|sku)/i.test(text) && /(\d[\d\s]*\s?(₽|руб|сум|so'm|\$|€|uzs))/i.test(text),
    category: (r.images.items || []).length >= 12 && /(сортировать|фильтр|sort by|filter|показать ещё|load more)/i.test(text),
    article: (r.headings || []).filter((h) => h.level === 2).length >= 3 && (r.text.mainWords || 0) >= 600,
    contacts: /(\+?\d[\d\s()-]{8,}\d)/.test(text) && /(адрес|address|manzil|как добраться|карта)/i.test(text) && (r.text.mainWords || 0) < 600,
  };
  const scores = TYPE_RULES.map(([id, rule]) => {
    let s = 0; const why = [];
    if (rule.schema && types.some((x) => rule.schema.test(x))) { s += 3; why.push('schema'); }
    if (rule.og && rule.og.test(og)) { s += 2; why.push('og:type'); }
    if (rule.url && rule.url.test(path)) { s += 2; why.push('url'); }
    if (rule.dom && dom[rule.dom]) { s += 2; why.push('content'); }
    return { id, s, why };
  }).sort((a, b) => b.s - a.s);
  let best = scores[0];
  if (path === '/' || /^\/(ru|en|uz|uk|tt)\/?$/.test(path)) best = { id: 'home', s: 4, why: ['url'] };
  else if (!best || best.s < 2) best = { id: (r.text.mainWords || 0) < 400 ? 'landing' : 'article', s: 1, why: ['content'] };
  const confidence = best.s >= 5 ? 'high' : best.s >= 3 ? 'medium' : 'low';
  const intent = { product: 'transactional', category: 'commercial', service: 'commercial', landing: 'commercial', article: 'informational', faq: 'informational', contacts: 'navigational', about: 'navigational', home: 'navigational' }[best.id];
  return { type: best.id, confidence, intent, why: best.why };
}

// What each page type needs, checked against the report; ids map to i18n keys tip_*.
export function typeTips(type, r, d, schemaTypes) {
  const has = (re) => (schemaTypes || []).some((x) => re.test(x));
  const tips = [];
  const push = (id, ok) => tips.push({ id, ok });
  if (type === 'product') {
    push('product_schema', has(/^(Product|ProductGroup)$/));
    push('product_offer', has(/^(Offer|AggregateOffer)$/) || JSON.stringify(r.schema.jsonld || []).includes('"offers"'));
    push('product_reviews', has(/^(AggregateRating|Review)$/) || JSON.stringify(r.schema.jsonld || []).includes('aggregateRating'));
    push('product_breadcrumbs', has(/^BreadcrumbList$/));
    push('product_images', (r.images.items || []).filter((i) => i.alt).length >= 2);
  } else if (type === 'article') {
    push('article_schema', has(/^(Article|BlogPosting|NewsArticle|TechArticle)$/));
    push('article_author', !!(d.trust && d.trust.author));
    push('article_date', !!(d.trust && (d.trust.timeTag || d.trust.dateText)));
    push('article_length', (r.text.mainWords || 0) >= 600);
    push('article_h2', (r.headings || []).filter((h) => h.level === 2).length >= 2);
  } else if (type === 'category') {
    push('category_text', (r.text.mainWords || 0) >= 150);
    push('category_breadcrumbs', has(/^BreadcrumbList$/));
    push('category_h1', (d.h1 || []).length === 1);
    push('category_pagination', !!(r.head.next || r.head.prev) || !/[?&]page=/.test(r.url));
  } else if (type === 'contacts') {
    push('contacts_phone', !!(d.trust && d.trust.phone));
    push('contacts_address', !!(d.trust && d.trust.address));
    push('contacts_schema', has(/^(LocalBusiness|Organization|.*Business|.*Store)$/));
  } else if (type === 'home') {
    push('home_org', has(/^(Organization|LocalBusiness|WebSite|Corporation)$/));
    push('home_h1', (d.h1 || []).length === 1);
    push('home_text', (r.text.mainWords || 0) >= 200);
  } else if (type === 'faq') {
    push('faq_schema', has(/^(FAQPage|QAPage)$/));
    push('faq_h', (r.headings || []).filter((h) => /\?$/.test(h.text)).length >= 3);
  } else if (type === 'service' || type === 'landing') {
    push('service_cta', /(заказать|оставить заявку|позвонить|order|call|get a quote|buyurtma)/i.test(r.text.fullText || ''));
    push('service_price', /(\d[\d\s]*\s?(₽|руб|сум|so'm|\$|€|uzs))/i.test(r.text.fullText || ''));
    push('service_schema', has(/^(Service|LocalBusiness|Organization|.*Business)$/));
  }
  return tips;
}

// ---------- Image savings ----------
export function imageSavings(items) {
  const rows = [];
  let total = 0;
  for (const im of items || []) {
    if (!im.bytes || im.broken || !im.naturalW) continue;
    const reasons = []; let save = 0;
    const need = Math.max(1, im.renderW) * (im.dpr || 1);
    if (im.renderW > 0 && im.naturalW > need * 1.5 && im.bytes > 30000) {
      const k = Math.min(1, need / im.naturalW);
      const s = Math.round(im.bytes * (1 - k * k));
      if (s > 10000) { save += s; reasons.push({ id: 'resize', w: Math.round(need) }); }
    }
    const left = im.bytes - save;
    if (/^(jpe?g|png|bmp|gif)$/.test(im.format || '') && left > 20000) {
      const s = Math.round(left * (im.format === 'png' || im.format === 'bmp' ? 0.45 : im.format === 'gif' ? 0.4 : 0.3));
      if (s > 8000) { save += s; reasons.push({ id: 'modern' }); }
    }
    const above = im.vh && im.top != null && im.top < im.vh;
    if (above && im.loading === 'lazy') reasons.push({ id: 'lazy_above' });
    if (!above && im.loading !== 'lazy' && im.vh && im.top > im.vh * 1.5) reasons.push({ id: 'lazy_below' });
    if (reasons.length) { rows.push({ ...im, save, reasons }); total += save; }
  }
  rows.sort((a, b) => b.save - a.save);
  return { rows, total };
}

// ---------- Another page, parsed from its HTML ----------
export function parsePage(html, url) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  const q = (s) => [...doc.querySelectorAll(s)];
  const meta = (n) => { const el = doc.querySelector(`meta[name="${n}" i]`); return el ? (el.getAttribute('content') || '').trim() : null; };
  const abs = (h) => { try { return new URL(h, url).href; } catch { return h; } };
  q('script, style, noscript, template, svg').forEach((e) => e.remove());
  const body = doc.body || doc.createElement('body');
  const mainEl = doc.querySelector('main, [role="main"], article') || body;
  const mainClone = mainEl.cloneNode(true);
  if (mainEl === body) mainClone.querySelectorAll('nav, header, footer, aside').forEach((e) => e.remove());
  const mainText = (mainClone.textContent || '').replace(/\s+/g, ' ').trim();
  const words = (mainText.match(/[\p{L}\p{N}]+/gu) || []).length;
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep */ }
  const links = q('a[href]').map((a) => abs(a.getAttribute('href')));
  const internal = links.filter((h) => { try { return new URL(h).hostname.replace(/^www\./, '') === host; } catch { return false; } }).length;
  const jsonld = [];
  // JSON-LD was removed with the scripts above, so read it from the raw HTML.
  const raw = new DOMParser().parseFromString(html || '', 'text/html');
  for (const s of raw.querySelectorAll('script[type="application/ld+json"]')) {
    try { const j = JSON.parse(s.textContent); (Array.isArray(j) ? j : [j]).forEach((x) => jsonld.push(x)); } catch { /* skip */ }
  }
  const types = new Set();
  const walk = (o) => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) { o.forEach(walk); return; } const tp = o['@type']; (Array.isArray(tp) ? tp : tp ? [tp] : []).forEach((x) => types.add(String(x))); Object.values(o).forEach(walk); };
  walk(jsonld);
  q('[itemtype]').forEach((e) => types.add(String(e.getAttribute('itemtype')).split('/').pop()));
  const canon = raw.querySelector('link[rel="canonical" i]');
  return {
    title: (raw.querySelector('title') || {}).textContent ? raw.querySelector('title').textContent.trim() : null,
    description: (() => { const el = raw.querySelector('meta[name="description" i]'); return el ? (el.getAttribute('content') || '').trim() : null; })(),
    robots: (() => { const el = raw.querySelector('meta[name="robots" i]'); return el ? el.getAttribute('content') : null; })() || meta('robots'),
    canonical: canon ? abs(canon.getAttribute('href') || '') : null,
    lang: (raw.documentElement.getAttribute('lang') || '').trim() || null,
    h1: q('h1').map((e) => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean),
    headings: q('h1,h2,h3').map((e) => ({ level: +e.tagName[1], text: e.textContent.replace(/\s+/g, ' ').trim() })).filter((x) => x.text),
    words, mainText,
    images: q('img').length, imagesNoAlt: q('img').filter((i) => !i.hasAttribute('alt')).length,
    links: links.length, internal, external: links.length - internal,
    schema: [...types].filter(Boolean).slice(0, 20),
    og: !!raw.querySelector('meta[property="og:title"]'),
    hreflang: raw.querySelectorAll('link[rel="alternate"][hreflang]').length,
    htmlBytes: (html || '').length,
  };
}

// Words the competitor uses noticeably more than this page (by stem).
export function wordGap(mineText, theirsText, top = 25) {
  const count = (txt) => { const m = new Map(); for (const w of tokens(txt)) { if (STOP.has(w) || w.length < 3 || /^\d+$/.test(w)) continue; const s = stem(w); const e = m.get(s) || { n: 0, word: w }; e.n++; m.set(s, e); } return m; };
  const a = count(mineText); const b = count(theirsText);
  const totalB = [...b.values()].reduce((n, e) => n + e.n, 0) || 1;
  const totalA = [...a.values()].reduce((n, e) => n + e.n, 0) || 1;
  const rows = [];
  for (const [s, e] of b) {
    if (e.n < 2) continue;
    const mine = a.get(s) ? a.get(s).n : 0;
    const pb = e.n / totalB; const pa = mine / totalA;
    if (pb > pa * 1.8) rows.push({ word: e.word, theirs: e.n, mine, gap: pb - pa });
  }
  return rows.sort((x, y) => y.gap - x.gap).slice(0, top);
}
