// Cheerio-based DOM helpers for extracting page signals.

import * as cheerio from "cheerio";

export interface HeadData {
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  ogUrl: string | null;
  ogType: string | null;
  twitterCard: string | null;
  twitterTitle: string | null;
  twitterDescription: string | null;
  noindex: boolean;
  noindexHeader: boolean;
  hreflangTags: Array<{ lang: string; href: string }>;
  charset: string | null;
  viewport: string | null;
}

export interface PageStructure {
  h1s: string[];
  h2s: string[];
  h3s: string[];
  h4s: string[];
  paragraphs: string[];
  orderedLists: number; // count of <ol>
  tables: number; // count of <table>
  images: number; // count of <img>
  videos: number; // count of <video> + YouTube iframes
  externalLinks: string[];
  internalLinks: string[];
  wordCount: number;
  bodyText: string;
}

/** Parse HTML and extract HEAD metadata. */
export function parseHead(
  html: string,
  xRobotsTag?: string | string[]
): HeadData {
  const $ = cheerio.load(html);
  const head = $("head");

  const title = head.find("title").first().text().trim() || null;
  const metaDescription =
    head
      .find('meta[name="description"]')
      .attr("content")
      ?.trim() ?? null;
  const canonical = head.find('link[rel="canonical"]').attr("href")?.trim() ?? null;
  const ogTitle =
    head.find('meta[property="og:title"]').attr("content")?.trim() ?? null;
  const ogDescription =
    head.find('meta[property="og:description"]').attr("content")?.trim() ?? null;
  const ogImage =
    head.find('meta[property="og:image"]').attr("content")?.trim() ?? null;
  const ogUrl =
    head.find('meta[property="og:url"]').attr("content")?.trim() ?? null;
  const ogType =
    head.find('meta[property="og:type"]').attr("content")?.trim() ?? null;
  const twitterCard =
    head.find('meta[name="twitter:card"]').attr("content")?.trim() ?? null;
  const twitterTitle =
    head.find('meta[name="twitter:title"]').attr("content")?.trim() ?? null;
  const twitterDescription =
    head.find('meta[name="twitter:description"]').attr("content")?.trim() ?? null;

  // Check noindex from meta tags
  const robotsMeta = head
    .find('meta[name="robots"]')
    .attr("content")
    ?.toLowerCase() ?? "";
  let noindex = robotsMeta.includes("noindex");

  // Check X-Robots-Tag header
  let noindexHeader = false;
  if (xRobotsTag) {
    const tags = Array.isArray(xRobotsTag) ? xRobotsTag : [xRobotsTag];
    noindexHeader = tags.some((t) => t.toLowerCase().includes("noindex"));
    if (noindexHeader) noindex = true;
  }

  const hreflangTags: Array<{ lang: string; href: string }> = [];
  head.find('link[rel="alternate"][hreflang]').each((_, el) => {
    const lang = $(el).attr("hreflang") ?? "";
    const href = $(el).attr("href") ?? "";
    if (lang && href) hreflangTags.push({ lang, href });
  });

  const charset =
    head.find('meta[charset]').attr("charset")?.trim() ??
    head.find('meta[http-equiv="Content-Type"]').attr("content")?.match(/charset=([^;]+)/i)?.[1]?.trim() ??
    null;

  const viewport =
    head.find('meta[name="viewport"]').attr("content")?.trim() ?? null;

  return {
    title,
    metaDescription,
    canonical,
    ogTitle,
    ogDescription,
    ogImage,
    ogUrl,
    ogType,
    twitterCard,
    twitterTitle,
    twitterDescription,
    noindex,
    noindexHeader,
    hreflangTags,
    charset,
    viewport,
  };
}

/** Extract page structure: headings, paragraphs, links, word count, body text. */
export function parseBody(html: string, baseUrl: string): PageStructure {
  const $ = cheerio.load(html);
  const body = $("body");

  const h1s: string[] = [];
  const h2s: string[] = [];
  const h3s: string[] = [];
  const h4s: string[] = [];
  body.find("h1").each((_, el) => { h1s.push($(el).text().trim()); });
  body.find("h2").each((_, el) => { h2s.push($(el).text().trim()); });
  body.find("h3").each((_, el) => { h3s.push($(el).text().trim()); });
  body.find("h4").each((_, el) => { h4s.push($(el).text().trim()); });

  const paragraphs: string[] = [];
  body.find("p").each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 20) paragraphs.push(text);
  });

  const orderedLists = body.find("ol").length;
  const tables = body.find("table").length;
  const images = body.find("img").length;

  let videos = body.find("video").length;
  body.find("iframe").each((_, el) => {
    const src = $(el).attr("src") ?? "";
    if (src.includes("youtube") || src.includes("youtu.be") || src.includes("vimeo")) {
      videos++;
    }
  });

  let baseParsed: URL | null = null;
  try { baseParsed = new URL(baseUrl); } catch { /* ignore */ }

  const externalLinks: string[] = [];
  const internalLinks: string[] = [];
  body.find("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (!href || href.startsWith("#") || href.startsWith("mailto:")) return;
    if (href.startsWith("http")) {
      try {
        const linkUrl = new URL(href);
        if (baseParsed && linkUrl.hostname !== baseParsed.hostname) {
          externalLinks.push(href);
        } else {
          internalLinks.push(href);
        }
      } catch { /* ignore invalid */ }
    } else {
      internalLinks.push(href);
    }
  });

  // Strip scripts/styles/nav from body text
  body.find("script, style, nav, header, footer, .nav, .menu").remove();
  const bodyText = body.text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText.split(/\s+/).filter((w) => w.length > 0).length;

  return {
    h1s,
    h2s,
    h3s,
    h4s,
    paragraphs,
    orderedLists,
    tables,
    images,
    videos,
    externalLinks,
    internalLinks,
    wordCount,
    bodyText,
  };
}

/** Extract all JSON-LD script blocks from HTML as raw strings. */
export function extractJsonLdBlocks(html: string): string[] {
  const $ = cheerio.load(html);
  const blocks: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const content = $(el).html();
    if (content) blocks.push(content.trim());
  });
  return blocks;
}

// =====================================================================
// v0.5 additions: body-level signals consumed by audit_page.
// Each helper takes the raw HTML string so callers can share cheerio.load.
// =====================================================================

/** Image alt-text coverage. */
export interface ImageAltStats {
  total: number;
  withMeaningfulAlt: number; // alt attr present AND non-empty
  decorative: number;        // alt="" (intentionally empty - decorative)
  missing: number;           // alt attribute absent entirely
  missingSamples: string[];  // up to 3 src values without alt
}

export function analyzeImages(html: string): ImageAltStats {
  const $ = cheerio.load(html);
  let total = 0;
  let withMeaningfulAlt = 0;
  let decorative = 0;
  let missing = 0;
  const missingSamples: string[] = [];
  $("img").each((_, el) => {
    total++;
    const alt = $(el).attr("alt");
    if (alt === undefined) {
      missing++;
      if (missingSamples.length < 3) {
        const src = $(el).attr("src") ?? "";
        if (src) missingSamples.push(src.slice(0, 80));
      }
    } else if (alt.trim().length === 0) {
      decorative++;
    } else {
      withMeaningfulAlt++;
    }
  });
  return { total, withMeaningfulAlt, decorative, missing, missingSamples };
}

/** Anchor text quality. */
export interface AnchorTextStats {
  total: number;
  lowQuality: number;
  lowQualitySamples: Array<{ text: string; href: string }>;
}

const LOW_QUALITY_ANCHOR_PHRASES = new Set([
  "click here", "click", "here", "read more", "more", "link", "this",
  "this link", "this page", "learn more", "more info", "details",
  "view", "see", "go", "go here", "tap here", "open",
]);

export function analyzeAnchors(html: string): AnchorTextStats {
  const $ = cheerio.load(html);
  let total = 0;
  let lowQuality = 0;
  const lowQualitySamples: Array<{ text: string; href: string }> = [];
  $("body a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("javascript:")) return;
    total++;
    const rawText = $(el).text().replace(/\s+/g, " ").trim();
    const text = rawText.toLowerCase();
    let isLowQuality = false;
    if (!rawText) {
      isLowQuality = true;
    } else if (LOW_QUALITY_ANCHOR_PHRASES.has(text)) {
      isLowQuality = true;
    } else if (/^https?:\/\//.test(rawText)) {
      // Raw URL used as anchor text.
      isLowQuality = true;
    } else if (rawText.length <= 2) {
      // Single character or arrow-only anchors.
      isLowQuality = true;
    }
    if (isLowQuality) {
      lowQuality++;
      if (lowQualitySamples.length < 5) {
        lowQualitySamples.push({ text: rawText.slice(0, 40) || "(empty)", href: href.slice(0, 80) });
      }
    }
  });
  return { total, lowQuality, lowQualitySamples };
}

/** Heading hierarchy: detects skipped levels and multiple H1s. */
export interface HeadingHierarchyStats {
  order: number[]; // [1,2,2,3,4,...]
  skips: Array<{ from: number; to: number; nearText: string }>;
  h1Count: number;
}

export function analyzeHeadingHierarchy(html: string): HeadingHierarchyStats {
  const $ = cheerio.load(html);
  const order: number[] = [];
  const skips: Array<{ from: number; to: number; nearText: string }> = [];
  let prev = 0;
  let h1Count = 0;
  $("body h1, body h2, body h3, body h4, body h5, body h6").each((_, el) => {
    const tag = (el as { name?: string }).name ?? "";
    const lvl = parseInt(tag.slice(1), 10);
    if (!Number.isFinite(lvl)) return;
    order.push(lvl);
    if (lvl === 1) h1Count++;
    if (prev > 0 && lvl > prev + 1) {
      const text = $(el).text().replace(/\s+/g, " ").trim().slice(0, 60);
      skips.push({ from: prev, to: lvl, nearText: text });
    }
    prev = lvl;
  });
  return { order, skips, h1Count };
}

/** Readability stats (no syllable counting - just word/sentence/paragraph length). */
export interface ReadabilityStats {
  totalWords: number;
  totalSentences: number;
  totalParagraphs: number;
  avgWordsPerSentence: number;
  avgWordsPerParagraph: number;
  longSentenceCount: number;  // > 30 words
  longParagraphCount: number; // > 120 words
}

export function analyzeReadability(paragraphs: string[]): ReadabilityStats {
  let totalWords = 0;
  let totalSentences = 0;
  let longSentenceCount = 0;
  let longParagraphCount = 0;
  for (const p of paragraphs) {
    const words = p.split(/\s+/).filter((w) => w.length > 0);
    totalWords += words.length;
    if (words.length > 120) longParagraphCount++;
    const sentences = p
      .split(/[.!?]+(?=\s|$)/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    totalSentences += sentences.length;
    for (const s of sentences) {
      const w = s.split(/\s+/).filter((x) => x.length > 0).length;
      if (w > 30) longSentenceCount++;
    }
  }
  const totalParagraphs = paragraphs.length;
  const avgWordsPerSentence = totalSentences > 0 ? totalWords / totalSentences : 0;
  const avgWordsPerParagraph = totalParagraphs > 0 ? totalWords / totalParagraphs : 0;
  return {
    totalWords,
    totalSentences,
    totalParagraphs,
    avgWordsPerSentence: Math.round(avgWordsPerSentence * 10) / 10,
    avgWordsPerParagraph: Math.round(avgWordsPerParagraph * 10) / 10,
    longSentenceCount,
    longParagraphCount,
  };
}

/** Mixed content: http:// asset URLs on a page served over https. */
export interface MixedContentStats {
  total: number;
  samples: string[];
}

export function analyzeMixedContent(html: string): MixedContentStats {
  const samples: string[] = [];
  let total = 0;
  // Match src="http://..." or href="http://..." (non-https). Also matches single-quoted.
  const re = /(?:src|href)\s*=\s*["']http:\/\/([^"'\s>]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    total++;
    if (samples.length < 3) samples.push("http://" + m[1].slice(0, 80));
  }
  return { total, samples };
}

/** Title vs H1 overlap ratio: 1.0 = identical, 0.0 = unrelated. */
export function titleH1Overlap(title: string | null, h1: string | null): number | null {
  if (!title || !h1) return null;
  const a = title.trim();
  const b = h1.trim();
  if (!a || !b) return null;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

/** Simple Levenshtein distance between two strings. */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}
