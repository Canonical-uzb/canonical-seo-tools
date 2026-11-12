// External services catalog. {url} = current page URL (encoded), {domain} = host, {rawurl} = unencoded URL.
export const SERVICES = [
  { group: 'svc_g_check', items: [
    { name: 'PageSpeed Insights', url: 'https://pagespeed.web.dev/analysis?url={url}' },
    { name: 'Google Rich Results Test', url: 'https://search.google.com/test/rich-results?url={url}' },
    { name: 'Schema Markup Validator', url: 'https://validator.schema.org/#url={url}' },
    { name: 'W3C HTML Validator', url: 'https://validator.w3.org/nu/?doc={url}' },
    { name: 'W3C CSS Validator', url: 'https://jigsaw.w3.org/css-validator/validator?uri={url}' },
    { name: 'Яндекс Валидатор микроразметки', url: 'https://webmaster.yandex.ru/tools/microtest/' },
    { name: 'W3C Link Checker', url: 'https://validator.w3.org/checklink?uri={url}&hide_type=all&summary=on' },
  ] },
  { group: 'svc_g_reputation', items: [
    { name: 'WOT', url: 'https://www.mywot.com/scorecard/{domain}' },
    { name: 'McAfee SiteAdvisor', url: 'https://siteadvisor.com/sitereport.html?url={domain}' },
    { name: 'Kaspersky OpenTIP', url: 'https://opentip.kaspersky.com/{domain}/' },
    { name: 'URLVoid', url: 'https://www.urlvoid.com/scan/{domain}/' },
    { name: 'Sucuri SiteCheck', url: 'https://sitecheck.sucuri.net/results/{domain}' },
  ] },
  { group: 'svc_g_traffic', items: [
    { name: 'Similarweb', url: 'https://www.similarweb.com/website/{domain}/' },
    { name: 'Google Trends', url: 'https://trends.google.com/trends/explore?q={domain}' },
    { name: 'archive.ph', url: 'https://archive.ph/{rawurl}' },
  ] },
  { group: 'svc_g_security', items: [
    { name: 'SSL Labs', url: 'https://www.ssllabs.com/ssltest/analyze.html?d={domain}' },
    { name: 'Security Headers', url: 'https://securityheaders.com/?q={url}&followRedirects=on' },
    { name: 'VirusTotal', url: 'https://www.virustotal.com/gui/domain/{domain}' },
    { name: 'Google Safe Browsing', url: 'https://transparencyreport.google.com/safe-browsing/search?url={domain}' },
  ] },
  { group: 'svc_g_domain', items: [
    { name: 'WHOIS (who.is)', url: 'https://who.is/whois/{domain}' },
    { name: 'DNS (Google Admin Toolbox)', url: 'https://toolbox.googleapps.com/apps/dig/#ANY/{domain}' },
    { name: 'Wayback Machine', url: 'https://web.archive.org/web/*/{rawurl}' },
  ] },
  { group: 'svc_g_social', items: [
    { name: 'Facebook Sharing Debugger', url: 'https://developers.facebook.com/tools/debug/?q={url}' },
    { name: 'LinkedIn Post Inspector', url: 'https://www.linkedin.com/post-inspector/inspect/{url}' },
  ] },
];

export function fillTemplate(tpl, pageUrl) {
  let host = '';
  try { host = new URL(pageUrl).hostname; } catch { host = ''; }
  return tpl
    .replaceAll('{url}', encodeURIComponent(pageUrl))
    .replaceAll('{rawurl}', pageUrl)
    .replaceAll('{domain}', host);
}

// Settings text: one link per line, "Name | https://...{url}..."
export function parseCustomLinks(text) {
  return (text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf('|');
    const name = i > -1 ? l.slice(0, i).trim() : l;
    const url = i > -1 ? l.slice(i + 1).trim() : l;
    return { name: name || url, url };
  }).filter((x) => /^https?:\/\//i.test(x.url));
}

export function searchOperators(pageUrl) {
  let u; try { u = new URL(pageUrl); } catch { return []; }
  const host = u.hostname;
  const bare = host.replace(/^www\./, '');
  const noProto = (u.host + u.pathname).replace(/\/$/, '');
  const g = (q) => 'https://www.google.com/search?q=' + encodeURIComponent(q);
  const y = (q) => 'https://yandex.ru/search/?text=' + encodeURIComponent(q);
  return [
    { label: 'Google site:', url: g('site:' + bare) },
    { label: 'Google site: URL', url: g('site:' + noProto) },
    { label: 'Google intitle:', url: null, needsTitle: true, make: (title) => g('intitle:"' + title + '" site:' + bare) },
    { label: 'Яндекс site:', url: y('site:' + bare) },
    { label: 'Яндекс host:', url: y('host:' + host) },
    { label: 'Яндекс url:', url: y('url:' + noProto) },
    { label: 'Яндекс title:', url: null, needsTitle: true, make: (title) => y('title:("' + title + '") site:' + bare) },
  ];
}

export function yandexRecrawl(pageUrl) {
  let u; try { u = new URL(pageUrl); } catch { return 'https://webmaster.yandex.ru/sites/'; }
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  const id = `${u.protocol.replace(':', '')}:${u.hostname}:${port}`;
  return `https://webmaster.yandex.ru/site/${id}/indexing/reindex/`;
}
