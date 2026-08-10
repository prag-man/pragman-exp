import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

export type DiscoveryHealth = "healthy" | "degraded" | "conflict";
export type InstallScope = "user" | "project";

export interface DiscoveryRecord {
  source: "codex" | "claude-code" | "cursor";
  skill_id: string;
  version: string;
  install_scope: InstallScope;
  path_alias: string;
  digest: string;
  health: DiscoveryHealth;
  shadowed_by: string | null;
}

export interface DiscoveryWarning {
  code: "INVALID_METADATA" | "METADATA_TOO_LARGE" | "ROOT_LIMIT" | "SKILL_LIMIT" | "SYMLINK_SKIPPED";
  path_alias: string;
}

export interface DiscoveryReport {
  schema_version: 1;
  installations: DiscoveryRecord[];
  warnings: DiscoveryWarning[];
  truncated: boolean;
  bounds: {
    maximum_hosts: number;
    maximum_skills_per_root: number;
    maximum_metadata_bytes: number;
  };
}

export interface DiscoveryRoot {
  source: DiscoveryRecord["source"];
  install_scope: InstallScope;
  root: string;
}

export interface DiscoveryOptions {
  homeRoot?: string;
  projectRoot?: string;
  roots?: readonly DiscoveryRoot[];
  maximumHosts?: number;
  maximumSkillsPerRoot?: number;
  maximumMetadataBytes?: number;
}

const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_BOUNDS = Object.freeze({
  maximum_hosts: 8,
  maximum_skills_per_root: 256,
  maximum_metadata_bytes: 32_768,
});

function canonicalMetadata(value: { name: string; description: string }): string {
  return JSON.stringify({ description: value.description, name: value.name });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function defaultRoots(homeRoot: string, projectRoot?: string): DiscoveryRoot[] {
  const roots: DiscoveryRoot[] = [
    { source: "codex", install_scope: "user", root: join(homeRoot, ".agents", "skills") },
    { source: "claude-code", install_scope: "user", root: join(homeRoot, ".claude", "skills") },
    { source: "cursor", install_scope: "user", root: join(homeRoot, ".cursor", "skills") },
  ];
  if (projectRoot) roots.push(
    { source: "codex", install_scope: "project", root: join(projectRoot, ".agents", "skills") },
    { source: "claude-code", install_scope: "project", root: join(projectRoot, ".claude", "skills") },
    { source: "cursor", install_scope: "project", root: join(projectRoot, ".cursor", "skills") },
  );
  return roots;
}

async function readMetadataPrefix(path: string, maximumBytes: number): Promise<{ text: string; tooLarge: boolean }> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maximumBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const prefix = buffer.subarray(0, Math.min(bytesRead, maximumBytes)).toString("utf8");
    const close = prefix.indexOf("\n---", 4);
    return { text: close >= 0 ? prefix.slice(0, close + 4) : prefix, tooLarge: bytesRead > maximumBytes && close < 0 };
  } finally {
    await handle.close();
  }
}

function parseSkillMetadata(text: string): { name: string; description: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return null;
  try {
    const value = parse(match[1]!, { uniqueKeys: true }) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.name === "string" && SKILL_ID.test(candidate.name)
      && typeof candidate.description === "string" && candidate.description.trim().length > 0
      ? { name: candidate.name, description: candidate.description }
      : null;
  } catch {
    return null;
  }
}

function rank(scope: InstallScope): number {
  return scope === "project" ? 2 : 1;
}

function applyShadowing(records: DiscoveryRecord[]): void {
  const groups = new Map<string, DiscoveryRecord[]>();
  for (const record of records) {
    if (record.health !== "healthy") continue;
    const key = `${record.source}\0${record.skill_id}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    if (new Set(group.map((record) => record.digest)).size > 1) {
      for (const record of group) record.health = "conflict";
      continue;
    }
    const winner = [...group].sort((left, right) => rank(right.install_scope) - rank(left.install_scope)
      || left.path_alias.localeCompare(right.path_alias))[0]!;
    for (const record of group) if (record !== winner) record.shadowed_by = winner.path_alias;
  }
}

export async function discoverKnownHosts(options: DiscoveryOptions = {}): Promise<DiscoveryReport> {
  const bounds = {
    maximum_hosts: options.maximumHosts ?? DEFAULT_BOUNDS.maximum_hosts,
    maximum_skills_per_root: options.maximumSkillsPerRoot ?? DEFAULT_BOUNDS.maximum_skills_per_root,
    maximum_metadata_bytes: options.maximumMetadataBytes ?? DEFAULT_BOUNDS.maximum_metadata_bytes,
  };
  const selectedRoots = [...(options.roots ?? defaultRoots(options.homeRoot ?? homedir(), options.projectRoot))];
  const roots = selectedRoots.slice(0, bounds.maximum_hosts);
  const warnings: DiscoveryWarning[] = [];
  let truncated = selectedRoots.length > roots.length;
  if (truncated) warnings.push({ code: "ROOT_LIMIT", path_alias: "known-host-roots" });
  const installations: DiscoveryRecord[] = [];

  for (const root of roots) {
    let entries;
    try {
      const rootMetadata = await lstat(root.root);
      if (rootMetadata.isSymbolicLink()) {
        warnings.push({ code: "SYMLINK_SKIPPED", path_alias: `${root.source}:${root.install_scope}:skills-root` });
        continue;
      }
      entries = await readdir(root.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const selected = entries.sort((left, right) => left.name.localeCompare(right.name)).slice(0, bounds.maximum_skills_per_root);
    if (entries.length > selected.length) {
      truncated = true;
      warnings.push({ code: "SKILL_LIMIT", path_alias: `${root.source}:${root.install_scope}:skills-root` });
    }
    for (const entry of selected) {
      const fallbackId = SKILL_ID.test(entry.name) ? entry.name : `invalid-${digest(entry.name).slice(0, 12)}`;
      const pathAlias = `${root.source}:${root.install_scope}:${fallbackId}`;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        if (entry.isSymbolicLink()) warnings.push({ code: "SYMLINK_SKIPPED", path_alias: pathAlias });
        continue;
      }
      const metadataPath = join(root.root, entry.name, "SKILL.md");
      try {
        const metadata = await lstat(metadataPath);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          if (metadata.isSymbolicLink()) warnings.push({ code: "SYMLINK_SKIPPED", path_alias: pathAlias });
          continue;
        }
        const prefix = await readMetadataPrefix(metadataPath, bounds.maximum_metadata_bytes);
        const parsed = prefix.tooLarge ? null : parseSkillMetadata(prefix.text);
        const skillId = parsed?.name ?? fallbackId;
        const alias = `${root.source}:${root.install_scope}:${skillId}`;
        const valid = parsed !== null && parsed.name === entry.name;
        installations.push({
          source: root.source,
          skill_id: skillId,
          version: "unknown",
          install_scope: root.install_scope,
          path_alias: alias,
          digest: digest(parsed ? canonicalMetadata(parsed) : prefix.text),
          health: valid ? "healthy" : "degraded",
          shadowed_by: null,
        });
        if (!valid) warnings.push({ code: prefix.tooLarge ? "METADATA_TOO_LARGE" : "INVALID_METADATA", path_alias: alias });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  applyShadowing(installations);
  installations.sort((left, right) => left.source.localeCompare(right.source)
    || left.skill_id.localeCompare(right.skill_id)
    || rank(left.install_scope) - rank(right.install_scope)
    || left.path_alias.localeCompare(right.path_alias));
  return { schema_version: 1, installations, warnings, truncated, bounds };
}
