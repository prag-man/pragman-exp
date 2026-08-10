import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const SKILLS = [
  "pragman-init", "pragman-workspace", "pragman-router", "pragman-research",
  "pragman-shape", "pragman-prototype", "pragman-analyze", "pragman-unfck",
];

const COMMANDS = [
  "pragman init", "pragman scan", "pragman doctor", "pragman tune", "pragman route",
  "pragman workspace add", "pragman workspace edit", "pragman workspace list",
  "pragman workspace link", "pragman workspace unlink", "pragman workspace validate",
  "pragman providers list", "pragman providers inspect", "pragman providers prefer", "pragman providers trust",
  "pragman sessions scan", "pragman sessions analyze", "pragman sessions purge",
  "pragman changes list", "pragman changes preview", "pragman changes apply", "pragman changes rollback",
  "pragman history purge", "pragman eval", "pragman events record", "pragman events score",
  "pragman events list", "pragman events summary", "pragman events rebuild", "pragman events export",
  "pragman events purge", "pragman events candidates list", "pragman events candidates decide",
];

test("README documents the complete portable surface and operating model", async () => {
  const readme = await readFile("README.md", "utf8");
  for (const skill of SKILLS) assert.match(readme, new RegExp(`\\b${skill}\\b`));
  for (const command of COMMANDS) assert.ok(readme.includes(command), `README is missing ${command}`);
  assert.match(readme, /Node\.js 22 (?:and|or) 24/i);
  assert.match(readme, /adaptive.*control (?:panel|plane)/is);
  assert.match(readme, /gstack/i);
  assert.match(readme, /Compound Engineering/i);
  assert.match(readme, /Superpowers/i);
  assert.match(readme, /local by default/i);
  assert.match(readme, /content-free event/i);
  assert.match(readme, /direct skill use.*not automatically/is);
  assert.match(readme, /skills\.sh/i);
});

test("CI covers macOS and Ubuntu on Node.js 22 and 24", async () => {
  const workflow = parse(await readFile(".github/workflows/ci.yml", "utf8"));
  assert.deepEqual(workflow.jobs.test.strategy.matrix.os, ["ubuntu-latest", "macos-latest"]);
  assert.deepEqual(workflow.jobs.test.strategy.matrix.node, [22, 24]);
  const runs = workflow.jobs.test.steps.map((step: { run?: string }) => step.run).filter(Boolean).join("\n");
  for (const command of ["npm ci", "npm test", "npm run build", "npm run validate:skills", "npm run evals", "npm pack --dry-run"]) {
    assert.ok(runs.includes(command), `CI is missing ${command}`);
  }
});

test("tag release uses npm trusted publishing, provenance, and checksummed release assets", async () => {
  const source = await readFile(".github/workflows/release.yml", "utf8");
  const workflow = parse(source);
  assert.deepEqual(workflow.on.push.tags, ["v*.*.*"]);
  assert.equal(workflow.permissions["id-token"], "write");
  assert.equal(workflow.permissions.contents, "write");
  assert.match(source, /npm@11\.5\.1/);
  assert.match(source, /npm publish[^\n]*--provenance/);
  assert.match(source, /verification\.verified/);
  assert.match(source, /merge-base --is-ancestor/);
  assert.match(source, /npm view .*dist\.integrity/);
  assert.match(source, /verify-package\.mjs/);
  assert.match(source, /checksums-sha256\.txt/);
  assert.match(source, /gh release create/);
  assert.match(source, /gh release upload[^\n]*--clobber/);
  assert.doesNotMatch(source, /NODE_AUTH_TOKEN|NPM_TOKEN/);
});

test("public policy and release runbook describe privacy-safe contribution and staged publication", async () => {
  const [security, contributing, checklist, license] = await Promise.all([
    readFile("SECURITY.md", "utf8"),
    readFile("CONTRIBUTING.md", "utf8"),
    readFile("docs/operations/release-checklist.md", "utf8"),
    readFile("LICENSE", "utf8"),
  ]);
  assert.match(security, /private vulnerability reporting/i);
  assert.match(security, /session content/i);
  assert.match(contributing, /red.*green/is);
  assert.match(contributing, /saniti[sz]ed/i);
  assert.match(checklist, /0\.1\.0-beta\.0/);
  assert.match(checklist, /mandatory credential gate/i);
  assert.match(checklist, /trusted publisher/i);
  assert.match(checklist, /skills\.sh/i);
  assert.match(license, /MIT License/);
});
