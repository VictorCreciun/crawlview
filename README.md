# crawlview

See what search engines and AI crawlers actually store for your pages — not what your browser shows you.

```
npx crawlview https://example.com --render
```

Your browser runs JavaScript, so DevTools shows you a finished page. Most crawlers
do not. `crawlview` requests the page once as each crawler, compares what comes
back, and tells you where the two disagree.

---

## The output

```
crawlview  https://example.com/
           15 crawlers in 0.4s, plus a rendered browser

  AGENT               STATUS   HTML     TEXT  TITLE  DESC  H1  CANON  LD  ROBOTS
  Googlebot              200  870 B      0 w     ok    ok   0     ok   0   allow
  bingbot                200  870 B      0 w     ok    ok   0     ok   0   allow
  GPTBot                 200  870 B      0 w     ok    ok   0     ok   0   allow
  ClaudeBot              200  870 B      0 w     ok    ok   0     ok   0   allow
  PerplexityBot          200  870 B      0 w     ok    ok   0     ok   0   allow
  Google-Extended          —      —        —      —     —   —      —   —   allow
  browser (rendered)     200  15 KB  2,408 w     ok    ok   1     ok   1       —

  ✗ problems
    2,408 words render in the browser; every crawler stores none of it.
      The page is built in the browser, so what gets stored is the empty container
      the app mounts into. Prerender the routes or move rendering to the server;
      nothing else on this report matters until this is fixed.
    Crawlers see no internal links at all.
      The browser exposes 3. Navigation is rendered client-side, so a crawler that
      lands here cannot reach any other page — the rest of the site is
      undiscoverable from this one.
    Structured data is injected by JavaScript.
      Types present after rendering but absent from the HTML crawlers store.
      · Organization
```

## Install

Nothing to install — `npx crawlview <url>` runs it.

For repeated use: `npm install -g crawlview`, or add it to a project with
`npm install -D crawlview`.

Requires Node 20 or newer. The base install is three small dependencies and
starts instantly; the browser comparison is opt-in (see below).

## What it checks

**Divergence — the reason the tool exists**
- What each crawler stores against what a browser renders
- Structured data that only appears after JavaScript runs
- Internal links that only appear after JavaScript runs, so crawlers cannot reach the rest of the site
- Different status codes, redirect chains or titles served to different crawlers

**robots.txt, per crawler**
- Whether each crawler is allowed this exact URL, and which rule decided it
- The AI-only tokens — `Google-Extended`, `Applebot-Extended` — that never fetch anything and so cannot be observed any other way
- **A named group that silently cancels the wildcard rules.** `User-agent: Googlebot` followed by `Allow: /` does not extend `User-agent: *` — it replaces it, so every `Disallow` above stops applying to Google alone. Written as a welcome, read as an exemption
- Misspelled directives. A typo parses cleanly and then does nothing, silently

**Indexing directives**
- `X-Robots-Tag` headers, which are invisible in the page source and outrank the meta tag
- A header and a meta tag that contradict each other
- `noindex` shipped to production

**Structured data**
- Required and recommended properties for the types Google documents
- **Claims the page itself does not make.** Markup must describe what a visitor can see; a `priceRange` or `telephone` that appears only in the JSON-LD is what structured-data manual actions are issued for
- **An `ItemList` longer than the page.** A listing page marks up its whole result set and then renders twelve — the difference is a set of products described to a search engine and shown to nobody
- `AggregateRating` with no reviews anywhere on the page
- Ratings outside their own scale, breadcrumbs numbered out of order, duplicate `@id`, blocks that do not parse

**Language**
- **The declared language against the language the text is actually written in.** A translated route that renders the default language declares `lang="ru"` and serves Romanian. Nothing else looks for this, and the site looks perfect until you read it
- hreflang: reciprocity (each alternate is fetched and checked for a link back), self-reference, `x-default`, duplicates, unreachable targets

**AI answer readiness**
- Whether AI crawlers — none of which run JavaScript — receive anything at all
- How much of the page survives content extraction, the step before anything is embedded
- Section shape: whether headings produce chunks a retrieval pipeline can use
- Whether the page can be cited: date, author, canonical, stable heading anchors
- `/llms.txt`

**Site-wide** (`--sitemap`)
- Every page-level check above, run on every page rather than only the one you named, and reported one line per distinct problem with example URLs — a shop missing the same description on 200 pages is one fix, not 200 findings
- Sitemap URLs that 404, redirect, are `noindex`, or are disallowed in robots.txt
- Pages that canonicalise somewhere other than themselves
- Orphans: in the sitemap, linked from nowhere
- Pages linked internally but missing from the sitemap, and among them the ones that answer 404 — every internal link is a promise the site makes about itself
- Duplicate titles and descriptions, and pages that look identical to each other

**Also**
- Soft 404s — a URL that cannot exist answering `200`, which is what an SPA fallback does to every misspelled link
- Canonical pointing at `localhost`, another host, or nothing
- Open Graph completeness

## Options

```
  -a, --agents <list>    Crawlers to check. Ids or groups: search, ai, social, all, default
  -r, --render           Also load the page in a browser and diff the two
  -s, --sitemap          Site mode: walk the sitemap and check it as a whole
      --sitemap-url <u>  Use this sitemap instead of discovering one
  -l, --limit <n>        Pages to check in site mode (default: 50)

  -v, --verbose          Show notes and passing checks too
      --json             Machine-readable output, on stdout
      --html <file>      Standalone HTML report
      --md <file>        Markdown, for an issue or a PR comment

      --ignore <codes>   Finding codes to suppress, comma separated
      --config <file>    Settings file (otherwise crawlview.json, if present)
      --fail-on <level>  What --ci treats as failure: error (default) or warn

      --snapshot <file>  Write a baseline to compare against later
      --diff <file>      Compare this run against a baseline
      --ci               Exit non-zero when anything is a problem
      --min-text <pct>   In --ci, fail when a crawler sees less than this share
                         of the browser's text (default: 60)

  -H, --header <k: v>    Extra request header. Repeatable
      --auth <user:pass> HTTP basic auth
      --cookie <string>  Cookie header, for pages behind a session
      --timeout <ms>     Per-request timeout (default: 20000)
      --concurrency <n>  Parallel requests (default: 4)
      --delay <ms>       Minimum gap between request starts (default: 0)
      --no-crawl-delay   Ignore a crawl-delay declared in robots.txt
      --insecure         Do not verify TLS certificates
      --no-color         Plain output

      --list-agents      Print every crawler this knows about
```

### The browser comparison

`--render` needs a browser. In order, it uses:

1. **Playwright**, if the project already has it
2. **Any Chrome or Chromium on the machine**, including one Playwright downloaded for another project
3. Otherwise it says so and continues without the comparison

So `npx crawlview` never downloads a browser behind your back. To guarantee one:

```
npm install -D playwright && npx playwright install chromium
```

`CHROME_PATH` overrides the search.

### Settings

A `crawlview.json` beside your code is what makes this survivable in CI. Without
somewhere to record an accepted trade-off, one finding you have decided to live
with makes the build permanently red and the check gets deleted a week later.

```json
{
  "ignore": ["og-absent", "citability-weak"],
  "agents": ["search", "ai"],
  "failOn": "error",
  "minText": 80
}
```

Suppressed findings are counted and reported, never silently dropped —
otherwise the file becomes a place to hide things. Ignoring a code covers its
sitemap-mode form too, so `og-absent` also matches `page:og-absent`.

### Private and staging sites

```
crawlview https://staging.example.com --auth user:pass
crawlview https://example.com/account --cookie "session=abc123"
crawlview https://example.com -H "X-Preview-Token: xyz"
```

## In CI

Catch a rendering regression before it ships, rather than three weeks later in
Search Console:

```yaml
- run: npx crawlview https://staging.example.com --render --ci --min-text 80
```

`--ci` exits `1` if anything is a problem, or if a crawler sees less than
`--min-text` percent of the browser's text.

To catch changes rather than absolutes, commit a baseline:

```bash
crawlview https://example.com --render --snapshot .crawlview.json   # once
crawlview https://example.com --render --diff .crawlview.json --ci  # every build
```

A snapshot holds findings and per-crawler counts, not HTML — it stays small and
readable in a diff.

### GitHub Action

```yaml
- uses: VictorCreciun/crawlview@v1
  with:
    url: https://example.com
    render: true
    ci: true
    min-text: 80
```

Outputs `errors`, `warnings` and `report` (the Markdown), so a workflow can post
the report as a PR comment.

## As a library

```ts
import { analyse } from "crawlview";

const { report } = await analyse({
  url: "https://example.com",
  agents: ["ai"],
  render: true,
});

for (const finding of report.findings) {
  if (finding.severity === "error") console.log(finding.code, finding.title);
}
```

Everything the CLI uses is exported: `parseRobots`, `evaluateRobots`, `parseHtml`,
`detectLanguage`, `crawlSite`, `toHtml`, `toMarkdown`, `toJson`, `diffSnapshot`.

## Tests

```
npm test              # the suite
node scripts/mutate.mjs   # verify the suite actually tests anything
```

A green suite is not evidence on its own: a test that passes whether or not the
code works verifies nothing. `scripts/mutate.mjs` breaks one piece of logic at a
time — inverts a comparison, removes a guard, disables a check — and confirms
the suite notices. A mutation that survives names a behaviour nothing tests.

It found real gaps the first time it ran, including two for bugs that had just
been fixed: the tests written alongside those fixes were asserting something
adjacent to the thing that broke.

## A note on user agents

`crawlview` sends each crawler's real user-agent string. It has to: a server
decides what to send based on that exact string, and appending an identifier of
our own would change the answer we came to measure.

It is a debugging tool, not a crawler. One request per agent, and it never
follows links to fetch pages you did not ask for — `--sitemap` fetches exactly
what the sitemap lists, up to `--limit`.

Sitemap mode obeys a `crawl-delay` declared in robots.txt, because a tool that
sends real crawler user-agents and then fetches hundreds of pages has no
business ignoring a limit written for that exact situation. `--delay` still
wins when it is the slower of the two, and it spaces request *starts* globally
rather than per worker. `--no-crawl-delay` exists for a site you own.

## Why the AI crawlers matter

Google renders JavaScript, eventually, from a queue. `GPTBot`, `ClaudeBot`,
`PerplexityBot` and `CCBot` do not render at all. A site can rank perfectly in
search and be completely absent from every assistant's answer, and the two facts
are unrelated — which is why they are in the same table here.

`Google-Extended` and `Applebot-Extended` are stranger still: robots.txt tokens
that gate AI training and AI answers but never fetch anything. There is no
request to observe, so the only way to know where you stand is to read the rules
for them — which this does.

## License

MIT © [coresmith.dev](https://coresmith.dev)
