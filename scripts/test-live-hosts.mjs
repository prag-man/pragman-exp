#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_HOSTS = Object.freeze(["codex", "claude-code", "cursor"]);
const SMOKE_PROMPT = [
  "Use the installed pragman-router skill to route this synthetic request only.",
  "Request: Explain in two sentences why a small local README typo fix is low risk.",
  "Do not browse, invoke tools, change files, load user or workspace context, or contact external services.",
  "This is obvious, bounded, read-only work: do not ask a question.",
  "End with exactly: PRAGMAN_SMOKE {\"lane\":\"fast\",\"interview\":false,\"egress\":false,\"writes\":false}",
].join("\n");

function fail(message) {
  throw new Error(message);
}

export function parseLiveHostArguments(argv) {
  let mode = "check";
  let modeWasSet = false;
  let json = false;
  const hosts = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") json = true;
    else if (argument === "--check" || argument === "--run") {
      const nextMode = argument.slice(2);
      if (modeWasSet && mode !== nextMode) fail("Choose either --check or --run");
      mode = nextMode;
      modeWasSet = true;
    } else if (argument === "--host" && argv[index + 1]) {
      const host = argv[++index];
      if (!LIVE_HOSTS.includes(host)) fail(`Unsupported live host: ${host}`);
      hosts.push(host);
    } else fail(`Unknown or incomplete argument: ${argument}`);
  }
  return { hosts: hosts.length === 0 ? [...LIVE_HOSTS] : [...new Set(hosts)], json, mode };
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
      args: ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--json", SMOKE_PROMPT],
      shell: false,
    };
  }
  if (host === "claude-code") {
    return {
      command: "claude",
      args: ["--print", "--output-format", "json", "--permission-mode", "plan", "--tools", "", "--no-session-persistence", SMOKE_PROMPT],
      shell: false,
    };
  }
  fail(`Host ${host} uses local adapter acceptance, not an external command`);
}

function collectStrings(value, result = []) {
  if (typeof value === "string") result.push(value);
  else if (Array.isArray(value)) for (const child of value) collectStrings(child, result);
  else if (value && typeof value === "object") for (const child of Object.values(value)) collectStrings(child, result);
  return result;
}

function observableText(output) {
  const strings = [output];
  for (const line of output.split(/\r?\n/)) {
    try {
      collectStrings(JSON.parse(line), strings);
    } catch {
      // Host CLIs may mix a non-JSON version/status line with structured output.
    }
  }
  try {
    collectStrings(JSON.parse(output), strings);
  } catch {
    // JSONL and plain text were already handled above.
  }
  return strings.join("\n");
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
  return { available: true, host, version: sanitizeVersion(result.stdout || result.stderr || "version unavailable") };
}

async function prepareHostRoot(host) {
  const root = await mkdtemp(join(tmpdir(), `pragman-live-${host}-`));
  const target = host === "claude-code"
    ? join(root, ".claude/skills/pragman-router")
    : join(root, ".agents/skills/pragman-router");
  await mkdir(dirname(target), { recursive: true });
  await cp(join(REPOSITORY_ROOT, "skills/pragman-router"), target, { recursive: true, errorOnExist: true });
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
    return assertSmokeInvariants(`${result.stdout}\n${result.stderr}`);
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

async function main(argv) {
  try {
    const options = parseLiveHostArguments(argv);
    const prerequisites = options.hosts.map(executableStatus);
    if (options.mode === "check") {
      const result = { mode: "check", prerequisites };
      process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : prerequisites.map((item) => `${item.host}: ${item.available ? item.version : "missing"}`).join("\n") + "\n");
      return prerequisites.every((item) => item.available) ? 0 : 2;
    }

    assertLiveRunAuthorized(process.env);
    const unavailable = prerequisites.filter((item) => !item.available);
    if (unavailable.length > 0) fail(`Missing live host prerequisites: ${unavailable.map((item) => item.host).join(", ")}`);
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

