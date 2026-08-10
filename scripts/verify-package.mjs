#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_SKILLS = Object.freeze([
  "pragman-init",
  "pragman-workspace",
  "pragman-router",
  "pragman-research",
  "pragman-shape",
  "pragman-prototype",
  "pragman-analyze",
  "pragman-unfck",
]);

const FORBIDDEN_SEGMENTS = new Set([
  ".git",
  ".pragman",
  ".codex",
  ".claude",
  ".cursor",
  ".npmrc",
  "node_modules",
  "id_rsa",
  "id_ed25519",
]);

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[opusr]_[A-Za-z0-9]{36,255}\b/,
  /\bnpm_[A-Za-z0-9]{36,255}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
];

const PRIVATE_PATH_PATTERNS = [
  /(?:^|["'\s=(])\/Users\/[A-Za-z0-9._-]+\//,
  /(?:^|["'\s=(])\/home\/[A-Za-z0-9._-]+\//,
  /(?:^|["'\s=(])[A-Za-z]:\\Users\\[^\\\s]+\\/i,
];

function fail(message) {
  throw new Error(message);
}

function normalizeEntry(entry) {
  if (typeof entry !== "string" || entry.length === 0 || entry.includes("\0") || entry.includes("\\")) {
    fail(`Invalid package path: ${String(entry)}`);
  }
  const withoutPrefix = entry.startsWith("package/") ? entry.slice("package/".length) : entry;
  if (isAbsolute(withoutPrefix)) fail(`Invalid absolute package path: ${entry}`);
  const parts = withoutPrefix.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    fail(`Invalid package path traversal: ${entry}`);
  }
  return withoutPrefix;
}

function isForbiddenPath(entry) {
  const parts = entry.toLowerCase().split("/");
  if (parts.some((part) => FORBIDDEN_SEGMENTS.has(part))) return true;
  if (parts.some((part) => part === ".env" || part.startsWith(".env."))) return true;
  return entry === "docs/superpowers" || entry.startsWith("docs/superpowers/");
}

function validateManifest(manifest) {
  if (manifest.name !== "@prag-man/pragman-exp") fail("Unexpected package name");
  if (manifest.private === true) fail("Package manifest must not be private");
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    fail("Package version must be a publishable semantic version");
  }
  if (manifest.license !== "MIT") fail("Package license must be MIT");
  if (manifest.engines?.node !== ">=22 <25") fail("Package must support Node.js >=22 <25");
  if (manifest.bin?.pragman !== "dist/packages/cli/src/index.js") fail("Package must expose the pragman binary");
  const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  if (typeof repository !== "string" || !/^git\+https:\/\/github\.com\/prag-man\/pragman-exp\.git$/.test(repository)) {
    fail("Package repository must be the public prag-man/pragman-exp GitHub repository");
  }
}

async function readContainedFile(root, entry) {
  const absolute = resolve(root, entry);
  const rootReal = await realpath(root);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`Package entry must be a regular file: ${entry}`);
  if (metadata.size > 10 * 1024 * 1024) fail(`Package entry exceeds 10 MiB: ${entry}`);
  const entryReal = await realpath(absolute);
  if (entryReal !== rootReal && !entryReal.startsWith(`${rootReal}${sep}`)) {
    fail(`Package entry resolves outside package root: ${entry}`);
  }
  return readFile(entryReal);
}

export async function verifyPackageDirectory(root, rawEntries) {
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) fail("Package contains no files");
  if (rawEntries.length > 2_000) fail("Package contains more than 2000 files");
  const entries = [...new Set(rawEntries.map(normalizeEntry))].sort();
  if (entries.length !== rawEntries.length) fail("Package contains duplicate file paths");
  for (const entry of entries) if (isForbiddenPath(entry)) fail(`Forbidden package path: ${entry}`);

  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/packages/cli/src/index.js",
    "packages/config/schemas/envelope.schema.json",
    "providers/capabilities.yaml",
    "providers/pragman.yaml",
    "providers/gstack.yaml",
    "providers/compound-engineering.yaml",
    "providers/superpowers.yaml",
    "host-adapters/compatibility.json",
    "scripts/run-evals.mjs",
  ]) {
    if (!entries.includes(required)) fail(`Missing required package file: ${required}`);
  }

  const skills = entries
    .filter((entry) => /^skills\/[^/]+\/SKILL\.md$/.test(entry))
    .map((entry) => entry.split("/")[1])
    .filter((skill) => skill !== undefined)
    .sort();
  const expectedSorted = [...EXPECTED_SKILLS].sort();
  if (JSON.stringify(skills) !== JSON.stringify(expectedSorted)) {
    fail(`Package must contain exactly eight public skills: ${EXPECTED_SKILLS.join(", ")}`);
  }

  const manifestBytes = await readContainedFile(root, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    fail("Package manifest is not valid JSON");
  }
  validateManifest(manifest);

  for (const entry of entries) {
    const bytes = await readContainedFile(root, entry);
    if (bytes.includes(0)) continue;
    const content = bytes.toString("utf8");
    if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) {
      fail(`Credential-shaped content found in package file: ${entry}`);
    }
    if (PRIVATE_PATH_PATTERNS.some((pattern) => pattern.test(content))) {
      fail(`Private absolute path found in package file: ${entry}`);
    }
  }

  return { files: entries.length, skills: [...EXPECTED_SKILLS], version: manifest.version };
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "no output").trim();
    fail(`${command} ${arguments_.join(" ")} failed: ${detail}`);
  }
  return result.stdout;
}

async function inspectDryRun(packageRoot) {
  const output = run("npm", ["pack", "--json", "--dry-run", "--ignore-scripts"], { cwd: packageRoot });
  let report;
  try {
    report = JSON.parse(output);
  } catch {
    fail("npm pack --json did not return valid JSON");
  }
  const first = Array.isArray(report) ? report[0] : undefined;
  if (!first || !Array.isArray(first.files)) fail("npm pack report did not contain a file manifest");
  return verifyPackageDirectory(packageRoot, first.files.map((file) => file.path));
}

function validateArchiveListing(archive) {
  const listing = run("tar", ["-tzf", archive]).split(/\r?\n/).filter(Boolean);
  for (const entry of listing) normalizeEntry(entry.endsWith("/") ? entry.slice(0, -1) : entry);
  const verbose = run("tar", ["-tvzf", archive]).split(/\r?\n/).filter(Boolean);
  if (verbose.some((line) => !line.startsWith("-") && !line.startsWith("d"))) {
    fail("Package archive contains links or non-regular entries");
  }
  return listing.filter((entry) => !entry.endsWith("/")).map(normalizeEntry);
}

async function inspectArchive(archive) {
  const absoluteArchive = resolve(archive);
  const entries = validateArchiveListing(absoluteArchive);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pragman-package-verify-"));
  try {
    run("tar", ["-xzf", absoluteArchive, "-C", temporaryRoot]);
    return await verifyPackageDirectory(join(temporaryRoot, "package"), entries);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  let json = false;
  let archive;
  let root = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") json = true;
    else if (argument === "--root" && argv[index + 1]) root = resolve(argv[++index]);
    else if (!argument.startsWith("-") && archive === undefined) archive = argument;
    else fail(`Unknown or incomplete argument: ${argument}`);
  }
  return { archive, json, root };
}

async function main(argv) {
  try {
    const options = parseArguments(argv);
    const result = options.archive ? await inspectArchive(options.archive) : await inspectDryRun(options.root);
    const message = { ok: true, ...result };
    process.stdout.write(options.json ? `${JSON.stringify(message)}\n` : `Verified ${result.files} files and ${result.skills.length} skills for ${result.version}.\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) process.exitCode = await main(process.argv.slice(2));
