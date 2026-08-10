import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArguments } from "../../packages/cli/src/args.ts";

const cli = new URL("../../packages/cli/src/index.ts", import.meta.url).pathname;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pragman-workspace-cli-"));
  const personalRoot = join(root, "personal");
  const companyRoot = join(root, "company");
  const clientRoot = join(root, "client");
  const partnerRoot = join(root, "partner");
  const projectRoot = join(root, "project");
  await Promise.all([personalRoot, companyRoot, clientRoot, partnerRoot, projectRoot].map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(personalRoot, "config.yaml"), "schema_version: 1\nprivacy:\n  default_sensitivity: internal\nupdates:\n  channel: stable\noutput:\n  format: human\n");
  return { root, personalRoot, companyRoot, clientRoot, partnerRoot, projectRoot };
}

function invoke(args: string[], input?: unknown) {
  return spawnSync(process.execPath, [cli, ...args, "--json"], {
    encoding: "utf8",
    input: input === undefined ? undefined : JSON.stringify(input),
  });
}

function workspace(workspaceId: string, root: string, sensitivity = "internal") {
  return {
    schema_version: 1,
    workspace_id: workspaceId,
    name: workspaceId === "company" ? "Company" : "Client",
    root,
    context_sources: [{
      id: "canonical-docs",
      kind: "directory",
      uri: "docs",
      description: "Canonical internal docs",
      sensitivity,
    }],
    sensitivity,
  };
}

test("argument grammar recognizes every workspace command and its selectors", () => {
  for (const action of ["add", "edit", "list", "link", "unlink", "validate"]) {
    assert.equal(parseArguments(["workspace", action]).command, `workspace.${action}`);
  }
  const parsed = parseArguments(["workspace", "validate", "--workspace", "company", "--project-root", "/tmp/project"]);
  assert.equal(parsed.workspace, "company");
  assert.equal(parsed.projectRoot, "/tmp/project");
});

test("workspace add previews before writing and applies only the matching digest", async () => {
  const { personalRoot, companyRoot } = await fixture();
  const value = workspace("company", companyRoot);
  const preview = invoke(["workspace", "add", "--config", personalRoot, "--non-interactive", "--preview"], value);
  assert.equal(preview.status, 0, preview.stderr);
  const previewEnvelope = JSON.parse(preview.stdout);
  assert.equal(previewEnvelope.command, "workspace.add");
  assert.equal(previewEnvelope.data.mutated, false);
  assert.match(previewEnvelope.data.preview_digest, /^[a-f0-9]{64}$/);
  await assert.rejects(readFile(join(personalRoot, "workspaces", "company", "workspace.yaml")));

  const stale = invoke(["workspace", "add", "--config", personalRoot, "--apply", "0".repeat(64)], value);
  assert.equal(stale.status, 5, stale.stderr);
  assert.equal(JSON.parse(stale.stdout).error.code, "STALE_PREVIEW");

  const applied = invoke(["workspace", "add", "--config", personalRoot, "--apply", previewEnvelope.data.preview_digest], value);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).data.mutated, true);
  assert.match(await readFile(join(personalRoot, "workspaces", "company", "workspace.yaml"), "utf8"), /workspace_id: company/);
});

test("workspace edit validates the proposed configuration and rejects stale apply", async () => {
  const { personalRoot, companyRoot } = await fixture();
  const created = invoke(["workspace", "add", "--config", personalRoot], workspace("company", companyRoot));
  const createDigest = JSON.parse(created.stdout).data.preview_digest;
  assert.equal(invoke(["workspace", "add", "--config", personalRoot, "--apply", createDigest], workspace("company", companyRoot)).status, 0);

  const editInput = { operations: [{ op: "replace", path: "/name", value: "Example Co" }], reason: "Use current company name" };
  const preview = invoke(["workspace", "edit", "--config", personalRoot, "--workspace", "company"], editInput);
  assert.equal(preview.status, 0, preview.stderr);
  const digest = JSON.parse(preview.stdout).data.preview_digest;
  await writeFile(join(personalRoot, "workspaces", "company", "workspace.yaml"), (await readFile(join(personalRoot, "workspaces", "company", "workspace.yaml"), "utf8")).replace("name: Company", "name: Drifted"));
  const stale = invoke(["workspace", "edit", "--config", personalRoot, "--workspace", "company", "--apply", digest], editInput);
  assert.equal(stale.status, 5, stale.stderr);
  assert.equal(JSON.parse(stale.stdout).error.code, "STALE_PREVIEW");

  const unsafe = invoke(["workspace", "edit", "--config", personalRoot, "--workspace", "company"], {
    operations: [{ op: "replace", path: "/workspace_id", value: "other" }], reason: "move",
  });
  assert.equal(unsafe.status, 2, unsafe.stderr);
  const unsupported = invoke(["workspace", "edit", "--config", personalRoot, "--workspace", "company"], {
    operations: [{ op: "copy", path: "/name", value: "Other" }], reason: "unsupported patch",
  });
  assert.equal(unsupported.status, 2, unsupported.stderr);
});

test("multiple workspaces list without exposing private roots or source URIs", async () => {
  const { personalRoot, companyRoot, clientRoot } = await fixture();
  for (const [id, path, sensitivity] of [["company", companyRoot, "confidential"], ["client", clientRoot, "restricted"]] as const) {
    const value = workspace(id, path, sensitivity);
    const preview = invoke(["workspace", "add", "--config", personalRoot], value);
    const digest = JSON.parse(preview.stdout).data.preview_digest;
    assert.equal(invoke(["workspace", "add", "--config", personalRoot, "--apply", digest], value).status, 0);
  }
  const listed = invoke(["workspace", "list", "--config", personalRoot]);
  assert.equal(listed.status, 0, listed.stderr);
  const data = JSON.parse(listed.stdout).data;
  assert.deepEqual(data.workspaces.map((entry: { workspace_id: string }) => entry.workspace_id), ["client", "company"]);
  const serialized = JSON.stringify(data);
  assert.equal(serialized.includes(companyRoot), false);
  assert.equal(serialized.includes(clientRoot), false);
  assert.equal(serialized.includes("docs"), false);
  assert.deepEqual(Object.keys(data.workspaces[0]).sort(), ["context_source_count", "name", "sensitivity", "workspace_id"]);
});

test("project link preserves one primary and ordered additional workspaces", async () => {
  const { personalRoot, companyRoot, clientRoot, projectRoot } = await fixture();
  for (const [id, path] of [["company", companyRoot], ["client", clientRoot]] as const) {
    const value = workspace(id, path);
    const preview = invoke(["workspace", "add", "--config", personalRoot], value);
    invoke(["workspace", "add", "--config", personalRoot, "--apply", JSON.parse(preview.stdout).data.preview_digest], value);
  }
  const link = { project_id: "example-product", workspace: "company", additional_workspaces: ["client"] };
  const preview = invoke(["workspace", "link", "--config", personalRoot, "--project-root", projectRoot, "--non-interactive"], link);
  assert.equal(preview.status, 0, preview.stderr);
  const digest = JSON.parse(preview.stdout).data.preview_digest;
  const applied = invoke(["workspace", "link", "--config", personalRoot, "--project-root", projectRoot, "--apply", digest], link);
  assert.equal(applied.status, 0, applied.stderr);
  const manifest = await readFile(join(projectRoot, ".pragman", "manifest.yaml"), "utf8");
  assert.match(manifest, /workspace: company/);
  assert.match(manifest, /additional_workspaces:\n  - client/);

  const duplicate = invoke(["workspace", "link", "--config", personalRoot, "--project-root", projectRoot], {
    ...link, additional_workspaces: ["company"],
  });
  assert.equal(duplicate.status, 2, duplicate.stderr);
});

test("validate reports linked provenance and additional conflicts without private context", async () => {
  const { personalRoot, companyRoot, clientRoot, partnerRoot, projectRoot } = await fixture();
  const primary = workspace("company", companyRoot);
  const secondary = workspace("client", clientRoot, "confidential");
  const partner = workspace("partner", partnerRoot, "restricted");
  for (const value of [primary, secondary, partner]) {
    const preview = invoke(["workspace", "add", "--config", personalRoot], value);
    invoke(["workspace", "add", "--config", personalRoot, "--apply", JSON.parse(preview.stdout).data.preview_digest], value);
  }
  const link = { project_id: "demo", workspace: "company", additional_workspaces: ["client", "partner"] };
  const linkPreview = invoke(["workspace", "link", "--config", personalRoot, "--project-root", projectRoot], link);
  invoke(["workspace", "link", "--config", personalRoot, "--project-root", projectRoot, "--apply", JSON.parse(linkPreview.stdout).data.preview_digest], link);

  const validated = invoke(["workspace", "validate", "--config", personalRoot, "--project-root", projectRoot]);
  assert.equal(validated.status, 0, validated.stderr);
  const data = JSON.parse(validated.stdout).data;
  assert.equal(data.mode, "project-linked");
  assert.equal(data.primary_workspace, "company");
  assert.deepEqual(data.additional_workspaces, ["client", "partner"]);
  assert.ok(data.provenance["/context_sources"]);
  assert.deepEqual(data.conflicts.find((entry: { path: string }) => entry.path === "/sensitivity"), {
    path: "/sensitivity", workspace_ids: ["client", "partner"], requires_choice: true,
  });
  const serialized = JSON.stringify(data);
  assert.equal(serialized.includes(companyRoot), false);
  assert.equal(serialized.includes(clientRoot), false);
  assert.equal(serialized.includes(partnerRoot), false);
  assert.equal(serialized.includes("Canonical internal docs"), false);
});

test("workspace mutations fail closed on secret-like values and symlinked history", async () => {
  const { root, personalRoot, companyRoot, projectRoot } = await fixture();
  const secret = workspace("company", companyRoot);
  secret.description = "api_key=sk-proj-12345678901234567890";
  const denied = invoke(["workspace", "add", "--config", personalRoot], secret);
  assert.equal(denied.status, 5, denied.stderr);
  assert.equal(JSON.parse(denied.stdout).error.code, "PRIVACY_DENIED");

  const value = workspace("company", companyRoot);
  let preview = invoke(["workspace", "add", "--config", personalRoot], value);
  invoke(["workspace", "add", "--config", personalRoot, "--apply", JSON.parse(preview.stdout).data.preview_digest], value);
  const link = { project_id: "demo", workspace: "company", additional_workspaces: [] };
  preview = invoke(["workspace", "link", "--config", personalRoot, "--project-root", projectRoot], link);
  invoke(["workspace", "link", "--config", personalRoot, "--project-root", projectRoot, "--apply", JSON.parse(preview.stdout).data.preview_digest], link);
  const outside = join(root, "outside");
  await mkdir(outside);
  await symlink(outside, join(projectRoot, ".pragman", "history"));
  const unlinkPreview = invoke(["workspace", "unlink", "--config", personalRoot, "--project-root", projectRoot]);
  const unlinked = invoke(["workspace", "unlink", "--config", personalRoot, "--project-root", projectRoot, "--apply", JSON.parse(unlinkPreview.stdout).data.preview_digest]);
  assert.equal(unlinked.status, 5, unlinked.stderr);
  assert.ok(await readFile(join(projectRoot, ".pragman", "manifest.yaml")));
});

test("workspace unlink previews and atomically removes only the selected project link", async () => {
  const { personalRoot, companyRoot, projectRoot } = await fixture();
  const value = workspace("company", companyRoot);
  let preview = invoke(["workspace", "add", "--config", personalRoot], value);
  invoke(["workspace", "add", "--config", personalRoot, "--apply", JSON.parse(preview.stdout).data.preview_digest], value);
  const link = { project_id: "demo", workspace: "company", additional_workspaces: [] };
  preview = invoke(["workspace", "link", "--config", personalRoot, "--project-root", projectRoot], link);
  invoke(["workspace", "link", "--config", personalRoot, "--project-root", projectRoot, "--apply", JSON.parse(preview.stdout).data.preview_digest], link);

  const unlinkPreview = invoke(["workspace", "unlink", "--config", personalRoot, "--project-root", projectRoot]);
  assert.equal(unlinkPreview.status, 0, unlinkPreview.stderr);
  const unlinkDigest = JSON.parse(unlinkPreview.stdout).data.preview_digest;
  assert.ok(await readFile(join(projectRoot, ".pragman", "manifest.yaml")));
  const unlinked = invoke(["workspace", "unlink", "--config", personalRoot, "--project-root", projectRoot, "--apply", unlinkDigest]);
  assert.equal(unlinked.status, 0, unlinked.stderr);
  await assert.rejects(readFile(join(projectRoot, ".pragman", "manifest.yaml")));
});

test("workspace failures retain stable exit classes and human output", async () => {
  const { personalRoot } = await fixture();
  const missing = invoke(["workspace", "validate", "--config", personalRoot, "--workspace", "missing"]);
  assert.equal(missing.status, 2, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).error.code, "NOT_FOUND");
  const human = spawnSync(process.execPath, [cli, "workspace", "validate", "--config", personalRoot, "--workspace", "missing"], { encoding: "utf8" });
  assert.equal(human.status, 2);
  assert.match(human.stderr, /not found/i);
});

test("pragman-workspace package carries portable degradation and paired behavioral evals", async () => {
  const skillRoot = new URL("../../skills/pragman-workspace/", import.meta.url);
  const [skill, compatibility, metadata, baseline, forward] = await Promise.all([
    readFile(new URL("SKILL.md", skillRoot), "utf8"),
    readFile(new URL("COMPATIBILITY.md", skillRoot), "utf8"),
    readFile(new URL("agents/openai.yaml", skillRoot), "utf8"),
    readFile(new URL("evals/baseline.json", skillRoot), "utf8").then(JSON.parse),
    readFile(new URL("evals/forward.json", skillRoot), "utf8").then(JSON.parse),
  ]);
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  assert.deepEqual(frontmatter.split("\n").map((line) => line.split(":", 1)[0]), ["name", "description"]);
  assert.match(skill, /CLI unavailable/);
  assert.match(skill, /do not write or claim validation/i);
  assert.match(compatibility, />=0\.1\.0 <1\.0\.0/);
  assert.match(metadata, /\$pragman-workspace/);
  assert.equal(baseline.scenarios.length >= 3, true);
  assert.deepEqual(forward.scenarios.map((entry: { scenario_id: string }) => entry.scenario_id), baseline.scenarios.map((entry: { scenario_id: string }) => entry.scenario_id));
  assert.equal(forward.scenarios.every((entry: { passed: boolean }) => entry.passed), true);
  assert.equal([skill, compatibility, metadata, JSON.stringify(baseline), JSON.stringify(forward)].join("\n").includes("/Users/"), false);
});
