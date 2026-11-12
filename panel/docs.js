// "How to fix" documentation links per issue (official Google / Yandex / web.dev / schema.org pages).
const G = 'https://developers.google.com/search/docs/';
const RULES = [
  [/^title_|_h1_noshare|title_spam/, G + 'appearance/title-link'],
  [/^desc_|desc_eq_h1|title_eq_desc/, G + 'appearance/snippet'],
  [/^(noindex|nofollow_page|noindex_raw|canonical_noindex)$/, G + 'crawling-indexing/robots-meta-tag'],
  [/^robots_|^res_blocked/, G + 'crawling-indexing/robots/intro'],
  [/^ai_blocked$/, G + 'crawling-indexing/google-common-crawlers'],
  [/^(canonical_|can_target|pagination_canonical|var_page_dup|sm_noncanonical)/, G + 'crawling-indexing/consolidate-duplicate-urls'],
  [/^(sitemap_|sm_)/, G + 'crawling-indexing/sitemaps/build-sitemap'],
  [/^hl_/, G + 'specialty/international/localized-versions'],
  [/^(lang_missing|lang_mismatch)$/, G + 'specialty/international/managing-multi-regional-sites'],
  [/^product_/, G + 'appearance/structured-data/product'],
  [/^(breadcrumb_bad|no_breadcrumbs)$/, G + 'appearance/structured-data/breadcrumb'],
  [/^article_/, G + 'appearance/structured-data/article'],
  [/^no_org_schema$/, G + 'appearance/structured-data/organization'],
  [/^(schema_|jsonld_)/, G + 'appearance/structured-data/intro-structured-data'],
  [/^img_/, G + 'appearance/google-images'],
  [/^lcp_/, 'https://web.dev/articles/lcp'],
  [/^cls_|^img_nosize$/, 'https://web.dev/articles/cls'],
  [/^inp_/, 'https://web.dev/articles/inp'],
  [/^(redirect_chain|var_|meta_refresh)/, G + 'crawling-indexing/301-redirects'],
  [/^(soft_404|soft404_page|false404_page|odd_404|bare_404|status_error)$/, G + 'crawling-indexing/http-network-errors'],
  [/^js_|^outside_html$/, G + 'crawling-indexing/javascript/javascript-seo-basics'],
  [/^(links_js|links_bad|links_vague|links_hidden|links_nofollow_internal|dup_links)$/, G + 'crawling-indexing/links-crawlable'],
  [/^(viewport_|mobile_)/, G + 'crawling-indexing/mobile/mobile-sites-mobile-first-indexing'],
  [/^(mixed|form_insecure)$/, 'https://web.dev/articles/what-is-mixed-content'],
  [/^(no_https|no_hsts)$/, 'https://web.dev/articles/why-https-matters'],
  [/^favicon_missing$/, G + 'appearance/favicon-in-search'],
  [/^(og_missing|twitter_missing)$/, 'https://ogp.me/'],
  [/^url_issues$/, G + 'crawling-indexing/url-structure'],
  [/^clean_param_hit$/, 'https://yandex.ru/support/webmaster/robot-workings/clean-param.html'],
  [/^(no_compression|ttfb_slow|blocking_|broken_resources|old_http)/, 'https://web.dev/articles/fast'],
];

export function docFor(id) {
  for (const [re, url] of RULES) if (re.test(id)) return url;
  return null;
}
