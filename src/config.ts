import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Finding } from "./types.js";

/* A project's settings, so a team can adopt this in CI.
 *
 * Without somewhere to record a decision, one accepted trade-off makes the
 * build permanently red and the check gets deleted a week later. The config
 * file is where "we know, and it stays" lives — in the repository, next to the
 * code it describes, rather than in one person's shell history. */

export interface Config {
  /** Finding codes to suppress. A page-level code also suppresses its
   *  `page:` form, so ignoring `og-absent` covers sitemap mode too. */
  ignore: string[];
  /** Crawlers to check, in the same syntax as --agents. */
  agents?: string[];
  /** Severity at which --ci fails: "error" (default) or "warn". */
  failOn?: "error" | "warn";
  /** Floor for --ci, as a percentage of the browser's text. */
  minText?: number;
}

const EMPTY: Config = { ignore: [] };

const NAMES = ["crawlview.json", ".crawlviewrc.json", ".crawlviewrc"];

/** Reads a config file. Named explicitly it must exist and must parse — a
 *  silently ignored `--config` would be worse than a crash. Discovered, a
 *  missing file simply means there is no config. */
export async function loadConfig(explicit?: string): Promise<{ config: Config; path: string | null }> {
  if (explicit) {
    const raw = await readFile(explicit, "utf8");
    return { config: parse(raw, explicit), path: explicit };
  }
  for (const name of NAMES) {
    try {
      const file = path.resolve(process.cwd(), name);
      const raw = await readFile(file, "utf8");
      return { config: parse(raw, file), path: file };
    } catch {
      continue;
    }
  }
  return { config: EMPTY, path: null };
}

function parse(raw: string, where: string): Config {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${where} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${where} must contain a JSON object`);
  }
  const record = data as Record<string, unknown>;

  const ignore = Array.isArray(record.ignore)
    ? record.ignore.filter((v): v is string => typeof v === "string")
    : [];
  const agents = Array.isArray(record.agents)
    ? record.agents.filter((v): v is string => typeof v === "string")
    : undefined;
  const failOn = record.failOn === "warn" || record.failOn === "error" ? record.failOn : undefined;
  const minText = typeof record.minText === "number" && Number.isFinite(record.minText)
    ? record.minText
    : undefined;

  return { ignore, ...(agents ? { agents } : {}), ...(failOn ? { failOn } : {}), ...(minText !== undefined ? { minText } : {}) };
}

/** Splits findings into those to show and those the project has accepted.
 *  The suppressed ones are counted rather than discarded: a report that
 *  quietly drops findings is how a config file becomes a place to hide. */
export function applyIgnores(
  findings: Finding[],
  ignore: string[],
): { kept: Finding[]; ignored: Finding[] } {
  if (!ignore.length) return { kept: findings, ignored: [] };
  const set = new Set(ignore.map((c) => c.trim()).filter(Boolean));

  const suppressed = (code: string): boolean => {
    if (set.has(code)) return true;
    // Sitemap mode prefixes page-level codes; ignoring the base covers both.
    const colon = code.indexOf(":");
    if (colon > 0 && set.has(code.slice(colon + 1))) return true;
    return false;
  };

  const kept: Finding[] = [];
  const ignored: Finding[] = [];
  for (const item of findings) (suppressed(item.code) ? ignored : kept).push(item);
  return { kept, ignored };
}
