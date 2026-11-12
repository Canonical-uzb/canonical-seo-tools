// Exports: CSV, JSON, Excel (own writer, panel/xlsx.js), plain-text, Markdown and HTML reports.
import { t } from './i18n.js';
import { buildXlsx } from './xlsx.js';

export function toCsv(rows) {
  // Values come from the analysed page: neutralise formulas (=, +, -, @, tab, CR) before quoting.
  const esc = (v) => {
    let s = v == null ? '' : String(v);
    if (typeof v !== 'number' && /^[\s]*[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '﻿' + rows.map((r) => r.map(esc).join(';')).join('\r\n');
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: false }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
}

export function fileBase(url) {
  let host = 'page';
  try { const u = new URL(url); host = (u.hostname + u.pathname).replace(/[^\w.-]+/g, '_').replace(/_+$/, ''); } catch { /* keep */ }
  const d = new Date();
  const stamp = d.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `canonical_${host.slice(0, 80)}_${stamp}`;
}

export function downloadCsv(rows, name) {
  download(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }), name + '.csv');
}

export function downloadJson(obj, name) {
  download(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }), name + '.json');
}

export function downloadXlsx(sheets, name) {
  download(buildXlsx(sheets), name + '.xlsx');
}

export function issueText(i) {
  return { msg: t('r.' + i.id, i.params), fix: t('f.' + i.id, i.params) };
}

export function sheetsFor(rep, res) {
  const d = res.d;
  const sev = (s) => t('sev_' + s);
  return [
    [t('x_summary'), [
      [t('x_field'), t('x_value')],
      ['URL', rep.url],
      [t('score'), res.score],
      [t('status_code'), d.status ?? ''],
      ['Title', d.title.text],
      [t('chars'), d.title.len],
      ['Description', d.desc.text],
      [t('chars'), d.desc.len],
      ['H1', d.h1.join(' | ')],
      ['Canonical', (rep.head.canonicals[0] || {}).href || ''],
      [t('words_main'), rep.text.mainWords],
      [t('links'), rep.links.total],
      [t('images'), rep.images.total],
      ['LCP, ms', rep.perf.lcp ?? ''],
      ['CLS', rep.perf.cls ?? ''],
      ['INP, ms', rep.perf.inp ?? ''],
      ['TTFB, ms', d.ttfb ?? ''],
      [t('collected_at'), rep.collectedAt],
    ]],
    [t('x_issues'), [[t('x_severity'), t('x_group'), t('x_issue'), t('x_fix')], ...res.issues.map((i) => { const x = issueText(i); return [sev(i.sev), t('tab_' + i.group), x.msg, x.fix]; })]],
    [t('tab_headings'), [[t('level'), t('text'), t('x_flags')], ...rep.headings.map((h) => ['H' + h.level, h.text, (d.headingFlags.get(h.idx) || []).map((f) => t('hf_' + f)).join(', ')])]],
    [t('tab_links'), [['URL', t('anchor'), t('type'), 'rel', 'title', t('x_flags')], ...d.links.map((l) => [l.href || l.raw || '', l.text || l.imgAlt || '', t('lt_' + l.type), l.rel, l.title, l.bad.map((b) => t('lb_' + b)).join(', ')])]],
    [t('tab_images'), [['src', 'alt', 'title', t('natural'), t('rendered'), t('weight_kb'), t('x_flags')], ...d.images.map((i) => [i.src, i.alt ?? t('no_attr'), i.title || '', `${i.naturalW}×${i.naturalH}`, `${i.renderW}×${i.renderH}`, i.bytes ? Math.round(i.bytes / 1024) : '', i.flags.filter((f) => !['eager', 'lazy', 'modern'].includes(f)).map((f) => t('if_' + f)).join(', ')])]],
    [t('x_schema'), [[t('type'), t('x_source')], ...d.schemaTypes.map((s) => [s.type, s.src.join(', ')])]],
    [t('x_headers'), [[t('x_header'), t('x_value')], ...d.headers.map((h) => [h.name, h.value])]],
  ];
}

export function reportText(rep, res, markdown) {
  const d = res.d;
  const L = [];
  const h = (s) => L.push(markdown ? `\n## ${s}\n` : `\n${s.toUpperCase()}\n`);
  L.push(markdown ? `# ${t('report_title')}: ${rep.url}` : `${t('report_title')}: ${rep.url}`);
  L.push(`${t('score')}: ${res.score}/100 · ${t('collected_at')}: ${new Date(rep.collectedAt).toLocaleString()}`);
  h(t('x_key'));
  const kv = (k, v) => L.push(markdown ? `- **${k}:** ${v}` : `${k}: ${v}`);
  kv(t('status_code'), d.status ?? '—');
  kv('Title', `${d.title.text || '—'} (${d.title.len})`);
  kv('Description', `${d.desc.text || '—'} (${d.desc.len})`);
  kv('H1', d.h1.join(' | ') || '—');
  kv('Canonical', (rep.head.canonicals[0] || {}).href || '—');
  kv(t('sum_indexable'), d.summary.indexable ? t('yes') : t('no'));
  kv(t('words_main'), rep.text.mainWords);
  kv('LCP / CLS / INP', `${rep.perf.lcp ?? '—'} ms / ${rep.perf.cls ?? '—'} / ${rep.perf.inp ?? '—'} ms`);
  h(t('x_issues') + ` (${res.issues.length})`);
  if (!res.issues.length) L.push(t('no_issues'));
  res.issues.forEach((i) => {
    const x = issueText(i);
    L.push(markdown ? `- **${t('sev_' + i.sev)}** — ${x.msg}\n  ${t('x_fix')}: ${x.fix}` : `[${t('sev_' + i.sev)}] ${x.msg}\n    ${t('x_fix')}: ${x.fix}`);
  });
  return L.join('\n');
}
