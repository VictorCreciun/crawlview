import type { CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

/* Content extraction, deliberately close to what a retrieval pipeline does.
   The point is not to be perfect — it is to fail in the same places a real
   extractor fails, so the report tells you something true about how your page
   will be read by a machine. */

const STRIP = [
  "script", "style", "noscript", "template", "svg", "canvas", "iframe",
  "form", "button", "select", "textarea", "input", "video", "audio",
];

/** Containers that almost never hold the article body. Removed only when a
 *  better candidate exists, so a page that is nothing but <nav> still reports
 *  its words instead of reporting zero. */
const CHROME = ["nav", "header", "footer", "aside", "[role=navigation]", "[role=banner]", "[role=contentinfo]"];

export function normalise(text: string): string {
  return text.replace(/ /g, " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function countWords(text: string): number {
  if (!text) return 0;
  // Counts CJK characters individually: they carry a word's worth of meaning
  // each, and splitting on whitespace would report a Japanese page as ~zero.
  const cjk = text.match(/[぀-ヿ一-鿿가-힯]/g)?.length ?? 0;
  const words = text.replace(/[぀-ヿ一-鿿가-힯]/g, " ")
    .split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return words + cjk;
}

function linkDensity($: CheerioAPI, node: AnyNode): number {
  const el = $(node);
  const total = el.text().trim().length;
  if (total === 0) return 1;
  const linked = el.find("a").text().trim().length;
  return linked / total;
}

/** Returns an element's tag name, for reporting which container won. */
function tagOf(node: AnyNode | undefined): string {
  return node && "tagName" in node ? node.tagName : "div";
}

/** Picks the element most likely to hold the body copy, then returns its text.
 *  Scoring is text length discounted by how much of it sits inside links —
 *  the signal that separates an article from a menu. */
export function extractReadable($: CheerioAPI): { text: string; container: string } {
  const work = $.root().clone();
  work.find(STRIP.join(",")).remove();
  work.find("[hidden], [aria-hidden=true], [style*='display:none'], [style*='display: none']").remove();

  const explicit = work.find("main, article, [role=main]").first();
  if (explicit.length && countWords(explicit.text()) > 40) {
    const clone = explicit.clone();
    clone.find(CHROME.join(",")).remove();
    return { text: normalise(clone.text()), container: tagOf(explicit.get(0)) };
  }

  let bestNode: AnyNode | null = null;
  let bestScore = -Infinity;
  work.find("div, section, td, li").each((_, node) => {
    const el = $(node);
    const length = el.text().trim().length;
    if (length < 200) return;
    const density = linkDensity($, node);
    if (density > 0.5) return;
    // Nesting penalty keeps a wrapper from beating the block it contains.
    const depth = el.parents().length;
    const score = length * (1 - density) - depth * 25;
    if (score > bestScore) {
      bestScore = score;
      bestNode = node;
    }
  });

  if (bestNode) {
    const winner: AnyNode = bestNode;
    const chosen = $(winner).clone();
    chosen.find(CHROME.join(",")).remove();
    const text = normalise(chosen.text());
    if (countWords(text) > 30) return { text, container: tagOf(winner) };
  }

  const body = work.find("body");
  return { text: normalise(body.length ? body.text() : work.text()), container: "body" };
}

/** All visible text, chrome included. Used for word counts, where the question
 *  is "did anything at all survive", not "what is the article". */
export function visibleText($: CheerioAPI): string {
  const work = $.root().clone();
  work.find(STRIP.join(",")).remove();
  const body = work.find("body");
  return normalise(body.length ? body.text() : work.text());
}
