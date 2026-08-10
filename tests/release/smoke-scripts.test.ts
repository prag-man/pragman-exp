import assert from "node:assert/strict";
import test from "node:test";

import {
  assertLiveRunAuthorized,
  assertCodexTrace,
  assertSmokeInvariants,
  buildLiveHostCommand,
  parseLiveHostArguments,
} from "../../scripts/test-live-hosts.mjs";
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

test("Codex live evidence must show only a read-only Pragman router skill inspection", () => {
  const trace = [
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc \"sed -n '1,220p' SKILL.md\"", aggregated_output: "---\nname: pragman-router\n---", status: "completed", exit_code: 0 } }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc \"sed -n '1,220p' references/routing-contract.md\"", aggregated_output: "# Routing contract", status: "completed", exit_code: 0 } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: 'PRAGMAN_SMOKE {"lane":"fast","interview":false,"egress":false,"writes":false}' } }),
  ].join("\n");
  assert.deepEqual(assertCodexTrace(trace), { skill_reads: 1, command_count: 2 });
  assert.throws(() => assertCodexTrace(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } })), /did not inspect/i);
  assert.throws(() => assertCodexTrace(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "touch /tmp/live/.agents/skills/pragman-router/changed", status: "completed", exit_code: 0 } })), /non-read-only/i);
  assert.throws(() => assertCodexTrace(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "cat /tmp/private.txt", status: "completed", exit_code: 0 } })), /outside pragman-router/i);
  assert.throws(() => assertCodexTrace(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc \"sed -n '1,220p' SKILL.md\"", aggregated_output: "name: another-skill", status: "completed", exit_code: 0 } })), /outside pragman-router/i);
  assert.throws(() => assertCodexTrace(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc \"cat references/../../private.md\"", status: "completed", exit_code: 0 } })), /non-read-only/i);
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
