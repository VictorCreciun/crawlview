import type { Agent, RobotsRuleSet } from "./types.js";

interface Rule {
  allow: boolean;
  pattern: string;
  /** Pattern length is the specificity tiebreak defined by RFC 9309. */
  length: number;
  regex: RegExp;
}

interface Group {
  tokens: string[];
  rules: Rule[];
  crawlDelay: number | null;
}

export interface Robots {
  groups: Group[];
  sitemaps: string[];
  /** Lines the parser could not make sense of, worth surfacing: a typo in
   *  robots.txt fails silently and nobody ever finds out. */
  malformed: string[];
}

/** Turns a robots path pattern into a regex. `*` is any run of characters and
 *  `$` anchors the end; everything else is literal. */
function toRegex(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") out += ".*";
    else if (ch === "$" && i === pattern.length - 1) out += "$";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(out);
}

/** Not part of RFC 9309, but shipped by real crawlers and real sites. */
const TOLERATED = new Set([
  "host", "clean-param", "request-rate", "visit-time", "noindex", "comment",
]);

export function parseRobots(body: string): Robots {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  const malformed: string[] = [];

  let current: Group | null = null;
  // A blank line does not end a group, but a rule line after user-agent lines
  // does: the next user-agent starts a new one.
  let expectingTokens = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    const sep = line.indexOf(":");
    if (sep === -1) {
      malformed.push(rawLine.trim());
      continue;
    }
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    switch (field) {
      case "user-agent": {
        if (!value) { malformed.push(rawLine.trim()); break; }
        if (!current || !expectingTokens) {
          current = { tokens: [], rules: [], crawlDelay: null };
          groups.push(current);
          expectingTokens = true;
        }
        current.tokens.push(value.toLowerCase());
        break;
      }
      case "allow":
      case "disallow": {
        if (!current) {
          // Rules before any User-agent line apply to nobody. Record it —
          // it is a common way to write a robots.txt that does nothing.
          malformed.push(rawLine.trim());
          break;
        }
        expectingTokens = false;
        // `Disallow:` with an empty value means "allow everything".
        if (field === "disallow" && value === "") break;
        if (!value.startsWith("/")) { malformed.push(rawLine.trim()); break; }
        current.rules.push({
          allow: field === "allow",
          pattern: value,
          length: value.length,
          regex: toRegex(value),
        });
        break;
      }
      case "crawl-delay": {
        if (!current) break;
        expectingTokens = false;
        const n = Number.parseFloat(value);
        if (Number.isFinite(n)) current.crawlDelay = n;
        else malformed.push(rawLine.trim());
        break;
      }
      case "sitemap": {
        if (value) sitemaps.push(value);
        break;
      }
      default:
        // A misspelled directive still has a valid `field: value` shape, so it
        // parses cleanly and then does nothing — which is the whole reason the
        // report calls these out. Fields that are non-standard but real are
        // tolerated so they are not reported as typos.
        if (!TOLERATED.has(field)) malformed.push(rawLine.trim());
        break;
    }
  }

  return { groups, sitemaps, malformed };
}

/** Finds the group for an agent. RFC 9309: the most specific matching token
 *  wins, and `*` is only the fallback. An agent that lists several tokens —
 *  ClaudeBot also answers to `anthropic-ai` — takes the most specific hit
 *  among them, which is why the tokens are ordered in the agent table. */
function findGroup(robots: Robots, agent: Agent): { group: Group | null; token: string | null } {
  let best: { group: Group; token: string; length: number } | null = null;

  for (const group of robots.groups) {
    for (const token of group.tokens) {
      if (token === "*") continue;
      for (const candidate of agent.robotsTokens) {
        const wanted = candidate.toLowerCase();
        // Google matches a token as a case-insensitive prefix of the product
        // name, so `Googlebot` in robots.txt also covers `Googlebot-Image`.
        if (wanted === token || wanted.startsWith(token)) {
          if (!best || token.length > best.length) {
            best = { group, token, length: token.length };
          }
        }
      }
    }
  }
  if (best) return { group: best.group, token: best.token };

  const wildcard = robots.groups.find((g) => g.tokens.includes("*"));
  return { group: wildcard ?? null, token: null };
}

export function evaluate(robots: Robots | null, agent: Agent, url: string): RobotsRuleSet {
  if (!robots) {
    return { matchedToken: null, allowed: true, decidingRule: null, crawlDelay: null };
  }
  const { group, token } = findGroup(robots, agent);
  if (!group) {
    return { matchedToken: null, allowed: true, decidingRule: null, crawlDelay: null };
  }

  let path: string;
  try {
    const parsed = new URL(url);
    path = parsed.pathname + parsed.search;
  } catch {
    path = url;
  }

  let winner: Rule | null = null;
  for (const rule of group.rules) {
    if (!rule.regex.test(path)) continue;
    if (
      !winner ||
      rule.length > winner.length ||
      // Equal specificity: Allow wins, per the standard.
      (rule.length === winner.length && rule.allow && !winner.allow)
    ) {
      winner = rule;
    }
  }

  return {
    matchedToken: token,
    allowed: winner ? winner.allow : true,
    decidingRule: winner ? `${winner.allow ? "Allow" : "Disallow"}: ${winner.pattern}` : null,
    crawlDelay: group.crawlDelay,
  };
}

export function robotsUrl(pageUrl: string): string {
  const u = new URL(pageUrl);
  return `${u.protocol}//${u.host}/robots.txt`;
}

/** Disallow rules that apply to everyone but not to this agent.
 *
 *  A group named for a specific crawler *replaces* the wildcard group; it does
 *  not extend it. So `User-agent: Googlebot` followed by `Allow: /` cancels
 *  every Disallow written under `User-agent: *` — for Google only, silently,
 *  and in a file whose whole purpose is to state what is off limits. Almost
 *  everyone who writes such a block means it as an addition. */
export function wildcardOverrides(robots: Robots, agent: Agent): string[] {
  const { group, token } = findGroup(robots, agent);
  if (!group || !token) return [];

  const wildcard = robots.groups.find((g) => g.tokens.includes("*"));
  if (!wildcard || wildcard === group) return [];

  const own = new Set(group.rules.filter((r) => !r.allow).map((r) => r.pattern));
  return wildcard.rules
    .filter((r) => !r.allow && !own.has(r.pattern))
    .map((r) => r.pattern);
}
