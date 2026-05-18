// Headless browser rendering via playwright-core. Optional dep, lazy-imported.
// Adds 3-10s per request and a ~50MB install; opt in via render: "headless".

import { POLITE_FETCH } from "./config.js";

export interface HeadlessResult {
  body: string;
  finalUrl: string;
  statusCode: number;
  headers: Record<string, string>;
  redirected: boolean;
}

export class HeadlessUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadlessUnavailableError";
  }
}

let browserPromise: Promise<unknown> | null = null;

async function getBrowser(): Promise<unknown> {
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    let pw: { chromium: { launch: (opts: object) => Promise<unknown> } };
    try {
      // Indirect specifier prevents TypeScript from requiring playwright-core types at compile time;
      // the dep is an optional peer dependency installed only when users opt into headless mode.
      const specifier = "playwright-core";
      pw = (await import(specifier)) as unknown as typeof pw;
    } catch {
      throw new HeadlessUnavailableError(
        "playwright-core is not installed. Install it with `npm install playwright-core` then run `npx playwright install chromium` once."
      );
    }
    return pw.chromium.launch({ headless: true });
  })();
  return browserPromise;
}

export async function renderHeadless(url: string): Promise<HeadlessResult> {
  const browser = (await getBrowser()) as {
    newContext: (opts: object) => Promise<{
      newPage: () => Promise<{
        goto: (
          url: string,
          opts: object
        ) => Promise<{
          status: () => number;
          url: () => string;
          headers: () => Record<string, string>;
        } | null>;
        content: () => Promise<string>;
        close: () => Promise<void>;
      }>;
      close: () => Promise<void>;
    }>;
  };
  const context = await browser.newContext({ userAgent: POLITE_FETCH.USER_AGENT });
  const page = await context.newPage();
  try {
    const response = await page.goto(url, {
      waitUntil: "networkidle",
      timeout: POLITE_FETCH.TIMEOUT_MS,
    });
    if (!response) {
      throw new Error(`No response from ${url}`);
    }
    const status = response.status();
    if (status >= 400) {
      throw new Error(`HTTP ${status}`);
    }
    const body = await page.content();
    const finalUrl = response.url();
    const headers = response.headers();
    return {
      body,
      finalUrl,
      statusCode: status,
      headers,
      redirected: finalUrl !== url,
    };
  } finally {
    await page.close();
    await context.close();
  }
}

export async function closeHeadlessBrowser(): Promise<void> {
  if (!browserPromise) return;
  try {
    const browser = (await browserPromise) as { close: () => Promise<void> };
    await browser.close();
  } catch {
    // ignore
  }
  browserPromise = null;
}
