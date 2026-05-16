// Smoke tests for all 12 AI-SEO MCP tools.
// Network tests are gated on CI=true to avoid network calls in CI.
// Each test exercises the tool against the spec-defined test targets.

import { describe, it, expect } from "vitest";

// Tools under test (using compiled dist via tsx or direct src imports)
import { auditPage } from "../src/tools/audit-page.js";
import { auditSchema } from "../src/tools/audit-schema.js";
import { auditCanonical } from "../src/tools/audit-canonical.js";
import { checkRobots } from "../src/tools/check-robots.js";
import { checkSitemap } from "../src/tools/check-sitemap.js";
import { checkTechnical } from "../src/tools/check-technical.js";
import { scoreAiOverviewEligibility } from "../src/tools/score-ai-overview-eligibility.js";
import { generateLlmsTxtTool } from "../src/tools/generate-llms-txt.js";
import { validateLlmsTxt } from "../src/tools/validate-llms-txt.js";
import { scoreCitationWorthiness } from "../src/tools/score-citation-worthiness.js";
import { extractEntities } from "../src/tools/extract-entities.js";
import { diffPages } from "../src/tools/diff-pages.js";
// rewrite tools require LLM host - excluded from automated smoke tests

const skipNet = process.env["CI"] === "true";

describe("audit_schema - inline JSON", () => {
  it("detects http:// context and string author", async () => {
    const result = await auditSchema({
      schema_json: '{"@context":"http://schema.org","@type":"Article","author":"Jane Smith"}',
      respect_robots: true,
    });
    expect(result.source).toBe("inline");
    expect(result.findings.length).toBeGreaterThan(0);
    const criticals = result.findings.filter((f) => f.severity === "critical");
    expect(criticals.length).toBeGreaterThan(0);
  });

  it("returns empty findings for valid Article schema", async () => {
    const validSchema = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Article",
      "name": "Test Article",
      "author": {
        "@type": "Person",
        "name": "Jane Smith",
        "url": "https://example.com/jane",
        "sameAs": ["https://linkedin.com/in/janesmith"],
      },
    });
    const result = await auditSchema({ schema_json: validSchema, respect_robots: true });
    const criticals = result.findings.filter((f) => f.severity === "critical");
    expect(criticals.length).toBe(0);
  });
});

describe("validate_llms_txt - inline content", () => {
  it("detects missing H1 heading (critical finding)", async () => {
    const badContent = `> This is a description.\n\n## Section\n\n- [Link](https://example.com): A page.`;
    const result = await validateLlmsTxt({ content: badContent, check_links: false });
    expect(result.valid).toBe(false);
    const critical = result.findings.find((f) => f.severity === "critical");
    expect(critical).toBeDefined();
  });

  it("passes a well-formed llms.txt", async () => {
    const goodContent = `# Test Site\n\n> A test site for AI SEO.\n\n## Pages\n\n- [Home](https://example.com/): The home page.\n- [About](https://example.com/about): About us.`;
    const result = await validateLlmsTxt({ content: goodContent, check_links: false });
    expect(result.valid).toBe(true);
    const criticals = result.findings.filter((f) => f.severity === "critical");
    expect(criticals.length).toBe(0);
  });

  it("detects relative links as critical", async () => {
    const relativeLinks = `# Site\n\n> Description.\n\n## Pages\n\n- [Page](/page): A page.`;
    const result = await validateLlmsTxt({ content: relativeLinks, check_links: false });
    expect(result.valid).toBe(false);
  });
});

describe("score_citation_worthiness - text mode", () => {
  it("returns valid score structure for plain text", async () => {
    const text = `Machine learning is a subset of AI. In 2024, 73% of enterprises adopted ML. How does gradient descent work? Gradient descent minimizes the loss function by iterating over training data.`;
    const result = await scoreCitationWorthiness({ text, target_query: "how does machine learning work" });
    expect(result.overall_score).toBeGreaterThanOrEqual(0);
    expect(result.overall_score).toBeLessThanOrEqual(100);
    expect(result.engine_scores.perplexity).toBeGreaterThanOrEqual(0);
    expect(result.engine_scores.chatgpt).toBeGreaterThanOrEqual(0);
    expect(result.engine_scores.google_ai_overviews).toBeGreaterThanOrEqual(0);
    expect(result.engine_scores.claude).toBeGreaterThanOrEqual(0);
  });
});

describe("extract_entities - text mode", () => {
  it("finds entities in sample text", async () => {
    const text = `OpenAI was founded by Sam Altman and Elon Musk. OpenAI released GPT-4 in 2023. GPT-4 powers ChatGPT. ChatGPT is used by millions of users.`;
    const result = await extractEntities({ text });
    expect(result.entity_count).toBeGreaterThan(0);
    expect(result.citation_density_score).toBeGreaterThanOrEqual(0);
  });
});

describe("diff_pages - network (two real URLs)", () => {
  it.skipIf(skipNet)("returns valid diff structure for two URLs", async () => {
    const result = await diffPages({
      url_a: "https://automatelab.tech",
      url_b: "https://example.com",
      query: "AI SEO audit tool",
      respect_robots: false,
    });
    expect(result.url_a).toBe("https://automatelab.tech");
    expect(result.url_b).toBe("https://example.com");
    expect(result.query).toBe("AI SEO audit tool");
    expect(["a", "b", "tie"]).toContain(result.better_for_citation);
    expect(result.scores.a).toBeGreaterThanOrEqual(0);
    expect(result.scores.a).toBeLessThanOrEqual(100);
    expect(result.scores.b).toBeGreaterThanOrEqual(0);
    expect(result.scores.b).toBeLessThanOrEqual(100);
    // delta has all 8 dimensions
    const dims = ["schema", "structure", "robots", "entity_density", "freshness", "technical", "authority", "sitemap"] as const;
    for (const dim of dims) {
      expect(result.delta[dim]).toBeDefined();
      expect(["a", "b", "tie"]).toContain(result.delta[dim].advantage);
    }
    expect(result.missing_in_a).toBeInstanceOf(Array);
    expect(result.missing_in_b).toBeInstanceOf(Array);
    expect(result.fix_recommendations_for_a).toBeInstanceOf(Array);
  });
});

// ============ Network-dependent tests ============

describe("check_robots - example.com (network)", () => {
  it.skipIf(skipNet)("returns result (not error) even without robots.txt", async () => {
    const result = await checkRobots({ domain: "example.com" });
    expect(result.robots_url).toBe("https://example.com/robots.txt");
    expect(result.findings).toBeInstanceOf(Array);
    // example.com has no robots.txt - should emit warning
    const hasWarning = result.findings.some((f) => f.severity === "warning" || f.severity === "info");
    expect(hasWarning).toBe(true);
  });
});

describe("audit_schema - Wikipedia (network)", () => {
  it.skipIf(skipNet)("finds schema types on Wikipedia Answer engine page", async () => {
    const result = await auditSchema({
      url: "https://en.wikipedia.org/wiki/Answer_engine",
      respect_robots: false, // Wikipedia allows all crawlers
    });
    expect(result.found_types.length).toBeGreaterThan(0);
  });
});

describe("audit_page - automatelab.tech (network)", () => {
  it.skipIf(skipNet)("completes without error and returns valid score", async () => {
    const result = await auditPage({
      url: "https://automatelab.tech",
      include_raw_html: false,
      respect_robots: false,
    });
    expect(result.url).toBe("https://automatelab.tech");
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(["A", "B", "C", "D", "F"]).toContain(result.grade);
    expect(result.findings).toBeInstanceOf(Array);
    expect(result.dimension_scores).toHaveProperty("schema");
    // citation_verdict block
    expect(result.citation_verdict).toBeDefined();
    expect(["unlikely", "marginal", "likely"]).toContain(result.citation_verdict.will_ai_cite);
    expect(result.citation_verdict.top_3_blockers).toBeInstanceOf(Array);
    expect(result.citation_verdict.top_3_blockers.length).toBeLessThanOrEqual(3);
    expect(typeof result.citation_verdict.one_line_summary).toBe("string");
    expect(result.citation_verdict.one_line_summary.length).toBeGreaterThan(0);
    // report_html absent when not requested
    expect(result.report_html).toBeUndefined();
  });

  it.skipIf(skipNet)("returns standalone HTML scorecard when generate_report=true", async () => {
    const result = await auditPage({
      url: "https://automatelab.tech",
      include_raw_html: false,
      respect_robots: false,
      generate_report: true,
    });
    expect(typeof result.report_html).toBe("string");
    const html = result.report_html as string;
    // must be a complete HTML document
    expect(html).toMatch(/<!DOCTYPE html>/i);
    expect(html).toMatch(/<html/);
    expect(html).toMatch(/<\/html>/);
    // must contain the audited URL
    expect(html).toContain("automatelab.tech");
    // must contain the grade
    expect(html).toContain(result.grade);
    // must contain the score
    expect(html).toContain(String(result.score));
    // no external stylesheet or script dependencies
    expect(html).not.toMatch(/src="https?:\/\//);
    expect(html).not.toMatch(/href="https?:\/\/[^"]+\.css/);
  });
});

describe("check_technical - automatelab.tech (network)", () => {
  it.skipIf(skipNet)("reports HTTPS true and returns findings", async () => {
    const result = await checkTechnical({
      url: "https://automatelab.tech",
      respect_robots: false,
    });
    expect(result.https).toBe(true);
    expect(result.findings).toBeInstanceOf(Array);
  });
});

describe("check_sitemap - automatelab.tech (network)", () => {
  it.skipIf(skipNet)("returns sitemap result", async () => {
    const result = await checkSitemap({
      domain: "automatelab.tech",
      max_urls_to_check: 10,
    });
    expect(["found", "missing", "error"]).toContain(result.status);
  });
});

describe("score_ai_overview_eligibility - automatelab.tech (network)", () => {
  it.skipIf(skipNet)("returns eligibility score 0-100", async () => {
    const result = await scoreAiOverviewEligibility({
      url: "https://automatelab.tech",
      respect_robots: false,
    });
    expect(result.overall_eligibility_score).toBeGreaterThanOrEqual(0);
    expect(result.overall_eligibility_score).toBeLessThanOrEqual(100);
    expect(result.factors).toHaveProperty("semantic_completeness");
    expect(result.top_improvements).toBeInstanceOf(Array);
  });
});

describe("generate_llms_txt - automatelab.tech (network)", () => {
  it.skipIf(skipNet)("returns non-empty llms.txt with H1 and at least one link", async () => {
    const result = await generateLlmsTxtTool({
      domain: "automatelab.tech",
      max_pages: 5,
      include_full: false,
    });
    expect(result.llms_txt.length).toBeGreaterThan(10);
    // Should have H1 heading
    expect(result.llms_txt).toMatch(/^#\s+/m);
    // Should have at least one Markdown link
    expect(result.llms_txt).toMatch(/\[.+\]\(https?:\/\//);
    expect(result.pages_indexed).toBeGreaterThan(0);
  });
});

describe("audit_canonical - automatelab.tech (network)", () => {
  it.skipIf(skipNet)("returns canonical analysis", async () => {
    const result = await auditCanonical({
      url: "https://automatelab.tech",
      respect_robots: false,
    });
    expect(result.url).toBe("https://automatelab.tech");
    expect(result.findings).toBeInstanceOf(Array);
  });
});

describe("extract_entities - Wikipedia (network)", () => {
  it.skipIf(skipNet)("extracts entities from Wikipedia page (static HTML, entity-rich)", async () => {
    const result = await extractEntities({
      url: "https://en.wikipedia.org/wiki/Answer_engine",
      respect_robots: false,
    });
    // Wikipedia is static HTML with rich text - should find multiple entities
    expect(result.entity_count).toBeGreaterThan(0);
    expect(result.citation_density_score).toBeGreaterThanOrEqual(0);
  });
});
