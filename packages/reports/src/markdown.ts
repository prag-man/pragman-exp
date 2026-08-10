import {
  ANALYSIS_ACTION_GROUPS,
  ANALYSIS_DIMENSIONS,
  validateAnalysisReport,
  type AnalysisReport,
} from "./json.ts";

function escapeMarkdown(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]{}()#+.!|-])/g, "\\$1");
}

function label(value: string): string {
  return value.split("-").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
}

export function renderAnalysisMarkdown(report: AnalysisReport): string {
  validateAnalysisReport(report);
  const lines = [
    `# ${escapeMarkdown(report.title)}`,
    "",
    `Subject: ${escapeMarkdown(report.subject)}`,
    "",
    escapeMarkdown(report.summary),
    "",
    "## Evidence",
    "",
  ];
  if (report.evidence.length === 0) lines.push("No evidence was supplied.", "");
  for (const evidence of report.evidence) {
    lines.push(`- ${escapeMarkdown(evidence.claim)} — Confidence: ${evidence.confidence}; Evidence: ${evidence.evidence_refs.map(escapeMarkdown).join(", ") || "none"}`);
  }
  lines.push("", "## Analysis dimensions", "");
  for (const dimension of ANALYSIS_DIMENSIONS) {
    lines.push(`### ${label(dimension)}`, "", escapeMarkdown(report.dimensions[dimension]), "");
  }
  for (const group of ANALYSIS_ACTION_GROUPS) {
    lines.push(`## ${group}`, "");
    const actions = report.actions[group];
    if (actions.length === 0) {
      lines.push("No action proposed.", "");
      continue;
    }
    for (const action of actions) {
      lines.push(`- ${escapeMarkdown(action.action)}`);
      lines.push(`  - Why: ${escapeMarkdown(action.rationale)}`);
      lines.push(`  - Confidence: ${action.confidence}`);
      lines.push(`  - Evidence: ${action.evidence_refs.map(escapeMarkdown).join(", ") || "none"}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}
