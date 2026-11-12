// Shows the page as the server sent it, with JavaScript off: what a bot without rendering sees.
// The HTML goes into a sandboxed iframe without allow-scripts, so none of the page's scripts run.
(async () => {
  // UI language: the panel's setting if saved, else Chrome's.
  let lang = (chrome.i18n.getUILanguage() || 'en').toLowerCase().slice(0, 2);
  try { const got = await chrome.storage.sync.get('settings'); const l = got.settings && got.settings.lang; if (l && l !== 'auto') lang = l; } catch { /* ignore */ }
  const T = {
    ru: { view: 'Как страница', text: 'Только текст', code: 'Исходный код', words: 'слов без JS', ext: 'Картинки и стили сайта', err: 'Не удалось получить исходный HTML. Обновите страницу и нажмите «Обновить» в панели Canonical.', title: 'Canonical — без JavaScript', note: 'Скрипты, фреймы, формы и meta refresh отключены. Картинки и стили сайта не загружаются, пока вы их не включите.' },
    en: { view: 'As a page', text: 'Text only', code: 'Source code', words: 'words without JS', ext: 'Site images and styles', err: 'Couldn’t get the source HTML. Reload the page and press Refresh in the Canonical panel.', title: 'Canonical — without JavaScript', note: 'Scripts, frames, forms and meta refresh are off. Site images and styles are not loaded until you turn them on.' },
    uk: { view: 'Як сторінка', text: 'Лише текст', code: 'Вихідний код', words: 'слів без JS', ext: 'Зображення й стилі сайту', err: 'Не вдалося отримати вихідний HTML. Оновіть сторінку й натисніть «Оновити» в панелі Canonical.', title: 'Canonical — без JavaScript', note: 'Скрипти, фрейми, форми й meta refresh вимкнено. Зображення й стилі сайту не завантажуються, доки ви їх не ввімкнете.' },
    uz: { view: 'Sahifa sifatida', text: 'Faqat matn', code: 'Manba kod', words: 'soʻz JS siz', ext: 'Sayt rasmlari va uslublari', err: 'Manba HTML ni olib boʻlmadi. Sahifani yangilang va Canonical panelida «Yangilash» ni bosing.', title: 'Canonical — JavaScript siz', note: 'Skriptlar, freymlar, shakllar va meta refresh oʻchirilgan. Sayt rasmlari va uslublari siz yoqmaguningizcha yuklanmaydi.' },
    tt: { view: 'Бит буларак', text: 'Текст кына', code: 'Чыганак код', words: 'сүз JS’сыз', ext: 'Сайт рәсемнәре һәм стильләре', err: 'Чыганак HTML’ны алып булмады. Битне яңартыгыз һәм Canonical панелендә «Яңарту» төймәсенә басыгыз.', title: 'Canonical — JavaScript’сыз', note: 'Скриптлар, фреймнар, формалар һәм meta refresh сүндерелгән. Сайт рәсемнәре һәм стильләре сез кабызмыйча йөкләнми.' },
  };
  const L = T[lang] || T.en;
  document.title = L.title;
  document.getElementById('b-view').textContent = L.view;
  document.getElementById('b-text').textContent = L.text;
  document.getElementById('b-code').textContent = L.code;
  const out = document.getElementById('out');
  const tabId = Number(new URLSearchParams(location.search).get('tabId'));
  let html = ''; let url = '';
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: () => ({ html: globalThis.__seoLens ? globalThis.__seoLens.rawHtml() : '', url: location.href }) });
    html = res.result.html; url = res.result.url;
    if (!html) {
      const r = await chrome.scripting.executeScript({ target: { tabId }, func: async () => { const x = await fetch(location.href, { credentials: 'include', cache: 'no-store' }); return { html: await x.text(), url: location.href }; } });
      html = r[0].result.html; url = r[0].result.url;
    }
  } catch { /* handled below */ }
  if (!html) { out.textContent = L.err; return; }
  document.getElementById('url').textContent = url;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // <noscript> content is what browsers show with JS off; expanded first, so the cleanup below covers it too.
  doc.querySelectorAll('noscript').forEach((n) => {
    const inner = new DOMParser().parseFromString(n.textContent || '', 'text/html').body;
    const d = doc.createElement('div');
    d.append(...[...inner.childNodes].map((c) => doc.importNode(c, true)));
    n.replaceWith(d);
  });
  doc.querySelectorAll('script, iframe, frame, frameset, object, embed, portal').forEach((x) => x.remove());
  doc.querySelectorAll('meta[http-equiv]').forEach((m) => { if (/refresh|content-security-policy/i.test(m.getAttribute('http-equiv'))) m.remove(); });
  doc.querySelectorAll('form').forEach((f) => { f.removeAttribute('action'); f.setAttribute('onsubmit', 'return false'); });
  doc.querySelectorAll('[srcdoc]').forEach((x) => x.removeAttribute('srcdoc'));
  const base = doc.createElement('base'); base.href = url;
  doc.head.prepend(base);
  const clone = doc.body ? doc.body.cloneNode(true) : doc.createElement('body');
  clone.querySelectorAll('style,template').forEach((e) => e.remove());
  const text = (clone.innerText || clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  const words = (text.match(/[\p{L}\p{N}]+/gu) || []).length;
  document.getElementById('info').textContent = `${words} ${L.words}`;
  // Private mode: a CSP inside the preview blocks every network request (images, CSS, fonts).
  const cspMeta = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src data:; form-action \'none\'">';
  const htmlOut = doc.documentElement.outerHTML;
  const srcdocFor = (withExternal) => '<!doctype html>' + (withExternal ? htmlOut : htmlOut.replace(/<head([^>]*)>/i, (m) => m + cspMeta));
  let external = false;
  const show = (mode) => {
    ['view', 'text', 'code'].forEach((m) => document.getElementById('b-' + m).setAttribute('aria-pressed', String(m === mode)));
    let el;
    if (mode === 'view') {
      el = document.createElement('iframe');
      el.setAttribute('sandbox', ''); // no scripts, no forms, no top navigation
      el.setAttribute('referrerpolicy', 'no-referrer');
      el.srcdoc = srcdocFor(external);
    } else {
      el = document.createElement('pre');
      el.textContent = mode === 'text' ? text : html;
    }
    document.getElementById('out').replaceWith(el);
    el.id = 'out';
  };
  const extBtn = document.getElementById('b-ext');
  extBtn.textContent = L.ext;
  extBtn.title = L.note;
  const noteEl = document.createElement('span'); noteEl.className = 'note'; noteEl.textContent = L.note; document.querySelector('.bar').appendChild(noteEl);
  extBtn.onclick = () => { external = !external; extBtn.setAttribute('aria-pressed', String(external)); show('view'); };
  document.getElementById('b-view').onclick = () => show('view');
  document.getElementById('b-text').onclick = () => show('text');
  document.getElementById('b-code').onclick = () => show('code');
  show('view');
})();
