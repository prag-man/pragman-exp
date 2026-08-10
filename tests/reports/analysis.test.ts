import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { renderAnalysisJson, renderAnalysisMarkdown, type AnalysisReport } from "../../packages/reports/src/index.ts";

const report = (): AnalysisReport => ({
  schema_version: 1,
  title: "Release analysis",
  subject: "router-v1",
  summary: "The route worked, but context arrived late.",
  evidence: [{ claim: "Two avoidable retries occurred.", evidence_refs: ["event:retry-count"], confidence: "high" }],
  dimensions: {
    "intent-versus-outcome": "Outcome met after one scope correction.",
    "scope-and-routing-quality": "Initial route was too broad.",
    "assumptions-and-decisions": "Provider availability was assumed.",
    "context-completeness": "Workspace constraints arrived late.",
    "provider-and-tool-fit": "Selected provider was capable.",
    "time-versus-value": "Retry cost exceeded its value.",
    "rework-compactions-retries-waits": "Two retries; no compaction.",
    "verification-and-quality": "All deterministic checks passed.",
    "human-agent-collaboration": "One focused clarification changed scope.",
    "external-blockers": "No external blocker.",
    "reusable-learning": "Resolve workspace context before routing.",
  },
  actions: {
    Keep: [{ action: "Keep deterministic routing.", rationale: "It made the final choice explainable.", evidence_refs: ["route:final"], confidence: "high" }],
    Change: [], Stop: [], Automate: [], Learn: [], "Test next": [],
  },
});

test("renders deterministic JSON with evidence, confidence, and exact action groups", () => {
  const parsed = JSON.parse(renderAnalysisJson(report()));
  assert.deepEqual(Object.keys(parsed.actions), ["Keep", "Change", "Stop", "Automate", "Learn", "Test next"]);
  assert.equal(parsed.evidence[0].confidence, "high");
  assert.deepEqual(parsed.actions.Keep[0].evidence_refs, ["route:final"]);
});

test("renders readable Markdown without turning untrusted text into HTML", () => {
  const input = report();
  input.summary = "Observed <script>alert(1)</script> in an imported note.";
  const markdown = renderAnalysisMarkdown(input);
  assert.match(markdown, /^# Release analysis/m);
  assert.match(markdown, /## Keep/);
  assert.match(markdown, /Confidence: high/);
  assert.doesNotMatch(markdown, /<script>/);
  assert.match(markdown, /&lt;script&gt;/);
});

test("rejects missing analysis dimensions, action groups, and unsupported confidence", () => {
  const missingDimension = report();
  delete (missingDimension.dimensions as Partial<AnalysisReport["dimensions"]>)["external-blockers"];
  assert.throws(() => renderAnalysisJson(missingDimension), /dimensions/i);
  const missingGroup = report();
  delete (missingGroup.actions as Partial<AnalysisReport["actions"]>).Stop;
  assert.throws(() => renderAnalysisMarkdown(missingGroup), /action groups/i);
  const invalidConfidence = report();
  invalidConfidence.evidence[0]!.confidence = "certain" as "high";
  assert.throws(() => renderAnalysisJson(invalidConfidence), /confidence/i);
});

test("ships an evidence-bound analysis skill with paired successful, drifted, and blocked scenarios", async () => {
  const root = new URL("../../skills/pragman-analyze/", import.meta.url);
  const [skill, compatibility, metadata, reference, baseline, forward] = await Promise.all([
    readFile(new URL("SKILL.md", root), "utf8"),
    readFile(new URL("COMPATIBILITY.md", root), "utf8"),
    readFile(new URL("agents/openai.yaml", root), "utf8"),
    readFile(new URL("references/analysis-contract.md", root), "utf8"),
    readFile(new URL("evals/baseline.json", root), "utf8").then(JSON.parse),
    readFile(new URL("evals/forward.json", root), "utf8").then(JSON.parse),
  ]);
  assert.match(skill, /^---\nname: pragman-analyze\n/);
  assert.match(skill, /not silent configuration changes|do not automatically modify/i);
  assert.match(reference, /Eleven required dimensions/);
  for (const group of ["Keep", "Change", "Stop", "Automate", "Learn", "Test next"]) assert.match(reference, new RegExp(`\\b${group.replace(" ", "\\s+")}\\b`));
  assert.deepEqual(baseline.scenarios.map((scenario: { scenario_id: string }) => scenario.scenario_id), ["successful-work", "drifted-work", "blocked-work"]);
  assert.deepEqual(baseline.scenarios.map((scenario: { scenario_id: string }) => scenario.scenario_id), forward.scenarios.map((scenario: { scenario_id: string }) => scenario.scenario_id));
  assert.equal(forward.scenarios.every((scenario: { passed: boolean }) => scenario.passed), true);
  assert.equal([skill, compatibility, metadata, reference].join("\n").includes("/Users/"), false);
});
