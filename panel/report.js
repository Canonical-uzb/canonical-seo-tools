// Standalone HTML report: one file that opens in any browser, for a client who has no extension.
import { t, currentLang } from './i18n.js';
import { docFor } from './docs.js';
import { schemaTypes } from './rules.js';

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safe = (fn, fallback = '') => { try { return fn(); } catch { return fallback; } };

export function buildHtmlReport(rep, res, extra = {}) {
  const d = res.d; const r = rep;
  const lang = currentLang();
  const counts = { crit: 0, warn: 0, info: 0 };
  res.issues.forEach((i) => counts[i.sev]++);
  const scoreCls = res.score >= 85 ? 'ok' : res.score >= 60 ? 'warn' : 'crit';
  const when = new Date(r.collectedAt || Date.now()).toLocaleString(lang === 'en' ? 'en-GB' : lang);
  const kv = (rows) => `<table class="kv">${rows.filter((x) => x && x[1] !== undefined).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v == null || v === '' ? '<span class="muted">—</span>' : v}</td></tr>`).join('')}</table>`;
  const pill = (sev, text) => `<span class="pill p-${sev}">${esc(text)}</span>`;
  const link = (u) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>` : '—');
  const sev = ['crit', 'warn', 'info'];
  const issuesHtml = sev.map((s) => {
    const list = res.issues.filter((i) => i.sev === s);
    if (!list.length) return '';
    return `<h3>${pill(s, t('sev_' + s))} ${list.length}</h3><ol class="issues">${list.map((i) => {
      const doc = docFor(i.id);
      return `<li class="i-${s}"><b>${esc(t('r.' + i.id, i.params || {}))}</b><span class="grp">${esc(t('tab_' + i.group))}</span><p>${esc(t('f.' + i.id, i.params || {}))}${doc ? ` <a href="${esc(doc)}" target="_blank" rel="noopener">${esc(t('doc_link'))} ↗</a>` : ''}</p></li>`;
    }).join('')}</ol>`;
  }).join('') || `<p class="ok">${esc(t('rep_no_issues'))}</p>`;

  const types = safe(() => schemaTypes(r.schema).map((x) => x.type), []);
  const linksInt = safe(() => d.links.filter((l) => l.type === 'internal').length, null);
  const linksExt = safe(() => d.links.filter((l) => l.type === 'external' || l.type === 'subdomain').length, null);
  const nofollow = safe(() => d.links.filter((l) => l.nofollow).length, null);
  const imgNoAlt = safe(() => d.images.filter((i) => i.flags.includes('noalt') || i.flags.includes('emptyalt')).length, null);
  const pt = extra.pageType;
  const rd = extra.readability;
  const sv = extra.savings;
  const heads = (r.headings || []).slice(0, 80).map((x) => `<li style="margin-left:${(x.level - 1) * 14}px"><code>H${x.level}</code> ${esc(x.text)}</li>`).join('');
  const sum = d.summary || {};
  const cwv = (name, v, rate, unit) => `<div class="m m-${rate || 'na'}"><span>${name}</span><b>${v == null ? '—' : esc(v) + (unit || '')}</b><i>${esc(t('rate_' + (rate || 'na')))}</i></div>`;
  const sections = [
    [t('rep_overview'), kv([
      ['URL', link(r.url)],
      [t('status_code'), esc(d.status || '—')],
      pt ? [t('pt_title'), `${esc(t('pt_' + pt.type))} · ${esc(t('intent_' + pt.intent))}`] : null,
      [t('sum_indexable'), sum.indexable ? pill('ok', t('yes')) : pill('crit', t('no'))],
      [t('sum_followable'), sum.followable ? pill('ok', t('yes')) : pill('warn', t('no'))],
      [t('sum_crawlable'), sum.crawlable ? pill('ok', t('yes')) : pill('crit', t('no'))],
    ])],
    [t('tab_meta'), kv([
      ['Title', `${esc(d.title.text)} <span class="muted">(${d.title.len} · ${d.title.px} px)</span>`],
      ['Description', `${esc(d.desc.text)} <span class="muted">(${d.desc.len} · ${d.desc.px} px)</span>`],
      ['H1', esc((d.h1 || []).join(' | '))],
      ['Canonical', safe(() => d.canonical.list.map((c) => link(c.href)).join('<br>'))],
      ['Meta robots', esc(safe(() => d.directives.all.map((x) => `${x.name}: ${x.content}`).join('; ')))],
      ['lang', esc(r.head.lang)],
      ['hreflang', esc(safe(() => d.hreflang.length, 0))],
      ['Open Graph', Object.keys(r.head.og || {}).length ? pill('ok', t('yes')) : pill('warn', t('no'))],
    ])],
    [t('tab_index'), kv([
      ['robots.txt', esc(safe(() => d.robots.fetch.status, '—'))],
      [t('robots_verdict'), safe(() => (d.robots.match.allowed ? pill('ok', t('allowed')) : pill('crit', t('disallowed'))), '')],
      ['sitemap.xml', esc(safe(() => (d.sitemap.first.ok ? `${d.sitemap.first.status} · ${d.sitemap.count || 0}` : t('not_found')), '—'))],
      [t('ai_title'), esc(safe(() => `${d.aiBots.filter((b) => !b.allowed).length} / ${d.aiBots.length} ${t('disallowed')}`))],
    ])],
    [t('tab_headings'), heads ? `<ul class="heads">${heads}</ul>` : `<p class="muted">—</p>`],
    [t('tab_text'), kv([
      [t('words_main'), esc(r.text.mainWords)],
      [t('words'), esc(r.text.fullWords)],
      rd && rd.enough ? [t('read_score'), `${rd.score}/100 · ${esc(t('read_' + rd.level))}`] : null,
      rd && rd.enough ? [t('read_avg_sentence'), esc(rd.avgSentence)] : null,
      rd && rd.enough ? [t('read_long_sentences'), esc(rd.longSentences.length)] : null,
    ])],
    [t('tab_links'), kv([[t('links'), esc(r.links.total)], [t('lt_internal'), esc(linksInt)], [t('lt_external'), esc(linksExt)], ['nofollow', esc(nofollow)]])],
    [t('tab_images'), kv([
      [t('images'), esc(r.images.total)],
      [t('rep_img_noalt'), esc(imgNoAlt)],
      sv ? [t('sav_total'), esc(Math.round(sv.total / 1024) + ' KB')] : null,
    ])],
    [t('tab_schema'), types.length ? types.map((x) => `<span class="tag">${esc(x)}</span>`).join(' ') : `<p class="muted">${esc(t('none_found'))}</p>`],
    [t('tab_server'), kv([
      [t('status_code'), esc(d.status)],
      [t('http_version'), esc(d.httpVersion)],
      [t('compression'), esc(d.encodingName || t('compression_none'))],
      ['TTFB', d.ttfb != null ? esc(d.ttfb + ' ms') : null],
      ['HSTS', esc(d.hsts || '—')],
      ['X-Content-Type-Options', esc(safe(() => d.secHeaders.xcto) || '—')],
      ['Content-Security-Policy', safe(() => (d.secHeaders.csp ? pill('ok', t('yes')) : pill('info', t('no'))), '')],
    ])],
    [t('tab_speed'), `<div class="metrics">${cwv('LCP', r.perf.lcp, d.cwv.lcp, ' ms')}${cwv('INP', r.perf.inp, d.cwv.inp, ' ms')}${cwv('CLS', r.perf.cls, d.cwv.cls, '')}</div>${(d.tech || []).length ? `<p>${d.tech.map((x) => `<span class="tag">${esc(x.name)}${x.ver ? ' ' + esc(x.ver) : ''}</span>`).join(' ')}</p>` : ''}`],
  ];
  const sectionHtml = sections.map(([title, body]) => `<section><h2>${esc(title)}</h2>${body}</section>`).join('');
  return `<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t('report_title'))} — ${esc(r.url)}</title>
<style>
:root{--bg:#f4f7fa;--card:#fff;--fg:#15202b;--muted:#5a6875;--line:#d9e2ea;--accent:#0a6f9c;--ok:#1d7a43;--okb:#e3f3e8;--warn:#9a5b00;--warnb:#fbefd9;--crit:#b3261e;--critb:#fbe7e5;--info:#4a4fb0;--infob:#ecebfa}
@media (prefers-color-scheme:dark){:root{--bg:#0f151b;--card:#172029;--fg:#e2e9ef;--muted:#93a2b0;--line:#2a3744;--accent:#4cc3ec;--ok:#66d18f;--okb:#173323;--warn:#f0b75a;--warnb:#3a2c12;--crit:#f28b82;--critb:#3b1f1d;--info:#a5a9f5;--infob:#24264a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;padding:24px 16px 48px}
.wrap{max-width:920px;margin:0 auto;display:grid;gap:16px}
header{display:flex;gap:16px;align-items:center;flex-wrap:wrap}.logo{width:44px;height:44px;border-radius:11px;background:linear-gradient(135deg,#1fb5e8,#0a8cc4);color:#fff;font:700 26px/44px system-ui;text-align:center}
h1{margin:0;font-size:24px}h2{margin:0 0 10px;font-size:17px}h3{margin:14px 0 8px;font-size:15px}.muted{color:var(--muted)}a{color:var(--accent);word-break:break-all}
section,.hero{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px}
.hero{display:flex;gap:20px;align-items:center;flex-wrap:wrap}.score{width:96px;height:96px;border-radius:50%;border:6px solid;display:grid;place-content:center;text-align:center}.score b{font-size:30px;line-height:1}.score span{font-size:12px;color:var(--muted)}
.s-ok{border-color:var(--ok);color:var(--ok)}.s-warn{border-color:var(--warn);color:var(--warn)}.s-crit{border-color:var(--crit);color:var(--crit)}
.pill{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12.5px;font-weight:600}.p-ok{background:var(--okb);color:var(--ok)}.p-warn{background:var(--warnb);color:var(--warn)}.p-crit{background:var(--critb);color:var(--crit)}.p-info{background:var(--infob);color:var(--info)}
.issues{margin:0;padding-left:22px;display:grid;gap:10px}.issues li{padding-left:6px}.issues p{margin:2px 0 0;color:var(--muted);font-size:14px}.grp{margin-left:8px;font-size:12px;color:var(--muted)}
.kv{width:100%;border-collapse:collapse}.kv th{width:34%;text-align:left;font-weight:500;color:var(--muted);vertical-align:top;padding:6px 10px 6px 0;border-top:1px solid var(--line)}.kv td{padding:6px 0;border-top:1px solid var(--line);word-break:break-word}
.heads{list-style:none;margin:0;padding:0;display:grid;gap:3px}.heads code{font-size:11px;background:var(--bg);padding:0 4px;border-radius:3px;color:var(--muted)}
.tag{display:inline-block;margin:0 4px 4px 0;padding:2px 8px;border:1px solid var(--line);border-radius:6px;font-size:13px}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.m{border:1px solid var(--line);border-top-width:4px;border-radius:8px;padding:10px;display:grid}.m b{font-size:22px}.m i{font-style:normal;font-size:12px;color:var(--muted)}.m-good{border-top-color:var(--ok)}.m-ni{border-top-color:var(--warn)}.m-poor{border-top-color:var(--crit)}
.ok{color:var(--ok)}footer{text-align:center;color:var(--muted);font-size:12px}
@media print{body{background:#fff}section,.hero{break-inside:avoid}}
</style></head><body><div class="wrap">
<header><div class="logo">C</div><div><h1>${esc(t('report_title'))}</h1><div class="muted">${link(r.url)} · ${esc(when)}</div></div></header>
<div class="hero"><div class="score s-${scoreCls}"><b>${res.score}</b><span>/100</span></div><div>${pill('crit', `${t('sev_crit')}: ${counts.crit}`)} ${pill('warn', `${t('sev_warn')}: ${counts.warn}`)} ${pill('info', `${t('sev_info')}: ${counts.info}`)}${pt ? `<p class="muted">${esc(t('pt_title'))}: ${esc(t('pt_' + pt.type))} · ${esc(t('intent_' + pt.intent))}</p>` : ''}</div></div>
<section><h2>${esc(t('issues_title'))} (${res.issues.length})</h2>${issuesHtml}</section>
${sectionHtml}
<footer>Canonical SEO Tools ${esc(extra.version || '')}</footer>
</div></body></html>`;
}
