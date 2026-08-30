import type { Agent } from "./types.js";

/* User-agent strings are the real ones each operator documents. Fidelity is the
   whole point: a server decides what to send based on this exact string, so
   appending an identifier of our own would change the answer we came to measure.
   The README says plainly that the tool sends these. */

const CHROME = "AppleWebKit/537.36 (KHTML, like Gecko)";

export const AGENTS: Agent[] = [
  {
    id: "googlebot",
    label: "Googlebot",
    group: "search",
    ua: `Mozilla/5.0 ${CHROME}; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/131.0.0.0 Safari/537.36`,
    robotsTokens: ["Googlebot"],
    js: "deferred",
    note: "Renders, but from a queue — the raw HTML is what gets stored first.",
  },
  {
    id: "googlebot-mobile",
    label: "Googlebot (mobile)",
    group: "search",
    ua: `Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) ${CHROME} Chrome/131.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)`,
    robotsTokens: ["Googlebot"],
    js: "deferred",
    note: "The crawler that actually decides your ranking — indexing is mobile-first.",
  },
  {
    id: "bingbot",
    label: "bingbot",
    group: "search",
    ua: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    robotsTokens: ["bingbot"],
    js: "deferred",
    note: "Also the index ChatGPT search reaches through.",
  },
  {
    id: "yandexbot",
    label: "YandexBot",
    group: "search",
    ua: "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
    robotsTokens: ["YandexBot", "Yandex"],
    js: "deferred",
  },
  {
    id: "duckduckbot",
    label: "DuckDuckBot",
    group: "search",
    ua: "Mozilla/5.0 (compatible; DuckDuckBot-Https/1.1; https://duckduckgo.com/duckduckbot)",
    robotsTokens: ["DuckDuckBot"],
    js: "no",
  },
  {
    id: "gptbot",
    label: "GPTBot",
    group: "ai",
    ua: `Mozilla/5.0 ${CHROME}; compatible; GPTBot/1.2; +https://openai.com/gptbot)`,
    robotsTokens: ["GPTBot"],
    js: "no",
    note: "Collects training data for OpenAI. Does not run your JavaScript.",
  },
  {
    id: "oai-searchbot",
    label: "OAI-SearchBot",
    group: "ai",
    ua: `Mozilla/5.0 ${CHROME}; compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)`,
    robotsTokens: ["OAI-SearchBot"],
    js: "no",
    note: "Builds the index ChatGPT cites from. Blocking it removes you from answers.",
  },
  {
    id: "chatgpt-user",
    label: "ChatGPT-User",
    group: "ai",
    ua: `Mozilla/5.0 ${CHROME}; compatible; ChatGPT-User/1.0; +https://openai.com/bot)`,
    robotsTokens: ["ChatGPT-User"],
    js: "no",
    note: "Fetches a page live when a user asks about it.",
  },
  {
    id: "claudebot",
    label: "ClaudeBot",
    group: "ai",
    ua: `Mozilla/5.0 ${CHROME}; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)`,
    robotsTokens: ["ClaudeBot", "anthropic-ai"],
    js: "no",
  },
  {
    id: "claude-user",
    label: "Claude-User",
    group: "ai",
    ua: `Mozilla/5.0 ${CHROME}; compatible; Claude-User/1.0; +Claude-User@anthropic.com)`,
    robotsTokens: ["Claude-User"],
    js: "no",
    note: "Fetches a page live on behalf of someone in a conversation.",
  },
  {
    id: "perplexitybot",
    label: "PerplexityBot",
    group: "ai",
    ua: `Mozilla/5.0 ${CHROME}; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)`,
    robotsTokens: ["PerplexityBot"],
    js: "no",
  },
  {
    id: "applebot",
    label: "Applebot",
    group: "ai",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)",
    robotsTokens: ["Applebot"],
    js: "deferred",
    note: "Feeds Siri and Spotlight.",
  },
  {
    id: "amazonbot",
    label: "Amazonbot",
    group: "ai",
    ua: `Mozilla/5.0 (Linux; like Android) ${CHROME} Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 (compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)`,
    robotsTokens: ["Amazonbot"],
    js: "no",
  },
  {
    id: "bytespider",
    label: "Bytespider",
    group: "ai",
    ua: "Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)",
    robotsTokens: ["Bytespider"],
    js: "no",
    note: "ByteDance. Widely blocked for ignoring crawl limits.",
  },
  {
    id: "ccbot",
    label: "CCBot",
    group: "ai",
    ua: "CCBot/2.0 (https://commoncrawl.org/faq/)",
    robotsTokens: ["CCBot"],
    js: "no",
    note: "Common Crawl. Most open LLM training sets start here.",
  },
  {
    id: "google-extended",
    label: "Google-Extended",
    group: "ai",
    ua: null,
    robotsTokens: ["Google-Extended"],
    js: "unknown",
    note: "robots.txt token only. Gates Gemini training and AI Overviews — it never fetches, so it cannot be observed any other way.",
  },
  {
    id: "applebot-extended",
    label: "Applebot-Extended",
    group: "ai",
    ua: null,
    robotsTokens: ["Applebot-Extended"],
    js: "unknown",
    note: "robots.txt token only. Gates Apple Intelligence training.",
  },
  {
    id: "facebookexternalhit",
    label: "facebookexternalhit",
    group: "social",
    ua: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    robotsTokens: ["facebookexternalhit"],
    js: "no",
    note: "Builds the preview card on Facebook, Messenger and WhatsApp.",
  },
  {
    id: "twitterbot",
    label: "Twitterbot",
    group: "social",
    ua: "Twitterbot/1.0",
    robotsTokens: ["Twitterbot"],
    js: "no",
  },
  {
    id: "linkedinbot",
    label: "LinkedInBot",
    group: "social",
    ua: "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
    robotsTokens: ["LinkedInBot"],
    js: "no",
  },
  {
    id: "slackbot",
    label: "Slackbot",
    group: "social",
    ua: "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    robotsTokens: ["Slackbot-LinkExpanding", "Slackbot"],
    js: "no",
  },
];

/** A browser, for the side of the comparison a human sees. */
export const BROWSER_UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${CHROME} Chrome/131.0.0.0 Safari/537.36`;

export const DEFAULT_AGENT_IDS = [
  "googlebot-mobile",
  "bingbot",
  "gptbot",
  "oai-searchbot",
  "claudebot",
  "perplexitybot",
  "google-extended",
  "facebookexternalhit",
];

const BY_ID = new Map(AGENTS.map((a) => [a.id, a]));
const GROUPS: Record<string, string[]> = {
  all: AGENTS.map((a) => a.id),
  search: AGENTS.filter((a) => a.group === "search").map((a) => a.id),
  ai: AGENTS.filter((a) => a.group === "ai").map((a) => a.id),
  social: AGENTS.filter((a) => a.group === "social").map((a) => a.id),
  default: DEFAULT_AGENT_IDS,
};

export function agentById(id: string): Agent | undefined {
  return BY_ID.get(id);
}

/** Accepts ids and group names, in any mix: `ai,googlebot` is valid. */
export function resolveAgents(spec: string[]): { agents: Agent[]; unknown: string[] } {
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const raw of spec) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    const group = GROUPS[key];
    if (group) {
      ids.push(...group);
      continue;
    }
    if (BY_ID.has(key)) {
      ids.push(key);
      continue;
    }
    unknown.push(raw);
  }
  const seen = new Set<string>();
  const agents: Agent[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const agent = BY_ID.get(id);
    if (agent) agents.push(agent);
  }
  return { agents, unknown };
}
