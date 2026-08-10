import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";

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
  const installedRoot = join(consumerDirectory, "node_modules/@prag-man/pragman-exp");
  const events = await import(pathToFileURL(join(installedRoot, "dist/packages/events/src/index.js")).href);
  const taskSuccessMetric = JSON.parse(await readFile(join(installedRoot, "evals/metrics/task-success.json"), "utf8"));
  const eventValidators = events.createEventValidators([taskSuccessMetric]);
  assert.equal(eventValidators.metric(taskSuccessMetric).ok, true);
  assert.equal(events.sha256Digest(taskSuccessMetric).length, 64);
  installedPackage.version = "9.8.7";
  await writeFile(join(
    consumerDirectory,
    "node_modules/@prag-man/pragman-exp/package.json",
  ), `${JSON.stringify(installedPackage, null, 2)}\n`);

  const result = spawnSync(join(consumerDirectory, "node_modules/.bin/pragman"), ["--version", "--json"], {
    cwd: consumerDirectory,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.command, "version");
  assert.equal(output.data.version, installedPackage.version);

  const evalState = join(consumerDirectory, "event-state");
  const evalResult = spawnSync(join(consumerDirectory, "node_modules/.bin/pragman"), [
    "eval", "run", "--state-root", evalState, "--json",
  ], {
    cwd: consumerDirectory,
    encoding: "utf8",
    input: JSON.stringify({
      scenario_file: join(installedRoot, "evals/fixtures/skill-events/baseline.json"),
      observed_file: join(installedRoot, "evals/fixtures/skill-events/forward.json"),
      evidence_id: "packed-evidence",
    }),
  });
  assert.equal(evalResult.status, 0, evalResult.stderr);
  const evalData = JSON.parse(evalResult.stdout).data;
  assert.equal(evalData.evidence.mode, "skill-eval");
  assert.match(evalData.artifact_digest, /^[a-f0-9]{64}$/);
  const artifact = JSON.parse(await readFile(join(evalState, "eval-evidence", "packed-evidence.json"), "utf8"));
  assert.equal(artifact.evidence.status, "COMPARABLE");
});
