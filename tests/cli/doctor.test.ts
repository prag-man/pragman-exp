import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArguments } from "../../packages/cli/src/args.ts";

const cli = new URL("../../packages/cli/src/index.ts", import.meta.url).pathname;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pragman-doctor-cli-"));
  const home = join(root, "home");
  const config = join(root, "config");
  await Promise.all([home, config].map((path) => mkdir(path, { recursive: true })));
  return { home, config };
}

function invoke(home: string, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args, "--json"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

test("argument grammar recognizes doctor", () => {
  assert.equal(parseArguments(["doctor"]).command, "doctor");
});

test("doctor reports core, CLI, schemas, configuration, providers, and host discovery health", async () => {
  const { home, config } = await fixture();
  const preview = invoke(home, ["init", "--config", config]);
  const digest = JSON.parse(preview.stdout).data.preview_digest;
  assert.equal(invoke(home, ["init", "--config", config, "--apply", digest]).status, 0);

  const result = invoke(home, ["doctor", "--config", config]);
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout).data;
  assert.equal(data.overall, "healthy");
  assert.deepEqual(data.components.map((entry: { component: string }) => entry.component), [
    "core", "cli", "schemas", "configuration", "providers", "host-adapters",
  ]);
  assert.equal(data.components.every((entry: { health: string }) => entry.health === "healthy"), true);
  assert.equal(JSON.stringify(data).includes(config), false);
});

test("doctor distinguishes missing configuration from broken metadata without reading its body", async () => {
  const { home, config } = await fixture();
  let result = invoke(home, ["doctor", "--config", config]);
  assert.equal(result.status, 4, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.overall, "degraded");

  const secret = "sk-proj-doctor-must-not-output-123456789";
  const skillRoot = join(home, ".claude", "skills", "broken");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), `---\nname: broken\n\n${secret}`);
  result = invoke(home, ["doctor", "--config", config]);
  assert.equal(result.status, 4, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.overall, "broken");
  assert.equal(result.stdout.includes(secret), false);
});

test("pragman-init package carries portable degradation and paired behavioral evals", async () => {
  const skillRoot = new URL("../../skills/pragman-init/", import.meta.url);
  const [skill, compatibility, metadata, discovery, baseline, forward] = await Promise.all([
    readFile(new URL("SKILL.md", skillRoot), "utf8"),
    readFile(new URL("COMPATIBILITY.md", skillRoot), "utf8"),
    readFile(new URL("agents/openai.yaml", skillRoot), "utf8"),
    readFile(new URL("references/discovery-boundary.md", skillRoot), "utf8"),
    readFile(new URL("evals/baseline.json", skillRoot), "utf8").then(JSON.parse),
    readFile(new URL("evals/forward.json", skillRoot), "utf8").then(JSON.parse),
  ]);
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  assert.deepEqual(frontmatter.split("\n").map((line) => line.split(":", 1)[0]), ["name", "description"]);
  assert.match(skill, /CLI unavailable/);
  assert.match(skill, /do not write or claim (?:a )?scan/i);
  assert.match(skill, /preview/i);
  assert.match(discovery, /never read credential|never read secret/i);
  assert.match(compatibility, />=0\.1\.0 <1\.0\.0/);
  assert.match(metadata, /\$pragman-init/);
  assert.equal(baseline.scenarios.length >= 3, true);
  assert.deepEqual(forward.scenarios.map((entry: { scenario_id: string }) => entry.scenario_id), baseline.scenarios.map((entry: { scenario_id: string }) => entry.scenario_id));
  assert.equal(forward.scenarios.every((entry: { passed: boolean }) => entry.passed), true);
  assert.equal([skill, compatibility, metadata, discovery, JSON.stringify(baseline), JSON.stringify(forward)].join("\n").includes("/Users/"), false);
});
