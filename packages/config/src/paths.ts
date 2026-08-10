import { realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import { ConfigError } from "./types.ts";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isContained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

export function assertSlug(value: string, label = "identifier"): string {
  if (!SLUG.test(value)) {
    throw new ConfigError("INVALID_PATH", `${label} must be a lowercase hyphenated slug`);
  }
  return value;
}

export function normalizeAbsolutePath(path: string, options: { requireNormalized?: boolean } = {}): string {
  if (!isAbsolute(path)) throw new ConfigError("INVALID_PATH", "Path must be absolute");
  const normalized = normalize(path);
  if (options.requireNormalized && normalized !== path) {
    throw new ConfigError("INVALID_PATH", "Path is not normalized");
  }
  return normalized;
}

export function personalConfigPath(personalRoot: string): string {
  return join(normalizeAbsolutePath(personalRoot), "config.yaml");
}

export function personalProfilePath(personalRoot: string): string {
  return join(normalizeAbsolutePath(personalRoot), "profile.yaml");
}

export function workspaceConfigPath(personalRoot: string, workspaceId: string): string {
  return join(normalizeAbsolutePath(personalRoot), "workspaces", assertSlug(workspaceId, "workspace id"), "workspace.yaml");
}

export function projectManifestPath(projectRoot: string): string {
  return join(normalizeAbsolutePath(projectRoot), ".pragman", "manifest.yaml");
}

export function resolveContainedPath(root: string, candidate: string, options?: { verifyRealPath?: false }): string;
export function resolveContainedPath(root: string, candidate: string, options: { verifyRealPath: true }): Promise<string>;
export function resolveContainedPath(
  root: string,
  candidate: string,
  options: { verifyRealPath?: boolean } = {},
): string | Promise<string> {
  const normalizedRoot = normalizeAbsolutePath(root);
  const resolved = isAbsolute(candidate) ? normalizeAbsolutePath(candidate) : resolve(normalizedRoot, candidate);
  if (!isContained(normalizedRoot, resolved)) {
    throw new ConfigError("INVALID_PATH", "Path escapes the selected root", { root: normalizedRoot });
  }
  if (!options.verifyRealPath) return resolved;
  return (async () => {
    const [realRoot, realCandidate] = await Promise.all([realpath(normalizedRoot), realpath(resolved)]);
    if (!isContained(realRoot, realCandidate)) {
      throw new ConfigError("INVALID_PATH", "Resolved path escapes the selected root", { root: normalizedRoot });
    }
    return realCandidate;
  })();
}
