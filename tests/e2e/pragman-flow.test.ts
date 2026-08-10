import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cli = new URL("../../packages/cli/src/index.ts", import.meta.url).pathname;
type Invocation = ReturnType<typeof spawnSync>;

function invoke(home: string, args: string[], input?: unknown): Invocation {
  return spawnSync(process.execPath, [cli, ...args, "--json"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
    input: input === undefined ? undefined : JSON.stringify(input),
    timeout: 10_000,
  });
}

function data(result: Invocation, label: string): any {
  assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout}`);
  const envelope = JSON.parse(result.stdout as string);
  assert.equal(envelope.ok, true, label);
  return envelope.data;
}

test("the safe Pragman loop moves from initialization through a reversible approved improvement", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragman-flow-"));
  const home = join(root, "home");
  const config = join(root, "config");
  const workspaceRoot = join(root, "workspace");
  const projectRoot = join(root, "project");
  const sessionRoot = join(root, "sessions");
  await Promise.all([home, config, workspaceRoot, projectRoot, sessionRoot].map((path) => mkdir(path, { recursive: true })));

  const initPreview = data(invoke(home, ["init", "--config", config, "--non-interactive"]), "init preview");
  assert.equal(initPreview.mutated, false);
  assert.match(initPreview.preview_digest, /^[a-f0-9]{64}$/);
  const initialized = data(invoke(home, ["init", "--config", config, "--non-interactive", "--apply", initPreview.preview_digest]), "init apply");
  assert.equal(initialized.mutated, true);

  const workspace = {
    schema_version: 1,
    workspace_id: "example-co",
    name: "Example Co",
    root: workspaceRoot,
    sensitivity: "internal",
    context_sources: [{
      id: "product-docs",
      kind: "directory",
      uri: "docs",
      description: "Sanitized product documentation",
      sensitivity: "internal",
    }],
  };
  const workspacePreview = data(invoke(home, ["workspace", "add", "--config", config, "--preview"], workspace), "workspace add preview");
  data(invoke(home, ["workspace", "add", "--config", config, "--apply", workspacePreview.preview_digest], workspace), "workspace add apply");

  const link = { project_id: "demo-project", workspace: "example-co", additional_workspaces: [] };
  const linkPreview = data(invoke(home, ["workspace", "link", "--config", config, "--project-root", projectRoot, "--preview"], link), "workspace link preview");
  const linked = data(invoke(home, ["workspace", "link", "--config", config, "--project-root", projectRoot, "--apply", linkPreview.preview_digest], link), "workspace link apply");
  assert.equal(linked.mutated, true);

  const skillRoot = join(home, ".agents", "skills", "safe-review");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), "---\nname: safe-review\ndescription: Use when reviewing a bounded change\n---\n\n# Safe review\n\nReview only the requested diff.\n");
  const pragmanShapeRoot = join(home, ".agents", "skills", "pragman-shape");
  await mkdir(pragmanShapeRoot, { recursive: true });
  await writeFile(join(pragmanShapeRoot, "SKILL.md"), "---\nname: pragman-shape\ndescription: Use when shaping a bounded experiment\n---\n\n# Pragman Shape\n");
  const scanned = data(invoke(home, ["scan", "--project-root", projectRoot]), "scan");
  assert.equal(scanned.installations.some((entry: { skill_id: string }) => entry.skill_id === "safe-review"), true);
  assert.equal(JSON.stringify(scanned).includes(skillRoot), false);

  const routeRequest = {
    request: "Shape a bounded, reversible product experiment",
    task_family: "shape",
    desired_outcome: "A small experiment with explicit acceptance criteria",
    deliverable_kind: "response-only",
    execution_mode: "serial",
    declared_side_effects: [],
    data_inputs: [],
    egress_destinations: [],
    urgency: "normal",
    uncertainties: [{ id: "scope", description: "The smallest useful slice is unknown", impact: "medium" }],
    scope_systems: ["product"],
    estimated_sessions: "one",
    downstream_impact: "low",
    reversibility: "reversible",
    requested_capabilities: ["shape-task"],
    workspace: "example-co",
    project: "demo-project",
  };
  const routed = data(invoke(home, ["route", "--config", config, "--project-root", projectRoot, "--host", "codex"], routeRequest), "route");
  assert.equal(routed.status, "ready");
  assert.deepEqual(routed.contract.providers, ["pragman:shape"]);
  assert.match(routed.contract.request_digest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(routed).includes(routeRequest.request), false);

  await writeFile(join(sessionRoot, "session.jsonl"), [
    { timestamp: "2026-08-10T10:00:00.000Z", type: "session_meta", payload: { id: "sanitized-demo", version: "1" } },
    { timestamp: "2026-08-10T10:00:01.000Z", type: "response_item", payload: { role: "user", content: "Please keep this experiment bounded and reversible." } },
    { timestamp: "2026-08-10T10:00:02.000Z", type: "event_msg", payload: { type: "context_compacted" } },
  ].map(JSON.stringify).join("\n"));
  const selection = {
    sources: [{ adapter: "codex", root: sessionRoot, project_alias: "demo-project" }],
    from: "2026-08-01T00:00:00.000Z",
    through: "2026-08-31T23:59:59.999Z",
    project_aliases: ["demo-project"],
    content_categories: ["messages", "lifecycle"],
    privacy_depth: "safe",
  };
  const analysis = data(invoke(home, ["sessions", "analyze", "--config", config], {
    selection,
    context: { objective: "Reduce iteration time while preserving verification", constraints: ["No destructive writes"] },
  }), "session analysis");
  assert.equal(analysis.mutation_allowed, false);
  assert.deepEqual(Object.keys(analysis.report.actions), ["Keep", "Change", "Stop", "Automate", "Learn", "Test next"]);
  assert.equal(JSON.stringify(analysis).includes(sessionRoot), false);

  const change = {
    target: "personal",
    target_id: "personal",
    operations: [{ op: "replace", path: "/output/format", value: "json" }],
    reason: "Use machine-readable output for the measured loop",
    evidence_refs: ["session-analysis:sanitized-demo"],
  };
  const changePreview = data(invoke(home, ["changes", "preview", "--config", config], change), "change preview");
  assert.equal(changePreview.mutated, false);
  const changed = data(invoke(home, ["changes", "apply", "--config", config, "--apply", changePreview.preview_digest], change), "change apply");
  assert.equal(changed.mutated, true);
  assert.match(await readFile(join(config, "config.yaml"), "utf8"), /format: json/);

  const changes = data(invoke(home, ["changes", "list", "--config", config]), "changes list").changes;
  assert.equal(changes.length, 1);
  const rollbackPreview = data(invoke(home, ["changes", "rollback", "--config", config, "--change", changes[0].change_id]), "rollback preview");
  assert.equal(rollbackPreview.mutated, false);
  const rolledBack = data(invoke(home, ["changes", "rollback", "--config", config, "--change", changes[0].change_id, "--apply", rollbackPreview.preview_digest]), "rollback apply");
  assert.equal(rolledBack.mutated, true);
  assert.match(await readFile(join(config, "config.yaml"), "utf8"), /format: human/);
  assert.match(await readFile(join(projectRoot, ".pragman", "manifest.yaml"), "utf8"), /workspace: example-co/);
});
