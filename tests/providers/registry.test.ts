import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ProviderRegistryValidationError,
  createProviderRegistry,
  loadProviderRegistry,
  type CapabilityDefinition,
  type ProviderDefinition,
} from "../../packages/provider-registry/src/index.ts";

const digest = (character: string) => character.repeat(64);

const capability = (overrides: Partial<CapabilityDefinition> = {}): CapabilityDefinition => ({
  schema_version: 1,
  id: "diagnose-software-failure",
  stage: 20,
  depends_on: [],
  result_contract: "provider-result-v1",
  ...overrides,
});

const provider = (overrides: Partial<ProviderDefinition> = {}): ProviderDefinition => ({
  schema_version: 1,
  id: "gstack:investigate",
  source: "garrytan/gstack",
  source_version: "1.2.0",
  trust: "curated",
  capabilities: ["diagnose-software-failure"],
  host_support: ["codex", "claude-code", "cursor"],
  invoke: { kind: "native-skill", skill_id: "gstack:investigate" },
  context_policy: {
    accepted_classes: ["task-contract", "context-summary", "redacted-excerpt"],
    maximum_sensitivity: "confidential",
    accepts_redacted_excerpts: true,
  },
  side_effects: ["read-files", "run-commands"],
  workflow_weight: "standard",
  result_contract: "provider-result-v1",
  ...overrides,
});

test("bundled registry validates canonical capability and provider definitions", async () => {
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const registry = await loadProviderRegistry({ directory: join(root, "providers") });

  assert.ok(registry.listCapabilities().length >= 8);
  assert.deepEqual(registry.listProviders().map((record) => record.id), [
    "compound-engineering:ce-code-review",
    "compound-engineering:ce-plan",
    "compound-engineering:ce-work",
    "gstack:investigate",
    "gstack:qa",
    "gstack:review",
    "gstack:ship",
    "pragman:analyze",
    "pragman:research",
    "pragman:router",
    "pragman:shape",
    "superpowers:brainstorming",
    "superpowers:systematic-debugging",
    "superpowers:test-driven-development",
    "superpowers:verification-before-completion",
  ]);
  assert.equal(registry.getProvider("gstack:investigate")?.trust, "curated");
});

test("registry rejects unknown fields, invalid trust, missing capabilities, and capability cycles", () => {
  assert.throws(() => createProviderRegistry({
    capabilities: [capability({ extra: true } as never)],
    providers: [provider()],
  }), (error: unknown) => error instanceof ProviderRegistryValidationError
    && error.issues.some((issue) => issue.code === "UNKNOWN_FIELD"));

  assert.throws(() => createProviderRegistry({
    capabilities: [capability()],
    providers: [provider({ trust: "trusted" as never })],
  }), (error: unknown) => error instanceof ProviderRegistryValidationError
    && error.issues.some((issue) => issue.code === "INVALID_TRUST"));

  assert.throws(() => createProviderRegistry({
    capabilities: [capability()],
    providers: [provider({ capabilities: ["missing-capability"] })],
  }), (error: unknown) => error instanceof ProviderRegistryValidationError
    && error.issues.some((issue) => issue.code === "MISSING_CAPABILITY"));

  assert.throws(() => createProviderRegistry({
    capabilities: [
      capability({ id: "first", depends_on: ["second"] }),
      capability({ id: "second", depends_on: ["first"] }),
    ],
    providers: [provider({ capabilities: ["first"] })],
  }), (error: unknown) => error instanceof ProviderRegistryValidationError
    && error.issues.some((issue) => issue.code === "CAPABILITY_CYCLE"));
});

test("registry validates incompatible requested capability pairs", () => {
  const registry = createProviderRegistry({
    capabilities: [
      capability({ id: "safe-change", incompatible_with: ["live-deploy"] }),
      capability({ id: "live-deploy", stage: 80, incompatible_with: ["safe-change"] }),
    ],
    providers: [provider({ capabilities: ["safe-change", "live-deploy"] })],
  });

  assert.deepEqual(registry.validateRequestedCapabilities(["safe-change", "live-deploy"]), {
    ok: false,
    code: "INCOMPATIBLE_CAPABILITIES",
    capabilities: ["live-deploy", "safe-change"],
  });
  assert.deepEqual(registry.validateRequestedCapabilities(["safe-change"]), { ok: true });
});

test("project discovery shadows lower scopes only at compatible trust and reports conflicts", () => {
  const discoveries = [
    { source: "garrytan/gstack", skill_id: "gstack:investigate", version: "1.2.0", install_scope: "project", path_alias: "project-gstack", digest: digest("a"), trust: "curated" },
    { source: "garrytan/gstack", skill_id: "gstack:investigate", version: "1.1.0", install_scope: "user", path_alias: "user-gstack", digest: digest("b"), trust: "curated" },
  ] as const;
  const registry = createProviderRegistry({ capabilities: [capability()], providers: [provider()], discoveries });
  assert.deepEqual(registry.getStatus("gstack:investigate"), {
    health: "healthy",
    reason: null,
    selected_path_alias: "project-gstack",
    selected_digest: digest("a"),
    shadowed_path_aliases: ["user-gstack"],
  });

  const conflict = createProviderRegistry({
    capabilities: [capability()], providers: [provider()],
    discoveries: [
      { ...discoveries[0], trust: "discovered" },
      discoveries[1],
    ],
  });
  assert.equal(conflict.getStatus("gstack:investigate").health, "conflict");

  const identical = createProviderRegistry({
    capabilities: [capability()], providers: [provider()],
    discoveries: [discoveries[0], { ...discoveries[1], digest: digest("a") }],
  });
  assert.deepEqual(identical.getStatus("gstack:investigate").shadowed_path_aliases, []);
});

test("digest drift resets health and unsupported host versions remain incompatible", () => {
  const discovery = { source: "garrytan/gstack", skill_id: "gstack:investigate", version: "1.2.0", install_scope: "user", path_alias: "user-gstack", digest: digest("c"), trust: "curated" } as const;
  const drifted = createProviderRegistry({
    capabilities: [capability()], providers: [provider()], discoveries: [discovery], host: "codex", host_version: "1.4.0",
    previous_health: [{ provider_id: "gstack:investigate", version: "1.2.0", digest: digest("d"), health: "healthy" }],
  });
  assert.equal(drifted.getStatus("gstack:investigate").health, "unknown");
  assert.equal(drifted.getStatus("gstack:investigate").reason, "DIGEST_DRIFT");

  const incompatible = createProviderRegistry({
    capabilities: [capability()],
    providers: [provider({ compatibility: { hosts: { codex: ">=1.0.0 <2.0.0" } } })],
    discoveries: [discovery], host: "codex", host_version: "2.0.0",
  });
  assert.equal(incompatible.getStatus("gstack:investigate").health, "incompatible");

  const manual = createProviderRegistry({
    capabilities: [capability()],
    providers: [provider({ id: "gstack:manual", invoke: { kind: "manual", instructions: ["Run the reviewed workflow manually."] } })],
  });
  assert.equal(manual.getStatus("gstack:manual").health, "degraded");

  const quarantined = createProviderRegistry({
    capabilities: [capability()], providers: [provider()], discoveries: [discovery],
    previous_health: [{ provider_id: "gstack:investigate", version: "1.1.0", digest: digest("d"), health: "quarantined" }],
  });
  assert.equal(quarantined.getStatus("gstack:investigate").health, "quarantined");
});
