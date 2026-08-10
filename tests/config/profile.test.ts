import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConfigError, loadPersonalProfile, personalProfilePath } from "../../packages/config/src/index.ts";

test("personal profiles load through the published schema and a fixed local path", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragman-profile-"));
  await writeFile(join(root, "profile.yaml"), "schema_version: 1\nprofile_id: founder\nroles:\n  - Founder\nresponsibilities:\n  - Product\n");
  assert.equal(personalProfilePath(root), join(root, "profile.yaml"));
  assert.equal((await loadPersonalProfile(root)).profile_id, "founder");
});

test("personal profile loading rejects unknown fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragman-profile-"));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "profile.yaml"), "schema_version: 1\nprofile_id: founder\nroles:\n  - Founder\nresponsibilities:\n  - Product\nprivate_root: /private/company\n");
  await assert.rejects(loadPersonalProfile(root), (error: unknown) => error instanceof ConfigError && error.code === "INVALID_CONFIGURATION");
});
