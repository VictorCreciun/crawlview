import type { Finding, PageReport, RunOptions } from "../types.js";
import { capture, pool } from "../fetch.js";
import { parseHtml } from "../extract/html.js";
import { baseLang, confusable } from "../extract/language.js";
import { BROWSER_UA } from "../agents.js";
import { fetched, finding, truncate, unique } from "./util.js";

/** Declared language against the language the text is actually written in,
 *  plus hreflang correctness. The first half is the check that finds the bug
 *  nobody looks for: a translated route serving the wrong language's copy
 *  while confidently declaring the right one. */
export async function checkLanguage(report: PageReport, opts: RunOptions): Promise<Finding[]> {
  const out: Finding[] = [];
  const results = fetched(report);
  if (!results.length) return out;

  const facts = report.browser?.facts ?? results[0]!.facts!;
  const url = report.browser?.capture.finalUrl ?? results[0]!.capture!.finalUrl;

  const declared = baseLang(facts.htmlLang);
  const detected = facts.detectedLang;

  if (!facts.htmlLang) {
    out.push(finding("lang-missing", "warn", "The <html> element declares no language.",
      { detail: "Translation, text-to-speech and language-targeted search all start from this attribute." }));
  } else if (!declared) {
    out.push(finding("lang-invalid", "warn", `lang="${facts.htmlLang}" is not a valid language tag.`));
  }

  // The signature check.
  if (declared && detected && facts.wordCount >= 40) {
    if (declared !== detected && !confusable(declared, detected)) {
      const confidence = Math.round(facts.detectedLangConfidence * 100);
      out.push(finding("lang-mismatch", "error",
        `The page declares lang="${declared}" but the text reads as ${detected}.`,
        { detail: "Usually a translated route that renders the default language: the URL and the attribute are right, the copy never switched. The tell is that every language version has the same word count. Search engines index it under the wrong language and stop showing it to the audience it was written for.",
          evidence: [`detected ${detected} at ${confidence}% confidence`, truncate(facts.text, 140)] }));
    }
  }

  // A path segment that promises a language the page does not deliver.
  const segment = new URL(url).pathname.split("/").filter(Boolean)[0];
  const fromPath = segment && /^[a-z]{2}(-[a-z]{2})?$/i.test(segment) ? baseLang(segment) : null;
  if (fromPath && declared && fromPath !== declared && !confusable(fromPath, declared)) {
    out.push(finding("lang-path-mismatch", "warn",
      `The URL says /${segment}/ but the page declares lang="${declared}".`));
  }

  // --- hreflang ----------------------------------------------------------------
  const alternates = facts.hreflang;
  if (!alternates.length) {
    if (fromPath) {
      out.push(finding("hreflang-absent", "warn",
        "The URL is language-scoped but the page carries no hreflang links.",
        { detail: "Without them each translation competes with the others instead of being offered to the right audience." }));
    }
    return out;
  }

  const tags = alternates.map((a) => a.lang.toLowerCase());
  const duplicates = unique(tags.filter((t, i) => tags.indexOf(t) !== i));
  if (duplicates.length) {
    out.push(finding("hreflang-duplicate", "error", "The same hreflang value is declared more than once.",
      { evidence: duplicates }));
  }

  const invalid = alternates.filter((a) => a.lang.toLowerCase() !== "x-default" && !/^[a-z]{2,3}(-[a-z]{2,4})?(-[a-z]{2}|-\d{3})?$/i.test(a.lang));
  if (invalid.length) {
    out.push(finding("hreflang-invalid", "error", "An hreflang value is not a valid language tag.",
      { evidence: invalid.map((a) => a.lang) }));
  }

  if (!tags.includes("x-default")) {
    out.push(finding("hreflang-no-xdefault", "info", "No x-default is declared.",
      { detail: "It names the page to serve when no translation matches the visitor." }));
  }

  const selfUrl = (facts.canonical ?? url).replace(/\/$/, "");
  const hasSelf = alternates.some((a) => a.href.replace(/\/$/, "") === selfUrl);
  if (!hasSelf) {
    out.push(finding("hreflang-no-self", "error", "The page does not list itself among its hreflang alternates.",
      { detail: "A set where one member omits itself is discarded whole — the other translations lose their links too.",
        evidence: [`page: ${selfUrl}`, ...alternates.slice(0, 4).map((a) => `${a.lang}: ${a.href}`)] }));
  }

  // Reciprocity. Each alternate has to point back, or the set is ignored.
  const targets = alternates
    .filter((a) => a.href.replace(/\/$/, "") !== selfUrl)
    .slice(0, 12);

  if (targets.length) {
    const fetchedAlternates = await pool(targets, Math.min(opts.concurrency, 4), opts.delayMs, async (alt) => {
      const cap = await capture({ url: alt.href, ua: BROWSER_UA, agentId: "hreflang" }, opts);
      if (cap.error || !cap.ok) return { alt, ok: false, back: [] as string[], status: cap.status, error: cap.error };
      const parsed = parseHtml(cap.html, cap.finalUrl);
      return {
        alt,
        ok: true,
        back: parsed.hreflang.map((h) => h.href.replace(/\/$/, "")),
        status: cap.status,
        error: undefined as string | undefined,
      };
    });

    const broken = fetchedAlternates.filter((r) => !r.ok);
    if (broken.length) {
      out.push(finding("hreflang-unreachable", "error",
        `${broken.length} hreflang ${broken.length === 1 ? "target does" : "targets do"} not load.`,
        { evidence: broken.map((b) => `${b.alt.lang}: ${b.alt.href} → ${b.error ?? b.status}`) }));
    }

    const oneWay = fetchedAlternates.filter((r) => r.ok && !r.back.includes(selfUrl));
    if (oneWay.length) {
      out.push(finding("hreflang-not-reciprocal", "error",
        `${oneWay.length} hreflang ${oneWay.length === 1 ? "link is" : "links are"} not returned.`,
        { detail: "hreflang only counts when both pages name each other. A one-way declaration is dropped in full.",
          evidence: oneWay.map((r) => `${r.alt.lang}: ${r.alt.href} does not link back to ${selfUrl}`) }));
    }

    // The same content served under several language tags.
    if (!oneWay.length && !broken.length) {
      out.push(finding("hreflang-reciprocal", "ok",
        `All ${targets.length} hreflang alternates link back.`));
    }
  }

  return out;
}
