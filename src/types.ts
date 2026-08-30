/** Every crawler we know how to imitate, plus the two robots-only tokens. */
export type AgentGroup = "search" | "ai" | "social";

/** Whether the crawler executes JavaScript before storing the page.
 *  `deferred` is Google's model: the HTML is stored immediately, rendering
 *  happens later from a queue, and a page can sit unrendered for days. It is
 *  not the same guarantee as `yes`, which is why it is its own value. */
export type JsSupport = "yes" | "deferred" | "no" | "unknown";

export interface Agent {
  id: string;
  label: string;
  group: AgentGroup;
  /** Null for tokens that only exist in robots.txt and never fetch anything
   *  (Google-Extended, Applebot-Extended). They gate training and AI answers,
   *  so they matter, but there is nothing to request as them. */
  ua: string | null;
  /** Robots tokens this agent obeys, most specific first. A group is matched
   *  by the most specific token present in robots.txt, not the first one. */
  robotsTokens: string[];
  js: JsSupport;
  /** Shown when a check needs to explain why this agent matters. */
  note?: string;
}

export interface RedirectHop {
  url: string;
  status: number;
  location: string | null;
}

/** One fetch, by one agent. */
export interface Capture {
  agentId: string;
  requestedUrl: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  redirects: RedirectHop[];
  headers: Record<string, string>;
  html: string;
  bytes: number;
  elapsedMs: number;
  /** Set when the request never produced a response. */
  error?: string;
  /** True when the HTML came from a rendered browser rather than a raw fetch. */
  rendered: boolean;
}

export interface HeadingNode {
  level: number;
  text: string;
  id: string | null;
}

export interface LinkNode {
  href: string;
  absolute: string | null;
  text: string;
  rel: string | null;
  internal: boolean;
  nofollow: boolean;
}

export interface HreflangNode {
  lang: string;
  href: string;
}

export interface PageFacts {
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  /** `<meta name="robots">` and any engine-specific variants found. */
  metaRobots: { name: string; content: string }[];
  htmlLang: string | null;
  headings: HeadingNode[];
  links: LinkNode[];
  hreflang: HreflangNode[];
  jsonLd: JsonLdBlock[];
  images: { src: string; alt: string | null }[];
  /** Readable body text, script and chrome stripped. */
  text: string;
  /** Everything a visitor can read, navigation and footer included. Kept apart
   *  from `text` because the two answer different questions: `text` is what an
   *  extractor would keep, this is what a person can see. Anything asking
   *  "is this on the page" has to use this one — a phone number in the footer
   *  is on the page, and the article extractor throws footers away. */
  visibleText: string;
  wordCount: number;
  /** Detected language of `text`, ISO 639-1, null when text is too short. */
  detectedLang: string | null;
  detectedLangConfidence: number;
  openGraph: Record<string, string>;
  twitter: Record<string, string>;
  /** Bytes of <script> content vs bytes of readable text. */
  scriptBytes: number;
  hasNoscriptContent: boolean;
}

export interface JsonLdBlock {
  /** Raw text of the script tag, kept so we can report parse errors precisely. */
  raw: string;
  parsed: unknown;
  error: string | null;
  /** Flattened @type values found anywhere in the block, including @graph. */
  types: string[];
}

export type Severity = "error" | "warn" | "info" | "ok";

export interface Finding {
  /** Stable identifier, usable in --ignore and in snapshots. */
  code: string;
  severity: Severity;
  /** One sentence stating the defect, in plain words. */
  title: string;
  /** What it means for the site, and what to do. Optional for `ok`. */
  detail?: string;
  /** Agents this applies to, empty when it is a page-level fact. */
  agents?: string[];
  /** Anything worth printing verbatim: a URL, a header value, a snippet. */
  evidence?: string[];
}

export interface RobotsRuleSet {
  /** The group whose token matched, or null when only `*` applied. */
  matchedToken: string | null;
  allowed: boolean;
  /** The rule that decided it, for the report. */
  decidingRule: string | null;
  crawlDelay: number | null;
}

export interface AgentResult {
  agent: Agent;
  capture: Capture | null;
  facts: PageFacts | null;
  robots: RobotsRuleSet | null;
}

export interface PageReport {
  url: string;
  startedAt: string;
  elapsedMs: number;
  agents: AgentResult[];
  /** The rendered browser view, when --render was used. */
  browser: { capture: Capture; facts: PageFacts } | null;
  findings: Finding[];
  robotsTxt: { url: string; status: number; body: string | null } | null;
  llmsTxt: { url: string; status: number; present: boolean } | null;
  /** Set in site mode. */
  site?: SiteReport;
}

export interface SiteReport {
  sitemapUrl: string | null;
  urls: string[];
  checked: number;
  pages: { url: string; findings: Finding[]; wordCount: number | null; status: number | null }[];
  findings: Finding[];
}

export interface RunOptions {
  url: string;
  agents: string[];
  render: boolean;
  timeoutMs: number;
  concurrency: number;
  headers: Record<string, string>;
  basicAuth: string | null;
  cookies: string | null;
  followRedirects: boolean;
  maxRedirects: number;
  insecure: boolean;
  respectRobots: boolean;
  delayMs: number;
  userAgentSuffix: string | null;
}
