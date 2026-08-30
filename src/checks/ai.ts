import type { Finding, PageFacts, PageReport } from "../types.js";
import { countWords } from "../extract/text.js";
import { fetched, finding, pct, truncate } from "./util.js";

/* Whether a language model can use the page, which is a different question
   from whether a crawler can fetch it. A page can be perfectly indexed and
   still be useless to a retrieval pipeline. */

/** Approximates what a retrieval pipeline keeps: the readable body, split at
 *  headings. Sections are what gets embedded and returned, so their shape
 *  decides whether the page is quotable or just present. */
function sections(facts: PageFacts): { heading: string; words: number }[] {
  if (!facts.headings.length) return [{ heading: "(no headings)", words: facts.wordCount }];
  const text = facts.text;
  const marks: { heading: string; index: number }[] = [];
  for (const h of facts.headings) {
    if (h.level > 3 || !h.text) continue;
    const index = text.indexOf(h.text);
    if (index >= 0) marks.push({ heading: h.text, index });
  }
  marks.sort((a, b) => a.index - b.index);
  if (!marks.length) return [{ heading: "(headings not in body text)", words: facts.wordCount }];

  const out: { heading: string; words: number }[] = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i]!.index;
    const end = i + 1 < marks.length ? marks[i + 1]!.index : text.length;
    out.push({ heading: marks[i]!.heading, words: countWords(text.slice(start, end)) });
  }
  return out;
}

/** Joins a list the way a sentence needs it: "a, no b and no c". */
function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", no ")} and no ${items[items.length - 1]}`;
}

export function checkAi(report: PageReport): Finding[] {
  const out: Finding[] = [];
  const results = fetched(report);
  if (!results.length) return out;

  // Deliberately the bot view, not the browser view: this is about what a
  // model receives, and most AI crawlers never run JavaScript.
  const botView = results.find((r) => r.agent.group === "ai") ?? results[0]!;
  const facts = botView.facts!;

  // --- llms.txt ---------------------------------------------------------------
  if (report.llmsTxt) {
    if (report.llmsTxt.present) {
      out.push(finding("llms-txt-present", "ok", "The site publishes /llms.txt."));
    } else {
      out.push(finding("llms-txt-absent", "info", "No /llms.txt.",
        { detail: "An emerging convention: a plain-text map of the site written for models rather than crawlers. Optional, cheap, and nothing else fills the role." }));
    }
  }

  // --- Is there anything to extract at all ------------------------------------
  const readableWords = countWords(facts.text);
  /* A listing page is a list. There is no article buried in it to be kept or
     lost, so measuring how much prose survives extraction says nothing — it
     fired on every category page of a shop, each of which was working exactly
     as intended. An ItemList is the page telling us what it is. */
  const isListing = facts.jsonLd.some((b) => b.types.includes("ItemList"));
  if (!isListing && facts.wordCount >= 100 && pct(readableWords, facts.wordCount) < 35) {
    /* The usual cure is a <main> or <article> wrapper — but only when there is
       not one already. Recommending it to a page that has it reads as advice
       from something that did not look. */
    /* <main> only, deliberately. An <article> is not a landmark for this
       purpose: a product card is an <article>, a comment is an <article>, and
       a grid of twelve of them says nothing about whether the body copy has a
       wrapper. Matching them made the advice claim a page "already has" one
       when it plainly did not. */
    const hasLandmark = /<main\b|role=["']main["']/i.test(results[0]?.capture?.html ?? "");
    out.push(finding("extraction-poor", "warn",
      `Only ${pct(readableWords, facts.wordCount)}% of the page's text survives content extraction.`,
      { group: "Little of the page's text survives content extraction.",
        detail: hasLandmark
          ? "The body copy is not distinguishable from navigation and boilerplate. The page already has a <main> or <article>, so the wrapper is not the problem: the landmark is holding the furniture as well as the content."
          : "The body copy is not distinguishable from navigation and boilerplate, so an extractor keeps the wrong part. Wrapping the article in <main> or <article> is usually the whole fix.",
        evidence: [`${facts.wordCount} words on the page, ${readableWords} in the extracted body`] }));
  }

  if (readableWords > 0 && readableWords < 120 && facts.wordCount >= 120) {
    out.push(finding("extraction-thin", "info",
      `Content extraction keeps only ${readableWords} words.`,
      { detail: "Below roughly 150 words a page rarely holds enough to be worth citing." }));
  }

  // --- Section shape ----------------------------------------------------------
  const parts = sections(facts);
  if (parts.length > 1) {
    const oversized = parts.filter((s) => s.words > 900);
    const tiny = parts.filter((s) => s.words < 15);
    if (oversized.length) {
      out.push(finding("chunk-oversized", "info",
        `${oversized.length} section${oversized.length > 1 ? "s run" : " runs"} past 900 words without a heading.`,
        { detail: "Long unbroken sections get split mid-thought when a pipeline chunks them, and the fragment that comes back may not carry its own context.",
          evidence: oversized.slice(0, 3).map((s) => `${truncate(s.heading, 50)} — ${s.words} words`) }));
    }
    if (tiny.length > parts.length / 2) {
      out.push(finding("chunk-fragmented", "info",
        "Most sections hold almost no text.",
        { detail: "Headings used for layout rather than structure. An outline built from them describes nothing." }));
    }
  }

  // --- Citability -------------------------------------------------------------
  const missing: string[] = [];
  const hasDate = facts.jsonLd.some((b) =>
    /"date(Published|Modified)"/.test(b.raw)) || facts.headings.length > 0 && /\b(20\d{2})\b/.test(facts.text.slice(0, 400));
  const hasAuthor = facts.jsonLd.some((b) => /"author"/.test(b.raw));
  if (!hasDate) missing.push("publication date");
  if (!hasAuthor) missing.push("author");
  if (!facts.canonical) missing.push("canonical URL");
  const anchored = facts.headings.filter((h) => h.level <= 3 && h.id).length;
  const anchorable = facts.headings.filter((h) => h.level <= 3).length;
  if (anchorable >= 3 && anchored < anchorable / 2) missing.push("stable heading anchors");

  if (missing.length >= 2) {
    out.push(finding("citability-weak", "info",
      `The page gives a model little to cite: no ${list(missing)}.`,
      { group: "The page gives a model little to cite.",
        detail: "Assistants prefer sources they can attribute and link precisely. These cost nothing to add and decide whether you are quoted or merely read." }));
  }

  // --- The AI-specific view ----------------------------------------------------
  const aiAgents = results.filter((r) => r.agent.group === "ai");
  if (aiAgents.length) {
    const worst = aiAgents.reduce((acc, r) => Math.min(acc, r.facts!.wordCount), Number.POSITIVE_INFINITY);
    // 120 words is roughly where a page stops being a stub and starts holding
    // something an assistant could quote. Below that the divergence check has
    // already said the page is empty, and saying it twice adds nothing.
    if (worst < 50 && (report.browser?.facts.wordCount ?? 0) > 120) {
      out.push(finding("ai-sees-nothing", "error",
        "AI crawlers receive an effectively empty page.",
        { detail: "None of them run JavaScript. Whatever the page is about, an assistant asked about this topic has nothing from you to quote.",
          agents: aiAgents.map((a) => a.agent.id) }));
    }
  }

  // --- Preview cards -----------------------------------------------------------
  const og = facts.openGraph;
  const ogMissing = ["title", "description", "image"].filter((k) => !(k in og));
  if (!Object.keys(og).length) {
    out.push(finding("og-absent", "warn", "No Open Graph tags.",
      { detail: "Every share on Slack, WhatsApp, LinkedIn and Facebook will render as a bare link." }));
  } else if (ogMissing.length) {
    out.push(finding("og-incomplete", "info", `Open Graph is missing: ${ogMissing.join(", ")}.`));
  }

  return out;
}
