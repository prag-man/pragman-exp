import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../../", import.meta.url).pathname;

test("packed package installs an emitted pragman binary that runs through a symlink from a path with spaces", async () => {
  assert.ok(["22", "24"].includes(process.versions.node.split(".")[0] ?? ""));
  const directory = await mkdtemp(join(tmpdir(), "pragman package smoke "));
  const packDirectory = join(directory, "packed artifacts");
  const consumerDirectory = join(directory, "consumer project");
  await mkdir(packDirectory);
  await mkdir(consumerDirectory);

  const packed = spawnSync("npm", ["pack", "--pack-destination", packDirectory, "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, packed.stderr);
  const [{ filename }] = JSON.parse(packed.stdout);
  const tarball = join(packDirectory, filename);

  const installed = spawnSync("npm", ["install", "--ignore-scripts", tarball], {
    cwd: consumerDirectory,
    encoding: "utf8",
  });
  assert.equal(installed.status, 0, installed.stderr);

  const installedPackage = JSON.parse(await readFile(join(
    consumerDirectory,
    "node_modules/@prag-man/pragman-exp/package.json",
  ), "utf8"));
  assert.equal(installedPackage.bin.pragman, "dist/packages/cli/src/index.js");

  const result = spawnSync(join(consumerDirectory, "node_modules/.bin/pragman"), ["--version", "--json"], {
    cwd: consumerDirectory,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).command, "version");
});
