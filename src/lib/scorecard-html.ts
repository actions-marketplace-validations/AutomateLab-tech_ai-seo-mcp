// Render a standalone HTML scorecard from an audit_page result.
// No external dependencies - inline CSS only.

import type { CitationVerdict } from "../tools/audit-page.js";

interface ScorecardInput {
  url: string;
  fetched_at: string;
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  citation_verdict: CitationVerdict;
  dimension_scores: {
    schema: number;
    robots: number;
    technical: number;
    freshness: number;
    structure: number;
    authority: number;
    entity_density: number;
    sitemap: number;
  };
}

const DIMENSION_LABELS: Record<string, string> = {
  schema: "Schema",
  technical: "Technical",
  structure: "Structure",
  robots: "Robots",
  freshness: "Freshness",
  authority: "Authority",
  entity_density: "Entity Density",
  sitemap: "Sitemap",
};

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function barColor(score: number): string {
  if (score >= 75) return "#22c55e";
  if (score >= 50) return "#f59e0b";
  return "#ef4444";
}

function verdictColor(verdict: string): string {
  if (verdict === "likely") return "#22c55e";
  if (verdict === "marginal") return "#f59e0b";
  return "#ef4444";
}

function gradeColor(grade: string): string {
  if (grade === "A") return "#22c55e";
  if (grade === "B") return "#84cc16";
  if (grade === "C") return "#f59e0b";
  if (grade === "D") return "#f97316";
  return "#ef4444";
}

export function renderScorecardHtml(input: ScorecardInput): string {
  const { url, fetched_at, score, grade, citation_verdict, dimension_scores } = input;

  const formattedDate = new Date(fetched_at).toUTCString();
  const verdictLabel =
    citation_verdict.will_ai_cite === "likely"
      ? "Likely to be cited"
      : citation_verdict.will_ai_cite === "marginal"
        ? "Marginally citable"
        : "Unlikely to be cited";

  const dimensionRows = Object.entries(dimension_scores)
    .map(([key, val]) => {
      const label = DIMENSION_LABELS[key] ?? key;
      const color = barColor(val);
      return `
      <div class="dim-row">
        <span class="dim-label">${escHtml(label)}</span>
        <div class="bar-track">
          <div class="bar-fill" style="width:${val}%;background:${color};"></div>
        </div>
        <span class="dim-score">${val}</span>
      </div>`;
    })
    .join("");

  const blockerItems = citation_verdict.top_3_blockers
    .map((b, i) => {
      const impactBadge = b.estimated_impact
        ? `<span class="badge badge-${b.estimated_impact}">${escHtml(b.estimated_impact)}</span>`
        : "";
      return `
      <div class="blocker">
        <div class="blocker-header">
          <span class="blocker-num">${i + 1}</span>
          <span class="blocker-cat">${escHtml(b.category)}</span>
          ${impactBadge}
        </div>
        <p class="blocker-msg">${escHtml(b.message)}</p>
        <p class="blocker-fix"><strong>Fix:</strong> ${escHtml(b.fix)}</p>
      </div>`;
    })
    .join("");

  const noBlockers =
    citation_verdict.top_3_blockers.length === 0
      ? `<p class="no-blockers">No critical blockers found.</p>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI-SEO Scorecard - ${escHtml(url)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;padding:2rem 1rem}
.card{max-width:700px;margin:0 auto;background:#1e293b;border-radius:12px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,.4)}
.header{padding:2rem;border-bottom:1px solid #334155}
.header-url{font-size:.85rem;color:#94a3b8;word-break:break-all;margin-bottom:.5rem}
.header-ts{font-size:.78rem;color:#64748b}
.grade-row{display:flex;align-items:center;gap:1.5rem;margin-top:1.25rem}
.grade-badge{font-size:3rem;font-weight:800;line-height:1;color:${gradeColor(grade)}}
.score-num{font-size:1.75rem;font-weight:700;color:#f1f5f9}
.score-label{font-size:.8rem;color:#94a3b8;margin-top:.2rem}
.verdict-pill{display:inline-block;padding:.35rem .9rem;border-radius:999px;font-size:.85rem;font-weight:600;background:${verdictColor(citation_verdict.will_ai_cite)}22;color:${verdictColor(citation_verdict.will_ai_cite)};border:1px solid ${verdictColor(citation_verdict.will_ai_cite)}44;margin-top:.5rem}
.summary{font-size:.9rem;color:#cbd5e1;margin-top:.75rem;line-height:1.5}
.section{padding:1.5rem 2rem}
.section + .section{border-top:1px solid #334155}
.section-title{font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#64748b;margin-bottom:1rem}
.dim-row{display:grid;grid-template-columns:110px 1fr 36px;align-items:center;gap:.75rem;margin-bottom:.6rem}
.dim-label{font-size:.82rem;color:#94a3b8;text-align:right}
.bar-track{height:8px;background:#0f172a;border-radius:4px;overflow:hidden}
.bar-fill{height:100%;border-radius:4px;transition:width .3s}
.dim-score{font-size:.82rem;font-weight:600;color:#e2e8f0;text-align:right}
.blocker{background:#0f172a;border-radius:8px;padding:1rem;margin-bottom:.75rem;border-left:3px solid #ef4444}
.blocker:last-child{margin-bottom:0}
.blocker-header{display:flex;align-items:center;gap:.5rem;margin-bottom:.5rem}
.blocker-num{width:22px;height:22px;border-radius:50%;background:#ef4444;color:#fff;font-size:.75rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.blocker-cat{font-size:.8rem;font-weight:600;color:#cbd5e1;text-transform:capitalize}
.badge{padding:.15rem .5rem;border-radius:4px;font-size:.7rem;font-weight:600;text-transform:uppercase}
.badge-high{background:#ef444422;color:#ef4444}
.badge-medium{background:#f59e0b22;color:#f59e0b}
.badge-low{background:#22c55e22;color:#22c55e}
.blocker-msg{font-size:.82rem;color:#94a3b8;margin-bottom:.35rem;line-height:1.4}
.blocker-fix{font-size:.82rem;color:#64748b;line-height:1.4}
.blocker-fix strong{color:#94a3b8}
.no-blockers{font-size:.9rem;color:#22c55e}
.footer{padding:1rem 2rem;text-align:center;font-size:.75rem;color:#475569;border-top:1px solid #334155}
.footer a{color:#6366f1;text-decoration:none}
.footer a:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <div class="header-url">${escHtml(url)}</div>
    <div class="header-ts">Audited ${escHtml(formattedDate)}</div>
    <div class="grade-row">
      <div>
        <div class="grade-badge">${escHtml(grade)}</div>
      </div>
      <div>
        <div class="score-num">${score}<span style="font-size:1rem;color:#64748b">/100</span></div>
        <div class="score-label">AI Citation Score</div>
      </div>
    </div>
    <div class="verdict-pill">${escHtml(verdictLabel)}</div>
    <p class="summary">${escHtml(citation_verdict.one_line_summary)}</p>
  </div>

  <div class="section">
    <div class="section-title">Dimension Scores</div>
    ${dimensionRows}
  </div>

  <div class="section">
    <div class="section-title">Top Blockers</div>
    ${blockerItems}${noBlockers}
  </div>

  <div class="footer">
    Generated by <a href="https://github.com/AutomateLab-tech/ai-seo-mcp" target="_blank" rel="noopener">AI Citation Toolkit</a> - github.com/AutomateLab-tech/ai-seo-mcp
  </div>
</div>
</body>
</html>`;
}
