export const ANALYSIS_DIMENSIONS = [
  "intent-versus-outcome",
  "scope-and-routing-quality",
  "assumptions-and-decisions",
  "context-completeness",
  "provider-and-tool-fit",
  "time-versus-value",
  "rework-compactions-retries-waits",
  "verification-and-quality",
  "human-agent-collaboration",
  "external-blockers",
  "reusable-learning",
] as const;

export const ANALYSIS_ACTION_GROUPS = ["Keep", "Change", "Stop", "Automate", "Learn", "Test next"] as const;

export type AnalysisConfidence = "low" | "medium" | "high";
export type AnalysisDimension = typeof ANALYSIS_DIMENSIONS[number];
export type AnalysisActionGroup = typeof ANALYSIS_ACTION_GROUPS[number];

export interface AnalysisEvidence {
  claim: string;
  evidence_refs: string[];
  confidence: AnalysisConfidence;
}

export interface AnalysisAction {
  action: string;
  rationale: string;
  evidence_refs: string[];
  confidence: AnalysisConfidence;
}

export interface AnalysisReport {
  schema_version: 1;
  title: string;
  subject: string;
  summary: string;
  evidence: AnalysisEvidence[];
  dimensions: Record<AnalysisDimension, string>;
  actions: Record<AnalysisActionGroup, AnalysisAction[]>;
}

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$/;
const CONFIDENCE = new Set<AnalysisConfidence>(["low", "medium", "high"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function text(value: unknown, name: string, maximum = 2_000): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || value.includes("\0")) {
    throw new TypeError(`${name} is invalid`);
  }
}

function references(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 32 && value.every((entry) => typeof entry === "string" && SAFE_REF.test(entry));
}

function validateEvidence(value: unknown, name: string): asserts value is AnalysisEvidence {
  if (!isObject(value)) throw new TypeError(`${name} is invalid`);
  text(value.claim, `${name} claim`);
  if (!references(value.evidence_refs)) throw new TypeError(`${name} evidence references are invalid`);
  if (!CONFIDENCE.has(value.confidence as AnalysisConfidence)) throw new TypeError(`${name} confidence is invalid`);
}

function validateAction(value: unknown, name: string): asserts value is AnalysisAction {
  if (!isObject(value)) throw new TypeError(`${name} is invalid`);
  text(value.action, `${name} action`);
  text(value.rationale, `${name} rationale`);
  if (!references(value.evidence_refs)) throw new TypeError(`${name} evidence references are invalid`);
  if (!CONFIDENCE.has(value.confidence as AnalysisConfidence)) throw new TypeError(`${name} confidence is invalid`);
}

export function validateAnalysisReport(value: AnalysisReport): void {
  if (!isObject(value) || value.schema_version !== 1) throw new TypeError("analysis schema version is invalid");
  text(value.title, "analysis title", 160);
  text(value.subject, "analysis subject", 160);
  text(value.summary, "analysis summary", 4_000);
  if (!Array.isArray(value.evidence) || value.evidence.length > 128) throw new TypeError("analysis evidence is invalid");
  value.evidence.forEach((entry, index) => validateEvidence(entry, `evidence ${index + 1}`));
  if (!isObject(value.dimensions) || Object.keys(value.dimensions).length !== ANALYSIS_DIMENSIONS.length
    || !ANALYSIS_DIMENSIONS.every((dimension) => Object.hasOwn(value.dimensions, dimension))) {
    throw new TypeError("analysis dimensions are incomplete");
  }
  for (const dimension of ANALYSIS_DIMENSIONS) text(value.dimensions[dimension], `dimension ${dimension}`, 4_000);
  if (!isObject(value.actions) || Object.keys(value.actions).length !== ANALYSIS_ACTION_GROUPS.length
    || !ANALYSIS_ACTION_GROUPS.every((group) => Object.hasOwn(value.actions, group))) {
    throw new TypeError("analysis action groups are incomplete");
  }
  for (const group of ANALYSIS_ACTION_GROUPS) {
    const actions = value.actions[group];
    if (!Array.isArray(actions) || actions.length > 64) throw new TypeError(`analysis action group ${group} is invalid`);
    actions.forEach((entry, index) => validateAction(entry, `${group} action ${index + 1}`));
  }
}

export function renderAnalysisJson(report: AnalysisReport): string {
  validateAnalysisReport(report);
  const normalized: AnalysisReport = {
    schema_version: 1,
    title: report.title,
    subject: report.subject,
    summary: report.summary,
    evidence: report.evidence.map((entry) => ({ ...entry, evidence_refs: [...entry.evidence_refs] })),
    dimensions: Object.fromEntries(ANALYSIS_DIMENSIONS.map((dimension) => [dimension, report.dimensions[dimension]])) as AnalysisReport["dimensions"],
    actions: Object.fromEntries(ANALYSIS_ACTION_GROUPS.map((group) => [group, report.actions[group].map((entry) => ({ ...entry, evidence_refs: [...entry.evidence_refs] }))])) as AnalysisReport["actions"],
  };
  return `${JSON.stringify(normalized, null, 2)}\n`;
}
