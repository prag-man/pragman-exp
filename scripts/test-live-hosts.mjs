#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, cp, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildContentFreeSkillEvidence,
  createBehavioralExecutionPrompt,
  createBehavioralExecutionSchema,
  createBehavioralForward,
  createBehavioralGradingPrompt,
  createBehavioralGradingSchema,
  liveEvidenceDigest,
  validateBehavioralExecution,
} from "./lib/live-behavioral-suite.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_HOSTS = Object.freeze(["codex", "claude-code", "cursor"]);
const LIVE_SKILLS = Object.freeze([
  "pragman-analyze",
  "pragman-init",
  "pragman-prototype",
  "pragman-research",
  "pragman-router",
  "pragman-shape",
  "pragman-unfck",
  "pragman-workspace",
]);
function createSmokePrompt(host) {
  const hostSkillRoot = host === "claude-code" ? ".claude/skills" : ".agents/skills";
  return [
    "Use the installed pragman-router skill to route this synthetic request only.",
    "Request: Explain in two sentences why a small local README typo fix is low risk.",
    "You may inspect only the installed pragman-router skill files if the host requires it. Do not browse, change files, load user or workspace context, or contact external services.",
    `For shell inspection, use one command per file: sed -n '1,240p' ${hostSkillRoot}/pragman-router/SKILL.md or cat ${hostSkillRoot}/pragman-router/<referenced-file>. Do not use compounds, pipelines, redirection, substitution, directory listing or search, or any other executable.`,
    "This is obvious, bounded, read-only work: do not ask a question.",
    "End with PRAGMAN_SMOKE followed by one compact JSON object reporting the chosen lane and booleans for whether you interviewed the user, used external egress, or wrote anything. Use keys lane, interview, egress, and writes, and use the lowercase lane identifier.",
  ].join("\n");
}

function fail(message) {
  throw new Error(message);
}

export function parseLiveHostArguments(argv) {
  let mode = "check";
  let modeWasSet = false;
  let json = false;
  let evidencePath = null;
  const hosts = [];
  const skillIds = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") json = true;
    else if (argument === "--check" || argument === "--run" || argument === "--behavioral") {
      const nextMode = argument.slice(2);
      if (modeWasSet && mode !== nextMode) fail("Choose exactly one live host mode");
      mode = nextMode;
      modeWasSet = true;
    } else if (argument === "--host" && argv[index + 1]) {
      const host = argv[++index];
      if (!LIVE_HOSTS.includes(host)) fail(`Unsupported live host: ${host}`);
      hosts.push(host);
    } else if (argument === "--skill" && argv[index + 1]) {
      const skillId = argv[++index];
      if (!LIVE_SKILLS.includes(skillId)) fail(`Unsupported live skill: ${skillId}`);
      skillIds.push(skillId);
    } else if (argument === "--evidence" && argv[index + 1]) evidencePath = argv[++index];
    else fail(`Unknown or incomplete argument: ${argument}`);
  }
  const selectedHosts = hosts.length === 0
    ? mode === "behavioral" ? ["codex", "claude-code"] : [...LIVE_HOSTS]
    : [...new Set(hosts)];
  if (mode === "behavioral" && !evidencePath) fail("Behavioral live mode requires --evidence <path>");
  if (mode === "behavioral" && selectedHosts.includes("cursor")) fail("Cursor does not support the live behavioral host suite");
  if (mode !== "behavioral" && evidencePath) fail("--evidence is only valid with --behavioral");
  if (mode !== "behavioral" && skillIds.length > 0) fail("--skill is only valid with --behavioral");
  return mode === "behavioral"
    ? { hosts: selectedHosts, json, mode, evidencePath, skillIds: skillIds.length > 0 ? [...new Set(skillIds)] : [...LIVE_SKILLS] }
    : { hosts: selectedHosts, json, mode };
}

export function assertLiveRunAuthorized(environment) {
  if (environment.PRAGMAN_LIVE_HOST_TESTS !== "1") {
    fail("Live execution is disabled; set PRAGMAN_LIVE_HOST_TESTS=1 after reviewing the sanitized task");
  }
}

export function buildLiveHostCommand(host) {
  if (host === "codex") {
    return {
      command: "codex",
      args: ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--json", createSmokePrompt(host)],
      shell: false,
    };
  }
  if (host === "claude-code") {
    return {
      command: "claude",
      args: ["--print", "--output-format", "json", "--permission-mode", "plan", "--tools", "", "--no-session-persistence", createSmokePrompt(host)],
      shell: false,
    };
  }
  fail(`Host ${host} uses local adapter acceptance, not an external command`);
}

export function buildBehavioralHostCommand(host, prompt, schemaPath, schema) {
  if (host === "codex") {
    return {
      command: "codex",
      args: [
        "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--json",
        "--output-schema", schemaPath, prompt,
      ],
      shell: false,
    };
  }
  if (host === "claude-code") {
    return {
      command: "claude",
      args: [
        "--print", "--output-format", "json", "--permission-mode", "plan", "--tools", "",
        "--no-session-persistence", "--json-schema", JSON.stringify(schema), prompt,
      ],
      shell: false,
    };
  }
  fail(`Host ${host} does not support live behavioral execution`);
}

function collectStrings(value, result = []) {
  if (typeof value === "string") result.push(value);
  else if (Array.isArray(value)) for (const child of value) collectStrings(child, result);
  else if (value && typeof value === "object") for (const child of Object.values(value)) collectStrings(child, result);
  return result;
}

function observableText(output) {
  const strings = [];
  for (const line of output.split(/\r?\n/)) {
    try {
      collectStrings(JSON.parse(line), strings);
    } catch {
      // Preserve plain host text, but do not mix raw JSON wrappers into the marker search.
      strings.push(line);
    }
  }
  return strings.join("\n");
}

function unwrapCodexReadCommand(command) {
  if (typeof command !== "string" || !command || /[\0\r\n]/.test(command)) {
    fail("Codex live run used an invalid read-only command");
  }
  const wrapper = command.match(/^\/bin\/(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/);
  let payload = wrapper ? wrapper[1] : command;
  if (wrapper) {
    const quote = payload[0];
    if ((quote !== "\"" && quote !== "'") || payload.at(-1) !== quote) {
      fail("Codex live run used an invalid read-only shell wrapper");
    }
    payload = payload.slice(1, -1);
    if (quote === "\"") payload = payload.replace(/\\\"/g, "\"");
  }
  if (/&&|\|\||[;|<>`]|\$\(|\$\{|\\/.test(payload)) {
    fail("Codex live run must use exactly one read-only command per skill file");
  }
  return payload;
}

function tokenizeCodexReadCommand(payload) {
  const tokens = [];
  let index = 0;
  while (index < payload.length) {
    while (/\s/.test(payload[index] ?? "")) index += 1;
    if (index >= payload.length) break;
    let token = "";
    while (index < payload.length && !/\s/.test(payload[index])) {
      const quote = payload[index];
      if (quote === "\"" || quote === "'") {
        const end = payload.indexOf(quote, index + 1);
        if (end === -1) fail("Codex live run used invalid quoting in a read-only command");
        token += payload.slice(index + 1, end);
        index = end + 1;
      } else {
        token += payload[index];
        index += 1;
      }
    }
    if (!token) fail("Codex live run used an empty read-only command token");
    tokens.push(token);
  }
  return tokens;
}

function parseCodexReadCommand(command) {
  const tokens = tokenizeCodexReadCommand(unwrapCodexReadCommand(command));
  const executable = tokens[0];
  const executableName = basename(executable ?? "");
  const allowedExecutablePaths = new Set([
    "cat", "sed", "/bin/cat", "/bin/sed", "/usr/bin/cat", "/usr/bin/sed",
  ]);
  if (!allowedExecutablePaths.has(executable) || !["cat", "sed"].includes(executableName)) {
    fail("Codex live run used a command outside the allowlisted read-only inspection");
  }
  let filePath;
  if (executableName === "cat") {
    if (tokens.length !== 2) fail("Codex live run must inspect one skill file per read-only command");
    filePath = tokens[1];
  } else {
    if (tokens.length !== 4 || tokens[1] !== "-n" || !/^[1-9]\d*(?:,[1-9]\d*)?p$/.test(tokens[2])) {
      fail("Codex live run used unsupported sed arguments for read-only inspection");
    }
    filePath = tokens[3];
  }
  if (!filePath || !/^[A-Za-z0-9._/-]+$/.test(filePath)) {
    fail("Codex live run used an invalid read-only skill path");
  }
  return filePath;
}

function resolveCodexSkillRead(root, skillId, filePath) {
  const segments = filePath.split("/");
  if (segments.includes("..")) fail("Codex live run attempted a skill path escape");
  const skillRoot = resolve(root, ".agents", "skills", skillId);
  const target = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  const skillRelativePath = relative(skillRoot, target).split(sep).join("/");
  if (!skillRelativePath || skillRelativePath.startsWith("../") || isAbsolute(skillRelativePath)
    || !/^(?:SKILL\.md|COMPATIBILITY\.md|(?:references|assets)\/[A-Za-z0-9][A-Za-z0-9._/-]*)$/.test(skillRelativePath)) {
    fail(`Codex live run inspected content outside ${skillId}`);
  }
  return skillRelativePath;
}

function assertCodexSkillTrace(output, skillId, root) {
  if (typeof root !== "string" || !isAbsolute(root)) fail("Codex live trace validation requires an absolute host root");
  let commandCount = 0;
  let skillReads = 0;
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type !== "item.completed") continue;
    const item = record && typeof record === "object" ? record.item : null;
    if (!item || typeof item !== "object") continue;
    if (["file_change", "mcp_tool_call", "web_search"].includes(item.type)) {
      fail("Codex live smoke used a tool outside the read-only skill inspection");
    }
    if (item.type !== "command_execution") continue;
    commandCount += 1;
    const command = typeof item.command === "string" ? item.command : "";
    const skillRelativePath = resolveCodexSkillRead(root, skillId, parseCodexReadCommand(command));
    if (skillRelativePath === "SKILL.md") skillReads += 1;
    if (item.status !== "completed" || item.exit_code !== 0) fail("Codex live smoke skill inspection did not complete cleanly");
  }
  if (skillReads === 0) fail(`Codex live run did not inspect ${skillId}/SKILL.md`);
  return { skill_reads: skillReads, command_count: commandCount };
}

export function assertCodexTrace(output, root) {
  return assertCodexSkillTrace(output, "pragman-router", root);
}

function assertCodexNoTools(output) {
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type !== "item.completed") continue;
    const item = record.item;
    if (item && typeof item === "object" && ["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(item.type)) {
      fail("Codex live grader used a tool");
    }
  }
}

function structuredCandidates(value, candidates) {
  if (!value || typeof value !== "object") return;
  if (value.structured_output && typeof value.structured_output === "object") candidates.push(value.structured_output);
  if (typeof value.result === "string") candidates.push(value.result);
  if (value.item?.type === "agent_message" && typeof value.item.text === "string") candidates.push(value.item.text);
}

function parseStructuredHostOutput(output) {
  const candidates = [];
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    try {
      const value = JSON.parse(line);
      structuredCandidates(value, candidates);
    } catch {
      // Host wrappers are required for behavioral mode; ignore diagnostic text.
    }
  }
  for (const candidate of candidates.reverse()) {
    if (candidate && typeof candidate === "object" && Array.isArray(candidate.scenarios)) return candidate;
    if (typeof candidate !== "string") continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.scenarios)) return parsed;
    } catch {
      // Try the next structured host result.
    }
  }
  fail("Live host returned no valid structured behavioral result");
}

export function assertSmokeInvariants(output) {
  const match = observableText(output).match(/PRAGMAN_SMOKE\s+(\{[^\r\n]+\})/);
  if (!match) fail("Live host output is missing PRAGMAN_SMOKE invariants");
  let actual;
  try {
    actual = JSON.parse(match[1]);
  } catch {
    fail("Live host returned malformed PRAGMAN_SMOKE invariants");
  }
  const expected = { lane: "fast", interview: false, egress: false, writes: false };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("Live host returned unexpected smoke invariants");
  return actual;
}

function sanitizeVersion(value) {
  return value
    .replace(/\/Users\/[A-Za-z0-9._-]+(?:\/[^\s]*)?/g, "<local-path>")
    .replace(/\/home\/[A-Za-z0-9._-]+(?:\/[^\s]*)?/g, "<local-path>")
    .replace(/[\r\n]+/g, " ")
    .replace(/[^A-Za-z0-9 ._+()/:<>-]/g, "?")
    .trim()
    .slice(0, 160);
}

function executableStatus(host) {
  if (host === "cursor") return { available: true, host, version: "local Cursor Markdown adapter acceptance" };
  const command = host === "codex" ? "codex" : "claude";
  const result = spawnSync(command, ["--version"], { encoding: "utf8", shell: false, timeout: 10_000 });
  if (result.error || result.status !== 0) return { available: false, host, version: null };
  let authenticated = false;
  if (host === "codex") {
    const auth = spawnSync(command, ["login", "status"], { encoding: "utf8", shell: false, timeout: 10_000 });
    authenticated = auth.status === 0 && /logged in/i.test(`${auth.stdout}\n${auth.stderr}`);
  } else {
    const auth = spawnSync(command, ["auth", "status", "--json"], { encoding: "utf8", shell: false, timeout: 10_000 });
    try { authenticated = auth.status === 0 && JSON.parse(auth.stdout).loggedIn === true; }
    catch { authenticated = false; }
  }
  return {
    available: true,
    authenticated,
    host,
    version: sanitizeVersion(result.stdout || result.stderr || "version unavailable"),
  };
}

async function prepareHostRoot(host, skillIds = ["pragman-router"]) {
  const root = await mkdtemp(join(tmpdir(), `pragman-live-${host}-`));
  for (const skillId of skillIds) {
    const target = host === "claude-code"
      ? join(root, ".claude/skills", skillId)
      : join(root, ".agents/skills", skillId);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(REPOSITORY_ROOT, "skills", skillId), target, { recursive: true, errorOnExist: true });
  }
  return root;
}

async function runExternalHost(host) {
  const root = await prepareHostRoot(host);
  try {
    const invocation = buildLiveHostCommand(host);
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
      maxBuffer: 1024 * 1024,
      shell: false,
      timeout: 180_000,
    });
    if (result.error) fail(`${host} smoke test could not start: ${result.error.code ?? result.error.message}`);
    if (result.status !== 0) fail(`${host} smoke test failed with exit ${result.status ?? "unknown"}; raw host output was not retained`);
    const output = `${result.stdout}\n${result.stderr}`;
    if (host === "codex") assertCodexTrace(output, root);
    return assertSmokeInvariants(output);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runCursorAcceptance() {
  await access(join(REPOSITORY_ROOT, "tests/sessions"));
  const result = spawnSync(process.execPath, [join(REPOSITORY_ROOT, "scripts/run-tests.mjs"), "tests/sessions"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout: 120_000,
  });
  if (result.error || result.status !== 0) fail("Cursor Markdown adapter acceptance failed; inspect the focused test locally");
  return { adapter: "cursor-markdown", passed: true };
}

async function collectSkillFiles(root, directory = root, result = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > 512) fail("Installed skill exceeds the live evaluation file limit");
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) fail("Installed skill contains a symlink");
    if (entry.isDirectory()) await collectSkillFiles(root, path, result);
    else if (entry.isFile()) result.push({ path, name: relative(root, path).split(sep).join("/") });
    else fail("Installed skill contains an unsupported file type");
  }
  return result;
}

async function digestSkillDirectory(root) {
  const hash = createHash("sha256");
  for (const file of await collectSkillFiles(root)) {
    const bytes = await readFile(file.path);
    hash.update(`${file.name}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

async function runStructuredHost(host, root, prompt, schema, skillId = null) {
  const schemaPath = join(root, `.pragman-live-schema-${randomUUID()}.json`);
  await writeFile(schemaPath, `${JSON.stringify(schema)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    const invocation = buildBehavioralHostCommand(host, prompt, schemaPath, schema);
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
      timeout: 600_000,
    });
    if (result.error) fail(`${host} behavioral invocation could not start`);
    if (result.status !== 0) fail(`${host} behavioral invocation failed`);
    const output = `${result.stdout}\n${result.stderr}`;
    if (host === "codex") {
      if (skillId) assertCodexSkillTrace(output, skillId, root);
      else assertCodexNoTools(output);
    }
    return parseStructuredHostOutput(output);
  } finally {
    await rm(schemaPath, { force: true });
  }
}

function contentFreeFailureCode(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/auth|logged in/i.test(message)) return "AUTH_REQUIRED";
  if (/schema|structured|scenario|observation|invariant/i.test(message)) return "INVALID_STRUCTURED_EVIDENCE";
  if (/inspect|tool|read-only|outside/i.test(message)) return "UNSAFE_HOST_BEHAVIOR";
  if (/timed out|timeout/i.test(message)) return "HOST_TIMEOUT";
  return "HOST_EXECUTION_FAILED";
}

async function readBehavioralBaseline(skillId) {
  const path = join(REPOSITORY_ROOT, "skills", skillId, "evals", "baseline.json");
  const baseline = JSON.parse(await readFile(path, "utf8"));
  if (baseline?.skill_id !== skillId || !Array.isArray(baseline.scenarios)) fail("Behavioral corpus identity mismatch");
  return baseline;
}

async function runBehavioralHost(host, prerequisite, skillIds) {
  const root = await prepareHostRoot(host, skillIds);
  const graderRoot = await mkdtemp(join(tmpdir(), `pragman-live-grader-${host}-`));
  const skills = [];
  try {
    for (const skillId of skillIds) {
      try {
        const baseline = await readBehavioralBaseline(skillId);
        const installedRoot = host === "claude-code"
          ? join(root, ".claude", "skills", skillId)
          : join(root, ".agents", "skills", skillId);
        const skillDigest = await digestSkillDirectory(installedRoot);
        const execution = validateBehavioralExecution(
          baseline.scenarios,
          await runStructuredHost(
            host,
            root,
            createBehavioralExecutionPrompt(skillId, baseline.scenarios, host),
            createBehavioralExecutionSchema(baseline.scenarios),
            skillId,
          ),
        );
        const grading = await runStructuredHost(
          host,
          graderRoot,
          createBehavioralGradingPrompt(skillId, baseline.scenarios, execution),
          createBehavioralGradingSchema(baseline.scenarios),
        );
        const forward = createBehavioralForward(skillId, baseline.scenarios, grading);
        skills.push(buildContentFreeSkillEvidence({
          host,
          hostVersion: prerequisite.version,
          skillDigest,
          baseline,
          forward,
          execution,
          grading,
        }));
      } catch (error) {
        skills.push({ schema_version: 1, host, skill_id: skillId, status: "ERROR", error_code: contentFreeFailureCode(error) });
      }
    }
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(graderRoot, { recursive: true, force: true }),
    ]);
  }
  return {
    host,
    host_version: prerequisite.version,
    status: skills.length === skillIds.length && skills.every((skill) => skill.status === "PASS") ? "PASS" : "FAIL",
    skills,
  };
}

async function writeBehavioralEvidence(path, artifact) {
  const absolutePath = resolve(path);
  await access(dirname(absolutePath));
  const handle = await open(absolutePath, "wx", 0o600);
  try {
    await handle.write(`${JSON.stringify(artifact)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function runBehavioralSuite(options, prerequisites) {
  const hosts = [];
  for (const host of options.hosts) {
    const prerequisite = prerequisites.find((item) => item.host === host);
    hosts.push(await runBehavioralHost(host, prerequisite, options.skillIds));
  }
  const skillResults = hosts.flatMap((host) => host.skills);
  const artifact = {
    schema_version: 1,
    artifact_type: "pragman-live-behavioral-evidence",
    created_at: new Date().toISOString(),
    status: hosts.every((host) => host.status === "PASS") ? "PASS" : "FAIL",
    summary: {
      hosts: hosts.length,
      skills: skillResults.length,
      passed_skills: skillResults.filter((skill) => skill.status === "PASS").length,
      failed_skills: skillResults.filter((skill) => skill.status !== "PASS").length,
    },
    hosts,
  };
  await writeBehavioralEvidence(options.evidencePath, artifact);
  return { artifact, artifactDigest: liveEvidenceDigest(artifact) };
}

async function main(argv) {
  try {
    const options = parseLiveHostArguments(argv);
    const prerequisites = options.hosts.map(executableStatus);
    if (options.mode === "check") {
      const result = { mode: "check", prerequisites };
      process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : prerequisites.map((item) => {
        if (!item.available) return `${item.host}: missing`;
        if (item.authenticated === false) return `${item.host}: ${item.version} (authentication required)`;
        return `${item.host}: ${item.version}`;
      }).join("\n") + "\n");
      return prerequisites.every((item) => item.available && item.authenticated !== false) ? 0 : 2;
    }

    assertLiveRunAuthorized(process.env);
    const unavailable = prerequisites.filter((item) => !item.available);
    if (unavailable.length > 0) fail(`Missing live host prerequisites: ${unavailable.map((item) => item.host).join(", ")}`);
    const unauthenticated = prerequisites.filter((item) => item.authenticated === false);
    if (unauthenticated.length > 0) fail(`Live host authentication required: ${unauthenticated.map((item) => item.host).join(", ")}`);
    if (options.mode === "behavioral") {
      const result = await runBehavioralSuite(options, prerequisites);
      const output = {
        mode: "behavioral",
        status: result.artifact.status,
        evidence_digest: result.artifactDigest,
        summary: result.artifact.summary,
      };
      process.stdout.write(options.json ? `${JSON.stringify(output)}\n` : `behavioral: ${output.status}; evidence ${output.evidence_digest}\n`);
      return result.artifact.status === "PASS" ? 0 : 1;
    }
    const results = [];
    for (const host of options.hosts) {
      const invariants = host === "cursor" ? await runCursorAcceptance() : await runExternalHost(host);
      results.push({ host, passed: true, invariants });
    }
    const result = { mode: "run", results };
    process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : results.map((item) => `${item.host}: passed`).join("\n") + "\n");
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) process.exitCode = await main(process.argv.slice(2));
