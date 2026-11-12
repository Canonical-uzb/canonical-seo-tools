// Subdomains from public Certificate Transparency logs (crt.sh, fallback Cert Spotter).
// Free, no account. Only the domain name is sent to these services, and only on click.

export const CT_ORIGINS = ['https://crt.sh/*', 'https://api.certspotter.com/*'];

// Two-part public suffixes common for RU/CIS/EU/global sites. Enough for a "registrable domain" guess.
const MULTI = new Set(('co.uk org.uk ac.uk gov.uk me.uk com.au net.au org.au co.nz com.br com.tr com.ua org.ua net.ua kiev.ua ' +
  'com.ru net.ru org.ru pp.ru msk.ru spb.ru com.kz org.kz com.uz co.uz org.uz net.uz com.by co.jp ne.jp or.jp co.kr ' +
  'com.cn net.cn org.cn com.hk com.sg com.my co.in net.in org.in co.za com.mx com.ar com.pl co.il com.es com.pt co.id').split(' '));

export function baseDomain(host) {
  const h = (host || '').toLowerCase().replace(/\.$/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || !h.includes('.')) return h;
  const parts = h.split('.');
  const last2 = parts.slice(-2).join('.');
  return MULTI.has(last2) && parts.length > 2 ? parts.slice(-3).join('.') : last2;
}

// The timeout covers reading the body; the body is capped (crt.sh answers can be huge).
async function getJson(url, ms, maxBytes = 15_000_000) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, credentials: 'omit', cache: 'no-store' });
    if (!res.ok) throw new Error(new URL(url).hostname + ' HTTP ' + res.status);
    const reader = res.body.getReader();
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { try { await reader.cancel(); } catch { /* ignore */ } throw new Error('response too large'); }
      chunks.push(value);
    }
    const all = new Uint8Array(size); let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.length; }
    return JSON.parse(new TextDecoder().decode(all));
  } finally { clearTimeout(tm); }
}

function addName(map, name, domain, notAfter) {
  for (let n of String(name || '').split(/\s+/)) {
    n = n.trim().toLowerCase().replace(/\.$/, '');
    if (!n || n.includes('@')) continue;
    const wildcard = n.startsWith('*.');
    if (wildcard) n = n.slice(2);
    if (n !== domain && !n.endsWith('.' + domain)) continue;
    const cur = map.get(n) || { host: n, wildcard: false, lastSeen: '' };
    cur.wildcard = cur.wildcard || wildcard;
    if (notAfter && notAfter > cur.lastSeen) cur.lastSeen = notAfter;
    map.set(n, cur);
  }
}

async function fromCrtSh(domain) {
  const list = await getJson(`https://crt.sh/?q=${encodeURIComponent('%.' + domain)}&output=json&exclude=expired`, 30000);
  const map = new Map();
  for (const c of list) addName(map, c.name_value, domain, (c.not_after || '').slice(0, 10));
  return map;
}

async function fromCertSpotter(domain) {
  const list = await getJson(`https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(domain)}&include_subdomains=true&expand=dns_names`, 20000);
  const map = new Map();
  for (const c of list) for (const n of c.dns_names || []) addName(map, n, domain, (c.not_after || '').slice(0, 10));
  return map;
}

// Returns { domain, source, items: [{host, wildcard, lastSeen}] } sorted by name.
export async function findSubdomains(domain) {
  let map; let source;
  try { map = await fromCrtSh(domain); source = 'crt.sh'; } catch (e1) {
    try { map = await fromCertSpotter(domain); source = 'Cert Spotter'; } catch (e2) {
      throw new Error(`${e1.message}; ${e2.message}`);
    }
  }
  const items = [...map.values()].sort((a, b) => a.host.split('.').reverse().join('.').localeCompare(b.host.split('.').reverse().join('.')));
  return { domain, source, items };
}

// Live check of one host: HTTPS first, then HTTP. Goes through the worker's guarded fetch
// (no private addresses, limited redirects and time).
export async function probeHost(host) {
  for (const proto of ['https', 'http']) {
    const r = await chrome.runtime.sendMessage({ type: 'trace', urls: [`${proto}://${host}/`], allowPrivate: false }).catch(() => null);
    const t = r && r.list && r.list[0];
    if (t && t.final) return { ok: true, status: t.final.status, finalUrl: t.final.url, redirected: t.hops.length > 0, proto };
    if (t && t.blocked) return { ok: false, blocked: t.blocked };
  }
  return { ok: false };
}
