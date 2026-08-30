import type { Finding, JsonLdBlock, PageFacts, PageReport } from "../types.js";
import { fetched, finding, truncate, unique } from "./util.js";

/* What Google documents as required and recommended for the types people
   actually ship. Kept small on purpose: a half-remembered rule that fires a
   false error is worse than no rule, so anything uncertain is left out. */
interface TypeSpec {
  required: string[];
  recommended: string[];
  /** The rich result this type is eligible for, when there is one. */
  richResult?: string;
}

const SPECS: Record<string, TypeSpec> = {
  Article: { required: ["headline"], recommended: ["image", "datePublished", "author"], richResult: "Article" },
  BlogPosting: { required: ["headline"], recommended: ["image", "datePublished", "author"], richResult: "Article" },
  NewsArticle: { required: ["headline"], recommended: ["image", "datePublished", "author"], richResult: "Article" },
  TechArticle: { required: ["headline"], recommended: ["image", "datePublished", "author"], richResult: "Article" },
  Product: { required: ["name"], recommended: ["image", "offers", "description"], richResult: "Product snippet" },
  Organization: { required: ["name"], recommended: ["url", "logo", "sameAs"] },
  LocalBusiness: { required: ["name", "address"], recommended: ["telephone", "openingHours", "geo"], richResult: "Local business" },
  Person: { required: ["name"], recommended: ["url"] },
  FAQPage: { required: ["mainEntity"], recommended: [], richResult: "FAQ" },
  Question: { required: ["name", "acceptedAnswer"], recommended: [] },
  BreadcrumbList: { required: ["itemListElement"], recommended: [], richResult: "Breadcrumbs" },
  Event: { required: ["name", "startDate", "location"], recommended: ["endDate", "offers"], richResult: "Event" },
  Recipe: { required: ["name", "recipeIngredient", "recipeInstructions"], recommended: ["image", "totalTime"], richResult: "Recipe" },
  JobPosting: { required: ["title", "description", "datePosted", "hiringOrganization"], recommended: ["jobLocation", "baseSalary"], richResult: "Job posting" },
  VideoObject: { required: ["name", "thumbnailUrl", "uploadDate"], recommended: ["description", "duration"], richResult: "Video" },
  SoftwareApplication: { required: ["name"], recommended: ["applicationCategory", "operatingSystem", "offers"] },
  WebSite: { required: ["name", "url"], recommended: [] },
  AggregateRating: { required: ["ratingValue"], recommended: ["reviewCount", "bestRating"] },
  Review: { required: ["reviewRating"], recommended: ["author"] },
};

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Walks a JSON-LD document, @graph included, yielding every typed node. */
function* walk(value: unknown): Generator<Node> {
  if (Array.isArray(value)) {
    for (const item of value) yield* walk(item);
    return;
  }
  if (!isNode(value)) return;
  if ("@type" in value) yield value;
  for (const key of Object.keys(value)) {
    if (key === "@type") continue;
    yield* walk(value[key]);
  }
}

function typesOf(node: Node): string[] {
  const raw = node["@type"];
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === "string");
  return [];
}

/** Literal values a machine could check against the page. Objects and URLs are
 *  skipped: a URL is not something a reader sees written out. */
function literals(node: Node, key: string): string[] {
  const value = node[key];
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim() && !/^https?:\/\//i.test(v)) out.push(v.trim());
    else if (typeof v === "number") out.push(String(v));
  };
  if (Array.isArray(value)) value.forEach(push);
  else push(value);
  return out;
}

/** Normalises text for comparison: case, punctuation and whitespace collapse,
 *  so "+373 69 49 22 22" matches "+37369492222" on the page. */
function haystack(text: string): string {
  return text.toLowerCase().replace(/[\s ().,–—-]/g, "");
}

/** Words that carry no identifying weight in an address, and whose abbreviation
 *  is the usual reason a true value looks missing: a page writes "str. Alba
 *  Iulia 198" where the markup says "Strada Alba Iulia 198". */
const NOISE = new Set([
  "str", "strada", "street", "st", "bd", "bulevardul", "boulevard", "ave", "avenue",
  "ul", "улица", "sos", "soseaua", "road", "rd", "drive", "lane",
  "the", "and", "of", "nr", "no", "apt", "oficiul", "office", "etaj",
]);

/** The identifying parts of a value: words of three letters or more, and any
 *  run of digits, with the noise words removed. */
function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3 || /^\d+$/.test(t))
    .filter((t) => !NOISE.has(t));
}

/** Is this value present on the page? An exact normalised match settles the
 *  single-token case — a phone number, a rating. For anything longer, most of
 *  the identifying tokens have to appear, in any order and any wording. A
 *  street written with an abbreviation is on the page, and calling it missing
 *  is a false accusation about the most consequential check in here. */
function mentioned(needle: string, hay: string, hayTokens: Set<string>): boolean {
  const flat = haystack(needle);
  if (flat.length < 2) return true;
  if (hay.includes(flat)) return true;

  const parts = tokens(needle);
  /* Nothing identifying in it, so there is nothing to look for. This is also
     what covers schema.org notation: a priceRange of "$$" is a band, not words,
     and no page has ever printed it. A guard naming priceRange explicitly used
     to sit below this function; it never changed an outcome, because a value
     made only of symbols yields no tokens either way. */
  if (parts.length === 0) return true;
  if (parts.length === 1) return hayTokens.has(parts[0]!);
  return parts.filter((t) => hayTokens.has(t)).length / parts.length >= 0.7;
}


export function checkStructured(report: PageReport): Finding[] {
  const out: Finding[] = [];
  const results = fetched(report);
  if (!results.length) return out;

  const facts: PageFacts = report.browser?.facts ?? results[0]!.facts!;
  const blocks: JsonLdBlock[] = facts.jsonLd;

  for (const block of blocks) {
    if (block.error) {
      out.push(finding("jsonld-invalid", "error", "A JSON-LD block does not parse.",
        { detail: "An unparseable block is ignored in full — every type inside it is invisible.",
          evidence: [block.error, truncate(block.raw, 120)] }));
    }
  }

  const nodes: Node[] = [];
  for (const block of blocks) {
    if (block.parsed) for (const node of walk(block.parsed)) nodes.push(node);
  }

  if (!nodes.length) {
    if (blocks.length === 0) {
      out.push(finding("jsonld-absent", "info", "No structured data on the page.",
        { detail: "Not an error. It does mean no rich result is possible, and a model reading the page has to infer what it is about from prose alone." }));
    }
    return out;
  }

  const allTypes = unique(nodes.flatMap(typesOf));
  /* Deliberately the full visible text, not the extracted article. A phone
     number and an address live in the footer on nearly every site, and the
     article extractor throws footers away — checking against it accused three
     honest sites in a row of claiming things they plainly displayed. */
  const source = `${facts.visibleText} ${facts.title ?? ""} ${facts.metaDescription ?? ""}`;
  const pageText = haystack(source);
  const pageTokens = new Set(
    source.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean),
  );

  // --- Required and recommended properties -----------------------------------
  for (const node of nodes) {
    for (const type of typesOf(node)) {
      const spec = SPECS[type];
      if (!spec) continue;
      const missingRequired = spec.required.filter((key) => !(key in node) || node[key] === "" || node[key] == null);
      if (missingRequired.length) {
        out.push(finding("jsonld-required-missing", "error",
          `${type} is missing ${missingRequired.length === 1 ? "a required property" : "required properties"}: ${missingRequired.join(", ")}.`,
          { group: "A structured-data type is missing a required property.",
            detail: spec.richResult ? `Without it the page cannot qualify for the ${spec.richResult} rich result.` : undefined }));
      }
      const missingRecommended = spec.recommended.filter((key) => !(key in node));
      if (missingRecommended.length && !missingRequired.length) {
        out.push(finding("jsonld-recommended-missing", "info",
          `${type} omits recommended ${missingRecommended.length === 1 ? "property" : "properties"}: ${missingRecommended.join(", ")}.`));
      }
    }
  }

  /* --- ItemList against what the page renders ------------------------------
     A listing page marks up its items and then paginates them. The markup gets
     the whole result set, the grid gets a slice, and the difference is a set of
     products described to a search engine and shown to nobody.

     Worth its own check rather than leaving it to the claim comparison above:
     that one reported six unfamiliar prices, which says nothing about where to
     look. This says twenty-eight items marked up, twenty-two on the page. */
  const explainedByList = new Set<Node>();
  for (const node of nodes.filter((n) => typesOf(n).includes("ItemList"))) {
    const raw = node["itemListElement"];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (list.length < 3) continue;

    const named: string[] = [];
    for (const entry of list) {
      if (!isNode(entry)) continue;
      const inner = isNode(entry["item"]) ? (entry["item"] as Node) : entry;
      const name = inner["name"];
      if (typeof name === "string" && name.trim()) named.push(name.trim());
    }
    if (named.length < 3) continue;

    const missing = named.filter((name) => !mentioned(name.slice(0, 60), pageText, pageTokens));
    if (missing.length) {
      // Every value inside this list is now accounted for by one finding.
      for (const inner of walk(node)) explainedByList.add(inner);
      const share = Math.round((missing.length / named.length) * 100);
      out.push(finding("itemlist-not-on-page", "error",
        `ItemList marks up ${named.length} items; ${missing.length} of them ${missing.length === 1 ? "is" : "are"} not on the page.`,
        { group: "ItemList marks up items the page does not render.",
          detail: share >= 50
            ? "More than half the list exists only in the markup. Either the page paginates and the markup does not, or the list is describing a different page altogether."
            : "The usual cause is pagination: the markup receives the whole result set while the grid renders a slice. Mark up the items the page actually renders.",
          evidence: missing.slice(0, 5).map((n) => truncate(n, 60)) }));
    }
  }

  // --- The cross-check: structured data must not out-claim the page ----------
  // Google's own rule, and one almost nothing verifies. A claim the reader
  // cannot see is the definition of the markup being about something else.
  const CLAIMS: { key: string; label: string }[] = [
    { key: "price", label: "a price" },
    { key: "priceRange", label: "a price range" },
    { key: "telephone", label: "a phone number" },
    { key: "ratingValue", label: "a rating" },
    { key: "reviewCount", label: "a review count" },
    { key: "ratingCount", label: "a rating count" },
    { key: "streetAddress", label: "a street address" },
    { key: "openingHours", label: "opening hours" },
  ];

  const unsupported: string[] = [];
  for (const node of nodes) {
    if (explainedByList.has(node)) continue;
    for (const { key, label } of CLAIMS) {
      for (const value of literals(node, key)) {
        if (!mentioned(value, pageText, pageTokens)) {
          unsupported.push(`${key}: "${truncate(value, 40)}" — ${label} the page never shows`);
        }
      }
    }
  }
  if (unsupported.length) {
    out.push(finding("jsonld-unsupported-claim", "error",
      `Structured data states ${unsupported.length === 1 ? "a fact" : "facts"} the page itself does not.`,
      { group: "Structured data states facts the page itself does not.",
        detail: "Markup has to describe what a visitor can see. Claims that appear only in the JSON-LD are what manual actions for structured-data spam are issued for.",
        evidence: unsupported.slice(0, 6) }));
  }

  // --- Offers -----------------------------------------------------------------
  // Only offers attached to a Product need a price. An Offer inside an
  // OfferCatalog is a service listing — demanding priceCurrency there would
  // fire on every studio and agency site that publishes what it does.
  for (const node of nodes.filter((n) => typesOf(n).includes("Product"))) {
    const offers = node["offers"];
    const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
    for (const offer of list) {
      if (!isNode(offer)) continue;
      const missing = ["price", "priceCurrency"].filter((k) => !(k in offer) || offer[k] == null || offer[k] === "");
      if (missing.length) {
        out.push(finding("offer-no-price", "error",
          `A Product offer is missing ${missing.join(" and ")}.`,
          { detail: "Product rich results need a price and its currency; without them the offer block is dropped." }));
      }
    }
  }

  // --- Ratings without anything to rate --------------------------------------
  const ratingNodes = nodes.filter((n) => typesOf(n).includes("AggregateRating"));
  if (ratingNodes.length) {
    const hasReviews = nodes.some((n) => typesOf(n).includes("Review"));
    const reviewWordsOnPage =
      /\b(review|reviews|rating|rated|stars?|testimonial|recenzi\w*|отзыв\w*)\b/i.test(facts.visibleText);
    if (!hasReviews && !reviewWordsOnPage) {
      out.push(finding("aggregaterating-unsupported", "error",
        "AggregateRating is declared but the page shows no reviews.",
        { detail: "A star rating in search results has to come from ratings the visitor can read on the same page. This is the single most common cause of a structured-data manual action." }));
    }
    for (const node of ratingNodes) {
      const value = Number(node["ratingValue"]);
      const best = Number(node["bestRating"] ?? 5);
      if (Number.isFinite(value) && Number.isFinite(best) && (value > best || value < 0)) {
        out.push(finding("rating-out-of-range", "error",
          `ratingValue ${value} is outside the 0–${best} scale it declares.`));
      }
      const count = Number(node["reviewCount"] ?? node["ratingCount"]);
      if (Number.isFinite(count) && count <= 0) {
        out.push(finding("rating-zero-count", "error", "AggregateRating declares zero reviews."));
      }
    }
  }

  // --- Breadcrumbs ------------------------------------------------------------
  for (const node of nodes.filter((n) => typesOf(n).includes("BreadcrumbList"))) {
    const items = node["itemListElement"];
    if (!Array.isArray(items)) continue;
    const positions = items.map((item) => (isNode(item) ? Number(item["position"]) : NaN));
    const expected = positions.map((_, i) => i + 1);
    if (positions.some((p, i) => p !== expected[i])) {
      out.push(finding("breadcrumb-positions", "warn",
        "Breadcrumb positions are not a 1-based sequence.",
        { evidence: [`found: ${positions.join(", ")}`, `expected: ${expected.join(", ")}`] }));
    }
    const last = items[items.length - 1];
    if (isNode(last) && "item" in last && items.length > 1) {
      out.push(finding("breadcrumb-last-linked", "info",
        "The last breadcrumb carries a link. Google expects the current page to have none."));
    }
  }

  // --- FAQ ---------------------------------------------------------------------
  for (const node of nodes.filter((n) => typesOf(n).includes("FAQPage"))) {
    const questions = node["mainEntity"];
    const list = Array.isArray(questions) ? questions : questions ? [questions] : [];
    let unseen = 0;
    for (const q of list) {
      if (!isNode(q)) continue;
      const name = typeof q["name"] === "string" ? q["name"] : null;
      if (name && !mentioned(name.slice(0, 40), pageText, pageTokens)) unseen++;
    }
    if (unseen > 0) {
      out.push(finding("faq-not-on-page", "error",
        `${unseen} FAQ ${unseen === 1 ? "question is" : "questions are"} in the markup but not visible on the page.`,
        { group: "FAQ questions are in the markup but not visible on the page.",
          detail: "FAQ markup only qualifies when the same question and answer are on the page for a visitor to read." }));
    }
  }

  // --- Duplicate @id ----------------------------------------------------------
  const ids = nodes.map((n) => n["@id"]).filter((v): v is string => typeof v === "string");
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) {
    out.push(finding("jsonld-duplicate-id", "warn", "Two nodes share an @id.",
      { detail: "They will be merged into one entity, and whichever loads second overwrites the first.",
        evidence: unique(dupes) }));
  }

  // --- What this page could win -----------------------------------------------
  const eligible = unique(
    allTypes.map((t) => SPECS[t]?.richResult).filter((r): r is string => !!r),
  );
  if (eligible.length) {
    out.push(finding("rich-result-eligible", "ok",
      `Markup present for: ${eligible.join(", ")}.`,
      { detail: "Eligibility is not a promise — it means nothing here disqualifies the page." }));
  }

  return out;
}
