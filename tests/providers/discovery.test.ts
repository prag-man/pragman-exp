import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { projectProviderRegistry, mapDiscoveries } from "../../packages/cli/src/commands/provider-support.ts";
import { discoverKnownHosts } from "../../packages/provider-registry/src/discovery.ts";
import { loadProviderRegistry, type ProviderDefinition } from "../../packages/provider-registry/src/index.ts";
import { routeTask, type RouteInput } from "../../packages/router/src/index.ts";

const providers = new URL("../../providers/", import.meta.url).pathname;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pragman-provider-discovery-"));
  const skills = join(root, "skills");
  await mkdir(skills, { recursive: true });
  return { root, skills };
}

async function skill(root: string, name: string) {
  await mkdir(join(root, "references"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "SKILL.md"), `---\nname: ${name}\ndescription: Use when diagnosing a software failure\n---\n\n# Diagnose\n\nFind the root cause.\n`);
  await writeFile(join(root, "references", "method.md"), "Form a falsifiable hypothesis.\n");
  await writeFile(join(root, "scripts", "check.sh"), "#!/bin/sh\nexit 0\n");
}

function routeInput(): RouteInput {
  return {
    request: "Diagnose the failing build", task_family: "debug", desired_outcome: "Root cause identified",
    deliverable_kind: "response-only", execution_mode: "serial", declared_side_effects: [], data_inputs: [],
    egress_destinations: [], urgency: "normal", uncertainties: [], scope_systems: ["repo"], estimated_sessions: "one",
    downstream_impact: "low", reversibility: "reversible", requested_capabilities: ["diagnose-software-failure"],
    workspace: null, project: null,
  };
}

test("bounded gstack collection discovery makes the curated external provider route-eligible", async () => {
  const { skills } = await fixture();
  const directory = join(skills, "gstack", "investigate");
  await skill(directory, "investigate");
  const legacyAlias = join(skills, "investigate");
  await skill(legacyAlias, "investigate");
  await writeFile(join(legacyAlias, "references", "method.md"), "Legacy alias with different packaging metadata.\n");

  const scan = await discoverKnownHosts({
    roots: [{ source: "codex", install_scope: "user", root: skills }],
  });
  const installation = scan.installations.find((entry) => entry.skill_id === "gstack:investigate");
  assert.ok(installation);
  assert.equal(installation.health, "healthy");
  assert.equal(installation.path_alias, "codex:user:gstack:investigate");
  assert.equal(installation.path_alias.includes(skills), false);

  const base = await loadProviderRegistry({ directory: providers });
  const discoveries = mapDiscoveries(scan.installations.filter((entry) => entry.health === "healthy"), base.listProviders());
  assert.deepEqual(discoveries.map((entry) => entry.source), ["garrytan/gstack"]);
  assert.equal(discoveries[0]?.path_alias, "codex:user:gstack:investigate");
  const registry = await loadProviderRegistry({ directory: providers, discoveries });
  const projected = projectProviderRegistry(registry);
  const route = routeTask(routeInput(), {
    ...projected,
    activeHost: "codex",
    allowedSideEffects: [],
  });
  assert.equal(route.status, "ready");
  if (route.status === "ready") assert.deepEqual(route.contract.providers, ["gstack:investigate"]);
});

test("canonical inventory digest changes for body, reference, and script drift", async () => {
  const { skills } = await fixture();
  const directory = join(skills, "investigate");
  await skill(directory, "investigate");
  const options = { roots: [{ source: "codex", install_scope: "user", root: skills }] } as const;
  const first = (await discoverKnownHosts(options)).installations[0]!;

  await writeFile(join(directory, "SKILL.md"), "---\nname: investigate\ndescription: Use when diagnosing a software failure\n---\n\nChanged body.\n");
  const body = (await discoverKnownHosts(options)).installations[0]!;
  assert.notEqual(body.digest, first.digest);

  await writeFile(join(directory, "references", "method.md"), "Changed reference.\n");
  const reference = (await discoverKnownHosts(options)).installations[0]!;
  assert.notEqual(reference.digest, body.digest);

  await writeFile(join(directory, "scripts", "check.sh"), "#!/bin/sh\nexit 1\n");
  const script = (await discoverKnownHosts(options)).installations[0]!;
  assert.notEqual(script.digest, reference.digest);
});

test("inventory symlinks and traversal limits degrade a skill instead of trusting partial content", async () => {
  const { root, skills } = await fixture();
  const directory = join(skills, "investigate");
  await skill(directory, "investigate");
  const outside = join(root, "outside.txt");
  await writeFile(outside, "outside\n");
  await symlink(outside, join(directory, "references", "outside.md"));

  const symlinked = await discoverKnownHosts({ roots: [{ source: "codex", install_scope: "user", root: skills }] });
  assert.equal(symlinked.installations[0]?.health, "degraded");
  assert.equal(symlinked.warnings.some((entry) => entry.code === "SYMLINK_SKIPPED"), true);

  const limited = await discoverKnownHosts({
    roots: [{ source: "codex", install_scope: "user", root: skills }],
    maximumInventoryEntries: 2,
  });
  assert.equal(limited.installations[0]?.health, "degraded");
  assert.equal(limited.truncated, true);
  assert.equal(limited.warnings.some((entry) => entry.code === "INVENTORY_LIMIT"), true);
});

test("bare skill names map only when the curated provider identity is unambiguous", async () => {
  const base = await loadProviderRegistry({ directory: providers });
  const gstack = base.getProvider("gstack:review")!;
  const colliding = {
    ...gstack,
    id: "superpowers:review",
    source: "obra/superpowers",
    invoke: { kind: "native-skill", skill_id: "superpowers:review" },
  } satisfies ProviderDefinition;
  const record = {
    source: "codex", skill_id: "review", version: "unknown", install_scope: "user", path_alias: "codex:user:review",
    digest: "a".repeat(64), health: "healthy", shadowed_by: null,
  } as const;
  assert.deepEqual(mapDiscoveries([record], [gstack, colliding]), []);
  assert.deepEqual(mapDiscoveries([record], [gstack]).map((entry) => entry.source), ["garrytan/gstack"]);
});

test("actual Pragman, gstack, Compound Engineering, and Superpowers install names map to curated identities", async () => {
  const base = await loadProviderRegistry({ directory: providers });
  const names = [
    "pragman-router", "investigate", "qa", "review", "ship", "ce-plan", "ce-work", "ce-code-review",
    "brainstorming", "systematic-debugging", "test-driven-development", "verification-before-completion",
  ];
  const records = names.map((name, index) => ({
    source: "codex" as const,
    skill_id: name,
    version: "unknown",
    install_scope: "user" as const,
    path_alias: `codex:user:${name}`,
    digest: index.toString(16).padStart(64, "0"),
    health: "healthy" as const,
    shadowed_by: null,
  }));
  assert.deepEqual(mapDiscoveries(records, base.listProviders()).map((entry) => entry.skill_id).sort(), [
    "compound-engineering:ce-code-review", "compound-engineering:ce-plan", "compound-engineering:ce-work",
    "gstack:investigate", "gstack:qa", "gstack:review", "gstack:ship", "pragman:router",
    "superpowers:brainstorming", "superpowers:systematic-debugging", "superpowers:test-driven-development",
    "superpowers:verification-before-completion",
  ]);
});

test("bundled native skills are absent until discovered while CLI-native providers remain installed", async () => {
  const base = await loadProviderRegistry({ directory: providers });
  const projected = projectProviderRegistry(base);
  assert.equal(projected.providers.find((entry) => entry.id === "pragman:shape")?.installed, false);
});
