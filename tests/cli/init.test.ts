import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
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

test("argument grammar recognizes init and its profile input selector", () => {
  const parsed = parseArguments(["init", "--config", "/tmp/pragman", "--project-root", "/tmp/project", "--file", "/tmp/profile.json"]);
  assert.equal(parsed.command, "init");
  assert.equal(parsed.config, "/tmp/pragman");
  assert.equal(parsed.projectRoot, "/tmp/project");
  assert.equal(parsed.file, "/tmp/profile.json");
});

test("init previews and atomically applies config plus a schema-validated profile from an explicit file", async () => {
  const { home, config, root } = await fixture();
  const input = join(root, "profile.json");
  await writeFile(input, JSON.stringify({
    schema_version: 1,
    profile_id: "founder-cto",
    roles: ["Founder", "CTO"],
    responsibilities: ["Product", "Engineering"],
    preferences: { collaboration: "concise" },
    prohibitions: ["publish-without-approval"],
    authority: ["local-code-changes"],
  }));

  const preview = invoke(home, ["init", "--config", config, "--file", input, "--non-interactive"]);
  assert.equal(preview.status, 0, preview.stderr);
  const previewData = JSON.parse(preview.stdout).data;
  assert.match(previewData.preview_digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(previewData.proposed_changes.map((change: { target_alias: string; action: string }) => [change.target_alias, change.action]), [
    ["personal-config", "create"],
    ["personal-profile", "create"],
  ]);
  assert.deepEqual(previewData.interview.questions, []);
  assert.equal(preview.stdout.includes("Product"), false);
  assert.equal(preview.stdout.includes(input), false);
  await assert.rejects(readFile(join(config, "config.yaml")));
  await assert.rejects(readFile(join(config, "profile.yaml")));

  const applied = invoke(home, ["init", "--config", config, "--file", input, "--non-interactive", "--apply", previewData.preview_digest]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(await readFile(join(config, "config.yaml"), "utf8"), /default_lane: adaptive/);
  const profile = await readFile(join(config, "profile.yaml"), "utf8");
  assert.match(profile, /profile_id: founder-cto/);
  assert.match(profile, /publish-without-approval/);
});

test("init reconfigures only the profile, suppresses answered questions, and rejects a stale profile preview", async () => {
  const { home, config, root } = await fixture();
  const configDocument = "schema_version: 1\nprivacy:\n  default_sensitivity: internal\nupdates:\n  channel: stable\noutput:\n  format: human\n";
  await writeFile(join(config, "config.yaml"), configDocument);
  await writeFile(join(config, "profile.yaml"), "schema_version: 1\nprofile_id: builder\nroles:\n  - Engineer\nresponsibilities:\n  - Delivery\n");
  const input = join(root, "profile.json");
  const nextProfile = {
    schema_version: 1,
    profile_id: "builder",
    roles: ["Engineering leader"],
    responsibilities: ["Delivery", "Planning"],
  };
  await writeFile(input, JSON.stringify(nextProfile));

  const preview = invoke(home, ["init", "--config", config, "--file", input, "--non-interactive"]);
  assert.equal(preview.status, 0, preview.stderr);
  const data = JSON.parse(preview.stdout).data;
  assert.deepEqual(data.proposed_changes.map((change: { target_alias: string; action: string }) => [change.target_alias, change.action]), [["personal-profile", "update"]]);
  assert.deepEqual(data.interview.questions.map((question: { id: string }) => question.id), ["approval-boundaries"]);

  await writeFile(join(config, "profile.yaml"), "schema_version: 1\nprofile_id: builder\nroles:\n  - Changed elsewhere\nresponsibilities:\n  - Delivery\n");
  const stale = invoke(home, ["init", "--config", config, "--file", input, "--non-interactive", "--apply", data.preview_digest]);
  assert.equal(stale.status, 5, stale.stderr);
  assert.equal(JSON.parse(stale.stdout).error.code, "STALE_PREVIEW");
  assert.equal(await readFile(join(config, "config.yaml"), "utf8"), configDocument);
  assert.match(await readFile(join(config, "profile.yaml"), "utf8"), /Changed elsewhere/);
});

test("invalid or unsafe profile input writes nothing and never echoes sensitive content", async () => {
  const { home, config, root } = await fixture();
  const input = join(root, "profile.json");
  const secret = "api_key=super-secret-value-123456";
  await writeFile(input, JSON.stringify({
    schema_version: 1,
    profile_id: "founder",
    roles: ["Founder"],
    responsibilities: [secret],
  }));
  const result = invoke(home, ["init", "--config", config, "--file", input, "--non-interactive"]);
  assert.equal(result.status, 5, result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, "PRIVACY_DENIED");
  assert.equal(result.stdout.includes(secret), false);
  await assert.rejects(readFile(join(config, "config.yaml")));
  await assert.rejects(readFile(join(config, "profile.yaml")));
});

test("profile privacy validation catches secrets stored under sensitive preference keys", async () => {
  const { home, config, root } = await fixture();
  const input = join(root, "profile.json");
  const secret = "super-secret-value-123456";
  await writeFile(input, JSON.stringify({
    schema_version: 1,
    profile_id: "founder",
    roles: ["Founder"],
    responsibilities: ["Product"],
    preferences: { api_key: secret },
  }));

  const result = invoke(home, ["init", "--config", config, "--file", input, "--non-interactive"]);
  assert.equal(result.status, 5, result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, "PRIVACY_DENIED");
  assert.equal(result.stdout.includes(secret), false);
  await assert.rejects(readFile(join(config, "profile.yaml")));
});

test("an unsafe profile target blocks the whole init transaction before config creation", async () => {
  const { home, config, root } = await fixture();
  const input = join(root, "profile.json");
  const outside = join(root, "outside-profile.yaml");
  const outsideDocument = "schema_version: 1\nprofile_id: founder\nroles:\n  - Existing founder\nresponsibilities:\n  - Existing product\n";
  await writeFile(outside, outsideDocument);
  await symlink(outside, join(config, "profile.yaml"));
  await writeFile(input, JSON.stringify({
    schema_version: 1,
    profile_id: "founder",
    roles: ["Founder"],
    responsibilities: ["Product"],
  }));

  const preview = invoke(home, ["init", "--config", config, "--file", input, "--non-interactive"]);
  assert.equal(preview.status, 0, preview.stderr);
  const digest = JSON.parse(preview.stdout).data.preview_digest;
  const applied = invoke(home, ["init", "--config", config, "--file", input, "--non-interactive", "--apply", digest]);
  assert.equal(applied.status, 5, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).error.code, "PRIVACY_DENIED");
  await assert.rejects(readFile(join(config, "config.yaml")));
  assert.equal(await readFile(outside, "utf8"), outsideDocument);
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
