// Domain, DNS, IP and hosting data from free public services, only on click:
// DNS-over-HTTPS (Google, Cloudflare, AdGuard, AliDNS), RDAP (rdap.org), ipwho.is, crt.sh, HackerTarget.
// Only the domain name or the site's IP is sent; every request is logged in the request journal.

const log = (url) => chrome.runtime.sendMessage({ type: 'logExternal', url }).catch(() => {});

async function getText(url, { headers = {}, ms = 12000, max = 3_000_000 } = {}) {
  log(url);
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { headers, credentials: 'omit', cache: 'no-store', signal: ctl.signal, redirect: 'follow' });
    const reader = res.body.getReader();
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) { try { await reader.cancel(); } catch { /* ignore */ } throw new Error('response too large'); }
      chunks.push(value);
    }
    const all = new Uint8Array(size); let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.length; }
    return { status: res.status, ok: res.ok, url: res.url, text: new TextDecoder().decode(all) };
  } finally { clearTimeout(tm); }
}
async function getJson(url, opts) {
  const r = await getText(url, opts);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return JSON.parse(r.text);
}

// ---------- DNS over HTTPS ----------
export const RESOLVERS = {
  Google: (n, t) => [`https://dns.google/resolve?name=${encodeURIComponent(n)}&type=${t}`, {}],
  Cloudflare: (n, t) => [`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(n)}&type=${t}`, { accept: 'application/dns-json' }],
  AdGuard: (n, t) => [`https://dns.adguard-dns.com/resolve?name=${encodeURIComponent(n)}&type=${t}`, {}],
  AliDNS: (n, t) => [`https://dns.alidns.com/resolve?name=${encodeURIComponent(n)}&type=${t}`, {}],
};
const TYPE_NUM = { A: 1, NS: 2, CNAME: 5, SOA: 6, MX: 15, TXT: 16, AAAA: 28, CAA: 257 };

export async function doh(name, type, resolver = 'Google') {
  if (/[^\x00-\x7f]/.test(name)) { try { name = new URL('http://' + name).hostname; } catch { /* keep as is */ } }
  const [url, headers] = RESOLVERS[resolver](name, type);
  const j = await getJson(url, { headers, ms: 8000, max: 200_000 });
  const want = TYPE_NUM[type];
  const answers = (j.Answer || []).filter((a) => !want || a.type === want).map((a) => String(a.data).replace(/^"|"$/g, '').replace(/"\s+"/g, ''));
  return { status: j.Status, answers };
}

export async function dnsRecords(host, base) {
  const jobs = [
    ['A', host], ['AAAA', host], ['CNAME', host], ['NS', base], ['MX', base], ['TXT', base], ['CAA', base], ['TXT', '_dmarc.' + base],
  ];
  const out = await Promise.all(jobs.map(async ([type, name]) => {
    try { const r = await doh(name, type); return { type: name.startsWith('_dmarc.') ? 'DMARC' : type, name, answers: r.answers, status: r.status }; } catch (e) { return { type, name, answers: [], error: String(e.message || e) }; }
  }));
  const txt = (out.find((x) => x.type === 'TXT') || { answers: [] }).answers;
  const spf = txt.find((x) => /^v=spf1/i.test(x)) || null;
  const dmarc = ((out.find((x) => x.type === 'DMARC') || { answers: [] }).answers.find((x) => /^v=DMARC1/i.test(x))) || null;
  return { rows: out.filter((x) => x.type !== 'DMARC'), spf, dmarc };
}

// Same A record from four resolvers: shows whether a DNS change has propagated.
export async function propagation(host) {
  return Promise.all(Object.keys(RESOLVERS).map(async (r) => {
    try { const x = await doh(host, 'A', r); return { resolver: r, answers: x.answers.filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)).sort(), status: x.status }; } catch (e) { return { resolver: r, answers: [], error: String(e.message || e) }; }
  }));
}

// ---------- IP: country, provider, ASN ----------
export async function ipInfo(ip) {
  try {
    const j = await getJson(`https://ipwho.is/${encodeURIComponent(ip)}`, { ms: 8000, max: 100_000 });
    if (j.success === false) throw new Error(j.message || 'ipwho.is error');
    return { source: 'ipwho.is', country: j.country, countryCode: j.country_code, city: j.city, region: j.region, asn: j.connection && j.connection.asn, org: j.connection && (j.connection.org || j.connection.isp), isp: j.connection && j.connection.isp, domain: j.connection && j.connection.domain };
  } catch (e1) {
    const j = await getJson(`https://rdap.org/ip/${encodeURIComponent(ip)}`, { ms: 10000, max: 500_000, headers: { accept: 'application/rdap+json' } });
    const org = (j.entities || []).map(vcardName).filter(Boolean)[0] || j.name;
    return { source: 'RDAP', country: j.country || null, countryCode: j.country || null, org, network: j.name, range: j.startAddress && `${j.startAddress} – ${j.endAddress}` };
  }
}

// ---------- DNSBL (blacklists) via DoH ----------
export const DNSBL = ['bl.spamcop.net', 'dnsbl-1.uceprotect.net', 'psbl.surriel.com', 'bl.mailspike.net', 'all.s5h.net', 'zen.spamhaus.org'];
export async function dnsbl(ip) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return { unsupported: true, rows: [] };
  const rev = ip.split('.').reverse().join('.');
  const rows = await Promise.all(DNSBL.map(async (zone) => {
    try {
      const r = await doh(`${rev}.${zone}`, 'A');
      const a = r.answers.find((x) => /^127\./.test(x));
      if (r.status === 3 || !a) return { zone, state: 'clean' };
      if (/^127\.255\.255\./.test(a) || /^127\.0\.0\.1$/.test(a) && zone.includes('spamhaus')) return { zone, state: 'refused', code: a };
      return { zone, state: 'listed', code: a };
    } catch (e) { return { zone, state: 'error', error: String(e.message || e) }; }
  }));
  return { rows };
}

// ---------- RDAP (structured WHOIS) ----------
// Some registries (e.g. .uz) return HTML entities inside RDAP strings: OOO &quot;NAME&quot;.
function unescapeHtml(t) {
  return String(t).replace(/&(quot|amp|lt|gt|apos|#39|#34);/g, (m, k) => ({ quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", '#39': "'", '#34': '"' })[k]);
}
function vcardName(ent) {
  const v = ent && ent.vcardArray && ent.vcardArray[1];
  if (!v) return null;
  const fn = v.find((x) => x[0] === 'fn');
  return fn && fn[3] ? unescapeHtml(fn[3]) : null;
}
export async function rdapDomain(domain) {
  const j = await getJson(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { ms: 12000, max: 1_000_000, headers: { accept: 'application/rdap+json' } });
  const ev = (name) => ((j.events || []).find((e) => e.eventAction === name) || {}).eventDate || null;
  const registrar = (j.entities || []).filter((e) => (e.roles || []).includes('registrar')).map(vcardName).filter(Boolean)[0] || null;
  const created = ev('registration');
  const expires = ev('expiration');
  const now = Date.now();
  return {
    registrar,
    created, expires, updated: ev('last changed') || ev('last update of RDAP database'),
    ageDays: created ? Math.floor((now - Date.parse(created)) / 864e5) : null,
    daysLeft: expires ? Math.floor((Date.parse(expires) - now) / 864e5) : null,
    status: j.status || [],
    // Trailing dots dropped; registry placeholders such as "not.defined" left out.
    nameservers: [...new Set((j.nameservers || []).map((n) => (n.ldhName || '').toLowerCase().replace(/\.$/, '')).filter((n) => n && !/^not\.defined$/.test(n)))],
    dnssec: j.secureDNS ? !!j.secureDNS.delegationSigned : null,
  };
}

// ---------- SSL certificate (from Certificate Transparency logs) ----------
export async function sslFromCT(host) {
  const list = await getJson(`https://crt.sh/?q=${encodeURIComponent(host)}&output=json&exclude=expired`, { ms: 30000, max: 10_000_000 });
  const base = host.split('.').slice(1).join('.');
  const match = list.filter((c) => String(c.name_value).split(/\s+/).some((n) => n.toLowerCase() === host || n.toLowerCase() === '*.' + base));
  if (!match.length) return null;
  match.sort((a, b) => String(b.not_before).localeCompare(String(a.not_before)));
  const c = match[0];
  const until = Date.parse(c.not_after + (/Z$/.test(c.not_after) ? '' : 'Z'));
  const issuer = (String(c.issuer_name).match(/O=([^,]+)/) || [])[1] || (String(c.issuer_name).match(/CN=([^,]+)/) || [])[1] || c.issuer_name;
  return { issuer, from: String(c.not_before).slice(0, 10), until: String(c.not_after).slice(0, 10), daysLeft: Math.floor((until - Date.now()) / 864e5), names: String(c.name_value).split(/\s+/).slice(0, 10), count: match.length };
}

// ---------- Neighbours on the same IP (HackerTarget, free daily limit) ----------
export async function reverseIp(ip) {
  const r = await getText(`https://api.hackertarget.com/reverseiplookup/?q=${encodeURIComponent(ip)}`, { ms: 15000, max: 2_000_000 });
  const text = r.text.trim();
  if (!r.ok || /error|API count|exceeded|invalid/i.test(text.slice(0, 120))) throw new Error(text.slice(0, 120) || 'HTTP ' + r.status);
  const hosts = text.split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.includes(' '));
  return { hosts: hosts.slice(0, 500), total: hosts.length };
}

// ---------- The same name in other zones (free or taken) ----------
export const ZONES = ['com', 'net', 'org', 'ru', 'uz', 'kz', 'by', 'ua', 'su', 'рф', 'io', 'co', 'ai', 'app', 'dev', 'info', 'biz', 'online', 'store', 'shop', 'site', 'pro', 'me', 'eu', 'de', 'pl', 'tr'];
export async function otherZones(base) {
  const label = base.split('.')[0];
  const current = base.slice(label.length + 1);
  const zones = ZONES.filter((z) => z !== current);
  const rows = await Promise.all(zones.map(async (z) => {
    const name = `${label}.${z}`;
    try {
      const r = await doh(name, 'NS');
      return { name, state: r.status === 3 ? 'free' : r.answers.length ? 'taken' : r.status === 0 ? 'taken' : 'unknown' };
    } catch { return { name, state: 'unknown' }; }
  }));
  return { label, rows };
}
