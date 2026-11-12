// Text analysis: tokens, stop-words, light stemming (RU/EN), frequency, focus keyword.

const RU_STOP = 'и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее её мне было вот от меня еще ещё нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее неё сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между это также при который которые которая которых которое весь свой своей наш наши ваш ваши также либо будут если очень является являются'.split(' ');
const EN_STOP = 'a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with you your yours yourself yourselves also get got may might must would one two new use used using via per'.split(' ');

export const STOP = new Set([...RU_STOP, ...EN_STOP]);

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

export function tokens(text) {
  return (String(text || '').toLowerCase().replace(/ё/g, 'е').match(WORD) || [])
    .map((w) => w.replace(/^[-'’]+|[-'’]+$/g, ''))
    .filter(Boolean);
}

const RU_END = ['иями', 'ями', 'ами', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ией', 'ий', 'ый', 'ой', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ую', 'юю', 'ом', 'ем', 'ам', 'ям', 'ах', 'ях', 'ия', 'ье', 'ья', 'ов', 'ев', 'ей', 'ию', 'ии', 'ть', 'ться', 'тся', 'ешь', 'ет', 'ут', 'ют', 'ит', 'ат', 'ят', 'ла', 'ло', 'ли', 'ал', 'ил', 'ы', 'и', 'а', 'я', 'о', 'е', 'у', 'ю', 'ь', 'й'];
RU_END.sort((a, b) => b.length - a.length);

export function stem(w) {
  if (/[а-я]/.test(w)) {
    if (w.length <= 3) return w;
    for (const e of RU_END) {
      if (w.endsWith(e) && w.length - e.length >= 3) return w.slice(0, -e.length);
    }
    return w;
  }
  if (/^[a-z]/.test(w)) {
    if (w.length <= 3) return w;
    return w.replace(/(ingly|edly|ing|ed|ies|es|s|ly)$/, (m) => (w.length - m.length >= 3 ? (m === 'ies' ? 'y' : '') : m));
  }
  return w;
}

export function frequency(text, { extraStop = [], useStop = true, top = 30 } = {}) {
  const extra = new Set(extraStop.map((s) => s.toLowerCase().replace(/ё/g, 'е')));
  const toks = tokens(text);
  const total = toks.length;
  const isStop = (w) => (useStop && (STOP.has(w) || extra.has(w))) || w.length < 3 || /^\d+$/.test(w);
  const words = new Map();
  const forms = new Map();
  toks.forEach((w) => {
    if (isStop(w)) return;
    const s = stem(w);
    words.set(s, (words.get(s) || 0) + 1);
    if (!forms.has(s)) forms.set(s, new Map());
    const f = forms.get(s); f.set(w, (f.get(w) || 0) + 1);
  });
  const bi = new Map();
  for (let i = 0; i < toks.length - 1; i++) {
    const a = toks[i]; const b = toks[i + 1];
    if (isStop(a) || isStop(b)) continue;
    const k = a + ' ' + b;
    bi.set(k, (bi.get(k) || 0) + 1);
  }
  const label = (s) => [...forms.get(s).entries()].sort((x, y) => y[1] - x[1])[0][0];
  const topWords = [...words.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
    .map(([s, n]) => ({ word: label(s), stem: s, count: n, pct: total ? (n / total) * 100 : 0 }));
  const topBi = [...bi.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, top)
    .map(([w, n]) => ({ word: w, count: n, pct: total ? (n / total) * 100 : 0 }));
  return { total, topWords, topBi };
}

export function stemsOf(text) {
  return tokens(text).filter((w) => !STOP.has(w)).map(stem);
}

// Shared meaningful words between two strings (by stem).
export function sharedWords(a, b) {
  const sa = new Map();
  tokens(a).filter((w) => !STOP.has(w) && w.length > 2).forEach((w) => sa.set(stem(w), w));
  const out = [];
  const seen = new Set();
  tokens(b).filter((w) => !STOP.has(w) && w.length > 2).forEach((w) => {
    const s = stem(w);
    if (sa.has(s) && !seen.has(s)) { seen.add(s); out.push(sa.get(s)); }
  });
  return out;
}

export function coverage(source, target) {
  const src = [...new Set(stemsOf(source).filter((s) => s.length > 2))];
  if (!src.length) return { total: 0, found: 0, missing: [] };
  const tgt = new Set(stemsOf(target));
  const missing = src.filter((s) => !tgt.has(s));
  return { total: src.length, found: src.length - missing.length, missing };
}

const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const translit = (s) => s.split('').map((c) => (TR[c] !== undefined ? TR[c] : c)).join('');

function phraseCount(toks, phraseStems) {
  if (!phraseStems.length) return 0;
  const st = toks.map(stem);
  let n = 0;
  for (let i = 0; i + phraseStems.length <= st.length; i++) {
    let ok = true;
    for (let j = 0; j < phraseStems.length; j++) if (st[i + j] !== phraseStems[j]) { ok = false; break; }
    if (ok) n++;
  }
  return n;
}

function containsPhrase(text, phraseStems) {
  if (!text) return false;
  return phraseCount(tokens(text), phraseStems) > 0;
}

export function focusKeyword(kw, ctx) {
  const phraseStems = tokens(kw).map(stem);
  if (!phraseStems.length) return null;
  const mainToks = tokens(ctx.mainText);
  const count = phraseCount(mainToks, phraseStems);
  const density = mainToks.length ? (count * phraseStems.length / mainToks.length) * 100 : 0;
  let path = '';
  try { path = decodeURIComponent(new URL(ctx.url).pathname).toLowerCase(); } catch { path = ''; }
  const slugWords = path.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const kwLat = tokens(kw).map(translit);
  const inUrl = phraseStems.every((s, i) => slugWords.some((w) => stem(w) === s || w.startsWith(kwLat[i].slice(0, Math.max(3, kwLat[i].length - 2)))));
  const checks = [
    { id: 'title', ok: containsPhrase(ctx.title, phraseStems), weight: 25 },
    { id: 'h1', ok: ctx.h1.some((h) => containsPhrase(h, phraseStems)), weight: 20 },
    { id: 'description', ok: containsPhrase(ctx.description, phraseStems), weight: 15 },
    { id: 'url', ok: inUrl, weight: 10 },
    { id: 'firstParagraph', ok: containsPhrase(ctx.firstParagraph, phraseStems), weight: 10 },
    { id: 'alt', ok: ctx.alts.some((a) => containsPhrase(a, phraseStems)), weight: 5 },
    { id: 'h2', ok: ctx.h2.some((h) => containsPhrase(h, phraseStems)), weight: 5 },
  ];
  const densityOk = density >= 0.5 && density <= 3;
  checks.push({ id: 'density', ok: densityOk, weight: 10 });
  const score = checks.reduce((a, c) => a + (c.ok ? c.weight : 0), 0);
  return { count, density, checks, score };
}
