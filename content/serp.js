// Canonical — search results helper for Google and Yandex.
// Numbers organic results (continuing across pages), marks Yandex ads, and adds a small
// toolbar to copy result links. Injected by the service worker on search pages.
(() => {
  if (globalThis.__seoLensSerp) { globalThis.__seoLensSerp.refresh(); return; }

  const host = location.hostname;
  const isGoogle = /(^|\.)google\.[a-z.]+$/i.test(host);
  const isYandex = /(^|\.)(yandex\.[a-z.]+|ya\.ru)$/i.test(host);
  if (!isGoogle && !isYandex) return;

  const ru = (chrome.i18n.getUILanguage() || '').toLowerCase().startsWith('ru');
  const L = ru
    ? { results: 'результатов', copy: 'Ссылки', copyFull: 'Ссылки + заголовки', copied: 'Скопировано', hide: 'Скрыть', ad: 'Реклама', none: 'Результаты не найдены' }
    : { results: 'results', copy: 'Links', copyFull: 'Links + titles', copied: 'Copied', hide: 'Hide', ad: 'Ad', none: 'No results found' };

  let cfg = { serpGoogle: false, serpYandex: false, serpAds: true, serpToolbar: true };
  let results = [];

  const STYLE = `
    .seolens-pos{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:20px;margin-right:8px;padding:0 5px;border-radius:5px;background:#0a6f9c;color:#fff !important;font:600 12px/20px system-ui,sans-serif !important;vertical-align:middle;text-decoration:none !important}
    .seolens-ad{outline:2px dashed #d35400 !important;outline-offset:4px;border-radius:6px;background:rgba(211,84,0,.06) !important;position:relative}
    .seolens-ad-label{display:inline-block;margin:0 0 4px;padding:1px 6px;border-radius:4px;background:#d35400;color:#fff;font:600 11px/1.5 system-ui,sans-serif}
    #seolens-serpbar{position:fixed;right:16px;bottom:16px;z-index:2147483646;display:flex;gap:6px;align-items:center;background:#fff;color:#18211d;border:1px solid #cfd8d4;border-radius:10px;padding:7px 8px 7px 10px;box-shadow:0 6px 20px rgba(0,0,0,.18);font:13px/1.3 system-ui,sans-serif}
    #seolens-serpbar b{color:#0a6f9c}
    #seolens-serpbar button{font:600 12px system-ui,sans-serif;border:1px solid #0a6f9c;background:#0a6f9c;color:#fff;border-radius:7px;padding:5px 9px;cursor:pointer}
    #seolens-serpbar button.ghost{background:transparent;color:#0a6f9c}
    #seolens-serpbar button.x{border:0;background:transparent;color:#5d6a64;padding:2px 4px;font-size:15px}
    @media (prefers-color-scheme: dark){#seolens-serpbar{background:#1a201d;color:#e3eae6;border-color:#2d3732}#seolens-serpbar b{color:#4fc3a8}}
  `;

  function ensureStyle() {
    if (document.getElementById('seolens-serp-style')) return;
    const st = document.createElement('style');
    st.id = 'seolens-serp-style';
    st.textContent = STYLE;
    (document.head || document.documentElement).appendChild(st);
  }

  const param = (k) => new URLSearchParams(location.search).get(k);

  function cleanGoogleHref(href) {
    try {
      const u = new URL(href);
      if (/google\./.test(u.hostname) && u.pathname === '/url') return u.searchParams.get('q') || u.searchParams.get('url') || href;
    } catch { /* keep */ }
    return href;
  }

  function googleResults() {
    const out = [];
    const seen = new Set();
    document.querySelectorAll('#search a h3, #rso a h3, #botstuff a h3').forEach((h3) => {
      const a = h3.closest('a');
      if (!a || !a.href) return;
      if (a.closest('#tads, #tadsb, #bottomads, [data-text-ad], [aria-label="Ads"], [aria-label="Реклама"]')) return;
      const url = cleanGoogleHref(a.href);
      if (!/^https?:/i.test(url) || seen.has(url)) return;
      try { if (/(^|\.)google\.[a-z.]+$/.test(new URL(url).hostname)) return; } catch { return; }
      seen.add(url);
      out.push({ titleEl: h3, url, title: h3.textContent.replace(/\s+/g, ' ').trim() });
    });
    return out;
  }

  function isYandexAd(item) {
    if (item.querySelector('.serp-item__label, .AdvLabel, .organic__label_type_adv, [class*="AdvLabel"], [data-fast-name="direct"]')) return true;
    if ((item.getAttribute('data-fast-name') || '') === 'direct') return true;
    const labels = item.querySelectorAll('span, div');
    for (let i = 0; i < labels.length && i < 400; i++) {
      const e = labels[i];
      if (e.childElementCount) continue;
      const tx = e.textContent.trim().toLowerCase();
      if (tx === 'реклама' || tx === 'ad' || tx === 'промо') return true;
    }
    return false;
  }

  function yandexItems() {
    const list = document.querySelectorAll('#search-result > li, .serp-list > li.serp-item, li.serp-item');
    const items = [];
    const seen = new Set();
    list.forEach((li) => { if (!seen.has(li)) { seen.add(li); items.push(li); } });
    return items;
  }

  function yandexResults(ads) {
    const out = [];
    const seen = new Set();
    yandexItems().forEach((item) => {
      if (isYandexAd(item)) { ads.push(item); return; }
      const a = item.querySelector('a.OrganicTitle-Link, a.organic__url, h2 a[href], a.Link[href][target]');
      if (!a || !a.href) return;
      let url = a.href;
      try {
        const u = new URL(url);
        if (/(^|\.)(yandex\.[a-z.]+|ya\.ru)$/.test(u.hostname)) return; // wizards and internal blocks
      } catch { return; }
      if (seen.has(url)) return;
      seen.add(url);
      const titleEl = item.querySelector('h2, .OrganicTitle-LinkText, .organic__title') || a;
      out.push({ titleEl, url, title: titleEl.textContent.replace(/\s+/g, ' ').trim() });
    });
    return out;
  }

  function offset() {
    if (isGoogle) return parseInt(param('start') || '0', 10) || 0;
    const p = parseInt(param('p') || '0', 10) || 0;
    const per = parseInt(param('numdoc') || '10', 10) || 10;
    return p * per;
  }

  function clear() {
    document.querySelectorAll('.seolens-pos, .seolens-ad-label').forEach((e) => e.remove());
    document.querySelectorAll('.seolens-ad').forEach((e) => e.classList.remove('seolens-ad'));
  }

  function enabled() {
    return (isGoogle && cfg.serpGoogle) || (isYandex && cfg.serpYandex);
  }

  function refresh() {
    observer.disconnect();
    clear();
    if (!enabled()) { removeBar(); observe(); return; }
    ensureStyle();
    const ads = [];
    results = isGoogle ? googleResults() : yandexResults(ads);
    const start = offset();
    results.forEach((r, i) => {
      const b = document.createElement('span');
      b.className = 'seolens-pos';
      b.textContent = String(start + i + 1);
      r.titleEl.prepend(b);
    });
    if (isYandex && cfg.serpAds) {
      ads.forEach((item) => {
        item.classList.add('seolens-ad');
        const lab = document.createElement('div');
        lab.className = 'seolens-ad-label';
        lab.textContent = L.ad;
        item.prepend(lab);
      });
    }
    if (cfg.serpToolbar) renderBar(); else removeBar();
    observe();
  }

  function removeBar() { const b = document.getElementById('seolens-serpbar'); if (b) b.remove(); }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    const old = btn.textContent;
    btn.textContent = L.copied;
    setTimeout(() => { btn.textContent = old; }, 1400);
  }

  function renderBar() {
    let bar = document.getElementById('seolens-serpbar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'seolens-serpbar';
      document.documentElement.appendChild(bar);
    }
    bar.replaceChildren();
    const label = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = 'Canonical';
    label.append(b, ` · ${results.length} ${L.results}`);
    const mk = (text, cls, fn) => { const x = document.createElement('button'); x.type = 'button'; x.textContent = text; if (cls) x.className = cls; x.addEventListener('click', () => fn(x)); return x; };
    const start = offset();
    bar.append(
      label,
      mk(L.copy, '', (btn) => copyText(results.map((r) => r.url).join('\n'), btn)),
      mk(L.copyFull, 'ghost', (btn) => copyText(results.map((r, i) => `${start + i + 1}\t${r.title}\t${r.url}`).join('\n'), btn)),
      mk('×', 'x', () => removeBar()),
    );
    bar.lastChild.title = L.hide;
  }

  let timer;
  const observer = new MutationObserver((muts) => {
    if (muts.every((m) => [...m.addedNodes].every((n) => n.nodeType === 1 && (n.classList.contains('seolens-pos') || n.id === 'seolens-serpbar' || n.classList.contains('seolens-ad-label'))))) return;
    clearTimeout(timer);
    timer = setTimeout(refresh, 600);
  });
  function observe() {
    const root = document.querySelector('#search, #rso, #botstuff, .main__content, .content__left, #search-result') ? document.body : document.documentElement;
    observer.observe(root, { childList: true, subtree: true });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) { Object.assign(cfg, pick(changes.settings.newValue || {})); refresh(); }
  });

  function pick(s) {
    const o = {};
    for (const k of ['serpGoogle', 'serpYandex', 'serpAds', 'serpToolbar']) if (typeof s[k] === 'boolean') o[k] = s[k];
    return o;
  }

  globalThis.__seoLensSerp = { refresh, results: () => results };
  chrome.storage.sync.get('settings').then((got) => { Object.assign(cfg, pick(got.settings || {})); refresh(); }).catch(() => refresh());
})();
