// In-memory LRU cache for politeFetch results.
// Keyed on URL (rendering mode reserved for headless support; static-only for now).
// Bypass via DISABLE_CACHE=true; default size 50 entries; TTL 5 minutes.

import type { FetchResult } from "./fetch.js";

export const FETCH_CACHE_CONFIG = {
  DISABLED: process.env["DISABLE_CACHE"] === "true",
  MAX_ENTRIES: Number(process.env["FETCH_CACHE_MAX_ENTRIES"] ?? 50),
  TTL_MS: Number(process.env["FETCH_CACHE_TTL_MS"] ?? 5 * 60 * 1000),
} as const;

interface CacheEntry {
  result: FetchResult;
  expiresAt: number;
}

// Insertion-order Map gives us LRU semantics: delete + re-set bumps to most-recent.
const cache = new Map<string, CacheEntry>();

export type RenderMode = "static" | "headless";

function makeKey(url: string, mode: RenderMode): string {
  return `${mode}::${url}`;
}

export function cacheGet(url: string, mode: RenderMode = "static"): FetchResult | null {
  if (FETCH_CACHE_CONFIG.DISABLED) return null;
  const key = makeKey(url, mode);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  // Bump to most-recent.
  cache.delete(key);
  cache.set(key, entry);
  return entry.result;
}

export function cacheSet(url: string, result: FetchResult, mode: RenderMode = "static"): void {
  if (FETCH_CACHE_CONFIG.DISABLED) return;
  const key = makeKey(url, mode);
  cache.set(key, {
    result,
    expiresAt: Date.now() + FETCH_CACHE_CONFIG.TTL_MS,
  });
  while (cache.size > FETCH_CACHE_CONFIG.MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function cacheClear(): void {
  cache.clear();
}

export function cacheSize(): number {
  return cache.size;
}
