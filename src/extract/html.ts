/* The slim entry point, deliberately: cheerio's main entry re-exports a
   `fromURL` helper that drags in undici, which we never call and which alone
   is larger than the rest of the dependency tree. */
import * as cheerio from "cheerio/slim";
import type { CheerioAPI } from "cheerio";
import type { HeadingNode, HreflangNode, JsonLdBlock, LinkNode, PageFacts } from "../types.js";
import { countWords, extractReadable, normalise, visibleText } from "./text.js";
import { detectLanguage } from "./language.js";

function abs(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function sameSite(a: string | null, base: string): boolean {
  if (!a) return false;
  try {
    return new URL(a).host === new URL(base).host;
  } catch {
    return false;
  }
}

function collectTypes(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectTypes(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const type = record["@type"];
  if (typeof type === "string") out.add(type);
  else if (Array.isArray(type)) for (const t of type) if (typeof t === "string") out.add(t);
  for (const key of Object.keys(record)) collectTypes(record[key], out);
}

function parseJsonLd($: CheerioAPI): JsonLdBlock[] {
  const blocks: JsonLdBlock[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text();
    const types = new Set<string>();
    try {
      const parsed = JSON.parse(raw) as unknown;
      collectTypes(parsed, types);
      blocks.push({ raw, parsed, error: null, types: [...types] });
    } catch (err) {
      blocks.push({
        raw,
        parsed: null,
        error: err instanceof Error ? err.message : String(err),
        types: [],
      });
    }
  });
  return blocks;
}

/** Every `<meta name="robots">` variant, including the engine-specific ones.
 *  `googlebot` overrides `robots` for Google alone, and a page can carry both
 *  with opposite values — which is exactly the kind of thing nobody notices. */
function parseMetaRobots($: CheerioAPI): { name: string; content: string }[] {
  const found: { name: string; content: string }[] = [];
  $("meta[name]").each((_, el) => {
    const name = ($(el).attr("name") ?? "").trim().toLowerCase();
    if (!/^(robots|googlebot|googlebot-news|bingbot|slurp|msnbot|yandex)$/.test(name)) return;
    found.push({ name, content: ($(el).attr("content") ?? "").trim() });
  });
  return found;
}

export function parseHtml(html: string, baseUrl: string): PageFacts {
  const $ = cheerio.load(html);

  const canonicalRaw = $('link[rel="canonical"]').first().attr("href") ?? null;
  const headings: HeadingNode[] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const tag = (el as { tagName?: string }).tagName ?? "h1";
    headings.push({
      level: Number.parseInt(tag.slice(1), 10) || 1,
      text: normalise($(el).text()),
      id: $(el).attr("id") ?? null,
    });
  });

  const links: LinkNode[] = [];
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (!href || href.startsWith("#") || /^(javascript|mailto|tel):/i.test(href)) return;
    const absolute = abs(href, baseUrl);
    const rel = $(el).attr("rel") ?? null;
    links.push({
      href,
      absolute,
      text: normalise($(el).text()).slice(0, 120),
      rel,
      internal: sameSite(absolute, baseUrl),
      nofollow: /\bnofollow\b/i.test(rel ?? ""),
    });
  });

  const hreflang: HreflangNode[] = [];
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    const lang = ($(el).attr("hreflang") ?? "").trim();
    const href = ($(el).attr("href") ?? "").trim();
    if (lang && href) hreflang.push({ lang, href: abs(href, baseUrl) ?? href });
  });

  const openGraph: Record<string, string> = {};
  $('meta[property^="og:"]').each((_, el) => {
    const key = ($(el).attr("property") ?? "").slice(3);
    const value = ($(el).attr("content") ?? "").trim();
    if (key && value && !(key in openGraph)) openGraph[key] = value;
  });

  const twitter: Record<string, string> = {};
  $('meta[name^="twitter:"]').each((_, el) => {
    const key = ($(el).attr("name") ?? "").slice(8);
    const value = ($(el).attr("content") ?? "").trim();
    if (key && value && !(key in twitter)) twitter[key] = value;
  });

  const images: { src: string; alt: string | null }[] = [];
  $("img[src]").each((_, el) => {
    images.push({ src: ($(el).attr("src") ?? "").trim(), alt: $(el).attr("alt") ?? null });
  });

  let scriptBytes = 0;
  $("script").each((_, el) => { scriptBytes += $(el).text().length; });

  const readable = extractReadable($);
  const allText = visibleText($);
  // Word count uses the whole visible page: the question a divergence check
  // asks is "did anything survive", and holding it to the article extractor's
  // opinion would blame the extractor for a server that returned an empty div.
  const wordCount = countWords(allText);
  const detected = detectLanguage(readable.text.length > 200 ? readable.text : allText);

  const noscript = $("noscript").text();

  return {
    title: $("title").first().text().trim() || null,
    metaDescription: $('meta[name="description"]').first().attr("content")?.trim() ?? null,
    canonical: canonicalRaw ? abs(canonicalRaw, baseUrl) : null,
    metaRobots: parseMetaRobots($),
    htmlLang: $("html").attr("lang")?.trim() ?? null,
    headings,
    links,
    hreflang,
    jsonLd: parseJsonLd($),
    images,
    text: readable.text,
    wordCount,
    detectedLang: detected.lang,
    detectedLangConfidence: detected.confidence,
    openGraph,
    twitter,
    scriptBytes,
    hasNoscriptContent: countWords(normalise(noscript)) > 20,
  };
}
