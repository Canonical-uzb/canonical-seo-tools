// robots.txt parsing and matching (RFC 9309 + Google/Yandex conventions).

export const BOTS = [
  { id: 'googlebot', label: 'Googlebot', token: 'googlebot', metaNames: ['robots', 'googlebot'] },
  { id: 'yandex', label: 'YandexBot', token: 'yandex', metaNames: ['robots', 'yandex', 'yandexbot'] },
  { id: 'bingbot', label: 'Bingbot', token: 'bingbot', metaNames: ['robots', 'bingbot', 'msnbot'] },
  { id: '*', label: '* (все)', token: '*', metaNames: ['robots'] },
];

// AI crawlers: closing them keeps content out of generative answers (ChatGPT, Claude, Perplexity, AI Overviews, Yandex Neuro).
export const AI_BOTS = [
  { label: 'GPTBot (OpenAI)', token: 'gptbot' },
  { label: 'OAI-SearchBot (ChatGPT Search)', token: 'oai-searchbot' },
  { label: 'ChatGPT-User', token: 'chatgpt-user' },
  { label: 'ClaudeBot (Anthropic)', token: 'claudebot' },
  { label: 'Claude-SearchBot', token: 'claude-searchbot' },
  { label: 'PerplexityBot', token: 'perplexitybot' },
  { label: 'Google-Extended (Gemini)', token: 'google-extended' },
  { label: 'Applebot-Extended', token: 'applebot-extended' },
  { label: 'YandexAdditional (Нейро)', token: 'yandexadditional' },
  { label: 'CCBot (Common Crawl)', token: 'ccbot' },
  { label: 'Bytespider (ByteDance)', token: 'bytespider' },
  { label: 'anthropic-ai', token: 'anthropic-ai' },
  { label: 'Claude-User', token: 'claude-user' },
  { label: 'Perplexity-User', token: 'perplexity-user' },
  { label: 'GoogleOther', token: 'googleother' },
  { label: 'Applebot (Siri, Spotlight)', token: 'applebot' },
  { label: 'Meta-ExternalAgent', token: 'meta-externalagent' },
  { label: 'FacebookBot', token: 'facebookbot' },
  { label: 'Amazonbot', token: 'amazonbot' },
  { label: 'DuckAssistBot', token: 'duckassistbot' },
  { label: 'MistralAI-User', token: 'mistralai-user' },
  { label: 'cohere-ai', token: 'cohere-ai' },
  { label: 'YouBot (You.com)', token: 'youbot' },
  { label: 'Diffbot', token: 'diffbot' },
  { label: 'PetalBot (Huawei)', token: 'petalbot' },
  { label: 'ImagesiftBot', token: 'imagesiftbot' },
  { label: 'Timpibot', token: 'timpibot' },
];

export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  const other = [];
  let current = null;
  let lastWasAgent = false;
  (text || '').split(/\r?\n/).forEach((rawLine, i) => {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) return;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) return;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [], line: i + 1 }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      return;
    }
    lastWasAgent = false;
    if (key === 'sitemap') { sitemaps.push(value); return; }
    if ((key === 'allow' || key === 'disallow') && current) {
      current.rules.push({ type: key, value, line: i + 1, raw: rawLine.trim() });
      return;
    }
    if (current && ['crawl-delay', 'clean-param', 'host'].includes(key)) {
      current.rules.push({ type: key, value, line: i + 1, raw: rawLine.trim(), meta: true });
      return;
    }
    other.push({ key, value, line: i + 1 });
  });
  return { groups, sitemaps, other };
}

function groupsFor(parsed, token) {
  const t = token.toLowerCase();
  if (t !== '*') {
    const exact = parsed.groups.filter((g) => g.agents.some((a) => a !== '*' && (a === t || t.startsWith(a) || a.startsWith(t))));
    if (exact.length) return { groups: exact, agent: exact[0].agents.find((a) => a !== '*') };
  }
  const star = parsed.groups.filter((g) => g.agents.includes('*'));
  return { groups: star, agent: star.length ? '*' : null };
}

function patternToRegex(p) {
  let s = p.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  if (s.endsWith('\\$')) s = s.slice(0, -2) + '$';
  else if (s.endsWith('$') && !s.endsWith('\\$')) { /* already anchored */ }
  return new RegExp('^' + s);
}

function decodePath(path) {
  try { return decodeURI(path); } catch { return path; }
}

// Returns { allowed, rule|null, agent|null, groupsFound }
export function matchRobots(parsed, token, url) {
  let u;
  try { u = new URL(url); } catch { return { allowed: true, rule: null, agent: null, groupsFound: false }; }
  const path = u.pathname + u.search;
  if (u.pathname === '/robots.txt') return { allowed: true, rule: null, agent: null, groupsFound: true };
  const { groups, agent } = groupsFor(parsed, token);
  if (!groups.length) return { allowed: true, rule: null, agent: null, groupsFound: false };
  let best = null;
  const candidates = [path, decodePath(path)];
  for (const g of groups) {
    for (const r of g.rules) {
      if (r.meta) continue;
      if (r.value === '') continue; // empty Disallow allows everything
      const re = patternToRegex(r.value);
      if (candidates.some((c) => re.test(c))) {
        const len = r.value.length;
        if (!best || len > best.len || (len === best.len && r.type === 'allow' && best.rule.type === 'disallow')) {
          best = { len, rule: r };
        }
      }
    }
  }
  return {
    allowed: !best || best.rule.type === 'allow',
    rule: best ? best.rule : null,
    agent,
    groupsFound: true,
    meta: groups.flatMap((g) => g.rules.filter((r) => r.meta)),
  };
}

export function isAllowedQuick(parsed, token, url) {
  return matchRobots(parsed, token, url).allowed;
}
