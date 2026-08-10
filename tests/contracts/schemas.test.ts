import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const schemaDirectory = new URL("../../packages/config/schemas/", import.meta.url);
const expectedSchemas = [
  "capability.schema.json",
  "change-record.schema.json",
  "envelope.schema.json",
  "learning.schema.json",
  "personal-config.schema.json",
  "profile.schema.json",
  "project.schema.json",
  "provider.schema.json",
  "route-evidence.schema.json",
  "routing.schema.json",
  "session-event.schema.json",
  "skill-event.schema.json",
  "task-contract.schema.json",
  "workspace.schema.json",
];

async function loadSchemas() {
  const files = (await readdir(schemaDirectory)).filter((file) => file.endsWith(".schema.json")).sort();
  assert.deepEqual(files, expectedSchemas);

  return Promise.all(
    files.map(async (file) => [file, JSON.parse(await readFile(new URL(file, schemaDirectory), "utf8"))]),
  );
}

test("publishes exactly the normative schema filenames and every schema compiles with AJV", async () => {
  const [{ default: Ajv2020 }, { default: addFormats }] = await Promise.all([
    import("ajv/dist/2020.js"),
    import("ajv-formats"),
  ]);
  const schemas = await loadSchemas();
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);

  for (const [file, schema] of schemas) {
    assert.doesNotThrow(() => ajv.compile(schema), file);
  }
});

test("personal configuration is versioned, applies documented defaults, and rejects unknown fields", async () => {
  const { default: Ajv2020 } = await import("ajv/dist/2020.js");
  const schema = JSON.parse(await readFile(new URL("personal-config.schema.json", schemaDirectory), "utf8"));
  const ajv = new Ajv2020({ useDefaults: true });
  const validate = ajv.compile(schema);
  const config = {
    schema_version: 1,
    privacy: { default_sensitivity: "internal" },
    updates: { channel: "stable" },
    output: { format: "human" },
  };

  assert.equal(validate(config), true, JSON.stringify(validate.errors));
  assert.deepEqual(config.telemetry, { enabled: false });
  assert.deepEqual(config.routing, { default_lane: "adaptive" });
  assert.equal(validate({ ...config, surprise: true }), false);
});

test("routing predicates are structured and reject free text or unknown action keys", async () => {
  const { default: Ajv2020 } = await import("ajv/dist/2020.js");
  const schema = JSON.parse(await readFile(new URL("routing.schema.json", schemaDirectory), "utf8"));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  const routing = {
    schema_version: 1,
    defaults: { lane: "adaptive" },
    rules: [{
      id: "debug-writes",
      priority: 10,
      when: { all: [{ field: "task_family", op: "eq", value: "debug" }] },
      action: {
        require_capabilities: ["code-change"],
        minimum_lane: "standard",
        require_approval: "route",
      },
    }],
  };

  assert.equal(validate(routing), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...routing, rules: [{ ...routing.rules[0], when: "debug tasks" }] }), false);
  assert.equal(validate({
    ...routing,
    rules: [{ ...routing.rules[0], action: { invoke: "provider-a" } }],
  }), false);

  const withCondition = (condition: unknown) => ({
    ...routing,
    rules: [{ ...routing.rules[0], when: { all: [condition] } }],
  });
  assert.equal(validate(withCondition({ field: "task_family", op: "eq", value: 42 })), false);
  assert.equal(validate(withCondition({ field: "effective_sensitivity", op: "eq", value: "secret" })), false);
  assert.equal(validate(withCondition({ field: "independent_system_count", op: "gte", value: "2" })), false);
  assert.equal(validate(withCondition({ field: "workspace", op: "is_null", value: null })), false);

  assert.equal(validate({
    ...routing,
    rules: [{
      ...routing.rules[0],
      action: { require_capabilities: ["code-review"], prefer: ["gstack:investigate"] },
    }],
  }), true, JSON.stringify(validate.errors));
  assert.equal(validate({
    ...routing,
    rules: [{ ...routing.rules[0], action: { require_capabilities: ["gstack:investigate"] } }],
  }), false);
});

test("provider, task, evidence, session, learning, and change schemas enforce key trust boundaries", async () => {
  const { default: Ajv2020 } = await import("ajv/dist/2020.js");
  const { default: addFormats } = await import("ajv-formats");
  const schemas = Object.fromEntries(await loadSchemas());
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);

  const provider = {
    schema_version: 1,
    id: "builtin-review",
    source: "bundled",
    source_version: "1.0.0",
    trust: "bundled",
    capabilities: ["code-review"],
    host_support: ["codex"],
    invoke: { type: "native-skill", skill_id: "review" },
    context_policy: {
      accepted_context_classes: ["task-contract", "redacted-excerpt"],
      maximum_sensitivity: "confidential",
      accepts_redacted_excerpts: true,
    },
    side_effects: [],
    workflow_weight: "standard",
    result_contract: "provider-result",
  };
  assert.equal(ajv.compile(schemas["provider.schema.json"])(provider), true);
  assert.equal(ajv.compile(schemas["provider.schema.json"])({
    ...provider,
    id: "gstack:investigate",
    source: "obra/gstack",
  }), true);
  assert.equal(
    ajv.compile(schemas["provider.schema.json"])({
      ...provider,
      invoke: { type: "cli", executable: "/tmp/arbitrary", arguments: [] },
    }),
    false,
  );

  const contract = {
    schema_version: 1,
    route_id: "018f5b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    parent_route_id: null,
    request_digest: "a".repeat(64),
    outcome: "review the change",
    lane: "standard",
    deliverable_kind: "response-only",
    execution_mode: "serial",
    workspace: null,
    project: null,
    in_scope: [],
    out_of_scope: [],
    assumptions: [],
    unresolved_conflicts: [],
    capabilities: ["code-review"],
    providers: ["builtin-review"],
    provider_sequence_policy: "stop",
    allowed_side_effects: [],
    data_inputs: [],
    effective_sensitivity: "internal",
    egress_approvals: [],
    proof: [],
    stop_conditions: [],
    created_at: "2026-08-10T12:00:00Z",
  };
  const validateContract = ajv.compile(schemas["task-contract.schema.json"]);
  assert.equal(validateContract(contract), true, JSON.stringify(validateContract.errors));
  assert.equal(validateContract({ ...contract, providers: ["gstack:investigate"] }), true);
  assert.equal(validateContract({ ...contract, capabilities: ["gstack:investigate"] }), false);
  assert.equal(validateContract({ ...contract, raw_private_path: "/Users/example/private" }), false);

  const validateSession = ajv.compile(schemas["session-event.schema.json"]);
  const sessionEvent = {
    schema_version: 1,
    event_id: "event-hash",
    session_id: "session-1",
    source: "codex",
    source_version: "1",
    source_alias: "codex-session-1",
    sequence: 1,
    timestamp: "2026-08-10T12:00:00Z",
    event_type: "unsupported",
    sensitivity: "internal",
    provenance: { source_alias: "codex-session-1", inferred_task: false },
    unsupported: { vendor_extension: { retained: true } },
  };
  assert.equal(validateSession(sessionEvent), true, JSON.stringify(validateSession.errors));
  assert.equal(validateSession({ ...sessionEvent, vendor_extension: true }), false);

  for (const file of ["route-evidence.schema.json", "learning.schema.json", "change-record.schema.json"]) {
    const schema = schemas[file];
    assert.equal(schema.additionalProperties, false, file);
    assert.ok(schema.required.includes("schema_version"), file);
  }
});

test("every normative date-time requires RFC 3339 UTC with a trailing Z", async () => {
  const [{ default: Ajv2020 }, { default: addFormats }] = await Promise.all([
    import("ajv/dist/2020.js"),
    import("ajv-formats"),
  ]);
  const schemas = Object.fromEntries(await loadSchemas());
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);

  function assertUtcPatterns(value: unknown, location: string): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertUtcPatterns(item, `${location}/${index}`));
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.format === "date-time") {
      assert.equal(record.pattern, "Z$", location);
    }
    for (const [key, child] of Object.entries(record)) {
      assertUtcPatterns(child, `${location}/${key}`);
    }
  }

  for (const [file, schema] of Object.entries(schemas)) {
    assertUtcPatterns(schema, file);
  }

  const validateSession = ajv.compile(schemas["session-event.schema.json"]);
  const baseEvent = {
    schema_version: 1,
    event_id: "event-hash",
    session_id: "session-1",
    source: "codex",
    source_version: "1",
    source_alias: "codex-session-1",
    sequence: 1,
    timestamp: "2026-08-10T12:00:00+05:30",
    event_type: "session-start",
    sensitivity: "internal",
    provenance: { source_alias: "codex-session-1" },
  };
  assert.equal(validateSession(baseEvent), false);
});

test("skill events capture privacy-safe local metrics and reject raw content or secrets", async () => {
  const { default: Ajv2020 } = await import("ajv/dist/2020.js");
  const { default: addFormats } = await import("ajv-formats");
  const schema = JSON.parse(await readFile(new URL("skill-event.schema.json", schemaDirectory), "utf8"));
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const event = {
    schema_version: 1,
    event_id: "018f5b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    timestamp: "2026-08-10T12:00:00Z",
    skill_id: "review",
    skill_version: "1.2.0",
    skill_digest: "a".repeat(64),
    skill_type: "capability",
    host: "codex",
    host_version: "1.0.0",
    model: "gpt-5",
    model_version: "2026-08-01",
    harness_version: "0.1.0",
    session_id: "session-alias-1",
    route_id: "018f5b8c-7f2d-7a51-a9c0-1d4cb73b10ac",
    eval_id: "router-baseline",
    case_id: "case-1",
    trial_id: "trial-1",
    event_type: "completed",
    invocation_mode: "router",
    trigger_expected: true,
    trigger_actual: true,
    outcome: "completed-with-proof",
    status: "succeeded",
    latency_ms: 1200,
    tool_calls: 2,
    retries: 0,
    rework_cycles: 1,
    verification_checks: 3,
    verification_passes: 3,
    provider: "builtin-review",
    ablation_arm: "skill-on",
    source_aliases: ["workspace-primary", "codex-session-1"],
    storage_scope: "local",
    append_only: true,
  };

  assert.equal(validate(event), true, JSON.stringify(validate.errors));
  for (const forbidden of ["raw_prompt", "raw_output", "secret"]) {
    assert.equal(validate({ ...event, [forbidden]: "must-not-be-stored" }), false, forbidden);
  }
});
