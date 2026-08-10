import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArguments } from "../../packages/cli/src/args.ts";

const cli = new URL("../../packages/cli/src/index.ts", import.meta.url).pathname;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pragman-init-cli-"));
  const home = join(root, "home");
  const config = join(root, "config");
  const project = join(root, "project");
  await Promise.all([home, config, project].map((path) => mkdir(path, { recursive: true })));
  return { root, home, config, project };
}

function invoke(home: string, args: string[], input?: unknown) {
  return spawnSync(process.execPath, [cli, ...args, "--json"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
    input: input === undefined ? undefined : JSON.stringify(input),
  });
}

async function writeSkill(root: string, description: string) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "SKILL.md"), `---\nname: review\ndescription: ${description}\n---\n\n# Review\n`);
}

test("argument grammar recognizes init and its existing selectors", () => {
  const parsed = parseArguments(["init", "--config", "/tmp/pragman", "--project-root", "/tmp/project"]);
  assert.equal(parsed.command, "init");
  assert.equal(parsed.config, "/tmp/pragman");
  assert.equal(parsed.projectRoot, "/tmp/project");
});

test("clean init uses adaptive defaults and previews before creating personal configuration", async () => {
  const { home, config } = await fixture();
  const preview = invoke(home, ["init", "--config", config, "--non-interactive"]);
  assert.equal(preview.status, 0, preview.stderr);
  const data = JSON.parse(preview.stdout).data;
  assert.equal(data.environment, "clean");
  assert.equal(data.mutated, false);
  assert.match(data.preview_digest, /^[a-f0-9]{64}$/);
  assert.equal(data.interview.questions.length <= 3, true);
  assert.equal(data.interview.defaults.telemetry_enabled, false);
  assert.equal(data.interview.defaults.routing_lane, "adaptive");
  await assert.rejects(readFile(join(config, "config.yaml")));

  const stale = invoke(home, ["init", "--config", config, "--apply", "0".repeat(64)]);
  assert.equal(stale.status, 5, stale.stderr);
  assert.equal(JSON.parse(stale.stdout).error.code, "STALE_PREVIEW");

  const applied = invoke(home, ["init", "--config", config, "--apply", data.preview_digest]);
  assert.equal(applied.status, 0, applied.stderr);
  const appliedData = JSON.parse(applied.stdout).data;
  assert.equal(appliedData.mutated, true);
  assert.deepEqual(appliedData.sample_route, {
    status: "handoff-required",
    lane: "fast",
    capability: "pragman.route",
    instructions: "Use the active host to route a read-only sample task; do not claim provider execution.",
  });
  assert.match(await readFile(join(config, "config.yaml"), "utf8"), /default_lane: adaptive/);
});

test("populated init preserves existing configuration and suppresses questions answered by discovery", async () => {
  const { home, config } = await fixture();
  await writeFile(join(config, "config.yaml"), "schema_version: 1\nprivacy:\n  default_sensitivity: confidential\nupdates:\n  channel: stable\noutput:\n  format: json\ntelemetry:\n  enabled: false\nrouting:\n  default_lane: standard\n");
  await mkdir(join(config, "workspaces", "company"), { recursive: true });
  await writeFile(join(config, "workspaces", "company", "workspace.yaml"), "schema_version: 1\nworkspace_id: company\nname: Company\nroot: /tmp/company\ncontext_sources: []\n");
  await writeSkill(join(home, ".agents", "skills", "review"), "Use when reviewing changes");

  const result = invoke(home, ["init", "--config", config, "--non-interactive"]);
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout).data;
  assert.equal(data.environment, "populated");
  assert.equal(data.preview_digest, null);
  assert.deepEqual(data.proposed_changes, []);
  assert.equal(data.interview.questions.some((entry: { id: string }) => entry.id === "trusted-tools"), false);
  assert.equal(data.interview.questions.some((entry: { id: string }) => entry.id === "workspace-inventory"), false);
  assert.equal(data.interview.defaults.default_sensitivity, "confidential");
  assert.equal(data.interview.defaults.routing_lane, "standard");
});

test("broken or shadow-conflicted init blocks writes and asks one resolution question", async () => {
  const { home, config, project } = await fixture();
  await writeSkill(join(home, ".agents", "skills", "review"), "Use when reviewing work");
  await writeSkill(join(project, ".agents", "skills", "review"), "Use when reviewing production work");
  const result = invoke(home, ["init", "--config", config, "--project-root", project, "--non-interactive"]);
  assert.equal(result.status, 3, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.error.code, "NEEDS_INPUT");
  assert.deepEqual(envelope.error.details.question_ids, ["installation-conflicts"]);
  await assert.rejects(readFile(join(config, "config.yaml")));
});

