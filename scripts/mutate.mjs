#!/usr/bin/env node
/**
 * Mutation check.
 *
 * A test that passes whether or not the code works verifies nothing, and a
 * green suite is no evidence on its own. This breaks one piece of logic at a
 * time and confirms the suite notices. A mutation that survives is a gap:
 * either the behaviour is untested, or the test that claims to cover it is
 * asserting something else.
 *
 *   node scripts/mutate.mjs            run every mutation
 *   node scripts/mutate.mjs robots     run the ones whose id contains "robots"
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/** id, file, the exact source to replace, and what to replace it with. */
const MUTATIONS = [
  // --- robots.txt -----------------------------------------------------------
  { id: "robots/specificity", file: "src/robots.ts",
    from: "rule.length > winner.length", to: "rule.length < winner.length" },
  { id: "robots/allow-wins-tie", file: "src/robots.ts",
    from: "(rule.length === winner.length && rule.allow && !winner.allow)", to: "false" },
  { id: "robots/wildcard-fallback", file: "src/robots.ts",
    from: "return { group: wildcard ?? null, token: null };", to: "return { group: null, token: null };" },
  { id: "robots/empty-disallow", file: "src/robots.ts",
    from: 'if (field === "disallow" && value === "") break;', to: "" },
  { id: "robots/wildcard-pattern", file: "src/robots.ts",
    from: 'if (ch === "*") out += ".*";', to: 'if (ch === "*") out += "\\\\*";' },
  { id: "robots/end-anchor", file: "src/robots.ts",
    from: 'else if (ch === "$" && i === pattern.length - 1) out += "$";', to: 'else if (ch === "$" && i === pattern.length - 1) out += "";' },
  { id: "robots/prefix-match", file: "src/robots.ts",
    from: "if (wanted === token || wanted.startsWith(token))", to: "if (wanted === token)" },
  { id: "robots/malformed", file: "src/robots.ts",
    from: "if (!TOLERATED.has(field)) malformed.push(rawLine.trim());", to: "" },
  { id: "robots/overrides-direction", file: "src/robots.ts",
    from: "wildcard.rules\n    .filter((r) => !r.allow && !own.has(r.pattern))",
    to: "wildcard.rules\n    .filter((r) => r.allow && !own.has(r.pattern))" },

  // --- text extraction ------------------------------------------------------
  { id: "text/buttons-stripped", file: "src/extract/text.ts",
    from: '  work.find(STRIP.join(",")).remove();\n  const body = work.find("body");',
    to: '  work.find([...STRIP, ...STRIP_INTERACTIVE].join(",")).remove();\n  const body = work.find("body");' },
  { id: "text/cjk-words", file: "src/extract/text.ts",
    from: "return words + cjk;", to: "return words;" },
  { id: "text/prefers-main", file: "src/extract/text.ts",
    from: 'const explicit = work.find("main, article, [role=main]").first();',
    to: 'const explicit = work.find("__never__").first();' },
  { id: "text/link-density", file: "src/extract/text.ts",
    from: "if (density > 0.5) return;", to: "" },

  // --- language -------------------------------------------------------------
  { id: "lang/short-sample", file: "src/extract/language.ts",
    from: "if (sample.length < 60) return { lang: null, confidence: 0 };", to: "" },
  { id: "lang/base-subtag", file: "src/extract/language.ts",
    from: 'const base = value.trim().toLowerCase().split(/[-_]/)[0];',
    to: 'const base = value.trim().toLowerCase();' },
  { id: "lang/confusable", file: "src/extract/language.ts",
    from: "return CONFUSABLE.some((set) => set.includes(a) && set.includes(b));", to: "return false;" },

  // --- HTML facts -----------------------------------------------------------
  { id: "html/visible-text", file: "src/extract/html.ts",
    from: "visibleText: allText,", to: "visibleText: readable.text," },
  { id: "html/jsonld-graph", file: "src/extract/html.ts",
    from: "for (const key of Object.keys(record)) collectTypes(record[key], out);", to: "" },
  { id: "html/skip-anchor-links", file: "src/extract/html.ts",
    from: 'if (!href || href.startsWith("#") || /^(javascript|mailto|tel):/i.test(href)) return;',
    to: "if (!href) return;" },
  { id: "html/meta-robots-variants", file: "src/extract/html.ts",
    from: "if (!/^(robots|googlebot|googlebot-news|bingbot|slurp|msnbot|yandex)$/.test(name)) return;",
    to: 'if (name !== "robots") return;' },

  // --- structured data ------------------------------------------------------
  { id: "structured/token-threshold", file: "src/checks/structured.ts",
    from: "return parts.filter((t) => hayTokens.has(t)).length / parts.length >= 0.7;",
    to: "return parts.filter((t) => hayTokens.has(t)).length / parts.length >= 0.99;" },
  { id: "structured/no-tokens", file: "src/checks/structured.ts",
    from: "if (parts.length === 0) return true;", to: "if (parts.length === 0) return false;" },
  { id: "structured/rating-unsupported", file: "src/checks/structured.ts",
    from: "if (!hasReviews && !reviewWordsOnPage) {", to: "if (false) {" },
  { id: "structured/rating-range", file: "src/checks/structured.ts",
    from: "(value > best || value < 0)", to: "false" },
  { id: "structured/breadcrumb-order", file: "src/checks/structured.ts",
    from: "if (positions.some((p, i) => p !== expected[i])) {", to: "if (false) {" },
  { id: "structured/offer-price", file: "src/checks/structured.ts",
    from: 'const missing = ["price", "priceCurrency"].filter', to: "const missing = [].filter" },
  { id: "structured/required-props", file: "src/checks/structured.ts",
    from: "if (missingRequired.length) {", to: "if (false) {" },

  { id: "structured/itemlist-missing", file: "src/checks/structured.ts",
    from: "if (missing.length) {\n      // Every value inside this list is now accounted for by one finding.",
    to: "if (false) {\n      // Every value inside this list is now accounted for by one finding." },
  { id: "structured/itemlist-dedupe", file: "src/checks/structured.ts",
    from: "if (explainedByList.has(node)) continue;", to: "" },
  { id: "structured/itemlist-floor", file: "src/checks/structured.ts",
    from: "if (named.length < 3) continue;", to: "" },

  // --- config ---------------------------------------------------------------
  { id: "config/ignore", file: "src/config.ts",
    from: "if (set.has(code)) return true;", to: "if (false) return true;" },
  { id: "config/base-code", file: "src/config.ts",
    from: "if (colon > 0 && set.has(code.slice(colon + 1))) return true;", to: "" },
  { id: "config/keeps-ignored", file: "src/config.ts",
    from: "for (const item of findings) (suppressed(item.code) ? ignored : kept).push(item);",
    to: "for (const item of findings) { if (!suppressed(item.code)) kept.push(item); }" },
  { id: "config/type-guard", file: "src/config.ts",
    from: 'const failOn = record.failOn === "warn" || record.failOn === "error" ? record.failOn : undefined;',
    to: "const failOn = record.failOn;" },
  { id: "config/rejects-array", file: "src/config.ts",
    from: "if (!data || typeof data !== \"object\" || Array.isArray(data)) {", to: "if (false) {" },

  // --- crawl-delay ----------------------------------------------------------
  { id: "site/crawl-delay", file: "src/site/crawl.ts",
    from: "if (!opts.ignoreCrawlDelay && declaredDelay && declaredDelay > 0) {", to: "if (false) {" },

  // --- basics ---------------------------------------------------------------
  { id: "basics/xrobots-header", file: "src/checks/basics.ts",
    from: "const headerBlocks = headerRobots.some((v) => /\\bnoindex|\\bnone\\b/i.test(v));",
    to: "const headerBlocks = false;" },
  { id: "basics/canonical-localhost", file: "src/checks/basics.ts",
    from: "/^(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\])(:\\d+)?$/i.test(canonicalHost)",
    to: "false" },
  { id: "basics/heading-skip", file: "src/checks/basics.ts",
    from: "if (to - from > 1) jumps.push(`h${from} → h${to}`);", to: "" },

  // --- divergence -----------------------------------------------------------
  { id: "divergence/starved-threshold", file: "src/checks/divergence.ts",
    from: "return browserWords >= 50 && pct(words, browserWords) < 30;",
    to: "return browserWords >= 50 && pct(words, browserWords) < 0;" },
  { id: "divergence/status", file: "src/checks/divergence.ts",
    from: "if (byStatus.size > 1) {", to: "if (false) {" },
  { id: "divergence/links-invisible", file: "src/checks/divergence.ts",
    from: "if (browserLinks.size > 0 && botLinks.size === 0) {", to: "if (false) {" },
  { id: "divergence/jsonld-client-only", file: "src/checks/divergence.ts",
    from: "if (onlyRendered.length) {", to: "if (false) {" },
  { id: "divergence/blocked", file: "src/checks/divergence.ts",
    from: "(r.capture.status === 403 || r.capture.status === 429)", to: "false" },

  // --- ai -------------------------------------------------------------------
  { id: "ai/sees-nothing", file: "src/checks/ai.ts",
    from: "if (worst < 50 && (report.browser?.facts.wordCount ?? 0) > 120) {", to: "if (false) {" },
  { id: "ai/citability", file: "src/checks/ai.ts",
    from: "if (missing.length >= 2) {", to: "if (false) {" },

  // --- fetch ----------------------------------------------------------------
  { id: "fetch/manual-redirects", file: "src/fetch.ts",
    from: 'redirect: "manual",', to: 'redirect: "follow",' },
  { id: "fetch/charset", file: "src/fetch.ts",
    from: 'const label = (charset ?? "utf-8").toLowerCase();', to: 'const label = "utf-8";' },
  { id: "fetch/redirect-loop", file: "src/fetch.ts",
    from: "if (next === url) {", to: "if (false) {" },
  { id: "fetch/pool-limit", file: "src/fetch.ts",
    from: "Math.max(1, Math.min(limit, items.length))", to: "items.length" },
  { id: "fetch/global-pacing", file: "src/fetch.ts",
    from: "    nextStart = at + delayMs;", to: "    nextStart = now + delayMs;" },
  { id: "fetch/pool-order", file: "src/fetch.ts",
    from: "results[index] = await worker(items[index]!, index);",
    to: "results[items.length - 1 - index] = await worker(items[index]!, index);" },
  { id: "fetch/timeout-message", file: "src/fetch.ts",
    from: "aborted ? `timed out after ${opts.timeoutMs} ms` : message", to: "message" },
  { id: "fetch/basic-auth", file: "src/fetch.ts",
    from: "headers.Authorization = `Basic ${Buffer.from(opts.basicAuth).toString(\"base64\")}`;", to: "" },

  // --- sitemap --------------------------------------------------------------
  { id: "sitemap/index-depth", file: "src/site/sitemap.ts",
    from: "if (depth >= 2) {", to: "if (false) {" },
  { id: "sitemap/entities", file: "src/site/sitemap.ts",
    from: '.replace(/&lt;/g, "<").replace(/&gt;/g, ">")', to: "" },
  { id: "sitemap/plain-text", file: "src/site/sitemap.ts",
    from: 'if (!/<urlset/i.test(body) && /^https?:\\/\\//m.test(body)) {', to: "if (false) {" },
  { id: "sitemap/candidate-order", file: "src/site/sitemap.ts",
    from: "return [...new Set([...declared, ...guesses])];", to: "return [...new Set([...guesses, ...declared])];" },

  // --- snapshot and ranking -------------------------------------------------
  { id: "snapshot/word-regression", file: "src/snapshot.ts",
    from: "agent.words < old.words * 0.7", to: "false" },
  { id: "snapshot/jsonld-regression", file: "src/snapshot.ts",
    from: '(old.jsonLd ?? 0) > 0 && (agent.jsonLd ?? 0) === 0', to: "false" },
  { id: "snapshot/status-change", file: "src/snapshot.ts",
    from: "old.status !== null && agent.status !== null && old.status !== agent.status", to: "false" },
  { id: "snapshot/no-html", file: "src/snapshot.ts",
    from: "findings: report.findings\n      .filter((f) => f.severity !== \"ok\")",
    to: "findings: report.findings" },
  { id: "run/dedupe", file: "src/run.ts",
    from: "return dedupe(findings).sort(", to: "return [...findings].sort(" },
  { id: "run/severity-order", file: "src/run.ts",
    from: 'const ORDER: Record<string, number> = { error: 0, warn: 1, info: 2, ok: 3 };',
    to: 'const ORDER: Record<string, number> = { error: 3, warn: 2, info: 1, ok: 0 };' },

  // --- reports --------------------------------------------------------------
  { id: "report/html-escape", file: "src/report/html.ts",
    from: '.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")', to: "" },
  { id: "report/html-noindex", file: "src/report/html.ts",
    from: '<meta name="robots" content="noindex">', to: "" },
  { id: "report/html-brand", file: "src/report/html.ts",
    from: "const brandBlock = options.brand", to: "const brandBlock = !options.brand" },
  { id: "report/terminal-nocolor", file: "src/report/terminal.ts",
    from: "const ink: Ink = opts.color ? pc : PLAIN;", to: "const ink: Ink = pc;" },
  { id: "report/terminal-verbose", file: "src/report/terminal.ts",
    from: 'if (severity === "info" && !opts.verbose) continue;', to: "" },
  { id: "report/json-summary", file: "src/report/json.ts",
    from: 'errors: report.findings.filter((f) => f.severity === "error").length,',
    to: "errors: 0," },
  { id: "report/markdown-backticks", file: "src/report/markdown.ts",
    from: 'e.replace(/`/g, "\'")', to: "e" },
];

const wanted = process.argv[2];
const list = wanted ? MUTATIONS.filter((m) => m.id.includes(wanted)) : MUTATIONS;

const survived = [];
const applied = [];
let notFound = 0;

for (const mutation of list) {
  const original = await readFile(mutation.file, "utf8");
  if (!original.includes(mutation.from)) {
    console.log(`  ?  ${mutation.id.padEnd(34)} source not found — mutation is stale`);
    notFound++;
    continue;
  }
  await writeFile(mutation.file, original.replace(mutation.from, mutation.to));
  applied.push(mutation.id);

  let caught = false;
  try {
    await run("npx", ["vitest", "run", "--silent", "--reporter=dot"], {
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
      /* Colour forced on, because a bug can only be observed under the
         conditions that make it matter. picocolors disables itself when
         stdout is not a terminal, so without this the --no-color mutation
         produces identical output either way and survives — which is exactly
         how the real bug reached production. */
      env: { ...process.env, FORCE_COLOR: "3" },
    });
  } catch {
    caught = true; // a non-zero exit means the suite noticed
  } finally {
    await writeFile(mutation.file, original);
  }

  if (caught) {
    console.log(`  ✓  ${mutation.id.padEnd(34)} caught`);
  } else {
    console.log(`  ✗  ${mutation.id.padEnd(34)} SURVIVED — nothing tests this`);
    survived.push(mutation.id);
  }
}

console.log(`\n  ${applied.length - survived.length}/${applied.length} mutations caught` +
  (notFound ? `, ${notFound} stale` : ""));

if (survived.length) {
  console.log("\n  Untested behaviour:");
  for (const id of survived) console.log(`    ${id}`);
  process.exit(1);
}
