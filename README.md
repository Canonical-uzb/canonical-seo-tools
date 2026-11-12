# Canonical SEO Tools

On-page SEO audit in the Chrome side panel. Open any page, press **Refresh**, and get a score, a list of issues with fixes, and every SEO signal of the page in one place. Runs locally, only when you click. No sign-up, no ads, no tracking.

[Русская версия ниже](#canonical-seo-tools--по-русски)

## What it checks

| Area | Checks |
| --- | --- |
| Meta | Title and description length in characters and pixels, duplicates, Google and Yandex snippet preview, Open Graph, Twitter Cards |
| Indexability | Meta robots and X-Robots-Tag, robots.txt for Googlebot, Yandex and Bing (with the exact rule), sitemap.xml, canonical and its target, hreflang, 28 AI crawlers |
| Content | H1–H6 tree, word count, readability score, long sentences and paragraphs, word frequency, focus keyword, text that appears only after JavaScript, no-JS page view |
| Links and images | Internal and external links, nofollow/sponsored/ugc, empty and vague anchors, alt and title, sizes, weight, lazy loading, possible savings |
| Structured data | JSON-LD, Microdata, RDFa, required fields for Product, Article, Breadcrumbs and more |
| Server | Status code, redirect chain (on demand, no reload), HTTP version, compression, caching, security headers, www/https variants, soft 404 |
| Speed | Core Web Vitals (LCP, INP, CLS), render-blocking resources, technologies and analytics tags |
| Domain | IP and country, hosting, registrar, domain age, SSL, DNS records, DNS propagation, blacklists, subdomains |
| Tools | Competitor comparison, check a list of up to 50 URLs, page type and search intent, HTML report for clients, QR code, share links, export to Excel, CSV, JSON and Markdown |

Interface languages: English, Russian, Ukrainian, Uzbek, Tatar. Light and dark theme.

## Install

**Chrome Web Store:** _link will be added after review._

**Manually (Chrome, Edge, Brave, Yandex Browser):**
1. Download the latest `canonical-seo-tools-*-chrome.zip` from [Releases](../../releases) and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode**.
3. Click **Load unpacked** and select the unzipped folder.

**Firefox (140+):** download `canonical-seo-tools-*-firefox.zip` from [Releases](../../releases). For a temporary install open `about:debugging` → **This Firefox** → **Load Temporary Add-on** → select `manifest.json`.

## Privacy

- Page analysis runs in your browser. Nothing is sent to us: there is no server.
- Checks run only when you press a button.
- Domain lookups send only the domain name or IP to public services (Google, Cloudflare, AdGuard and AliDNS DNS, rdap.org, ipwho.is, crt.sh, Cert Spotter, HackerTarget), and only when you press the button. Every request is shown in the request log in Settings.
- Cookie and Authorization headers are discarded and never stored.
- Settings and check history stay on your computer.

Full policy: _link to the privacy policy page_.

## Permissions

| Permission | Why |
| --- | --- |
| activeTab, scripting | Read the current page after your click |
| sidePanel | The interface is a side panel bound to one tab |
| storage | Settings, check history, request log (local only) |
| webRequest | Read status, headers and redirects of the analyzed page (read-only) |
| webNavigation | Drop the saved result when the page reloads; optional numbering on search result pages |
| contextMenus, downloads | Character count menu; saving exported reports |
| Access to all sites (optional) | Asked only when a check needs it: headers, URL variants, 404, canonical and hreflang targets, domain lookups |

## Build for Firefox

The Firefox package is built from the same code:

```bash
python3 build_firefox.py
```

The script writes a Firefox manifest (`background.scripts`, `sidebar_action`, `browser_specific_settings`) and packs the zip.

## Feedback

Found a bug or have an idea? Open an [issue](../../issues).

## License

See [LICENSE](LICENSE).

---

# Canonical SEO Tools — по-русски

SEO-анализ страницы в боковой панели Chrome. Откройте страницу, нажмите **«Обновить»** — и получите оценку, список проблем с подсказками и все SEO-данные страницы в одном месте. Работает в браузере и только по кнопке. Без регистрации, рекламы и слежки.

**Что проверяет:** мета-теги и сниппеты Google и Яндекса, индексацию (robots, robots.txt, sitemap, canonical, hreflang, AI-боты), заголовки и текст, читабельность, текст после JavaScript, ссылки и изображения, микроразметку, ответ сервера и редиректы, Core Web Vitals, технологии сайта, домен, DNS, SSL и IP. Есть сравнение с конкурентом, проверка списка адресов, HTML-отчёт для клиента и выгрузка в Excel.

**Установка вручную:** скачайте `canonical-seo-tools-*-chrome.zip` в разделе [Releases](../../releases), распакуйте, откройте `chrome://extensions`, включите режим разработчика и нажмите «Загрузить распакованное расширение».

**Если Chrome показывает предупреждение «Улучшенной защиты»** — это стандартное сообщение для расширений от новых разработчиков. Нажмите «Продолжить установку». Расширение не собирает и не передаёт данные, весь код открыт в этом репозитории.

**Языки интерфейса:** русский, английский, украинский, узбекский, татарский.
