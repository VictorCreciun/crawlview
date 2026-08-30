import type { Capture, RedirectHop, RunOptions } from "./types.js";

export interface FetchTarget {
  url: string;
  ua: string | null;
  agentId: string;
}

/** Reads the charset from the Content-Type header, falling back to a meta tag
 *  in the first 2 KB. Decoding as UTF-8 unconditionally turns a Cyrillic or
 *  Latin-2 page into replacement characters, and every text-based check —
 *  word count, language detection — would then be measuring the damage. */
function decode(buffer: ArrayBuffer, contentType: string | null): string {
  const bytes = new Uint8Array(buffer);
  let charset: string | null = null;

  const fromHeader = contentType?.match(/charset\s*=\s*["']?([\w-]+)/i);
  if (fromHeader?.[1]) charset = fromHeader[1];

  if (!charset) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
    const meta =
      head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i) ??
      head.match(/<meta[^>]+content\s*=\s*["'][^"']*charset=([\w-]+)/i);
    if (meta?.[1]) charset = meta[1];
  }

  const label = (charset ?? "utf-8").toLowerCase();
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function buildHeaders(ua: string | null, opts: RunOptions): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
  };
  if (ua) headers["User-Agent"] = opts.userAgentSuffix ? `${ua} ${opts.userAgentSuffix}` : ua;
  if (opts.basicAuth) {
    headers.Authorization = `Basic ${Buffer.from(opts.basicAuth).toString("base64")}`;
  }
  if (opts.cookies) headers.Cookie = opts.cookies;
  for (const [k, v] of Object.entries(opts.headers)) headers[k] = v;
  return headers;
}

/** Follows redirects by hand so every hop lands in the report. `redirect:
 *  "follow"` would hide exactly the thing we are looking for: a server that
 *  sends bots somewhere it does not send people. */
export async function capture(target: FetchTarget, opts: RunOptions): Promise<Capture> {
  const started = Date.now();
  const redirects: RedirectHop[] = [];
  let url = target.url;
  const headers = buildHeaders(target.ua, opts);

  const base: Capture = {
    agentId: target.agentId,
    requestedUrl: target.url,
    finalUrl: target.url,
    status: 0,
    ok: false,
    redirects,
    headers: {},
    html: "",
    bytes: 0,
    elapsedMs: 0,
    rendered: false,
  };

  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetch(url, {
        headers,
        redirect: "manual",
        signal: controller.signal,
      });

      const location = res.headers.get("location");
      const isRedirect = res.status >= 300 && res.status < 400 && location;

      if (isRedirect && opts.followRedirects) {
        redirects.push({ url, status: res.status, location });
        let next: string;
        try {
          next = new URL(location, url).toString();
        } catch {
          return { ...base, finalUrl: url, status: res.status, elapsedMs: Date.now() - started,
                   error: `unparseable Location header: ${location}` };
        }
        if (next === url) {
          return { ...base, finalUrl: url, status: res.status, elapsedMs: Date.now() - started,
                   error: "redirect loop: Location points at the same URL" };
        }
        url = next;
        continue;
      }

      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { responseHeaders[k] = v; });

      const buffer = await res.arrayBuffer();
      const html = decode(buffer, res.headers.get("content-type"));

      return {
        ...base,
        finalUrl: url,
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        headers: responseHeaders,
        html,
        bytes: buffer.byteLength,
        elapsedMs: Date.now() - started,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const aborted = controller.signal.aborted;
      return {
        ...base,
        finalUrl: url,
        elapsedMs: Date.now() - started,
        error: aborted ? `timed out after ${opts.timeoutMs} ms` : message,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ...base,
    finalUrl: url,
    elapsedMs: Date.now() - started,
    error: `more than ${opts.maxRedirects} redirects`,
  };
}

/** Plain text fetch for robots.txt, sitemaps and llms.txt. */
export async function fetchText(
  url: string,
  opts: RunOptions,
  ua: string | null = null,
): Promise<{ status: number; body: string | null; finalUrl: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, {
      headers: buildHeaders(ua, opts),
      redirect: "follow",
      signal: controller.signal,
    });
    const buffer = await res.arrayBuffer();
    return {
      status: res.status,
      body: decode(buffer, res.headers.get("content-type")),
      finalUrl: res.url || url,
    };
  } catch (err) {
    return {
      status: 0,
      body: null,
      finalUrl: url,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs tasks with a fixed ceiling on parallelism and an optional pause between
 *  starts. Politeness is not decoration here: the tool fires one request per
 *  agent, so a careless default would hit a small site with twenty at once. */
export async function pool<T, R>(
  items: T[],
  limit: number,
  delayMs: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      if (delayMs > 0 && index > 0) await new Promise((r) => setTimeout(r, delayMs));
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}
