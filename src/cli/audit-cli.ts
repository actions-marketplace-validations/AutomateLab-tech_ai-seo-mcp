#!/usr/bin/env node
// CLI wrapper around audit_page / audit_site, used by the ai-seo GitHub Action.
// Not part of the MCP protocol; reads flags and prints results to stdout/stderr.
//
// Usage:
//   ai-seo-audit --urls "https://a.com,https://b.com/post" [--min-score 70] [--respect-robots true] [--report-path report.md]
//
// Exit code:
//   0  all audited URLs scored >= min-score
//   1  any URL scored < min-score (regression)
//   2  bad arguments / runtime error

import { appendFileSync } from "node:fs";
import { auditPage } from "../tools/audit-page.js";
import { saveAuditReport } from "../tools/save-audit-report.js";

interface Args {
  urls: string[];
  minScore: number;
  respectRobots: boolean;
  reportPath: string | null;
  failOnRegression: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    urls: [],
    minScore: 70,
    respectRobots: true,
    reportPath: null,
    failOnRegression: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`flag ${a} requires a value`);
      i++;
      return v;
    };
    switch (a) {
      case "--urls":
        args.urls = next().split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--min-score":
        args.minScore = Number(next());
        break;
      case "--respect-robots":
        args.respectRobots = next().toLowerCase() !== "false";
        break;
      case "--report-path":
        args.reportPath = next();
        break;
      case "--fail-on-regression":
        args.failOnRegression = next().toLowerCase() !== "false";
        break;
      case "--help":
      case "-h":
        console.log("Usage: ai-seo-audit --urls <csv> [--min-score N] [--respect-robots true|false] [--report-path FILE] [--fail-on-regression true|false]");
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag: ${a}`);
    }
  }
  if (args.urls.length === 0) throw new Error("at least one URL is required via --urls");
  if (!Number.isFinite(args.minScore)) throw new Error("--min-score must be a number");
  return args;
}

function emitGithubOutput(key: string, value: string | number): void {
  const file = process.env["GITHUB_OUTPUT"];
  if (!file) return;
  const safe = String(value).replace(/\r?\n/g, " ");
  try {
    appendFileSync(file, `${key}=${safe}\n`);
  } catch {
    // best-effort; CI step will still see stdout/stderr
  }
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error("[ai-seo-audit] argument error:", err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  const results = [];
  let anyBelow = false;
  let minObserved = 100;

  for (const url of args.urls) {
    try {
      const result = await auditPage({
        url,
        include_raw_html: false,
        respect_robots: args.respectRobots,
        generate_report: false,
      });
      const below = result.score < args.minScore;
      if (below) anyBelow = true;
      if (result.score < minObserved) minObserved = result.score;
      console.log(`${below ? "❌" : "✅"} ${url} — score=${result.score} grade=${result.grade} quality=${result.content_quality}`);
      results.push(result);
    } catch (err) {
      console.error(`[ai-seo-audit] failed for ${url}:`, err instanceof Error ? err.message : String(err));
      anyBelow = true;
    }
  }

  if (args.reportPath && results.length > 0) {
    // Save the first result; users who pass multiple URLs typically want one report per run,
    // and the action wires --report-path to a single file. Multi-URL reporting can be added if asked.
    try {
      const saved = await saveAuditReport({
        audit_result: results[0],
        path: args.reportPath,
        overwrite: true,
      });
      console.log(`[ai-seo-audit] wrote ${saved.bytes_written}b -> ${saved.saved_to}`);
      emitGithubOutput("report_path", saved.saved_to);
    } catch (err) {
      console.error("[ai-seo-audit] could not save report:", err instanceof Error ? err.message : String(err));
    }
  }

  emitGithubOutput("min_score_observed", minObserved);
  emitGithubOutput("urls_audited", results.length);

  if (anyBelow && args.failOnRegression) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("[ai-seo-audit] fatal:", err);
  process.exit(2);
});
