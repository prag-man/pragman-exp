#!/usr/bin/env node

import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = join(repositoryRoot, "skills");
const expected = [
  "pragman-analyze", "pragman-init", "pragman-prototype", "pragman-research",
  "pragman-router", "pragman-shape", "pragman-unfck", "pragman-workspace",
];
const PRIVATE_PATH = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/;

function fail(message) { throw new Error(message); }
function contained(root, target) {
  const relation = relative(root, target);
  return relation !== ".." && !relation.startsWith(`..${sep}`) && !relation.includes(`..${sep}`);
}

async function validateSkill(name) {
  const root = join(skillsRoot, name);
  const required = ["SKILL.md", "COMPATIBILITY.md", "agents/openai.yaml", "evals/baseline.json", "evals/forward.json"];
  for (const path of required) {
    const info = await lstat(join(root, path)).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) fail(`${name}: missing or unsafe ${path}`);
  }
  const skill = await readFile(join(root, "SKILL.md"), "utf8");
  if (skill.split(/\r?\n/).length > 500) fail(`${name}: SKILL.md exceeds 500 lines`);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill);
  if (!match) fail(`${name}: invalid frontmatter`);
  const frontmatter = parse(match[1], { uniqueKeys: true });
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) fail(`${name}: frontmatter must be an object`);
  if (Object.keys(frontmatter).sort().join(",") !== "description,name" || frontmatter.name !== name || typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
    fail(`${name}: frontmatter must contain only matching name and description`);
  }
  const compatibility = await readFile(join(root, "COMPATIBILITY.md"), "utf8");
  if (!/CLI unavailable/i.test(skill) || !/(manual|fallback|without the CLI|unavailable)/i.test(`${skill}\n${compatibility}`)) fail(`${name}: missing honest manual degradation`);
  const metadata = parse(await readFile(join(root, "agents/openai.yaml"), "utf8"), { uniqueKeys: true });
  if (!metadata?.interface || typeof metadata.interface.display_name !== "string" || typeof metadata.interface.short_description !== "string"
    || typeof metadata.interface.default_prompt !== "string" || !metadata.interface.default_prompt.includes(`$${name}`)) fail(`${name}: invalid OpenAI UI metadata`);
  const links = [...skill.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((entry) => entry[1]);
  for (const link of links) {
    if (link.includes("://") || link.startsWith("#") || link.startsWith("/")) continue;
    const target = normalize(join(root, link));
    if (!contained(root, target) || relative(root, target).split(sep).length > 2) fail(`${name}: unsafe or deep skill link ${link}`);
    const info = await lstat(target).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) fail(`${name}: broken skill link ${link}`);
  }
  const [baseline, forward] = await Promise.all(["baseline", "forward"].map(async (arm) => JSON.parse(await readFile(join(root, `evals/${arm}.json`), "utf8"))));
  if (baseline.schema_version !== 1 || forward.schema_version !== 1 || baseline.skill_id !== name || forward.skill_id !== name
    || baseline.arm !== "skill-off" || forward.arm !== "skill-on" || !Array.isArray(baseline.scenarios) || baseline.scenarios.length < 3
    || !Array.isArray(forward.scenarios)) fail(`${name}: invalid paired eval envelope`);
  const baselineIds = baseline.scenarios.map((scenario) => scenario.scenario_id);
  const forwardIds = forward.scenarios.map((scenario) => scenario.scenario_id);
  if (new Set(baselineIds).size !== baselineIds.length || JSON.stringify(baselineIds) !== JSON.stringify(forwardIds)
    || !forward.scenarios.every((scenario) => scenario.passed === true && Array.isArray(scenario.invariants) && scenario.invariants.length > 0)) fail(`${name}: paired eval scenarios do not match`);
  const publicText = [skill, compatibility, JSON.stringify(metadata), JSON.stringify(baseline), JSON.stringify(forward)].join("\n");
  if (PRIVATE_PATH.test(publicText)) fail(`${name}: private absolute path detected`);
  return { name, scenarios: baseline.scenarios.length, lines: skill.split(/\r?\n/).length };
}

const entries = (await readdir(skillsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name).sort();
if (JSON.stringify(entries) !== JSON.stringify(expected)) fail(`Expected exactly eight skills: ${expected.join(", ")}`);
const results = [];
for (const name of entries) results.push(await validateSkill(name));
process.stdout.write(`${JSON.stringify({ ok: true, schema_version: 1, skills: results })}\n`);
