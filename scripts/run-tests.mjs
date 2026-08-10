#!/usr/bin/env node

import { readdir, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_SUFFIX = ".test.ts";

async function collect(target, root, files) {
  const metadata = await stat(target);
  if (metadata.isDirectory()) {
    const entries = await readdir(target, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      await collect(resolve(target, entry.name), root, files);
    }
    return;
  }
  if (metadata.isFile() && target.endsWith(TEST_SUFFIX)) {
    files.push(relative(root, target).split(sep).join("/"));
  }
}

export async function resolveTestFiles(arguments_ = []) {
  const root = process.cwd();
  const targets = arguments_.length === 0 ? ["tests"] : arguments_;
  const files = [];
  for (const target of targets) {
    const absoluteTarget = resolve(root, target);
    if (absoluteTarget !== root && !absoluteTarget.startsWith(`${root}${sep}`)) {
      throw new Error(`Test target is outside the repository: ${target}`);
    }
    await collect(absoluteTarget, root, files);
  }
  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
}

async function main(arguments_) {
  let files;
  try {
    files = await resolveTestFiles(arguments_);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (files.length === 0) {
    process.stderr.write("No test files matched the requested targets\n");
    return 2;
  }
  const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
  const result = spawnSync(process.execPath, [tsxCli, "--test", ...files], { stdio: "inherit" });
  return result.status ?? 1;
}

const normalizedModuleUrl = pathToFileURL(fileURLToPath(import.meta.url)).href;
const normalizedEntryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (normalizedModuleUrl === normalizedEntryUrl) {
  process.exitCode = await main(process.argv.slice(2));
}
