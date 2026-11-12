// Check history in chrome.storage.local: small snapshots (no HTML), last 5 per URL,
// at most 300 URLs (the oldest are dropped). Used for "changes since the last check".

const PER_URL = 5;
const MAX_URLS = 300;
const INDEX = 'hist_index';
const key = (url) => 'hist:' + url;
const normUrl = (u) => { try { const x = new URL(u); x.hash = ''; return x.href; } catch { return u; } };

export function snapshot(report, res) {
  const d = res.d;
  return {
    at: new Date().toISOString(),
    url: normUrl(report.url),
    score: res.score,
    status: d.status ?? null,
    title: d.title.text || '',
    description: d.desc.text || '',
    h1: (d.h1 || []).join(' | '),
    canonical: (report.head.canonicals[0] || {}).href || '',
    robots: (d.directives.all || []).map((x) => `${x.name}: ${x.content}`).join('; '),
    indexable: d.summary.indexable,
    words: report.text.mainWords,
    links: report.links.total,
    images: report.images.total,
    lcp: report.perf.lcp ?? null,
    cls: report.perf.cls ?? null,
    jsShare: d.jsdiff && d.jsdiff.ok ? d.jsdiff.share : null,
    schema: (d.schemaTypes || []).map((t) => t.type).sort().join(', '),
    xRobots: (d.headers || []).filter((h) => h.name === 'x-robots-tag').map((h) => h.value).join(', '),
    issues: res.issues.filter((i) => !i.extra).map((i) => ({ id: i.id, sev: i.sev, group: i.group, params: i.params })),
  };
}

export async function lastSnapshot(url) {
  const k = key(normUrl(url));
  try { const got = await chrome.storage.local.get(k); const list = got[k] || []; return list[list.length - 1] || null; } catch { return null; }
}

export async function listSnapshots(url) {
  const k = key(normUrl(url));
  try { const got = await chrome.storage.local.get(k); return got[k] || []; } catch { return []; }
}

export async function saveSnapshot(snap) {
  const k = key(snap.url);
  try {
    const got = await chrome.storage.local.get([k, INDEX]);
    const list = (got[k] || []).concat(snap).slice(-PER_URL);
    let index = (got[INDEX] || []).filter((x) => x.url !== snap.url);
    index.push({ url: snap.url, at: snap.at });
    const drop = index.length > MAX_URLS ? index.slice(0, index.length - MAX_URLS) : [];
    index = index.slice(-MAX_URLS);
    await chrome.storage.local.set({ [k]: list, [INDEX]: index });
    if (drop.length) await chrome.storage.local.remove(drop.map((x) => key(x.url)));
  } catch { /* quota or storage off: history is best-effort */ }
}

export async function clearHistory() {
  const got = await chrome.storage.local.get(INDEX).catch(() => ({}));
  const keys = (got[INDEX] || []).map((x) => key(x.url));
  await chrome.storage.local.remove([...keys, INDEX]).catch(() => {});
}

export async function historyUsage() {
  try {
    const got = await chrome.storage.local.get(INDEX);
    const bytes = await chrome.storage.local.getBytesInUse(null);
    return { urls: (got[INDEX] || []).length, bytes, quota: chrome.storage.local.QUOTA_BYTES || 10485760 };
  } catch { return { urls: 0, bytes: 0, quota: 10485760 }; }
}

const FIELDS = ['status', 'indexable', 'title', 'description', 'h1', 'canonical', 'robots', 'xRobots', 'schema', 'score', 'words', 'links', 'images', 'jsShare'];
export function diffSnapshots(prev, cur) {
  if (!prev) return null;
  const changes = [];
  for (const f of FIELDS) {
    const a = prev[f]; const b = cur[f];
    if (a === undefined) continue;
    if (String(a ?? '') !== String(b ?? '')) changes.push({ field: f, before: a, after: b });
  }
  const sig = (i) => i.id + '|' + JSON.stringify(i.params || {});
  const prevSet = new Map(prev.issues.map((i) => [i.id, i]));
  const curSet = new Map(cur.issues.map((i) => [i.id, i]));
  const added = cur.issues.filter((i) => !prevSet.has(i.id));
  const fixed = prev.issues.filter((i) => !curSet.has(i.id));
  const changedIssues = cur.issues.filter((i) => prevSet.has(i.id) && sig(prevSet.get(i.id)) !== sig(i));
  return { at: prev.at, changes, added, fixed, changedIssues };
}
