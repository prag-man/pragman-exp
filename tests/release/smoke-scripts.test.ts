import assert from "node:assert/strict";
import test from "node:test";

import {
  assertLiveRunAuthorized,
  assertCodexTrace,
  assertSmokeInvariants,
  buildBehavioralHostCommand,
  buildLiveHostCommand,
  parseLiveHostArguments,
} from "../../scripts/test-live-hosts.mjs";
import {
  buildContentFreeSkillEvidence,
  createBehavioralExecutionPrompt,
  createBehavioralExecutionSchema,
  createBehavioralGradingPrompt,
  createBehavioralGradingSchema,
} from "../../scripts/lib/live-behavioral-suite.mjs";
import {
  EXPECTED_SKILLS,
  assertRemoteRunAuthorized,
  assertSkillList,
  buildSkillsCommand,
  parseRemoteArguments,
} from "../../scripts/test-remote-install.mjs";

test("live host smoke checks are non-mutating until an explicit opt-in", () => {
  assert.deepEqual(parseLiveHostArguments([]), { hosts: ["codex", "claude-code", "cursor"], json: false, mode: "check" });
  assert.throws(() => assertLiveRunAuthorized({}), /PRAGMAN_LIVE_HOST_TESTS=1/);
  assert.doesNotThrow(() => assertLiveRunAuthorized({ PRAGMAN_LIVE_HOST_TESTS: "1" }));

  const codex = buildLiveHostCommand("codex");
  const claude = buildLiveHostCommand("claude-code");
  assert.equal(codex.shell, false);
  assert.equal(claude.shell, false);
  assert.ok(codex.args.includes("read-only"));
  assert.ok(claude.args.includes("--tools"));
  assert.ok(!codex.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!claude.args.includes("--dangerously-skip-permissions"));
  assert.ok(![...codex.args, ...claude.args].some((argument) => argument === "publish" || argument === "deploy"));
  assert.equal([...codex.args, ...claude.args].join(" ").includes('{"lane":"fast"'), false);
  assert.match([...codex.args, ...claude.args].join(" "), /lowercase lane identifier/);
});

test("behavioral live mode is explicit, evidence-bound, and excludes the local Cursor acceptance", () => {
  assert.deepEqual(
    parseLiveHostArguments(["--behavioral", "--host", "codex", "--host", "claude-code", "--evidence", "evidence.json"]),
    { hosts: ["codex", "claude-code"], json: false, mode: "behavioral", evidencePath: "evidence.json" },
  );
  assert.throws(() => parseLiveHostArguments(["--behavioral", "--host", "codex"]), /--evidence/i);
  assert.throws(
    () => parseLiveHostArguments(["--behavioral", "--host", "cursor", "--evidence", "evidence.json"]),
    /Cursor.*behavioral/i,
  );

  const codex = buildBehavioralHostCommand("codex", "synthetic prompt", "/tmp/schema.json");
  const claude = buildBehavioralHostCommand("claude-code", "synthetic prompt", "/tmp/schema.json", { type: "object" });
  assert.ok(codex.args.includes("--ephemeral"));
  assert.ok(codex.args.includes("--output-schema"));
  assert.ok(claude.args.includes("--json-schema"));
  assert.ok(!codex.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!claude.args.includes("--dangerously-skip-permissions"));
});

test("behavioral execution hides the invariant rubric and grading derives the exact observation shape", () => {
  const scenarios = [{
    scenario_id: "bounded-case",
    case_type: "trigger",
    prompt: "Handle this bounded synthetic request.",
    expected_trigger: true,
    expected_invariants: [
      { path: "triggered", equals: true },
      { path: "checks.preview_before_write", equals: true },
    ],
  }];
  const executionPrompt = createBehavioralExecutionPrompt("pragman-init", scenarios);
  assert.match(executionPrompt, /Handle this bounded synthetic request/);
  assert.equal(executionPrompt.includes("preview_before_write"), false);
  assert.equal(executionPrompt.includes("expected_trigger"), false);
  assert.equal(executionPrompt.includes("expected_invariants"), false);

  const executionSchema = createBehavioralExecutionSchema(scenarios);
  assert.deepEqual(executionSchema.properties.scenarios.items.properties.scenario_id.enum, ["bounded-case"]);
  const gradingPrompt = createBehavioralGradingPrompt("pragman-init", scenarios, {
    scenarios: [{ scenario_id: "bounded-case", triggered: true, response: "I would show a preview before changing anything." }],
  });
  assert.match(gradingPrompt, /preview_before_write/);
  const gradingSchema = createBehavioralGradingSchema(scenarios);
  const pathSchema = gradingSchema.properties.scenarios.items.properties.observation.properties.checks.items.properties.path;
  assert.deepEqual(pathSchema.enum, ["checks.preview_before_write"]);
});

test("live behavioral evidence contains only digests, booleans, counts, and public identities", () => {
  const baseline = {
    schema_version: 1,
    skill_id: "pragman-init",
    evaluation_kind: "behavioral",
    arm: "skill-off",
    privacy: "sanitized",
    scenarios: [{
      scenario_id: "bounded-case",
      case_type: "trigger",
      prompt: "private synthetic prompt must not survive",
      expected_trigger: true,
      observed_failures: ["private baseline detail must not survive"],
      expected_invariants: [
        { path: "triggered", equals: true },
        { path: "checks.preview_before_write", equals: true },
      ],
    }, {
      scenario_id: "control-case",
      case_type: "non-trigger",
      prompt: "private control prompt must not survive",
      expected_trigger: false,
      observed_failures: ["private control detail must not survive"],
      expected_invariants: [
        { path: "triggered", equals: false },
        { path: "checks.direct", equals: true },
      ],
    }],
  };
  const forward = {
    schema_version: 1,
    skill_id: "pragman-init",
    evaluation_kind: "behavioral",
    arm: "skill-on",
    privacy: "sanitized",
    observation_source: "curated-structured-observation",
    scenarios: [
      { scenario_id: "bounded-case", observation: { triggered: true, checks: { preview_before_write: true } } },
      { scenario_id: "control-case", observation: { triggered: false, checks: { direct: true } } },
    ],
  };
  const evidence = buildContentFreeSkillEvidence({
    host: "codex",
    hostVersion: "codex-cli 1",
    skillDigest: "a".repeat(64),
    baseline,
    forward,
    execution: { scenarios: [{ scenario_id: "bounded-case", triggered: true, response: "private response must not survive" }] },
    grading: forward,
  });
  const serialized = JSON.stringify(evidence);
  assert.equal(evidence.status, "PASS");
  assert.equal(serialized.includes("private"), false);
  assert.equal(serialized.includes("prompt"), false);
  assert.equal(serialized.includes("response"), false);
  assert.match(evidence.execution_digest, /^[a-f0-9]{64}$/);
});

test("Codex live evidence must show only a read-only Pragman router skill inspection", () => {
  const trace = [
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc \"sed -n '1,220p' SKILL.md\"", aggregated_output: "---\nname: pragman-router\n---", status: "completed", exit_code: 0 } }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc \"sed -n '1,220p' references/routing-contract.md\"", aggregated_output: "# Routing contract", status: "completed", exit_code: 0 } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: 'PRAGMAN_SMOKE {"lane":"fast","interview":false,"egress":false,"writes":false}' } }),
  ].join("\n");
  assert.deepEqual(assertCodexTrace(trace), { skill_reads: 1, command_count: 2 });
  assert.deepEqual(assertCodexTrace([
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "cat /tmp/live/.agents/skills/pragman-router/SKILL.md", aggregated_output: "name: pragman-router", status: "completed", exit_code: 0 } }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "cat /tmp/live/.agents/skills/pragman-router/COMPATIBILITY.md", aggregated_output: "compatible", status: "completed", exit_code: 0 } }),
  ].join("\n")), { skill_reads: 1, command_count: 2 });
  assert.deepEqual(assertCodexTrace(JSON.stringify({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "sed -n '1,120p' /tmp/live/.agents/skills/pragman-router/SKILL.md && sed -n '1,120p' /tmp/live/.agents/skills/pragman-router/references/routing-contract.md",
      aggregated_output: "name: pragman-router",
      status: "completed",
      exit_code: 0,
    },
  })), { skill_reads: 1, command_count: 1 });
  assert.throws(() => assertCodexTrace(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } })), /did not inspect/i);
  assert.throws(() => assertCodexTrace(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "touch /tmp/live/.agents/skills/pragman-router/changed", status: "completed", exit_code: 0 } })), /non-read-only/i);
  assert.throws(() => assertCodexTrace(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "cat /tmp/private.txt", status: "completed", exit_code: 0 } })), /outside pragman-router/i);
  assert.throws(() => assertCodexTrace(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc \"sed -n '1,220p' SKILL.md\"", aggregated_output: "name: another-skill", status: "completed", exit_code: 0 } })), /outside pragman-router/i);
  assert.throws(() => assertCodexTrace(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc \"cat references/../../private.md\"", status: "completed", exit_code: 0 } })), /non-read-only/i);
  assert.throws(() => assertCodexTrace([
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "cat /tmp/live/.agents/skills/pragman-router/SKILL.md", aggregated_output: "name: pragman-router", status: "completed", exit_code: 0 } }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "cat /tmp/live/.agents/skills/pragman-router/evals/forward.json", status: "completed", exit_code: 0 } }),
  ].join("\n")), /outside pragman-router/i);
  assert.throws(() => assertCodexTrace(JSON.stringify({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "cat /tmp/live/.agents/skills/pragman-router/SKILL.md /tmp/private.txt",
      aggregated_output: "name: pragman-router",
      status: "completed",
      exit_code: 0,
    },
  })), /outside pragman-router/i);
});

test("live host output must contain the exact content-free invariants", () => {
  assert.deepEqual(
    assertSmokeInvariants('status PRAGMAN_SMOKE {"lane":"fast","interview":false,"egress":false,"writes":false}'),
    { lane: "fast", interview: false, egress: false, writes: false },
  );
  assert.deepEqual(
    assertSmokeInvariants('{"type":"item.completed","item":{"type":"agent_message","text":"PRAGMAN_SMOKE {\\"lane\\":\\"fast\\",\\"interview\\":false,\\"egress\\":false,\\"writes\\":false}"}}'),
    { lane: "fast", interview: false, egress: false, writes: false },
  );
  assert.throws(() => assertSmokeInvariants("completed successfully"), /missing PRAGMAN_SMOKE invariants/i);
  assert.throws(
    () => assertSmokeInvariants('PRAGMAN_SMOKE {"lane":"deep","interview":false,"egress":false,"writes":false}'),
    /unexpected smoke invariants/i,
  );
});

test("remote installer is pinned, project-local, and publication-free", () => {
  assert.deepEqual(parseRemoteArguments([]), {
    json: false,
    mode: "check",
    skillsCli: "skills@1.5.9",
    source: "prag-man/pragman-exp",
  });
  assert.throws(() => assertRemoteRunAuthorized({}), /PRAGMAN_REMOTE_INSTALL_TESTS=1/);
  assert.doesNotThrow(() => assertRemoteRunAuthorized({ PRAGMAN_REMOTE_INSTALL_TESTS: "1" }));
  assert.throws(() => parseRemoteArguments(["--source", "./private-copy"]), /public Pragman repository/i);
  assert.throws(() => parseRemoteArguments(["--skills-cli", "skills@latest"]), /pinned skills CLI/i);

  const command = buildSkillsCommand("skills@1.5.9", ["add", "prag-man/pragman-exp", "--list"]);
  assert.equal(command.command, "npx");
  assert.equal(command.shell, false);
  assert.deepEqual(command.args.slice(0, 2), ["--yes", "skills@1.5.9"]);
  assert.ok(!command.args.some((argument) => /publish/i.test(argument)));
  assert.ok(!command.args.includes("--global"));
});

test("remote skill listing must contain exactly the eight public names", () => {
  const output = EXPECTED_SKILLS.map((skill) => `- ${skill}`).join("\n");
  assert.deepEqual(assertSkillList(output), EXPECTED_SKILLS);
  assert.throws(() => assertSkillList(`${output}\n- pragman-secret`), /unexpected skill list/i);
  assert.throws(() => assertSkillList(output.replace("- pragman-unfck", "")), /unexpected skill list/i);
});
