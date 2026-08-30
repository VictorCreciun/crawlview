import type { Finding, PageReport } from "../types.js";
import { fetched, finding, truncate, unique } from "./util.js";

const INDEXING_DIRECTIVES = /\b(noindex|nofollow|none|noarchive|nosnippet|max-snippet|max-image-preview|unavailable_after)\b/i;

/** Title, description, headings, canonical, and the two ways a page can tell
 *  a crawler to forget it exists. */
export function checkBasics(report: PageReport): Finding[] {
  const out: Finding[] = [];
  const results = fetched(report);
  if (!results.length) return out;

  // Prefer the browser view for content questions when we have it: judging a
  // client-rendered page's H1 from the bot view would report the same defect
  // twice, once here and once as a divergence.
  const primary = report.browser?.facts ?? results[0]!.facts!;
  const primaryCapture = report.browser?.capture ?? results[0]!.capture!;

  if (!primary.title) {
    out.push(finding("title-missing", "error", "The page has no <title>."));
  } else if (primary.title.length > 65) {
    out.push(finding("title-long", "info", `Title is ${primary.title.length} characters; search results cut around 60.`,
      { evidence: [primary.title] }));
  }

  if (!primary.metaDescription) {
    out.push(finding("description-missing", "warn", "No meta description.",
      { detail: "Search engines will invent one from the page text, and so will an LLM summarising it." }));
  }

  const h1s = primary.headings.filter((h) => h.level === 1);
  if (h1s.length === 0) {
    out.push(finding("h1-missing", "warn", "No <h1> on the page.",
      { detail: "Retrieval pipelines chunk by heading. A page with no top-level heading has no title for its own content." }));
  } else if (h1s.length > 1) {
    out.push(finding("h1-multiple", "info", `${h1s.length} <h1> elements.`,
      { evidence: h1s.map((h) => truncate(h.text, 60)).slice(0, 4) }));
  }

  // Heading hierarchy: a jump from h2 to h4 leaves the h4 with no parent, and
  // chunkers that build a tree from headings will attach it to the wrong node.
  const levels = primary.headings.map((h) => h.level);
  const jumps: string[] = [];
  for (let i = 1; i < levels.length; i++) {
    const from = levels[i - 1]!;
    const to = levels[i]!;
    if (to - from > 1) jumps.push(`h${from} → h${to}`);
  }
  if (jumps.length) {
    out.push(finding("heading-skip", "info", `Heading levels skip a step (${unique(jumps).join(", ")}).`,
      { detail: "Sections end up nested under the wrong parent when a machine builds an outline from the headings." }));
  }

  // Canonical.
  if (!primary.canonical) {
    out.push(finding("canonical-missing", "warn", "No canonical link.",
      { detail: "Any URL variant — trailing slash, query string, protocol — can be treated as a separate page." }));
  } else {
    let canonicalHost: string | null = null;
    try { canonicalHost = new URL(primary.canonical).host; } catch { /* reported below */ }
    if (!canonicalHost) {
      out.push(finding("canonical-invalid", "error", "The canonical link is not a valid URL.",
        { evidence: [primary.canonical] }));
    } else if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i.test(canonicalHost)) {
      out.push(finding("canonical-localhost", "error", "The canonical points at localhost.",
        { detail: "A prerender or static build shipped with the render host baked in. Every page is telling crawlers its real address is on someone's laptop.",
          evidence: [primary.canonical] }));
    } else {
      const pageHost = new URL(primaryCapture.finalUrl).host;
      if (canonicalHost !== pageHost) {
        out.push(finding("canonical-offsite", "warn", `The canonical points to a different host (${canonicalHost}).`,
          { detail: "Correct when the content genuinely lives elsewhere; otherwise this hands the page to another domain.",
            evidence: [primary.canonical] }));
      } else {
        const a = new URL(primary.canonical);
        const b = new URL(primaryCapture.finalUrl);
        const norm = (u: URL) => u.pathname.replace(/\/+$/, "") + u.search;
        if (norm(a) !== norm(b)) {
          out.push(finding("canonical-elsewhere", "info", "The canonical points at a different path on this site.",
            { evidence: [`page: ${primaryCapture.finalUrl}`, `canonical: ${primary.canonical}`] }));
        }
      }
    }
  }

  // meta robots and the header that silently outranks it.
  const headerRobots = Object.entries(primaryCapture.headers)
    .filter(([k]) => k.toLowerCase() === "x-robots-tag")
    .map(([, v]) => v);
  const metaRobots = primary.metaRobots;

  const headerBlocks = headerRobots.some((v) => /\bnoindex|\bnone\b/i.test(v));
  const metaBlocks = metaRobots.some((m) => /\bnoindex\b|\bnone\b/i.test(m.content));

  if (headerBlocks) {
    out.push(finding("noindex-header", "error", "An X-Robots-Tag header tells crawlers not to index this page.",
      { detail: "The header is invisible in the page source, which is why it survives so long. It also outranks any meta tag saying otherwise.",
        evidence: headerRobots.map((v) => `X-Robots-Tag: ${v}`) }));
  }
  if (metaBlocks && !headerBlocks) {
    out.push(finding("noindex-meta", "error", "A meta robots tag tells crawlers not to index this page.",
      { evidence: metaRobots.filter((m) => /noindex|none/i.test(m.content)).map((m) => `<meta name="${m.name}" content="${m.content}">`) }));
  }
  if (headerRobots.length && metaRobots.length && headerBlocks !== metaBlocks) {
    out.push(finding("robots-conflict", "error", "The X-Robots-Tag header and the meta robots tag disagree.",
      { detail: "The header wins. If the meta tag is the one you maintain, the page is not doing what you think.",
        evidence: [...headerRobots.map((v) => `header: ${v}`), ...metaRobots.map((m) => `meta ${m.name}: ${m.content}`)] }));
  }

  // A directive nobody reads: `googlebot` overrides `robots` for Google only.
  const generic = metaRobots.find((m) => m.name === "robots");
  const google = metaRobots.find((m) => m.name === "googlebot");
  if (generic && google && generic.content.trim().toLowerCase() !== google.content.trim().toLowerCase()) {
    out.push(finding("robots-meta-split", "info", "Google is given different robots directives from everyone else.",
      { evidence: [`robots: ${generic.content}`, `googlebot: ${google.content}`] }));
  }

  if (INDEXING_DIRECTIVES.test(headerRobots.join(" ")) && !headerBlocks) {
    out.push(finding("robots-header-present", "info", "An X-Robots-Tag header is set on this page.",
      { evidence: headerRobots }));
  }

  return out;
}
