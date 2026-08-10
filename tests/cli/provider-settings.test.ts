import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

import { parseArguments } from "../../packages/cli/src/args.ts";
import { executeProviderSettingsCommand } from "../../packages/cli/src/commands/provider-settings.ts";
import { loadRuntimeProviderRegistry } from "../../packages/cli/src/commands/provider-support.ts";
import {
  loadProviderOverrides,
  providerOverridesPath,
  validateProviderOverrides,
} from "../../packages/config/src/provider-overrides.ts";
import { createProviderRegistry, type ProviderDefinition } from "../../packages/provider-registry/src/index.ts";

async function temporaryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pragman-provider-settings-"));
}

const definition: ProviderDefinition = {
  schema_version: 1,
  id: "example:review",
  source: "example/skills",
  source_version: "1.2.3",
  trust: "discovered",
  capabilities: ["review-code"],
  host_support: ["codex"],
  invoke: { kind: "native-skill", skill_id: "example:review" },
  context_policy: {
    accepted_classes: ["task-contract"],
    maximum_sensitivity: "internal",
    accepts_redacted_excerpts: false,
  },
  side_effects: ["read-files"],
  workflow_weight: "light",
  result_contract: "provider-result-v1",
};

const shapeDefinition: ProviderDefinition = {
  ...definition,
  id: "pragman:shape",
  source: "prag-man/pragman-exp",
  source_version: "0.1.0",
  trust: "bundled",
  invoke: { kind: "manual", instructions: ["Run pragman:shape through the active host."] },
};

function registry(health: "healthy" | "conflict" | "quarantined" = "healthy") {
  return createProviderRegistry({
    capabilities: [{ schema_version: 1, id: "review-code", stage: 10, depends_on: [], result_contract: "provider-result-v1" }],
    providers: [definition, shapeDefinition],
    discoveries: [{
      source: definition.source,
      skill_id: "example:review",
      version: definition.source_version,
      install_scope: "user",
      path_alias: "codex:user:example-review",
      digest: "a".repeat(64),
    }],
    ...(health === "quarantined"
      ? { previous_health: [{ provider_id: definition.id, version: definition.source_version, digest: "a".repeat(64), health }] }
      : health === "conflict"
        ? { discoveries: [
            { source: definition.source, skill_id: "example:review", version: definition.source_version, install_scope: "user", path_alias: "codex:user:first", digest: "a".repeat(64) },
            { source: definition.source, skill_id: "example:review", version: definition.source_version, install_scope: "user", path_alias: "codex:user:second", digest: "b".repeat(64) },
          ] }
        : {}),
  });
}

function argumentsFor(argv: string[]) {
  return parseArguments(argv);
}

const noInput = { readStdin: async () => "" };

test("provider override schema is exact and enforces ordered unique provider identities", () => {
  assert.deepEqual(validateProviderOverrides({ schema_version: 1, prefer: ["example:review", "pragman:shape"], trust: [] }), {
    schema_version: 1, prefer: ["example:review", "pragman:shape"], trust: [],
  });
  assert.throws(() => validateProviderOverrides({ schema_version: 1, prefer: ["example:review", "example:review"], trust: [] }));
  assert.throws(() => validateProviderOverrides({ schema_version: 1, prefer: [], trust: [], token: "secret" }));
  assert.throws(() => validateProviderOverrides({
    schema_version: 1,
    prefer: [],
    trust: [
      { provider_id: "example:review", source: "example/skills", source_version: "1.2.3", digest: "a".repeat(64), reviewed_at: "2026-08-10T00:00:00.000Z" },
      { provider_id: "example:review", source: "example/skills", source_version: "1.2.3", digest: "b".repeat(64), reviewed_at: "2026-08-10T00:00:00.000Z" },
    ],
  }));
});

test("providers prefer previews first, applies the unchanged digest, and writes private ordered state", async () => {
  const root = await temporaryRoot();
  const args = ["providers", "prefer", "--config", root, "--provider", "example:review,pragman:shape,example:review"];
  const preview = await executeProviderSettingsCommand(argumentsFor(args), noInput, { loadRegistry: async () => registry() });
  assert.equal(preview.exitCode, 0);
  assert.equal(preview.envelope.ok, true);
  const data = preview.envelope.ok ? preview.envelope.data as Record<string, unknown> : {};
  assert.deepEqual(data.prefer, ["example:review", "pragman:shape"]);
  assert.equal(data.mutated, false);
  assert.equal(JSON.stringify(data).includes(root), false);
  await assert.rejects(readFile(providerOverridesPath(root), "utf8"));

  const applied = await executeProviderSettingsCommand(
    argumentsFor([...args, "--apply", String(data.preview_digest)]), noInput, { loadRegistry: async () => registry() },
  );
  assert.equal(applied.exitCode, 0);
  assert.equal(applied.envelope.ok && (applied.envelope.data as Record<string, unknown>).mutated, true);
  assert.deepEqual((await loadProviderOverrides(root)).prefer, ["example:review", "pragman:shape"]);
  assert.equal((await stat(providerOverridesPath(root))).mode & 0o077, 0);
  assert.ok((await readFile(join(root, "history", "changes.jsonl"), "utf8")).includes("provider-overrides"));
});

test("providers prefer rejects unknown providers and a stale apply without changing state", async () => {
  const root = await temporaryRoot();
  const unknown = await executeProviderSettingsCommand(
    argumentsFor(["providers", "prefer", "--config", root, "--provider", "unknown:thing"]), noInput,
    { loadRegistry: async () => registry() },
  );
  assert.equal(unknown.exitCode, 2);
  assert.equal(unknown.envelope.ok ? null : unknown.envelope.error.code, "UNKNOWN_PROVIDER");

  const stale = await executeProviderSettingsCommand(
    argumentsFor(["providers", "prefer", "--config", root, "--provider", "example:review", "--apply", "f".repeat(64)]), noInput,
    { loadRegistry: async () => registry() },
  );
  assert.equal(stale.exitCode, 5);
  assert.equal(stale.envelope.ok ? null : stale.envelope.error.code, "STALE_PREVIEW");
  assert.deepEqual(await loadProviderOverrides(root), { schema_version: 1, prefer: [], trust: [] });
});

test("providers trust requires acknowledgement and a healthy selected installation", async () => {
  const root = await temporaryRoot();
  const base = ["providers", "trust", "--config", root, "--provider", "example:review"];
  const missingAck = await executeProviderSettingsCommand(argumentsFor(base), noInput, { loadRegistry: async () => registry() });
  assert.equal(missingAck.exitCode, 5);
  assert.equal(missingAck.envelope.ok ? null : missingAck.envelope.error.code, "TRUST_ACKNOWLEDGEMENT_REQUIRED");

  for (const health of ["conflict", "quarantined"] as const) {
    const result = await executeProviderSettingsCommand(
      argumentsFor([...base, "--acknowledge-trust"]), noInput, { loadRegistry: async () => registry(health) },
    );
    assert.equal(result.exitCode, 5);
    assert.equal(result.envelope.ok ? null : result.envelope.error.code, "PROVIDER_TRUST_DENIED");
  }
  const absent = createProviderRegistry({
    capabilities: [{ schema_version: 1, id: "review-code", stage: 10, depends_on: [], result_contract: "provider-result-v1" }],
    providers: [definition],
  });
  const unavailable = await executeProviderSettingsCommand(
    argumentsFor([...base, "--acknowledge-trust"]), noInput, { loadRegistry: async () => absent },
  );
  assert.equal(unavailable.exitCode, 3);
  assert.equal(unavailable.envelope.ok ? null : unavailable.envelope.error.code, "PROVIDER_NOT_INSTALLED");
});

test("providers trust persists only the reviewed provider/source/version/digest binding", async () => {
  const root = await temporaryRoot();
  const args = ["providers", "trust", "--config", root, "--provider", "example:review", "--acknowledge-trust"];
  const dependencies = { loadRegistry: async () => registry(), now: () => new Date("2026-08-10T17:42:09.000Z") };
  const preview = await executeProviderSettingsCommand(argumentsFor(args), noInput, dependencies);
  assert.equal(preview.exitCode, 0);
  const previewData = preview.envelope.ok ? preview.envelope.data as Record<string, unknown> : {};
  assert.deepEqual(previewData.trust_record, {
    provider_id: "example:review",
    source: "example/skills",
    source_version: "1.2.3",
    digest: "a".repeat(64),
    reviewed_at: "2026-08-10T17:42:09.000Z",
  });
  assert.equal(JSON.stringify(previewData).includes("path_alias"), false);
  const applied = await executeProviderSettingsCommand(
    argumentsFor([...args, "--apply", String(previewData.preview_digest)]), noInput, dependencies,
  );
  assert.equal(applied.exitCode, 0);
  const saved = parse(await readFile(providerOverridesPath(root), "utf8")) as Record<string, unknown>;
  assert.deepEqual(saved.trust, [previewData.trust_record]);
});

test("argument grammar recognizes provider settings and explicit trust acknowledgement", () => {
  assert.equal(argumentsFor(["providers", "prefer"]).command, "providers.prefer");
  const trust = argumentsFor(["providers", "trust", "--acknowledge-trust"]);
  assert.equal(trust.command, "providers.trust");
  assert.equal(trust.acknowledgeTrust, true);
});

test("runtime routing loads persisted personal provider preferences", async () => {
  const root = await temporaryRoot();
  await writeFile(providerOverridesPath(root), "schema_version: 1\nprefer:\n  - pragman:shape\ntrust: []\n");
  const runtime = await loadRuntimeProviderRegistry(parseArguments(["route", "--config", root]));
  assert.deepEqual(runtime.personalPreferences, ["pragman:shape"]);
});
