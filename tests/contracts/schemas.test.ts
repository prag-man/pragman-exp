import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const schemaDirectory = new URL("../../packages/config/schemas/", import.meta.url);
const expectedSchemas = [
  "capability.schema.json",
  "change-record.schema.json",
  "envelope.schema.json",
  "eval-candidate-approval.schema.json",
  "eval-candidate.schema.json",
  "learning.schema.json",
  "personal-config.schema.json",
  "profile.schema.json",
  "project.schema.json",
  "provider-overrides.schema.json",
  "provider.schema.json",
  "route-evidence.schema.json",
  "routing.schema.json",
  "session-event.schema.json",
  "skill-event.schema.json",
  "skill-metric.schema.json",
  "skill-rollup.schema.json",
  "skill-score.schema.json",
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
    id: "pragman:builtin-review",
    source: "bundled",
    source_version: "1.0.0",
    trust: "bundled",
    capabilities: ["code-review"],
    host_support: ["codex"],
    invoke: { kind: "native-skill", skill_id: "pragman:review" },
    context_policy: {
      accepted_classes: ["task-contract", "redacted-excerpt"],
      maximum_sensitivity: "confidential",
      accepts_redacted_excerpts: true,
    },
    side_effects: [],
    workflow_weight: "standard",
    result_contract: "provider-result",
  };
  assert.equal(ajv.compile(schemas["provider.schema.json"])(provider), true);
  assert.equal(ajv.compile(schemas["provider.schema.json"])({ ...provider, id: "builtin-review" }), false);
  assert.equal(ajv.compile(schemas["provider.schema.json"])({ ...provider, trust: "quarantined" }), false);
  assert.equal(ajv.compile(schemas["provider.schema.json"])({
    ...provider,
    id: "gstack:investigate",
    source: "obra/gstack",
  }), true);
  assert.equal(
    ajv.compile(schemas["provider.schema.json"])({
      ...provider,
      invoke: { kind: "cli", executable: "/tmp/arbitrary", arguments: [] },
    }),
    false,
  );
  const validateBundledProvider = ajv.compile(schemas["provider.schema.json"]);
  const providerDirectory = new URL("../../providers/", import.meta.url);
  for (const file of (await readdir(providerDirectory)).filter((name) => name !== "capabilities.yaml" && name.endsWith(".yaml"))) {
    const document = parse(await readFile(new URL(file, providerDirectory), "utf8"), { merge: true }) as { providers?: unknown[] };
    for (const bundled of document.providers ?? []) {
      assert.equal(validateBundledProvider(bundled), true, `${file}: ${JSON.stringify(validateBundledProvider.errors)}`);
    }
  }

  const contract = {
    schema_version: 1,
    route_id: "018f5b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
    parent_route_id: null,
    router_depth: 0,
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
    providers: ["pragman:builtin-review"],
    provider_assignments: [{ provider_id: "pragman:builtin-review", capabilities: ["code-review"] }],
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
  assert.equal(validateContract({
    ...contract,
    providers: ["gstack:investigate"],
    provider_assignments: [{ provider_id: "gstack:investigate", capabilities: ["code-review"] }],
  }), true);
  assert.equal(validateContract({ ...contract, capabilities: ["gstack:investigate"] }), false);
  assert.equal(validateContract({ ...contract, raw_private_path: "/Users/example/private" }), false);

  const egressApproval = {
    schema_version: 1,
    approval_id: "018f5b8c-7f2d-7a51-a9c0-1d4cb73b10ac",
    route_id: contract.route_id,
    provider_id: "pragman:builtin-review",
    approved_at: "2026-08-10T12:00:00Z",
    expires_at: "2026-08-10T13:00:00Z",
    destination: "host-model",
    destination_id: "codex",
    source_aliases: ["workspace-primary"],
    data_categories: ["customer-summary"],
    effective_sensitivity: "confidential",
    disclosed_fields: ["customer-summary"],
    purpose: "Review the requested customer summary",
    retention: "provider-declared-30-days",
    further_calls_allowed: false,
    content_digest: "b".repeat(64),
  };
  assert.equal(validateContract({ ...contract, egress_approvals: [egressApproval] }), true, JSON.stringify(validateContract.errors));
  for (const requiredField of [
    "schema_version",
    "approval_id",
    "route_id",
    "provider_id",
    "approved_at",
    "expires_at",
    "destination",
    "destination_id",
    "source_aliases",
    "data_categories",
    "effective_sensitivity",
    "disclosed_fields",
    "purpose",
    "retention",
    "further_calls_allowed",
    "content_digest",
  ]) {
    const incomplete = { ...egressApproval } as Record<string, unknown>;
    delete incomplete[requiredField];
    assert.equal(validateContract({ ...contract, egress_approvals: [incomplete] }), false, requiredField);
  }
  assert.equal(validateContract({
    ...contract,
    egress_approvals: [{ ...egressApproval, raw_content: "must never be disclosed implicitly" }],
  }), false);
  assert.equal(validateContract({
    ...contract,
    egress_approvals: [{ ...egressApproval, approved: true }],
  }), false, "self-attested approval must not be accepted");

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

test("workspace and project roots accept normalized POSIX and Windows paths only", async () => {
  const { default: Ajv2020 } = await import("ajv/dist/2020.js");
  const schemas = Object.fromEntries(await loadSchemas());
  const ajv = new Ajv2020({ strict: true });
  const validateWorkspace = ajv.compile(schemas["workspace.schema.json"]);
  const validateProject = ajv.compile(schemas["project.schema.json"]);
  const workspace = {
    schema_version: 1,
    workspace_id: "primary",
    name: "Primary",
    root: "/Users/example/project",
    context_sources: [],
  };
  const project = {
    schema_version: 1,
    project_id: "project",
    workspace: "primary",
    root: "/Users/example/project",
  };

  for (const rootPath of ["/Users/example/project", "C:/Users/example/project"]) {
    assert.equal(validateWorkspace({ ...workspace, root: rootPath }), true, rootPath);
    assert.equal(validateProject({ ...project, root: rootPath }), true, rootPath);
  }
  for (const rootPath of [
    "relative/project",
    "/Users/example/../project",
    "/Users/example/./project",
    "/Users//example/project",
    "C://Users/example/project",
    "C:\\Users\\example\\project",
    "/Users/example/project/",
  ]) {
    assert.equal(validateWorkspace({ ...workspace, root: rootPath }), false, rootPath);
    assert.equal(validateProject({ ...project, root: rootPath }), false, rootPath);
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
    invocation_id: "01905b8c-7f2d-7a51-a9c0-1d4cb73b10ab",
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
    provider_digest: "b".repeat(64),
    eval_corpus_digest: "c".repeat(64),
    trial_policy_digest: "d".repeat(64),
    outcome_code: "completed-with-proof",
    status: "succeeded",
    duration_ms: 1200,
    tool_calls: 2,
    retries: 0,
    rework_cycles: 1,
    verification_checks: 3,
    verification_passes: 3,
    provider: "pragman:builtin-review",
    ablation_arm: "skill-on",
    observation_source: "router",
    source_aliases: ["workspace-primary", "codex-session-1"],
    storage_scope: "local",
    append_only: true,
  };

  assert.equal(validate(event), true, JSON.stringify(validate.errors));
  for (const forbidden of ["raw_prompt", "raw_output", "secret"]) {
    assert.equal(validate({ ...event, [forbidden]: "must-not-be-stored" }), false, forbidden);
  }
  for (const [field, benignValue] of [
    ["skill_id", "task-review"],
    ["outcome_code", "risk-analysis"],
  ]) {
    assert.equal(validate({ ...event, [field]: benignValue }), true, `${field}: ${benignValue}`);
  }
  assert.equal(validate({ ...event, source_aliases: ["mask-output"] }), true, "source_aliases: mask-output");
  for (const [field, unsafeValue] of [
    ["skill_version", "x".repeat(129)],
    ["host_version", "version with whitespace"],
    ["host_version", "version\nwith-control-text"],
    ["model", "sk-proj-super-secret-model-value"],
    ["model_version", "ghp_1234567890abcdefghijklmnopqrstuv"],
    ["harness_version", "xoxb-1234567890-secret"],
  ]) {
    assert.equal(validate({ ...event, [field]: unsafeValue }), false, `${field}: ${unsafeValue}`);
  }
  const realisticToken = "sk-proj-1234567890abcdefghijkl";
  for (const [field, embeddedSecret] of [
    ["skill_id", `review-${realisticToken}`],
    ["skill_version", `v1-${realisticToken}`],
    ["host", `codex-${realisticToken}`],
    ["host_version", `v1-${realisticToken}`],
    ["model", `gpt-${realisticToken}`],
    ["model_version", `v1-${realisticToken}`],
    ["harness_version", `v1-${realisticToken}`],
    ["session_id", `session-${realisticToken}`],
    ["eval_id", `eval-${realisticToken}`],
    ["case_id", `case-${realisticToken}`],
    ["trial_id", `trial-${realisticToken}`],
    ["outcome_code", `completed-${realisticToken}`],
    ["provider", `pragman:review-${realisticToken}`],
  ]) {
    assert.equal(validate({ ...event, [field]: embeddedSecret }), false, `${field}: embedded token`);
  }
  assert.equal(validate({ ...event, source_aliases: [`workspace-${realisticToken}`] }), false, "source_aliases: embedded token");
});
