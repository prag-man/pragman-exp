import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyPackageDirectory } from "../../scripts/verify-package.mjs";

const SKILLS = [
  "pragman-init",
  "pragman-workspace",
  "pragman-router",
  "pragman-research",
  "pragman-shape",
  "pragman-prototype",
  "pragman-analyze",
  "pragman-unfck",
] as const;

async function packageFixture(): Promise<{ root: string; entries: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "pragman-package-test-"));
  const entries = [
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
  ];
  await mkdir(join(root, "dist/packages/cli/src"), { recursive: true });
  await mkdir(join(root, "packages/config/schemas"), { recursive: true });
  await mkdir(join(root, "providers"), { recursive: true });
  await mkdir(join(root, "host-adapters"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "@prag-man/pragman-exp",
    version: "0.1.0",
    private: false,
    license: "MIT",
    engines: { node: ">=22 <25" },
    bin: { pragman: "dist/packages/cli/src/index.js" },
    repository: { type: "git", url: "git+https://github.com/prag-man/pragman-exp.git" },
  }));
  await writeFile(join(root, "README.md"), "# Pragman Exp\n");
  await writeFile(join(root, "LICENSE"), "MIT License\n");
  await writeFile(join(root, "dist/packages/cli/src/index.js"), "#!/usr/bin/env node\n");
  await writeFile(join(root, "packages/config/schemas/envelope.schema.json"), "{}\n");
  await writeFile(join(root, "host-adapters/compatibility.json"), "{}\n");
  await writeFile(join(root, "scripts/run-evals.mjs"), "#!/usr/bin/env node\n");
  for (const provider of ["capabilities", "pragman", "gstack", "compound-engineering", "superpowers"]) {
    await writeFile(join(root, "providers", `${provider}.yaml`), "version: 1\n");
  }
  for (const skill of SKILLS) {
    const path = `skills/${skill}/SKILL.md`;
    entries.push(path);
    await mkdir(join(root, "skills", skill), { recursive: true });
    await writeFile(join(root, path), `---\nname: ${skill}\ndescription: Test fixture\n---\n`);
  }
  return { root, entries };
}

test("package verifier accepts the complete public skill surface", async () => {
  const fixture = await packageFixture();
  const result = await verifyPackageDirectory(fixture.root, fixture.entries);
  assert.deepEqual(result.skills, [...SKILLS]);
  assert.equal(result.files, fixture.entries.length);
});

test("package verifier rejects private paths and credential-shaped content", async () => {
  const privatePath = await packageFixture();
  await writeFile(join(privatePath.root, ".npmrc"), "registry=https://registry.npmjs.org\n");
  await assert.rejects(
    verifyPackageDirectory(privatePath.root, [...privatePath.entries, ".npmrc"]),
    /forbidden package path.*\.npmrc/i,
  );

  const secret = await packageFixture();
  await writeFile(join(secret.root, "README.md"), `token: ghp_${"a".repeat(36)}\n`);
  await assert.rejects(verifyPackageDirectory(secret.root, secret.entries), /credential-shaped content/i);
});

test("package verifier requires deterministic runtime assets", async () => {
  const fixture = await packageFixture();
  await assert.rejects(
    verifyPackageDirectory(fixture.root, fixture.entries.filter((entry) => entry !== "providers/capabilities.yaml")),
    /missing required package file: providers\/capabilities\.yaml/i,
  );
});
