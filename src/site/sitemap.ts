import { fetchText } from "../fetch.js";
import { BROWSER_UA } from "../agents.js";
import type { RunOptions } from "../types.js";

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

/** Minimal XML pulling, deliberately not a parser. Sitemaps are a fixed,
 *  shallow shape and pulling <loc> out with a regex avoids a dependency that
 *  would otherwise be the heaviest thing in the package. */
function tags(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) out.push(match[1]!.trim());
  return out;
}

function decodeEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

export interface SitemapResult {
  entries: SitemapEntry[];
  sources: string[];
  errors: string[];
}

/** Follows sitemap indexes one level deep, which covers every sitemap anyone
 *  actually ships. Depth is capped so a self-referencing index cannot loop. */
export async function loadSitemap(url: string, opts: RunOptions, depth = 0): Promise<SitemapResult> {
  const result: SitemapResult = { entries: [], sources: [url], errors: [] };
  const res = await fetchText(url, opts, BROWSER_UA);

  if (res.status !== 200 || !res.body) {
    result.errors.push(`${url} → ${res.error ?? res.status}`);
    return result;
  }

  const body = res.body;

  // A sitemap index points at other sitemaps.
  if (/<sitemapindex/i.test(body)) {
    if (depth >= 2) {
      result.errors.push(`${url}: sitemap index nested too deep`);
      return result;
    }
    const children = tags(body, "sitemap").map((block) => decodeEntities(tags(block, "loc")[0] ?? "")).filter(Boolean);
    for (const child of children.slice(0, 50)) {
      const nested = await loadSitemap(child, opts, depth + 1);
      result.entries.push(...nested.entries);
      result.sources.push(...nested.sources);
      result.errors.push(...nested.errors);
    }
    return result;
  }

  // A plain-text sitemap is legal: one URL per line.
  if (!/<urlset/i.test(body) && /^https?:\/\//m.test(body)) {
    for (const line of body.split(/\r?\n/)) {
      const loc = line.trim();
      if (/^https?:\/\//i.test(loc)) result.entries.push({ loc, lastmod: null });
    }
    return result;
  }

  for (const block of tags(body, "url")) {
    const loc = decodeEntities(tags(block, "loc")[0] ?? "");
    if (!loc) continue;
    const lastmod = decodeEntities(tags(block, "lastmod")[0] ?? "") || null;
    result.entries.push({ loc, lastmod });
  }

  return result;
}

/** Where to look when the user did not name a sitemap: the declarations in
 *  robots.txt first, then the conventional locations. */
export function candidateSitemaps(origin: string, declared: string[]): string[] {
  const guesses = [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap-index.xml`,
    `${origin}/sitemap.txt`,
  ];
  return [...new Set([...declared, ...guesses])];
}
