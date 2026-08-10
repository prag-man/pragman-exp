import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { renderPrototypeHtml } from "../../packages/reports/src/html.ts";

test("renders an escaped self-contained clickable prototype with accessible landmarks", () => {
  const html = renderPrototypeHtml({
    title: "Operator <script>alert(1)</script>",
    summary: "Review one booking flow & record feedback.",
    screens: [
      {
        id: "queue",
        eyebrow: "01 / Triage",
        title: "Booking queue",
        body: "Choose the highest-risk departure.",
        actions: [{ label: "Open trip", target: "trip" }],
      },
      {
        id: "trip",
        eyebrow: "02 / Resolve",
        title: "Trip control",
        body: "Confirm documents, suppliers, and balances.",
        actions: [{ label: "Back to queue", target: "queue" }],
      },
    ],
  });

  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<nav[\s>]/);
  assert.match(html, /<main id="prototype">/);
  assert.match(html, /<section[^>]+id="queue"/);
  assert.match(html, /href="#trip"/);
  assert.match(html, /aria-label="Prototype feedback"/);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /Operator &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//);
  assert.doesNotMatch(html, /fetch\(|XMLHttpRequest|WebSocket/);
});

test("rejects duplicate, unsafe, or missing screen targets", () => {
  const base = {
    title: "Prototype",
    summary: "One flow",
    screens: [{ id: "start", eyebrow: "Start", title: "Start", body: "Body", actions: [] }],
  };
  assert.throws(() => renderPrototypeHtml({ ...base, screens: [...base.screens, base.screens[0]!] }), /duplicate/i);
  assert.throws(() => renderPrototypeHtml({ ...base, screens: [{ ...base.screens[0]!, id: "../escape" }] }), /screen id/i);
  assert.throws(() => renderPrototypeHtml({ ...base, screens: [{ ...base.screens[0]!, actions: [{ label: "Missing", target: "missing" }] }] }), /target/i);
});

test("bounds prototype structure and textual input", () => {
  assert.throws(() => renderPrototypeHtml({ title: "", summary: "x", screens: [] }), /title/i);
  assert.throws(() => renderPrototypeHtml({
    title: "Prototype",
    summary: "x",
    screens: Array.from({ length: 25 }, (_, index) => ({ id: `s-${index}`, eyebrow: "Step", title: "Screen", body: "Body", actions: [] })),
  }), /screens/i);
});

test("ships a portable prototype skill with a network-free clickable fallback and paired scenarios", async () => {
  const root = new URL("../../skills/pragman-prototype/", import.meta.url);
  const [skill, compatibility, metadata, reference, asset, baseline, forward] = await Promise.all([
    readFile(new URL("SKILL.md", root), "utf8"),
    readFile(new URL("COMPATIBILITY.md", root), "utf8"),
    readFile(new URL("agents/openai.yaml", root), "utf8"),
    readFile(new URL("references/prototype-contract.md", root), "utf8"),
    readFile(new URL("assets/prototype.html", root), "utf8"),
    readFile(new URL("evals/baseline.json", root), "utf8").then(JSON.parse),
    readFile(new URL("evals/forward.json", root), "utf8").then(JSON.parse),
  ]);
  assert.match(skill, /^---\nname: pragman-prototype\n/);
  assert.match(skill, /Keep.*Change.*Stop/s);
  assert.match(skill, /not (?:an early )?production/i);
  assert.match(reference, /no external fonts, images, scripts, stylesheets, telemetry, or network calls/i);
  assert.match(asset, /Content-Security-Policy/);
  assert.match(asset, /<main id="flow">/);
  assert.doesNotMatch(asset, /https?:\/\//);
  assert.deepEqual(baseline.scenarios.map((scenario: { scenario_id: string }) => scenario.scenario_id), forward.scenarios.map((scenario: { scenario_id: string }) => scenario.scenario_id));
  assert.equal(forward.scenarios.every((scenario: { passed: boolean }) => scenario.passed), true);
  assert.equal([skill, compatibility, metadata, reference, asset].join("\n").includes("/Users/"), false);
});
