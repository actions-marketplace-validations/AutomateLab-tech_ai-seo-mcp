// Polite fetch wrapper. Every HTTP request in the server goes through here.
// Enforces: User-Agent, timeout, byte cap, inter-request delay, robots.txt compliance.

import { fetch as undiciFetch } from "undici";
import { POLITE_FETCH } from "./config.js";
import { checkRobotsAllowed, fetchRobotsTxt } from "./robots.js";
import { cacheGet, cacheSet, type RenderMode } from "./cache.js";
import { renderHeadless, HeadlessUnavailableError } from "./headless.js";
import type { ToolError } from "../types.js";

// Per-call hostname -> last-request timestamp for inter-request delay tracking.
export type HostDelayMap = Map<string, number>;

export interface FetchOptions {
  /** Override global respect_robots setting for this request. */
  respectRobots?: boolean;
  /** Shared delay map for tracking inter-request delays within a tool call. */
  hostDelays?: HostDelayMap;
  /** Cached robots.txt content per hostname (avoid re-fetching). */
  robotsCache?: Map<string, string>;
  /** Allow redirects up to this many hops. Default 5 (handled by fetch internally). */
  maxRedirects?: number;
  /** Render mode for cache keying. Default "static". */
  renderMode?: RenderMode;
  /** Skip the in-memory fetch cache for this call. Robots/delays still apply. */
  noCache?: boolean;
}

export interface FetchResult {
  body: string;
  finalUrl: string;
  statusCode: number;
  headers: Record<string, string>;
  redirected: boolean;
}

export class ToolFetchError extends Error {
  constructor(public readonly toolError: ToolError) {
    super(
      (toolError as { message?: string }).message ??
      (toolError as { url?: string }).url ??
      "fetch error"
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract hostname from a URL string. Returns empty string on failure. */
function getHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * Polite HTTP GET. Validates URL, checks robots.txt, enforces rate limits.
 * Throws ToolFetchError on any error condition.
 */
export async function politeFetch(
  url: string,
  opts: FetchOptions = {}
): Promise<FetchResult> {
  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new ToolFetchError({
      type: "invalid_url",
      message: `Invalid URL: ${url}`,
    });
  }

  const hostname = parsedUrl.hostname;
  const respectRobots =
    opts.respectRobots !== undefined ? opts.respectRobots : POLITE_FETCH.RESPECT_ROBOTS;
  const renderMode: RenderMode = opts.renderMode ?? "static";

  // Cache lookup. Cached entries bypass robots check, rate limiting, and the network call.
  if (!opts.noCache) {
    const hit = cacheGet(url, renderMode);
    if (hit) {
      console.error(`[fetch] cache hit ${url}`);
      return hit;
    }
  }

  // Check inter-request delay
  if (opts.hostDelays) {
    const lastRequest = opts.hostDelays.get(hostname);
    if (lastRequest !== undefined) {
      const elapsed = Date.now() - lastRequest;
      if (elapsed < POLITE_FETCH.INTER_REQUEST_DELAY_MS) {
        await sleep(POLITE_FETCH.INTER_REQUEST_DELAY_MS - elapsed);
      }
    }
  }

  // Check robots.txt (skip for robots.txt and sitemaps to avoid recursion)
  const isRobotsTxt = parsedUrl.pathname.toLowerCase() === "/robots.txt";
  const isSitemap =
    parsedUrl.pathname.toLowerCase().includes("sitemap") ||
    parsedUrl.pathname.toLowerCase().includes("llms.txt");

  if (respectRobots && !isRobotsTxt && !isSitemap) {
    const robotsCache = opts.robotsCache ?? new Map<string, string>();
    if (!robotsCache.has(hostname)) {
      const robotsUrl = `${parsedUrl.protocol}//${hostname}/robots.txt`;
      try {
        const robotsText = await fetchRobotsTxt(robotsUrl);
        robotsCache.set(hostname, robotsText);
      } catch {
        // robots.txt absent or fetch error - treat as allow-all
        robotsCache.set(hostname, "");
      }
    }
    const robotsContent = robotsCache.get(hostname) ?? "";
    const allowed = checkRobotsAllowed(robotsContent, url, POLITE_FETCH.USER_AGENT);
    if (!allowed) {
      throw new ToolFetchError({
        type: "robots_blocked",
        url,
        user_agent: POLITE_FETCH.USER_AGENT,
      });
    }
  }

  // Update delay tracker
  if (opts.hostDelays) {
    opts.hostDelays.set(hostname, Date.now());
  }

  const startTime = Date.now();

  // Headless rendering branch: hand off to Playwright, skip undici entirely.
  if (renderMode === "headless") {
    console.error(`[fetch] GET (headless) ${url}`);
    try {
      const rendered = await renderHeadless(url);
      const duration = Date.now() - startTime;
      console.error(`[fetch] ${rendered.statusCode} (headless) ${url} (${duration}ms)`);
      const headlessResult: FetchResult = {
        body: rendered.body,
        finalUrl: rendered.finalUrl,
        statusCode: rendered.statusCode,
        headers: rendered.headers,
        redirected: rendered.redirected,
      };
      if (!opts.noCache) cacheSet(url, headlessResult, renderMode);
      return headlessResult;
    } catch (err) {
      if (err instanceof HeadlessUnavailableError) {
        throw new ToolFetchError({ type: "fetch_error", url, message: err.message });
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new ToolFetchError({ type: "fetch_error", url, message: `headless render failed: ${msg}` });
    }
  }

  console.error(`[fetch] GET ${url}`);

  try {
    const response = await undiciFetch(url, {
      method: "GET",
      headers: {
        "User-Agent": POLITE_FETCH.USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      signal: AbortSignal.timeout(POLITE_FETCH.TIMEOUT_MS),
      redirect: "follow",
    });

    // Stream body with byte cap using arrayBuffer slicing
    const arrayBuf = await response.arrayBuffer();
    const fullBytes = Buffer.from(arrayBuf);
    let truncated = false;
    let bodyBuf: Buffer;
    if (fullBytes.length > POLITE_FETCH.MAX_BYTES) {
      bodyBuf = fullBytes.subarray(0, POLITE_FETCH.MAX_BYTES);
      truncated = true;
    } else {
      bodyBuf = fullBytes;
    }

    if (truncated) {
      console.error(`[fetch] Response truncated at ${POLITE_FETCH.MAX_BYTES} bytes: ${url}`);
    }

    const body = bodyBuf.toString("utf-8");
    const duration = Date.now() - startTime;
    console.error(`[fetch] ${response.status} ${url} (${duration}ms, ${fullBytes.length}b)`);

    if (response.status >= 400) {
      throw new ToolFetchError({
        type: "fetch_error",
        url,
        status: response.status,
        message: `HTTP ${response.status}`,
      });
    }

    // Collect headers as plain Record<string, string>
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const fetchResult: FetchResult = {
      body,
      finalUrl: response.url || url,
      statusCode: response.status,
      headers,
      redirected: response.redirected,
    };

    if (!opts.noCache) {
      cacheSet(url, fetchResult, renderMode);
    }

    return fetchResult;
  } catch (err) {
    if (err instanceof ToolFetchError) throw err;
    const errObj = err as Error;
    if (errObj.name === "TimeoutError" || errObj.name === "AbortError") {
      throw new ToolFetchError({
        type: "fetch_timeout",
        url,
        timeout_ms: POLITE_FETCH.TIMEOUT_MS,
      });
    }
    throw new ToolFetchError({
      type: "fetch_error",
      url,
      message: errObj.message ?? String(err),
    });
  }
}

/**
 * HTTP HEAD request for link health checks. Returns status code or null on error.
 */
export async function politeHead(
  url: string,
  opts: FetchOptions = {}
): Promise<number | null> {
  const hostname = getHostname(url);
  if (!hostname) return null;

  if (opts.hostDelays) {
    const lastRequest = opts.hostDelays.get(hostname);
    if (lastRequest !== undefined) {
      const elapsed = Date.now() - lastRequest;
      if (elapsed < POLITE_FETCH.INTER_REQUEST_DELAY_MS) {
        await sleep(POLITE_FETCH.INTER_REQUEST_DELAY_MS - elapsed);
      }
    }
  }

  try {
    const response = await undiciFetch(url, {
      method: "HEAD",
      headers: { "User-Agent": POLITE_FETCH.USER_AGENT },
      signal: AbortSignal.timeout(POLITE_FETCH.TIMEOUT_MS),
      redirect: "follow",
    });
    // Consume body
    await response.arrayBuffer();
    if (opts.hostDelays) opts.hostDelays.set(hostname, Date.now());
    console.error(`[head] ${response.status} ${url}`);
    return response.status;
  } catch {
    return null;
  }
}
