// Canonical — page collector. Injected on demand by the side panel.
// Reads the page (never sends it anywhere), fetches same-origin robots.txt, sitemap and the raw HTML,
// and draws highlights. Output is a plain JSON object; the panel does all scoring.
(() => {
  if (globalThis.__seoLens) return;

  const LIMITS = { links: 5000, images: 2000, text: 300000, bg: 3000, raw: 3_000_000 };
  const state = { lcp: null, lcpEl: null, cls: 0, clsWindows: [], inp: null, interactions: new Map() };

  // ---------- Core Web Vitals (buffered observers keep running between collects) ----------
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        state.lcp = e.startTime;
        state.lcpEl = e.element ? describe(e.element) : (e.url || null);
        state.lcpLazy = !!(e.element && e.element.tagName === 'IMG' && (e.element.getAttribute('loading') || '').toLowerCase() === 'lazy');
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch { /* unsupported */ }
  try {
    let win = { value: 0, first: 0, last: 0 };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        if (win.value && (e.startTime - win.last < 1000) && (e.startTime - win.first < 5000)) {
          win.value += e.value; win.last = e.startTime;
        } else {
          win = { value: e.value, first: e.startTime, last: e.startTime };
        }
        state.cls = Math.max(state.cls, win.value);
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch { /* unsupported */ }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!e.interactionId) continue;
        const prev = state.interactions.get(e.interactionId) || 0;
        state.interactions.set(e.interactionId, Math.max(prev, e.duration));
      }
      const d = [...state.interactions.values()].sort((a, b) => b - a);
      if (d.length) state.inp = d[Math.min(d.length - 1, Math.floor(d.length / 50))];
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
  } catch { /* unsupported */ }

  function describe(el) {
    if (!el || !el.tagName) return null;
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (el.classList && el.classList.length) s += '.' + [...el.classList].slice(0, 2).join('.');
    return s;
  }

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch { return u || ''; } };
  const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;
  const countWords = (t) => (t.match(WORD) || []).length;

  async function timedFetch(url, opts = {}, ms = 8000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: ctl.signal });
    } finally { clearTimeout(timer); }
  }

  // Fetch + read the body with one timeout and a byte cap: a huge or endless response
  // is cut off instead of filling memory.
  async function fetchLimited(url, opts = {}, ms = 10000, maxBytes = 3_000_000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const res = await fetch(url, { ...opts, signal: ctl.signal });
      let text = '';
      if (res.body) {
        const reader = res.body.getReader();
        const chunks = []; let size = 0;
        while (size < maxBytes) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value); size += value.length;
        }
        try { await reader.cancel(); } catch { /* ignore */ }
        const all = new Uint8Array(Math.min(size, maxBytes)); let off = 0;
        for (const c of chunks) { const part = c.subarray(0, all.length - off); all.set(part, off); off += part.length; if (off >= all.length) break; }
        const cs = ((res.headers.get('content-type') || '').match(/charset=([\w-]+)/i) || [])[1] || document.characterSet || 'utf-8';
        try { text = new TextDecoder(cs).decode(all); } catch { text = new TextDecoder().decode(all); }
        res.truncated = size >= maxBytes;
      }
      return { res, text };
    } finally { clearTimeout(timer); }
  }

  function headerList(res) {
    const out = [];
    res.headers.forEach((value, name) => out.push({ name: name.toLowerCase(), value }));
    return out;
  }

  // ---------- head ----------
  function metaByName(name) {
    return [...document.querySelectorAll('meta[name]')].filter((m) => m.getAttribute('name').toLowerCase() === name);
  }
  function metaContent(name) { const m = metaByName(name)[0]; return m ? clean(m.getAttribute('content')) : null; }
  function metaProp(prefix) {
    const out = {};
    document.querySelectorAll('meta[property], meta[name]').forEach((m) => {
      const k = (m.getAttribute('property') || m.getAttribute('name') || '').toLowerCase();
      if (k.startsWith(prefix)) {
        const v = clean(m.getAttribute('content'));
        if (out[k] === undefined) out[k] = v; else if (Array.isArray(out[k])) out[k].push(v); else out[k] = [out[k], v];
      }
    });
    return out;
  }

  function collectHead() {
    const titles = [...document.querySelectorAll('title')]
      .filter((t) => !t.closest('svg'))
      .map((t) => ({ text: clean(t.textContent), inHead: !!t.closest('head') }));
    const descriptions = metaByName('description').map((m) => ({
      text: clean(m.getAttribute('content')), inHead: !!m.closest('head'),
    }));
    const robotsNames = ['robots', 'googlebot', 'googlebot-news', 'yandex', 'yandexbot', 'bingbot', 'msnbot'];
    const robotsMeta = [...document.querySelectorAll('meta[name]')]
      .filter((m) => robotsNames.includes(m.getAttribute('name').toLowerCase()))
      .map((m) => ({ name: m.getAttribute('name').toLowerCase(), content: clean(m.getAttribute('content')), inHead: !!m.closest('head') }));
    const canonicals = [...document.querySelectorAll('link[rel]')]
      .filter((l) => l.getAttribute('rel').toLowerCase().split(/\s+/).includes('canonical'))
      .map((l) => ({ raw: l.getAttribute('href') || '', href: abs(l.getAttribute('href') || ''), inHead: !!l.closest('head') }));
    const hreflang = [...document.querySelectorAll('link[rel][hreflang]')]
      .filter((l) => l.getAttribute('rel').toLowerCase().split(/\s+/).includes('alternate'))
      .map((l) => ({ lang: l.getAttribute('hreflang'), raw: l.getAttribute('href') || '', href: abs(l.getAttribute('href') || ''), inHead: !!l.closest('head') }));
    const icons = [...document.querySelectorAll('link[rel]')]
      .filter((l) => /(^|\s)(icon|shortcut icon|apple-touch-icon|apple-touch-icon-precomposed)(\s|$)/i.test(l.getAttribute('rel')))
      .map((l) => ({ rel: l.getAttribute('rel').toLowerCase(), href: abs(l.getAttribute('href') || ''), sizes: l.getAttribute('sizes') || '' }));
    const charsetEl = document.querySelector('meta[charset]');
    const httpEquivCt = [...document.querySelectorAll('meta[http-equiv]')].find((m) => m.getAttribute('http-equiv').toLowerCase() === 'content-type');
    const publisherLink = [...document.querySelectorAll('link[rel]')].find((l) => l.getAttribute('rel').toLowerCase() === 'publisher');
    const relLink = (r) => { const l = [...document.querySelectorAll('link[rel]')].find((x) => x.getAttribute('rel').toLowerCase().split(/\s+/).includes(r)); return l ? abs(l.getAttribute('href')) : null; };
    const feeds = [...document.querySelectorAll('link[rel~="alternate"][type]')]
      .filter((l) => /rss|atom/i.test(l.getAttribute('type')))
      .map((l) => ({ type: l.getAttribute('type'), href: abs(l.getAttribute('href') || ''), title: l.getAttribute('title') || '' }));
    return {
      titles,
      descriptions,
      author: metaContent('author'),
      publisher: metaContent('publisher') || (publisherLink ? abs(publisherLink.getAttribute('href')) : null),
      generator: metaByName('generator').map((m) => clean(m.getAttribute('content'))),
      charset: charsetEl ? charsetEl.getAttribute('charset') : (httpEquivCt ? httpEquivCt.getAttribute('content') : null),
      documentCharset: document.characterSet,
      viewport: metaContent('viewport'),
      themeColor: metaContent('theme-color'),
      robotsMeta,
      canonicals,
      hreflang,
      icons,
      lang: document.documentElement.getAttribute('lang'),
      dir: document.documentElement.getAttribute('dir'),
      og: metaProp('og:'),
      twitter: metaProp('twitter:'),
      prev: relLink('prev'),
      next: relLink('next'),
      feeds,
      doctype: document.doctype ? document.doctype.name : null,
    };
  }

  // ---------- headings ----------
  function collectHeadings() {
    const out = [];
    document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h, i) => {
      h.setAttribute('data-seolens-h', String(i));
      const r = h.getBoundingClientRect();
      const st = getComputedStyle(h);
      out.push({
        idx: i,
        level: Number(h.tagName[1]),
        text: clean(h.textContent),
        hidden: st.display === 'none' || st.visibility === 'hidden' || (r.width === 0 && r.height === 0),
      });
    });
    return out;
  }

  // ---------- text ----------
  const SKIP = 'script,style,noscript,template,svg,iframe,canvas,[hidden],[aria-hidden="true"]';
  const CHROME = 'nav,header,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"],form';

  function textOf(root, skipChrome) {
    if (!root) return '';
    const parts = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || p.closest(SKIP)) return NodeFilter.FILTER_REJECT;
        if (skipChrome && p.closest(CHROME)) return NodeFilter.FILTER_REJECT;
        return n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let n; let len = 0;
    while ((n = walker.nextNode())) {
      parts.push(n.nodeValue);
      len += n.nodeValue.length;
      if (len > LIMITS.text) break;
    }
    return clean(parts.join(' '));
  }

  function collectText() {
    const candidates = [...document.querySelectorAll('main, [role="main"], article')];
    let mainRoot = null; let best = 0;
    for (const c of candidates) {
      const l = (c.textContent || '').length;
      if (l > best) { best = l; mainRoot = c; }
    }
    const mainText = mainRoot ? textOf(mainRoot, false) : textOf(document.body, true);
    const fullText = document.body ? clean(document.body.innerText || textOf(document.body, false)) : '';
    const paragraphs = [...(mainRoot || document.body || document.createElement('div')).querySelectorAll('p')]
      .map((p) => clean(p.textContent)).filter((t) => t.length > 40);
    return {
      mainSource: mainRoot ? describe(mainRoot) : 'body − nav/header/footer/aside',
      mainText,
      fullText: fullText.slice(0, LIMITS.text),
      firstParagraph: paragraphs[0] || '',
      paragraphs: paragraphs.slice(0, 400).map((p) => p.slice(0, 3000)),
      // Text blocks in reading order (for sentence analysis: block edges end sentences).
      blocks: [...(mainRoot || document.body || document.createElement('div')).querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, figcaption, td')]
        .filter((el) => !el.closest('nav, header, footer, aside, script, style, noscript') && !el.querySelector('p, li, h1, h2, h3, h4, h5, h6'))
        .map((el) => clean(el.textContent)).filter((x) => x.length > 2).slice(0, 1500).map((x) => x.slice(0, 3000)),
      mainWords: countWords(mainText),
      fullWords: countWords(fullText),
      mainChars: mainText.length,
      mainCharsNoSpaces: mainText.replace(/\s/g, '').length,
      fullChars: fullText.length,
      fullCharsNoSpaces: fullText.replace(/\s/g, '').length,
      htmlBytes: new Blob([document.documentElement.outerHTML]).size,
      selection: clean(String(window.getSelection ? window.getSelection() : '')),
    };
  }

  // ---------- links ----------
  function baseDomain(host) {
    const parts = host.replace(/^www\./, '').split('.');
    const two = ['co.uk', 'com.au', 'co.jp', 'com.br', 'com.ua', 'com.tr', 'co.kr', 'org.uk', 'com.ru', 'msk.ru', 'spb.ru'];
    const last2 = parts.slice(-2).join('.');
    return two.includes(last2) ? parts.slice(-3).join('.') : last2;
  }

  function collectLinks() {
    const here = location.hostname;
    const hereBase = baseDomain(here);
    const out = [];
    const anchors = document.querySelectorAll('a');
    for (let i = 0; i < anchors.length && out.length < LIMITS.links; i++) {
      const a = anchors[i];
      a.setAttribute('data-seolens-l', String(i));
      const raw = a.getAttribute('href');
      const href = raw == null ? null : abs(raw);
      let type = 'other'; let host = '';
      if (href) {
        try {
          const u = new URL(href);
          host = u.hostname;
          if (/^https?:$/.test(u.protocol)) {
            if (u.hostname === here) type = 'internal';
            else if (baseDomain(u.hostname) === hereBase) type = 'subdomain';
            else type = 'external';
          }
        } catch { /* invalid URL */ }
      }
      const img = a.querySelector('img');
      const text = clean(a.textContent);
      out.push({
        idx: i,
        raw,
        href,
        host,
        type,
        text,
        imgAlt: img ? (img.getAttribute('alt') || '') : null,
        title: a.getAttribute('title') || '',
        rel: (a.getAttribute('rel') || '').toLowerCase(),
        target: a.getAttribute('target') || '',
        ariaLabel: a.getAttribute('aria-label') || '',
        inNav: !!a.closest('nav,header,footer'),
      });
    }
    return { items: out, total: anchors.length };
  }

  // ---------- images ----------
  function formatOf(src) {
    if (!src) return '';
    if (src.startsWith('data:')) { const m = src.match(/^data:image\/([\w+.-]+)/i); return m ? m[1].toLowerCase() : 'data'; }
    const m = src.split('?')[0].split('#')[0].match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : '';
  }

  function collectImages() {
    const sizes = new Map();
    for (const e of performance.getEntriesByType('resource')) {
      sizes.set(e.name, { transfer: e.transferSize || 0, encoded: e.encodedBodySize || 0, decoded: e.decodedBodySize || 0 });
    }
    const dpr = window.devicePixelRatio || 1;
    const out = [];
    const imgs = document.querySelectorAll('img');
    for (let i = 0; i < imgs.length && out.length < LIMITS.images; i++) {
      const img = imgs[i];
      img.setAttribute('data-seolens-i', String(i));
      const src = img.currentSrc || abs(img.getAttribute('src') || img.getAttribute('data-src') || '');
      const r = img.getBoundingClientRect();
      const sz = sizes.get(src) || null;
      out.push({
        idx: i,
        src,
        alt: img.hasAttribute('alt') ? img.getAttribute('alt') : null,
        title: img.getAttribute('title'),
        attrW: img.getAttribute('width'),
        attrH: img.getAttribute('height'),
        naturalW: img.naturalWidth,
        naturalH: img.naturalHeight,
        renderW: Math.round(r.width),
        renderH: Math.round(r.height),
        top: Math.round(r.top + window.scrollY),
        vh: window.innerHeight,
        dpr,
        loading: (img.getAttribute('loading') || '').toLowerCase(),
        srcset: img.getAttribute('srcset') || (img.closest('picture') ? 'picture' : ''),
        inPicture: !!img.closest('picture'),
        inLink: !!img.closest('a'),
        complete: img.complete,
        broken: img.complete && img.naturalWidth === 0 && !!src,
        format: formatOf(src),
        bytes: sz ? (sz.encoded || sz.transfer || 0) : null,
      });
    }
    const bg = [];
    const all = document.body ? document.body.getElementsByTagName('*') : [];
    for (let i = 0; i < all.length && i < LIMITS.bg; i++) {
      const v = getComputedStyle(all[i]).backgroundImage;
      if (v && v !== 'none') {
        const m = [...v.matchAll(/url\(["']?(.*?)["']?\)/g)];
        for (const x of m) if (x[1] && !x[1].startsWith('data:image/svg')) bg.push({ src: abs(x[1]), el: describe(all[i]), format: formatOf(x[1]) });
      }
    }
    const svgInline = document.querySelectorAll('svg').length;
    return { items: out, total: imgs.length, background: bg.slice(0, 500), svgInline };
  }

  // ---------- structured data ----------
  function collectJsonLd() {
    return [...document.querySelectorAll('script[type="application/ld+json" i]')].map((s, i) => {
      const raw = s.textContent || '';
      try {
        return { idx: i, ok: true, data: JSON.parse(raw) };
      } catch (e) {
        return { idx: i, ok: false, error: String(e.message || e), snippet: raw.slice(0, 300) };
      }
    });
  }

  function microdataItem(el, depth) {
    const item = { type: (el.getAttribute('itemtype') || '').trim(), props: {} };
    if (depth > 6) return item;
    const walk = (node) => {
      for (const child of node.children) {
        if (child.hasAttribute('itemprop')) {
          const names = child.getAttribute('itemprop').trim().split(/\s+/);
          let value;
          if (child.hasAttribute('itemscope')) value = microdataItem(child, depth + 1);
          else if (child.hasAttribute('content')) value = child.getAttribute('content');
          else if (['A', 'LINK', 'AREA'].includes(child.tagName)) value = abs(child.getAttribute('href'));
          else if (['IMG', 'SOURCE', 'VIDEO', 'AUDIO', 'IFRAME', 'EMBED'].includes(child.tagName)) value = abs(child.getAttribute('src'));
          else if (child.tagName === 'META') value = child.getAttribute('content');
          else if (child.tagName === 'TIME') value = child.getAttribute('datetime') || clean(child.textContent);
          else value = clean(child.textContent).slice(0, 300);
          for (const n of names) (item.props[n] = item.props[n] || []).push(value);
          if (!child.hasAttribute('itemscope')) walk(child);
        } else if (!child.hasAttribute('itemscope')) {
          walk(child);
        }
      }
    };
    walk(el);
    return item;
  }

  function collectMicrodata() {
    return [...document.querySelectorAll('[itemscope]')]
      .filter((el) => !el.hasAttribute('itemprop'))
      .slice(0, 100)
      .map((el) => microdataItem(el, 0));
  }

  function collectRdfa() {
    return [...document.querySelectorAll('[typeof]')]
      .filter((el) => !el.parentElement || !el.parentElement.closest('[typeof]'))
      .slice(0, 100)
      .map((el) => {
        const props = {};
        el.querySelectorAll('[property]').forEach((p) => {
          const k = p.getAttribute('property');
          if (k.startsWith('og:') || k.startsWith('fb:') || k.startsWith('twitter:')) return;
          const v = p.getAttribute('content') || p.getAttribute('href') || p.getAttribute('src') || clean(p.textContent).slice(0, 300);
          (props[k] = props[k] || []).push(v);
        });
        return { type: el.getAttribute('typeof'), vocab: el.getAttribute('vocab') || '', props };
      });
  }

  // ---------- page-level technical extras ----------
  function collectExtras() {
    const out = {};
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0;
    };
    const bgOf = (el) => {
      for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
        const c = getComputedStyle(e).backgroundColor;
        if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c;
      }
      return 'rgb(255, 255, 255)';
    };
    // Hidden links to other sites outside menus: a classic sign of link spam or a hacked site.
    const hidden = [];
    const anchors = document.querySelectorAll('a[href]');
    for (let i = 0; i < anchors.length && i < 3000; i++) {
      const a = anchors[i];
      if (a.closest('nav,header,footer,[role=menu],[role=dialog],dialog,[aria-hidden=true] nav,details,template')) continue;
      let href; try { href = new URL(a.getAttribute('href'), location.href); } catch { continue; }
      if (!/^https?:$/.test(href.protocol) || baseDomain(href.hostname) === baseDomain(location.hostname)) continue;
      const cs = getComputedStyle(a);
      const r = a.getBoundingClientRect();
      let why = '';
      if (cs.display === 'none' || a.closest('[hidden]')) why = 'display:none';
      else if (cs.visibility === 'hidden') why = 'visibility:hidden';
      else if (parseFloat(cs.opacity) === 0) why = 'opacity:0';
      else if (parseFloat(cs.fontSize) < 2 && clean(a.textContent)) why = 'font-size:0';
      else if (r.right < -500 || r.bottom < -500 || r.left > document.documentElement.scrollWidth + 500) why = 'offscreen';
      else if (clean(a.textContent) && cs.color === bgOf(a)) why = 'color=background';
      else {
        // display:none on an ancestor
        let p = a.parentElement; while (p && p !== document.body) { if (getComputedStyle(p).display === 'none') { why = 'parent display:none'; break; } p = p.parentElement; }
      }
      if (why) hidden.push({ idx: Number(a.getAttribute('data-seolens-l')), href: href.href, text: clean(a.textContent).slice(0, 80), why });
    }
    out.hiddenLinks = hidden.slice(0, 200);
    // Clickable non-links: navigation via JS that bots can't follow.
    const fake = [];
    document.querySelectorAll('[onclick]').forEach((el) => {
      if (el.closest('a[href]')) return;
      const code = el.getAttribute('onclick') || '';
      if (/location(\.href)?\s*=|window\.open|location\.assign|location\.replace/.test(code)) fake.push({ tag: el.tagName.toLowerCase(), text: clean(el.textContent).slice(0, 80), code: code.slice(0, 120) });
    });
    document.querySelectorAll('[data-href],[data-url],[data-link]').forEach((el) => {
      if (el.tagName === 'A' || el.closest('a[href]') || fake.length > 200) return;
      const v = el.getAttribute('data-href') || el.getAttribute('data-url') || el.getAttribute('data-link');
      if (/^(https?:)?\/|^[\w-]+\//.test(v || '')) fake.push({ tag: el.tagName.toLowerCase(), text: clean(el.textContent).slice(0, 80), code: 'data-href="' + v.slice(0, 100) + '"' });
    });
    out.fakeLinks = fake.slice(0, 200);
    // Render-blocking resources in <head>.
    const head = document.head || document.createElement('head');
    out.blocking = {
      scripts: [...head.querySelectorAll('script[src]')].filter((s) => !s.async && !s.defer && s.type !== 'module' && !/json|template/i.test(s.type)).map((s) => s.src).slice(0, 100),
      styles: [...head.querySelectorAll('link[rel~="stylesheet"]')].filter((l) => !l.disabled && (!l.media || /all|screen/i.test(l.media))).map((l) => l.href).slice(0, 100),
    };
    // Mobile-ish checks on the current viewport.
    const de = document.documentElement;
    const vw = window.innerWidth;
    const overflowEls = [];
    if (de.scrollWidth > de.clientWidth + 2) {
      const all = document.body ? document.body.querySelectorAll('*') : [];
      for (let i = 0; i < all.length && overflowEls.length < 10 && i < 20000; i++) {
        const r = all[i].getBoundingClientRect();
        if (r.right > de.clientWidth + 2 && r.width > 0 && getComputedStyle(all[i]).position !== 'fixed') {
          if (!overflowEls.some((x) => all[i].contains(x.el) || x.el.contains(all[i]))) overflowEls.push({ el: all[i], tag: all[i].tagName.toLowerCase() + (all[i].className && typeof all[i].className === 'string' ? '.' + all[i].className.trim().split(/\s+/)[0] : ''), width: Math.round(r.right) });
        }
      }
    }
    let small = 0; let textEls = 0; const smallSample = [];
    const walker = document.createTreeWalker(document.body || de, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    let n;
    while ((n = walker.nextNode()) && textEls < 4000) {
      const el = n.parentElement;
      if (!el || seen.has(el) || n.nodeValue.trim().length < 20) continue;
      seen.add(el);
      if (el.closest('script,style,noscript,sup,sub,small,footer,code')) continue;
      if (!isVisible(el)) continue;
      textEls++;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 12) { small++; if (smallSample.length < 5) smallSample.push({ size: fs, text: clean(n.nodeValue).slice(0, 60) }); }
    }
    let taps = 0; let tapTotal = 0; const tapSample = [];
    document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button]').forEach((el) => {
      if (tapTotal > 3000 || !isVisible(el)) return;
      // Links inside running text are exempt (WCAG 2.5.8).
      if (el.tagName === 'A' && el.closest('p,li') && clean(el.closest('p,li').textContent).length > clean(el.textContent).length + 20) return;
      tapTotal++;
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) { taps++; if (tapSample.length < 5) tapSample.push({ tag: el.tagName.toLowerCase(), text: clean(el.textContent || el.getAttribute('aria-label') || el.value || '').slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) }); }
    });
    out.mobile = { viewportWidth: vw, docWidth: de.scrollWidth, overflow: de.scrollWidth > de.clientWidth + 2, overflowEls: overflowEls.map(({ tag, width }) => ({ tag, width })), smallText: small, textEls, smallSample, smallTaps: taps, tapTotal, tapSample };
    // Meta refresh, insecure forms, breadcrumbs.
    const refresh = [...document.querySelectorAll('meta[http-equiv]')].find((m) => m.getAttribute('http-equiv').toLowerCase() === 'refresh');
    out.metaRefresh = refresh ? refresh.getAttribute('content') || '' : null;
    out.insecureForms = location.protocol === 'https:' ? [...document.forms].map((f) => f.getAttribute('action') || '').filter((a) => /^http:\/\//i.test(a)).slice(0, 20) : [];
    out.breadcrumbs = !!document.querySelector('[aria-label*="breadcrumb" i], [class*="breadcrumb" i], [id*="breadcrumb" i], [itemtype*="BreadcrumbList"], [class*="krosh" i]');
    return out;
  }

  // ---------- content that exists only after JavaScript ----------
  // Compares the HTML the server sent with the rendered page: which text blocks, headings
  // and links a bot without JS would not see. Marks such blocks for highlighting.
  const normT = (t) => (t || '').toLowerCase().replace(/ё/g, 'е').replace(/[\s ]+/g, ' ').replace(/[«»"“”„'’]/g, '').trim();
  function compareJs() {
    document.querySelectorAll('[data-seolens-js]').forEach((e) => e.removeAttribute('data-seolens-js'));
    if (!lastRawHtml) return { ok: false };
    const doc = new DOMParser().parseFromString(lastRawHtml, 'text/html');
    // Text outside <html>…</html> (garbage before the doctype or after the closing tag).
    const before = lastRawHtml.replace(/^﻿/, '').split(/<!doctype|<html/i)[0].replace(/<!--[\s\S]*?-->/g, '').trim();
    const afterIdx = lastRawHtml.search(/<\/html\s*>/i);
    const after = afterIdx >= 0 ? lastRawHtml.slice(afterIdx).replace(/<\/html\s*>/i, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/gi, '').trim() : '';
    const rawLinks = new Set([...doc.querySelectorAll('a[href]')].map((a) => { try { return new URL(a.getAttribute('href'), location.href).href.replace(/#.*$/, ''); } catch { return ''; } }));
    doc.querySelectorAll('script,style,noscript,template').forEach((e) => e.remove());
    const rawText = normT(doc.body ? doc.body.textContent : '');
    const blocks = [];
    let total = 0; let jsOnly = 0;
    const sel = 'p,li,h1,h2,h3,h4,h5,h6,td,th,dd,dt,blockquote,figcaption,summary,label,article,section,div';
    const all = document.body ? document.body.querySelectorAll(sel) : [];
    const counted = new Set();
    for (let i = 0; i < all.length && i < 30000; i++) {
      const el = all[i];
      if (el.closest('script,style,noscript,template,svg,[aria-hidden="true"]')) continue;
      // Only "leaf-ish" blocks: own text, no nested counted block containing most of it.
      if (el.tagName === 'DIV' || el.tagName === 'SECTION' || el.tagName === 'ARTICLE') {
        if (el.querySelector(sel.replace(/,div|,section|,article/g, ''))) continue;
      }
      let anc = el.parentElement; let inside = false;
      while (anc && anc !== document.body) { if (counted.has(anc)) { inside = true; break; } anc = anc.parentElement; }
      if (inside) continue;
      const txt = clean(el.innerText || el.textContent || '');
      if (txt.length < 25) continue;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      counted.add(el);
      const words = countWords(txt);
      total += words;
      const n = normT(txt);
      // Check a few slices: whole text, or its first and last 60 chars (markup may split it).
      const probe = n.length > 140 ? [n.slice(0, 60), n.slice(-60)] : [n];
      const inRaw = probe.every((pz) => rawText.includes(pz));
      if (!inRaw) {
        jsOnly += words;
        el.setAttribute('data-seolens-js', String(blocks.length));
        if (blocks.length < 300) blocks.push({ idx: blocks.length, tag: el.tagName.toLowerCase(), words, text: txt.slice(0, 160) });
      }
    }
    const hRaw = new Set([...doc.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => normT(h.textContent)).filter(Boolean));
    const headingsJs = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => ({ level: Number(h.tagName[1]), text: clean(h.textContent) })).filter((h) => h.text && !hRaw.has(normT(h.text))).slice(0, 100);
    const linksJs = [];
    document.querySelectorAll('a[href]').forEach((a) => {
      if (linksJs.length >= 300) return;
      let href; try { href = new URL(a.getAttribute('href'), location.href); } catch { return; }
      if (!/^https?:$/.test(href.protocol)) return;
      const k = href.href.replace(/#.*$/, '');
      if (!rawLinks.has(k)) linksJs.push({ href: k, text: clean(a.textContent).slice(0, 80), internal: href.hostname === location.hostname });
    });
    return {
      ok: true, totalWords: total, jsWords: jsOnly, share: total ? Math.round((jsOnly / total) * 100) : 0,
      blocks, headingsJs, linksJs, outside: { before: before.slice(0, 200), after: after.slice(0, 200) },
    };
  }

  // ---------- trust signals, page structure extras ----------
  function collectTrust() {
    const links = [...document.querySelectorAll('a[href]')];
    const txt = (a) => (clean(a.textContent) + ' ' + (a.getAttribute('href') || '')).toLowerCase();
    const find = (re) => { const a = links.find((l) => re.test(txt(l))); return a ? a.href : null; };
    const tel = links.find((a) => /^tel:/i.test(a.getAttribute('href') || ''));
    const mail = links.find((a) => /^mailto:/i.test(a.getAttribute('href') || ''));
    const bodyText = document.body ? document.body.innerText || '' : '';
    return {
      phone: tel ? tel.getAttribute('href').replace(/^tel:/i, '') : ((bodyText.match(/(?:\+\d{1,3}[\s(-]*)?\(?\d{2,4}\)?[\s-]?\d{2,3}[\s-]?\d{2}[\s-]?\d{2}/) || [])[0] || null),
      phoneLink: !!tel,
      email: mail ? mail.getAttribute('href').replace(/^mailto:/i, '').split('?')[0] : ((bodyText.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/) || [])[0] || null),
      contacts: find(/контакт|contact|связаться|kontakt|aloqa/),
      about: find(/о компании|о нас|about|компания|biz haqimizda/),
      privacy: find(/политик|конфиденциальн|privacy|персональн/),
      delivery: find(/доставк|delivery|оплат|payment|shipping/),
      reviews: find(/отзыв|review|testimonial/),
      address: !!document.querySelector('address,[itemprop="address"],[itemtype*="PostalAddress"]') || /(?:ул\.|улица|проспект|пр-т|д\.\s?\d|street|st\.|ko'chasi|г\.\s?[А-ЯЁ])/i.test(bodyText),
      author: document.querySelector('[rel="author"],[itemprop="author"],.author,[class*="author" i],meta[name="author"]') ? true : false,
      dateText: ((bodyText.match(/\b(?:\d{1,2}[./]\d{1,2}[./](?:20)\d{2}|\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+20\d{2})\b/i) || [])[0]) || null,
      timeTag: (document.querySelector('time[datetime]') || {}).getAttribute ? document.querySelector('time[datetime]').getAttribute('datetime') : null,
    };
  }

  function collectStructure() {
    const sitewideHeadings = [...document.querySelectorAll('nav h1,nav h2,nav h3,nav h4,nav h5,nav h6,header h2,header h3,header h4,header h5,header h6,footer h1,footer h2,footer h3,footer h4,footer h5,footer h6,aside h1,aside h2,aside h3,aside h4,aside h5,aside h6')]
      .map((h) => ({ level: Number(h.tagName[1]), text: clean(h.textContent).slice(0, 80), where: h.closest('nav,header,footer,aside').tagName.toLowerCase() })).slice(0, 50);
    // Same URL + same anchor more than once (outside menus).
    const pairs = new Map();
    document.querySelectorAll('a[href]').forEach((a) => {
      if (a.closest('nav,header,footer')) return;
      let k; try { k = new URL(a.getAttribute('href'), location.href).href.replace(/#.*$/, ''); } catch { return; }
      const t = clean(a.textContent).toLowerCase() || (a.querySelector('img') ? '[img]' : '');
      const key = k + '\u0001' + t;
      pairs.set(key, (pairs.get(key) || 0) + 1);
    });
    const dupLinks = [...pairs].filter(([, c]) => c > 1).map(([k, c]) => { const [href, text] = k.split('\u0001'); return { href, text, c }; }).sort((a, b) => b.c - a.c).slice(0, 50);
    // Several links from the content to one URL ("Read more" + title).
    const byUrl = new Map();
    document.querySelectorAll('a[href]').forEach((a) => {
      if (a.closest('nav,header,footer')) return;
      let k; try { k = new URL(a.getAttribute('href'), location.href).href.replace(/#.*$/, ''); } catch { return; }
      if (k === location.href.replace(/#.*$/, '')) return;
      byUrl.set(k, (byUrl.get(k) || 0) + 1);
    });
    const multiUrl = [...byUrl.values()].filter((c) => c > 1).length;
    const ids = new Map();
    document.querySelectorAll('[id]').forEach((e) => { if (e.id && !e.id.startsWith('seolens')) ids.set(e.id, (ids.get(e.id) || 0) + 1); });
    const dupIds = [...ids].filter(([, c]) => c > 1).map(([id, c]) => ({ id, c })).slice(0, 30);
    const frames = document.querySelectorAll('frameset,frame').length;
    const iframes = [...document.querySelectorAll('iframe[src]')].map((f) => f.src).slice(0, 30);
    const flash = document.querySelectorAll('object[type*="flash"],embed[type*="flash"],embed[src$=".swf"],object[data$=".swf"]').length;
    const geo = {};
    document.querySelectorAll('meta[name]').forEach((m) => { const n = m.getAttribute('name').toLowerCase(); if (/^geo\.|^icbm$/.test(n)) geo[n] = m.getAttribute('content') || ''; });
    const anchorsToHeadings = [...document.querySelectorAll('a[href^="#"]')].filter((a) => { let id = ''; try { id = decodeURIComponent(a.getAttribute('href').slice(1)); } catch { return false; } const t = id && document.getElementById(id); return t && (/^H[2-4]$/.test(t.tagName) || t.querySelector('h2,h3,h4') || (t.nextElementSibling && /^H[2-4]$/.test(t.nextElementSibling.tagName))); }).length;
    return { sitewideHeadings, dupLinks, multiUrl, dupIds, frames, iframes, flash, geo, toc: anchorsToHeadings };
  }

  // ---------- technologies (by markers in the DOM and resource URLs) ----------
  function collectTech() {
    const srcs = [...document.querySelectorAll('script[src],link[href],img[src]')].map((e) => e.src || e.href || '').join('\n');
    const html = document.documentElement.outerHTML.slice(0, 400000);
    const gen = [...document.querySelectorAll('meta[name="generator" i]')].map((m) => m.getAttribute('content') || '').join(' ');
    const found = [];
    const add = (name, cat, ok, ver) => { if (ok && !found.some((x) => x.name === name)) found.push({ name, cat, ver: ver || null }); };
    const v = (re, str) => { const m = (str || '').match(re); return m ? m[1] : null; };
    // CMS / site builders
    add('WordPress', 'cms', /\/wp-content\/|\/wp-includes\//.test(srcs + html) || /wordpress/i.test(gen), v(/WordPress\s*([\d.]+)/i, gen));
    add('1С-Битрикс', 'cms', /\/bitrix\/(js|templates|cache)\//.test(srcs + html) || /bitrix/i.test(gen));
    add('Tilda', 'cms', /tildacdn\.|tilda\.ws/.test(srcs + html));
    add('Joomla', 'cms', /\/media\/jui\/|\/components\/com_/.test(srcs) || /joomla/i.test(gen), v(/Joomla!?\s*([\d.]+)/i, gen));
    add('Drupal', 'cms', !!document.querySelector('script[data-drupal-selector],[data-drupal-link-system-path]') || /drupal/i.test(gen) || /\/sites\/default\/files\//.test(srcs), v(/Drupal\s*([\d.]+)/i, gen));
    add('Shopify', 'cms', /cdn\.shopify\.com|myshopify\.com/.test(srcs));
    add('Wix', 'cms', /static\.wixstatic\.com|parastorage\.com/.test(srcs));
    add('Webflow', 'cms', !!document.documentElement.getAttribute('data-wf-page') || /webflow/i.test(gen));
    add('Squarespace', 'cms', /squarespace\.com|sqspcdn\.com/.test(srcs));
    add('OpenCart', 'cms', /catalog\/view\/(theme|javascript)\//.test(srcs));
    add('MODX', 'cms', /modx/i.test(gen) || /\/assets\/components\//.test(srcs));
    add('Ghost', 'cms', /ghost/i.test(gen), v(/Ghost\s*([\d.]+)/i, gen));
    add('Magento', 'cms', /\/static\/version\d+\/|mage\/cookies/.test(srcs + html));
    add('PrestaShop', 'cms', /prestashop/i.test(gen + srcs));
    add('WooCommerce', 'shop', /woocommerce/.test(srcs + html));
    add('UMI.CMS', 'cms', /umi/i.test(gen));
    add('Craftum / Nethouse / uKit', 'cms', /craftum|nethouse|ukit\.com/.test(srcs));
    // frameworks / libraries
    add('Next.js', 'framework', !!document.getElementById('__NEXT_DATA__') || /\/_next\/static\//.test(srcs));
    add('Nuxt', 'framework', !!document.getElementById('__nuxt') || !!document.getElementById('__NUXT_DATA__') || /\/_nuxt\//.test(srcs));
    add('React', 'framework', !!document.querySelector('[data-reactroot],[data-reactid]') || /react(-dom)?(\.production)?(\.min)?\.js/.test(srcs));
    add('Vue.js', 'framework', !!document.querySelector('[data-v-app]') || /\sdata-v-[0-9a-f]{6,}/.test(html) || /vue(\.runtime)?(\.global)?(\.prod)?(\.min)?\.js/.test(srcs));
    add('Angular', 'framework', !!document.querySelector('[ng-version]'), (document.querySelector('[ng-version]') || { getAttribute: () => null }).getAttribute('ng-version'));
    add('Svelte / SvelteKit', 'framework', /\/_app\/immutable\//.test(srcs) || /class="[^"]*svelte-[a-z0-9]+/.test(html));
    add('Gatsby', 'framework', !!document.getElementById('___gatsby'));
    add('Astro', 'framework', /astro-island|data-astro-cid/.test(html));
    add('jQuery', 'library', /jquery[.-]?([\d.]+)?(\.min)?\.js/i.test(srcs), v(/jquery[.-]([\d.]+)(?:\.min)?\.js/i, srcs));
    add('Bootstrap', 'library', /bootstrap(\.bundle)?(\.min)?\.(css|js)/i.test(srcs), v(/bootstrap@([\d.]+)/i, srcs) || v(/bootstrap\/([\d.]+)\//i, srcs));
    add('Tailwind CSS', 'library', /tailwind/i.test(srcs) || /class="[^"]*\b(?:md|lg):[a-z]+-\S+/.test(html.slice(0, 200000)));
    add('Font Awesome', 'library', /font-?awesome/i.test(srcs));
    add('Google Fonts', 'library', /fonts\.googleapis\.com|fonts\.gstatic\.com/.test(srcs));
    add('Swiper', 'library', /swiper/i.test(srcs));
    add('GSAP', 'library', /gsap|greensock/i.test(srcs));
    add('Lodash', 'library', /lodash/i.test(srcs));
    // widgets / services
    add('reCAPTCHA', 'service', /recaptcha/.test(srcs));
    add('Cloudflare Turnstile', 'service', /challenges\.cloudflare\.com\/turnstile/.test(srcs));
    add('Jivo', 'service', /jivosite|jivo\.ru|code\.jivo/.test(srcs));
    add('Bitrix24 widget', 'service', /bitrix24|b24-/.test(srcs));
    add('Tawk.to', 'service', /tawk\.to/.test(srcs));
    add('Intercom', 'service', /intercom/.test(srcs));
    add('YouTube embed', 'service', /youtube\.com\/embed|youtube-nocookie/.test(html));
    add('Yandex Maps', 'service', /api-maps\.yandex|yandex\.\w+\/map-widget/.test(srcs + html));
    add('Google Maps', 'service', /maps\.googleapis\.com|google\.com\/maps\/embed/.test(srcs + html));
    add('jsDelivr / unpkg / cdnjs', 'cdn', /cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com/.test(srcs));
    return found;
  }

  // ---------- counters ----------
  // Looks in script/img/iframe URLs, inline scripts, data-attributes of scripts and the URLs
  // the page actually requested (catches tags loaded later through Tag Manager).
  function collectCounters() {
    const tags = [...document.querySelectorAll('script[src], img[src], iframe[src], link[href]')];
    const srcs = tags.map((s) => s.src || s.href || '').join('\n');
    const attrs = [...document.querySelectorAll('script[data-domain], script[data-cf-beacon], script[data-website-id]')].map((s) => [
      s.dataset.domain ? 'plausible-domain:' + s.dataset.domain : '',
      s.dataset.cfBeacon || '',
      s.dataset.websiteId ? 'umami-id:' + s.dataset.websiteId : '',
    ].join(' ')).join('\n');
    let requested = '';
    try { requested = performance.getEntriesByType('resource').map((e) => e.name).join('\n'); } catch { requested = ''; }
    let inline = '';
    for (const s of document.querySelectorAll('script:not([src]), noscript')) {
      inline += (s.textContent || '') + '\n';
      if (inline.length > 2_000_000) break;
    }
    const hay = [srcs, requested, attrs, inline].join('\n');
    const found = [];
    const seen = new Set();
    // presence: regex that proves the service is there; idRes: regexes that pull IDs (group 1).
    const add = (name, presence, idRes = []) => {
      if (seen.has(name)) return;
      const ids = new Set();
      for (const re of idRes) for (const m of hay.matchAll(re)) if (m[1]) { try { ids.add(decodeURIComponent(m[1])); } catch { ids.add(m[1]); } }
      if (!ids.size && !(presence && presence.test(hay))) return;
      seen.add(name);
      found.push({ name, ids: [...ids].slice(0, 10) });
    };
    // Google
    add('Google Analytics 4', null, [/\b(G-[A-Z0-9]{6,12})\b/g]);
    add('Universal Analytics', /google-analytics\.com\/(?:analytics|ga)\.js/, [/\b(UA-\d{4,10}-\d{1,4})\b/g]);
    add('Google Tag Manager', null, [/\b(GTM-[A-Z0-9]{4,9})\b/g]);
    add('Google Ads', null, [/\b(AW-\d{6,12})\b/g]);
    add('Google Optimize', null, [/\b(OPT-[A-Z0-9]{5,10})\b/g]);
    add('Floodlight (Campaign Manager)', /fls\.doubleclick\.net/, [/\b(DC-\d{6,10})\b/g]);
    // Runet
    add('Яндекс Метрика', /mc\.yandex\.(?:ru|com|by|kz|uz|com\.tr)\/(?:metrika|watch)/, [/mc\.yandex\.[a-z.]+\/watch\/(\d{5,12})/g, /\bym\(\s*(\d{5,12})\s*,/g, /yaCounter(\d{5,12})\b/g]);
    add('Top.Mail.Ru (VK Ads)', /top-fwz1\.mail\.ru|top\.mail\.ru\/js\/code\.js/, [/top-fwz1\.mail\.ru\/counter\?id=(\d{5,10})/g, /_tmr\.push\(\{\s*id:\s*["'](\d{5,10})/g]);
    add('VK Пиксель', /vk\.com\/js\/api\/openapi\.js|vk\.com\/rtrg/, [/(VK-RTRG-\d+-[A-Za-z0-9]+)/g]);
    add('LiveInternet', /counter\.yadro\.ru|liveinternet\.ru\/(?:click|hit)/);
    add('Rambler Top100', /counter\.rambler\.ru|top100\.ru|top100\.rambler\.ru/, [/(?:top100|rambler)[^"'\n]{0,80}?(?:id|account)["'=:\s]+(\d{5,9})/gi]);
    add('Openstat', /openstat\.net/, [/openstat[^"'\n]{0,40}?counter["'=:\s]+(\d{4,9})/gi]);
    add('Roistat', /cloud\.roistat\.com|roistat\.com\/api/, [/roistat[^"'\n]{0,60}?["']([a-f0-9]{32})["']/gi]);
    add('Calltouch', /mod\.calltouch\.ru|calltouch\.ru\/calltouch_tag/, [/ct\(\s*['"]modId['"]\s*,\s*['"]?([a-z0-9]+)/gi]);
    add('CoMagic / UIS', /app\.comagic\.ru|app\.uiscom\.ru/);
    add('Sber Ads / Segmento', /segmento\.ru|sberads/i);
    add('myTarget', /ad\.mail\.ru|privacy-cs\.mail\.ru/);
    // Global ad pixels
    add('Meta Pixel', /connect\.facebook\.net\/[^"'\s]+\/fbevents\.js/, [/fbq\(\s*['"]init['"]\s*,\s*['"](\d{8,20})/g, /facebook\.com\/tr\?id=(\d{8,20})/g]);
    add('TikTok Pixel', /analytics\.tiktok\.com/, [/ttq\.load\(\s*['"]([A-Z0-9]{10,25})/g, /sdkid=([A-Z0-9]{10,25})/g]);
    add('LinkedIn Insight', /snap\.licdn\.com\/li\.lms-analytics/, [/_linkedin_partner_id\s*=\s*["']?(\d{4,10})/g]);
    add('Microsoft Advertising (UET)', /bat\.bing\.com/, [/\bti\s*:\s*["']?(\d{5,10})/g, /bat\.bing\.com\/action\/0\?ti=(\d{5,10})/g]);
    add('Pinterest Tag', /s\.pinimg\.com\/ct\/core\.js|ct\.pinterest\.com/, [/pintrk\(\s*['"]load['"]\s*,\s*['"](\d{8,16})/g]);
    add('X (Twitter) Pixel', /static\.ads-twitter\.com\/uwt\.js/, [/twq\(\s*['"](?:config|init)['"]\s*,\s*['"]([a-z0-9]{5,8})/g]);
    add('Snap Pixel', /sc-static\.net\/scevent\.min\.js/, [/snaptr\(\s*['"]init['"]\s*,\s*['"]([a-f0-9-]{36})/g]);
    add('Criteo', /static\.criteo\.net|dynamic\.criteo\.com/, [/criteo_q[^]{0,200}?account\s*:\s*["']?(\d{3,8})/g]);
    // Product analytics and session recording
    add('Microsoft Clarity', /clarity\.ms\/tag/, [/clarity\.ms\/tag\/([a-z0-9]{6,12})/g, /["']clarity["']\s*,\s*["']script["']\s*,\s*["']([a-z0-9]{6,12})/g]);
    add('Hotjar', /static\.hotjar\.com/, [/hjid\s*:\s*(\d{5,10})/g, /hotjar-(\d{5,10})\.js/g]);
    add('Matomo / Piwik', /matomo\.js|piwik\.js|_paq\.push/, [/['"]setSiteId['"]\s*,\s*['"]?(\d{1,6})/g]);
    add('Plausible', /plausible\.io\/js/, [/plausible-domain:([^\s]+)/g]);
    add('Cloudflare Web Analytics', /static\.cloudflareinsights\.com\/beacon/, [/"token"\s*:\s*"([a-f0-9]{32})"/g]);
    add('Mixpanel', /cdn\.mxpnl\.com|mixpanel\.init/, [/mixpanel\.init\(\s*['"]([a-f0-9]{32})/g]);
    add('Amplitude', /cdn\.amplitude\.com|amplitude\.getInstance|amplitude\.init/, [/amplitude[^"'\n]{0,40}?init\(\s*['"]([a-f0-9]{32})/g]);
    add('Segment', /cdn\.segment\.com\/analytics\.js/, [/analytics\.load\(\s*['"]([A-Za-z0-9]{20,40})/g]);
    add('Heap', /cdn\.heapanalytics\.com/, [/heap\.load\(\s*['"](\d{6,12})/g]);
    add('HubSpot', /js\.hs-scripts\.com|js\.hs-analytics\.net/, [/js\.hs-scripts\.com\/(\d{5,10})\.js/g, /js\.hs-analytics\.net\/analytics\/\d+\/(\d{5,10})\.js/g]);
    add('Adobe Analytics', /AppMeasurement|omtrdc\.net|2o7\.net|assets\.adobedtm\.com/);
    add('Umami', /umami\.(?:is|js)|\/umami\.js/, [/umami-id:([a-f0-9-]{36})/g]);
    return found;
  }

  // ---------- performance & mixed content ----------
  function collectPerf() {
    const n = performance.getEntriesByType('navigation')[0];
    const res = performance.getEntriesByType('resource');
    let bytes = 0;
    for (const r of res) bytes += r.transferSize || 0;
    return {
      ttfb: n ? Math.round(n.responseStart - n.startTime) : null,
      dcl: n ? Math.round(n.domContentLoadedEventEnd - n.startTime) : null,
      load: n && n.loadEventEnd ? Math.round(n.loadEventEnd - n.startTime) : null,
      docTransfer: n ? n.transferSize : null,
      docEncoded: n ? n.encodedBodySize : null,
      redirectCount: n ? n.redirectCount : null,
      navType: n ? n.type : null,
      protocol: n ? n.nextHopProtocol || null : null,
      requests: res.length + 1,
      pageBytes: bytes + (n ? n.transferSize || 0 : 0),
      domNodes: document.getElementsByTagName('*').length,
      lcp: state.lcp == null ? null : Math.round(state.lcp),
      lcpEl: state.lcpEl,
      lcpLazy: !!state.lcpLazy,
      cls: Math.round(state.cls * 1000) / 1000,
      inp: state.inp == null ? null : Math.round(state.inp),
      interactions: state.interactions.size,
    };
  }

  function collectMixed() {
    if (location.protocol !== 'https:') return [];
    const set = new Set();
    for (const r of performance.getEntriesByType('resource')) if (r.name.startsWith('http:')) set.add(r.name);
    document.querySelectorAll('img[src],script[src],iframe[src],audio[src],video[src],source[src],link[rel~="stylesheet"][href]').forEach((el) => {
      const u = el.getAttribute('src') || el.getAttribute('href');
      if (u && abs(u).startsWith('http:')) set.add(abs(u));
    });
    return [...set].slice(0, 200);
  }

  // ---------- network (same origin) ----------
  let lastRawHtml = '';

  // Search the source HTML (as the server sent it) and the rendered DOM for text or a regular expression.
  function search(query, isRegex, caseSensitive) {
    let re;
    try { re = new RegExp(isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g' + (caseSensitive ? '' : 'i')); } catch (e) { return { error: String(e.message || e) }; }
    const run = (text) => {
      const hits = []; let count = 0; let m;
      re.lastIndex = 0;
      while ((m = re.exec(text)) && count < 5000) {
        count++;
        if (hits.length < 50) {
          const line = text.slice(0, m.index).split('\n').length;
          hits.push({ line, before: text.slice(Math.max(0, m.index - 60), m.index), match: m[0].slice(0, 200), after: text.slice(m.index + m[0].length, m.index + m[0].length + 60) });
        }
        if (!m[0].length) re.lastIndex++;
      }
      return { count, hits };
    };
    const domHtml = '<!doctype html>\n' + document.documentElement.outerHTML.replace(/ data-seolens-[a-z]="\d+"/g, '');
    return { raw: lastRawHtml ? run(lastRawHtml) : null, dom: run(domHtml), text: run(document.body ? document.body.innerText : '') };
  }

  async function collectRaw() {
    try {
      const { res, text: html } = await fetchLimited(location.href, { credentials: 'include', cache: 'no-store', redirect: 'follow' }, 15000, LIMITS.raw);
      const headers = headerList(res).filter((x) => !/^(set-cookie2?|cookie|authorization)$/.test(x.name));
      lastRawHtml = html;
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const q = (sel) => [...doc.querySelectorAll(sel)];
      const rawText = (() => {
        doc.querySelectorAll('script,style,noscript,template,svg').forEach((e) => e.remove());
        return clean(doc.body ? doc.body.textContent : '');
      })();
      return {
        ok: true,
        status: res.status,
        finalUrl: res.url,
        redirected: res.redirected,
        headers,
        bytes: html.length,
        titles: q('title').filter((t) => !t.closest('svg')).map((t) => clean(t.textContent)),
        descriptions: q('meta[name]').filter((m) => m.getAttribute('name').toLowerCase() === 'description').map((m) => clean(m.getAttribute('content'))),
        canonicals: q('link[rel]').filter((l) => l.getAttribute('rel').toLowerCase().split(/\s+/).includes('canonical')).map((l) => abs(l.getAttribute('href') || '')),
        robots: q('meta[name]').filter((m) => ['robots', 'googlebot', 'yandex'].includes(m.getAttribute('name').toLowerCase())).map((m) => ({ name: m.getAttribute('name').toLowerCase(), content: clean(m.getAttribute('content')) })),
        h1: q('h1').map((h) => clean(h.textContent)),
        words: countWords(rawText),
        links: q('a[href]').length,
        noindexTags: (html.match(/<noindex[\s>]/gi) || []).length + (html.match(/<!--\s*noindex\s*-->/gi) || []).length,
      };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  // Conditional GET: does the server answer 304 Not Modified to If-Modified-Since / If-None-Match?
  async function collectConditional(raw) {
    const get = (n) => { const h = (raw.headers || []).find((x) => x.name === n); return h ? h.value : null; };
    const lastModified = get('last-modified');
    const etag = get('etag');
    const out = { lastModified, etag, tested: false, status: null, sent: [] };
    if (!lastModified && !etag) return out;
    const headers = {};
    if (lastModified) { headers['If-Modified-Since'] = lastModified; out.sent.push('If-Modified-Since'); }
    if (etag) { headers['If-None-Match'] = etag; out.sent.push('If-None-Match'); }
    try {
      const res = await timedFetch(location.href, { credentials: 'include', cache: 'no-store', redirect: 'follow', headers }, 6000);
      out.tested = true;
      out.status = res.status;
      try { await res.body?.cancel(); } catch { /* ignore */ }
    } catch (e) {
      out.error = String(e.message || e);
    }
    return out;
  }

  // Resources that failed to load (Resource Timing responseStatus, Chrome 109+): broken CSS/JS/fonts/images.
  function collectBrokenResources() {
    const out = [];
    try {
      for (const e of performance.getEntriesByType('resource')) {
        if (e.responseStatus >= 400) out.push({ url: e.name, status: e.responseStatus, type: e.initiatorType });
        if (out.length >= 100) break;
      }
    } catch { /* ignore */ }
    return out;
  }

  // Same-origin resources the page uses (for the robots.txt check of CSS, JS, images and fonts).
  function collectResources() {
    const map = new Map();
    const kindOf = (url, hint) => {
      if (hint) return hint;
      const p = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return ''; } })();
      if (/\.css$/.test(p)) return 'css';
      if (/\.m?js$/.test(p)) return 'js';
      if (/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/.test(p)) return 'img';
      if (/\.(woff2?|ttf|otf|eot)$/.test(p)) return 'font';
      return 'other';
    };
    const put = (url, hint) => {
      if (!url) return;
      let u; try { u = new URL(url, location.href); } catch { return; }
      if (u.origin !== location.origin) return;
      u.hash = '';
      const k = u.href;
      if (!map.has(k)) map.set(k, kindOf(k, hint));
      else if (hint && map.get(k) === 'other') map.set(k, hint);
    };
    document.querySelectorAll('script[src]').forEach((e) => put(e.src, 'js'));
    document.querySelectorAll('link[href]').forEach((e) => {
      const rel = (e.rel || '').toLowerCase();
      if (rel.includes('stylesheet')) put(e.href, 'css');
      else if (rel.includes('preload') || rel.includes('modulepreload')) put(e.href, ({ style: 'css', script: 'js', font: 'font', image: 'img' })[e.getAttribute('as')] || (rel.includes('modulepreload') ? 'js' : null));
      else if (rel.includes('icon')) put(e.href, 'img');
    });
    document.querySelectorAll('img[src]').forEach((e) => put(e.currentSrc || e.src, 'img'));
    try {
      for (const r of performance.getEntriesByType('resource')) {
        const hint = r.initiatorType === 'script' ? 'js' : r.initiatorType === 'img' ? 'img' : null;
        put(r.name, hint);
      }
    } catch { /* ignore */ }
    return [...map].slice(0, 1500).map(([url, kind]) => ({ url, kind }));
  }

  async function collectRobots() {
    const url = location.origin + '/robots.txt';
    try {
      const got = await fetchLimited(url, { cache: 'no-store', redirect: 'follow', credentials: 'omit' }, 8000, 500_000);
      const res = got.res;
      const type = res.headers.get('content-type') || '';
      const text = res.ok ? got.text : '';
      const looksHtml = /^\s*<(!doctype|html)/i.test(text);
      return { url, ok: res.ok, status: res.status, finalUrl: res.url, contentType: type, text: looksHtml ? '' : text, looksHtml };
    } catch (e) {
      return { url, ok: false, status: 0, error: String(e.message || e), text: '' };
    }
  }

  function sitemapUrlsFromRobots(text) {
    const out = [];
    for (const line of (text || '').split(/\r?\n/)) {
      const m = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
      if (m) out.push(abs(m[1]));
    }
    return [...new Set(out)];
  }

  async function fetchSitemap(url) {
    try {
      const { res, text } = await fetchLimited(url, { cache: 'no-store', redirect: 'follow', credentials: 'omit' }, 15000, 10_000_000);
      const status = res.status;
      if (!res.ok) return { url, status, ok: false };
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      const err = doc.querySelector('parsererror');
      const rootName = doc.documentElement ? doc.documentElement.localName : '';
      const isXml = !err && (rootName === 'urlset' || rootName === 'sitemapindex');
      const locs = [...doc.getElementsByTagNameNS('*', 'loc')].map((l) => clean(l.textContent));
      // Quality of a urlset: lastmod format and dates, priority values, foreign hosts, http/https mix.
      let stats = null;
      if (isXml && rootName === 'urlset') {
        const urls = [...doc.getElementsByTagNameNS('*', 'url')];
        const now = Date.now() + 864e5;
        stats = { urls: urls.length, lastmod: 0, lastmodBad: 0, lastmodFuture: 0, newest: null, oldest: null, priorityBad: 0, foreign: 0, scheme: 0, dup: 0 };
        const seen = new Set();
        for (const u of urls.slice(0, 50000)) {
          const loc = clean((u.getElementsByTagNameNS('*', 'loc')[0] || {}).textContent || '');
          if (seen.has(loc)) stats.dup++; else seen.add(loc);
          try { const x = new URL(loc); if (x.hostname.replace(/^www\./, '') !== location.hostname.replace(/^www\./, '')) stats.foreign++; else if (x.protocol !== location.protocol) stats.scheme++; } catch { stats.foreign++; }
          const lm = (u.getElementsByTagNameNS('*', 'lastmod')[0] || {}).textContent;
          if (lm) {
            stats.lastmod++;
            const v = clean(lm);
            const tme = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.test(v) ? Date.parse(v) : NaN;
            if (!Number.isFinite(tme)) stats.lastmodBad++;
            else {
              if (tme > now) stats.lastmodFuture++;
              if (!stats.newest || v > stats.newest) stats.newest = v.slice(0, 10);
              if (!stats.oldest || v < stats.oldest) stats.oldest = v.slice(0, 10);
            }
          }
          const pr = (u.getElementsByTagNameNS('*', 'priority')[0] || {}).textContent;
          if (pr && !(Number(pr) >= 0 && Number(pr) <= 1)) stats.priorityBad++;
        }
      }
      return { url, status, ok: true, isXml, parseError: err ? clean(err.textContent).slice(0, 200) : null, type: rootName, locs, stats };
    } catch (e) {
      return { url, status: 0, ok: false, error: String(e.message || e) };
    }
  }

  async function collectSitemap(robots) {
    const declared = sitemapUrlsFromRobots(robots.text);
    const list = declared.length ? declared : [location.origin + '/sitemap.xml'];
    const here = location.href.split('#')[0];
    const variants = new Set([here, here.replace(/\/$/, ''), here.endsWith('/') ? here : here + '/']);
    const first = await fetchSitemap(list[0]);
    const result = { declared, checkedUrl: list[0], first: { ...first, locs: undefined }, count: 0, children: [], contains: null, checkedFiles: 0 };
    if (!first.ok || !first.isXml) return result;
    result.checkedFiles = 1;
    if (first.type === 'urlset') {
      result.stats = first.stats;
      result.count = first.locs.length;
      result.contains = first.locs.some((l) => variants.has(l));
    } else {
      result.children = first.locs.slice(0, 200);
      result.count = first.locs.length;
      let contains = false;
      for (const child of first.locs.slice(0, 5)) {
        if (!child.startsWith(location.origin)) continue;
        const c = await fetchSitemap(child);
        result.checkedFiles++;
        if (!result.stats && c.stats) { result.stats = c.stats; result.statsFile = child; }
        if (c.ok && c.locs && c.locs.some((l) => variants.has(l))) { contains = true; break; }
      }
      result.contains = contains ? true : null; // null = not found in the files checked
    }
    return result;
  }

  // ---------- highlights ----------
  const STYLE_ID = 'seolens-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = `
      html.seolens-hl-headings [data-seolens-h]{outline:2px solid #0f6b5a !important;outline-offset:2px !important}
      html.seolens-hl-headings [data-seolens-hl]::before{content:attr(data-seolens-hl);display:inline-block;background:#0f6b5a;color:#fff;font:600 11px/1.6 ui-monospace,monospace;padding:0 5px;margin-right:6px;border-radius:3px;vertical-align:middle}
      html.seolens-hl-rel a[rel~="nofollow" i]{outline:2px dotted #c0392b !important;outline-offset:2px !important;background:rgba(192,57,43,.08) !important}
      html.seolens-hl-rel a[rel~="sponsored" i]{outline:2px dashed #d35400 !important;outline-offset:2px !important;background:rgba(211,84,0,.08) !important}
      html.seolens-hl-rel a[rel~="ugc" i]{outline:2px dashed #8e44ad !important;outline-offset:2px !important;background:rgba(142,68,173,.08) !important}
      html.seolens-hl-rel.seolens-page-nofollow a[href]{outline:1px dotted #c0392b !important}
      html.seolens-hl-js [data-seolens-js]{outline:2px dashed #d35400 !important;outline-offset:2px !important;background:rgba(211,84,0,.10) !important}
      html.seolens-hl-js [data-seolens-js]::before{content:'JS';display:inline-block;margin-right:6px;padding:0 5px;border-radius:4px;background:#d35400;color:#fff;font:600 11px/1.6 system-ui,sans-serif}
      html.seolens-hl-noindex noindex, html.seolens-hl-noindex [data-seolens-noindex]{outline:2px dashed #7f1d1d !important;outline-offset:2px !important;background:rgba(127,29,29,.07) !important;display:block}
      .seolens-flash{animation:seolens-flash 1.8s ease-out 1 !important}
      @keyframes seolens-flash{0%,40%{outline:4px solid #f39c12;outline-offset:3px;box-shadow:0 0 0 9999px rgba(0,0,0,.18)}100%{outline:0 solid transparent;box-shadow:none}}
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  function markNoindexComments() {
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_COMMENT);
    let n; let open = null;
    while ((n = walker.nextNode())) {
      const v = n.nodeValue.trim().toLowerCase();
      if (v === 'noindex') open = n;
      else if (v === '/noindex' && open && open.parentNode === n.parentNode) {
        let s = open.nextSibling;
        while (s && s !== n) { if (s.nodeType === 1) s.setAttribute('data-seolens-noindex', ''); s = s.nextSibling; }
        open = null;
      }
    }
  }

  function highlight(kind, on) {
    ensureStyle();
    const root = document.documentElement;
    if (kind === 'headings') {
      document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
        if (on) h.setAttribute('data-seolens-hl', h.tagName); else h.removeAttribute('data-seolens-hl');
      });
    }
    if (kind === 'noindex' && on) markNoindexComments();
    if (kind === 'rel') {
      const pageNofollow = [...document.querySelectorAll('meta[name]')].some((m) => ['robots', 'googlebot', 'yandex'].includes(m.getAttribute('name').toLowerCase()) && /nofollow|none/i.test(m.getAttribute('content') || ''));
      root.classList.toggle('seolens-page-nofollow', on && pageNofollow);
    }
    root.classList.toggle('seolens-hl-' + kind, on);
    return { ok: true };
  }

  function scrollToEl(kind, idx) {
    const attr = { h: 'data-seolens-h', l: 'data-seolens-l', i: 'data-seolens-i', j: 'data-seolens-js' }[kind];
    if (!attr) return { ok: false };
    const el = document.querySelector(`[${attr}="${Number(idx)}"]`);
    if (!el) return { ok: false, reason: 'gone' };
    ensureStyle();
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('seolens-flash');
    void el.offsetWidth;
    el.classList.add('seolens-flash');
    setTimeout(() => el.classList.remove('seolens-flash'), 2000);
    const r = el.getBoundingClientRect();
    return { ok: true, visible: r.width > 0 && r.height > 0 };
  }

  // ---------- public ----------
  // Each module runs on its own: if one throws on an odd page, the others still report.
  const moduleErrors = [];
  function safe(name, fn, fallback) {
    try { return fn(); } catch (e) { moduleErrors.push({ module: name, error: String(e && e.message || e).slice(0, 300) }); return fallback; }
  }
  async function safeAsync(name, fn, fallback) {
    try { return await fn(); } catch (e) { moduleErrors.push({ module: name, error: String(e && e.message || e).slice(0, 300) }); return fallback; }
  }
  const EMPTY_HEAD = { titles: [], descriptions: [], author: null, publisher: null, generator: [], charset: null, documentCharset: document.characterSet, viewport: null, themeColor: null, robotsMeta: [], canonicals: [], hreflang: [], icons: [], lang: null, dir: null, og: {}, twitter: {}, prev: null, next: null, feeds: [], doctype: null };
  const EMPTY_TEXT = { mainSource: '', mainText: '', fullText: '', firstParagraph: '', mainWords: 0, fullWords: 0, mainChars: 0, mainCharsNoSpaces: 0, fullChars: 0, fullCharsNoSpaces: 0, htmlBytes: 0, selection: '' };

  async function collect() {
    const t0 = performance.now();
    moduleErrors.length = 0;
    const head = safe('head', collectHead, EMPTY_HEAD);
    const headings = safe('headings', collectHeadings, []);
    const text = safe('text', collectText, EMPTY_TEXT);
    const links = safe('links', collectLinks, { items: [], total: 0 });
    const images = safe('images', collectImages, { items: [], total: 0, background: [], svgInline: 0 });
    const jsonld = safe('jsonld', collectJsonLd, []);
    const microdata = safe('microdata', collectMicrodata, []);
    const rdfa = safe('rdfa', collectRdfa, []);
    const counters = safe('counters', collectCounters, []);
    const extras = safe('extras', collectExtras, {});
    const mixed = safe('mixed', collectMixed, []);
    const tech = safe('tech', collectTech, []);
    const [raw, robots] = await Promise.all([
      safeAsync('raw', collectRaw, { ok: false, error: 'module error' }),
      safeAsync('robots', collectRobots, { url: location.origin + '/robots.txt', ok: false, status: 0, text: '' }),
    ]);
    const [sitemap, conditional] = await Promise.all([
      safeAsync('sitemap', () => collectSitemap(robots), { declared: [], checkedUrl: location.origin + '/sitemap.xml', first: { status: 0, ok: false }, count: 0, children: [], contains: null, checkedFiles: 0 }),
      raw.ok ? safeAsync('conditional', () => collectConditional(raw), null) : Promise.resolve(null),
    ]);
    const resources = safe('resources', collectResources, []);
    const brokenRes = safe('brokenRes', collectBrokenResources, []);
    const jsdiff = safe('jsdiff', compareJs, { ok: false });
    const trust = safe('trust', collectTrust, null);
    const structure = safe('structure', collectStructure, {});
    await new Promise((r) => setTimeout(r, 50)); // let buffered observers flush
    const perf = safe('perf', collectPerf, { ttfb: null, dcl: null, load: null, redirectCount: null, requests: 0, pageBytes: 0, domNodes: 0, lcp: null, lcpEl: null, cls: null, inp: null, interactions: 0, protocol: null });
    return {
      v: 1,
      collectedAt: new Date().toISOString(),
      url: location.href,
      origin: location.origin,
      host: location.hostname,
      protocol: location.protocol,
      contentType: document.contentType,
      head, headings, text, links, images,
      schema: { jsonld, microdata, rdfa },
      counters, mixed, perf, raw, robots, sitemap, conditional, resources, brokenRes, tech, extras, jsdiff, trust, structure,
      noindexTags: document.getElementsByTagName('noindex').length,
      moduleErrors: moduleErrors.slice(),
      took: Math.round(performance.now() - t0),
    };
  }

  globalThis.__seoLens = {
    collect,
    search,
    rawHtml: () => lastRawHtml,
    highlight,
    scrollTo: scrollToEl,
    selection: () => {
      let t = String(window.getSelection ? window.getSelection() : '');
      const el = document.activeElement;
      if (!t && el && typeof el.selectionStart === 'number' && el.value) t = el.value.slice(el.selectionStart, el.selectionEnd);
      return t;
    },
  };
})();
