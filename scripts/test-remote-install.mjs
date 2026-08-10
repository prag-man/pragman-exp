#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOSTS = Object.freeze(["codex", "claude-code", "cursor"]);
export const EXPECTED_SKILLS = Object.freeze([
  "pragman-init",
  "pragman-workspace",
  "pragman-router",
  "pragman-research",
  "pragman-shape",
  "pragman-prototype",
  "pragman-analyze",
  "pragman-unfck",
]);

function fail(message) {
  throw new Error(message);
}

function validSource(source) {
  return source === "prag-man/pragman-exp"
    || source === "https://github.com/prag-man/pragman-exp"
    || /^https:\/\/github\.com\/prag-man\/pragman-exp\/tree\/v\d+\.\d+\.\d+$/.test(source);
}

export function parseRemoteArguments(argv) {
  let json = false;
  let mode = "check";
  let modeWasSet = false;
  let skillsCli = "skills@1.5.9";
  let source = "prag-man/pragman-exp";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") json = true;
    else if (argument === "--check" || argument === "--run") {
      const nextMode = argument.slice(2);
      if (modeWasSet && mode !== nextMode) fail("Choose either --check or --run");
      mode = nextMode;
      modeWasSet = true;
    } else if (argument === "--source" && argv[index + 1]) source = argv[++index];
    else if (argument === "--skills-cli" && argv[index + 1]) skillsCli = argv[++index];
    else fail(`Unknown or incomplete argument: ${argument}`);
  }
  if (!validSource(source)) fail("Remote tests accept only the public Pragman repository or a stable release tag URL");
  if (!/^skills@1\.\d+\.\d+$/.test(skillsCli)) fail("Remote tests require a pinned skills CLI 1.x version");
  return { json, mode, skillsCli, source };
}

export function assertRemoteRunAuthorized(environment) {
  if (environment.PRAGMAN_REMOTE_INSTALL_TESTS !== "1") {
    fail("Remote installation is disabled; set PRAGMAN_REMOTE_INSTALL_TESTS=1 after publication and source review");
  }
}

export function buildSkillsCommand(skillsCli, arguments_) {
  if (!/^skills@1\.\d+\.\d+$/.test(skillsCli)) fail("Remote tests require a pinned skills CLI 1.x version");
  if (!Array.isArray(arguments_) || arguments_.some((argument) => typeof argument !== "string" || argument.length === 0)) {
    fail("skills command arguments must be non-empty strings");
  }
  if (arguments_.some((argument) => /publish/i.test(argument) || argument === "--global" || argument === "-g")) {
    fail("Remote test commands cannot publish or install globally");
  }
  return { command: "npx", args: ["--yes", skillsCli, ...arguments_], shell: false };
}

function stripAnsi(value) {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

export function assertSkillList(output) {
  const observed = [...new Set(
    (stripAnsi(output).match(/\bpragman-[a-z]+\b/g) ?? []).filter((name) => name !== "pragman-exp"),
  )].sort();
  const expected = [...EXPECTED_SKILLS].sort();
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    fail(`Unexpected skill list; expected exactly: ${EXPECTED_SKILLS.join(", ")}`);
  }
  return [...EXPECTED_SKILLS];
}

function runSkills(skillsCli, arguments_, cwd) {
  const invocation = buildSkillsCommand(skillsCli, arguments_);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "1", DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1", NO_COLOR: "1" },
    maxBuffer: 2 * 1024 * 1024,
    shell: false,
    timeout: 180_000,
  });
  if (result.error) fail(`skills CLI could not start: ${result.error.code ?? result.error.message}`);
  if (result.status !== 0) fail(`skills CLI failed with exit ${result.status ?? "unknown"}; remote output was not retained`);
  return `${result.stdout}\n${result.stderr}`;
}

async function listRegularFiles(root, prefix = "") {
  const result = [];
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const child = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await listRegularFiles(root, child));
    else if (entry.isFile()) result.push(child.split(sep).join("/"));
    else fail(`Installed skill contains a non-regular entry: ${child}`);
  }
  return result;
}

async function findSkillRoots(root, skill, depth = 0) {
  if (depth > 8) return [];
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") continue;
    const child = join(root, entry.name);
    if (entry.name === skill) {
      try {
        const marker = await lstat(join(child, "SKILL.md"));
        if (marker.isFile()) found.push(child);
      } catch {
        // Continue looking; an unrelated directory can share the skill name.
      }
    }
    found.push(...await findSkillRoots(child, skill, depth + 1));
  }
  return found;
}

async function verifyInstalledSkill(projectRoot, skill) {
  const roots = await findSkillRoots(projectRoot, skill);
  if (roots.length === 0) fail(`Remote install did not create ${skill}`);
  const expectedRoot = join(REPOSITORY_ROOT, "skills", skill);
  const expectedFiles = await listRegularFiles(expectedRoot);
  let matched = false;
  for (const root of roots) {
    const rootReal = await realpath(root);
    const projectReal = await realpath(projectRoot);
    if (rootReal !== projectReal && !rootReal.startsWith(`${projectReal}${sep}`)) fail(`${skill} resolves outside the isolated project`);
    const actualFiles = await listRegularFiles(root);
    if (JSON.stringify(actualFiles) === JSON.stringify(expectedFiles)) matched = true;
  }
  if (!matched) fail(`Installed ${skill} files do not match the tagged repository`);
}

async function createProjectRoot(label) {
  const root = await mkdtemp(join(tmpdir(), `pragman-remote-${label}-`));
  await Promise.all([
    mkdir(join(root, ".agents"), { recursive: true }),
    mkdir(join(root, ".claude"), { recursive: true }),
    mkdir(join(root, ".cursor"), { recursive: true }),
  ]);
  return root;
}

async function installSelection(options, host, selection) {
  const root = await createProjectRoot(`${host}-${selection === "*" ? "all" : "one"}`);
  try {
    runSkills(options.skillsCli, [
      "add", options.source, "--skill", selection, "--agent", host, "--copy", "--yes",
    ], root);
    const skills = selection === "*" ? EXPECTED_SKILLS : [selection];
    for (const skill of skills) await verifyInstalledSkill(root, skill);
    return { host, selection: selection === "*" ? "all" : selection, skills: skills.length };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function prerequisiteStatus(skillsCli) {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const npx = spawnSync("npx", ["--version"], { encoding: "utf8", shell: false, timeout: 10_000 });
  return {
    networkRequiredForRun: true,
    node: process.versions.node,
    nodeSupported: major === 22 || major === 24,
    npxAvailable: !npx.error && npx.status === 0,
    projectLocalOnly: true,
    publicationCommands: false,
    skillsCli,
  };
}

async function main(argv) {
  try {
    const options = parseRemoteArguments(argv);
    const prerequisites = prerequisiteStatus(options.skillsCli);
    if (options.mode === "check") {
      const result = { mode: "check", prerequisites, source: options.source };
      process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : [
        `Node ${prerequisites.node}: ${prerequisites.nodeSupported ? "supported" : "unsupported"}`,
        `npx: ${prerequisites.npxAvailable ? "available" : "missing"}`,
        `skills CLI: ${options.skillsCli} (pinned; network used only with --run)`,
        "scope: isolated project roots only; no publication commands",
      ].join("\n") + "\n");
      return prerequisites.nodeSupported && prerequisites.npxAvailable ? 0 : 2;
    }

    assertRemoteRunAuthorized(process.env);
    if (!prerequisites.nodeSupported || !prerequisites.npxAvailable) fail("Remote install prerequisites are not satisfied");
    const listRoot = await createProjectRoot("list");
    try {
      assertSkillList(runSkills(options.skillsCli, ["add", options.source, "--list"], listRoot));
    } finally {
      await rm(listRoot, { recursive: true, force: true });
    }

    const installs = [];
    for (const host of HOSTS) {
      installs.push(await installSelection(options, host, "pragman-router"));
      installs.push(await installSelection(options, host, "*"));
    }

    const result = { mode: "run", listed: EXPECTED_SKILLS.length, installs, passed: true };
    process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `Verified ${EXPECTED_SKILLS.length} skills and ${installs.length} isolated installs.\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) process.exitCode = await main(process.argv.slice(2));
