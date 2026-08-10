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
  code: "INVALID_METADATA" | "INVALID_MCP_METADATA" | "METADATA_TOO_LARGE" | "ROOT_LIMIT" | "SKILL_LIMIT" | "SYMLINK_SKIPPED" | "INVENTORY_LIMIT" | "ENVIRONMENT_LIMIT";
  path_alias: string;
}

export interface EnvironmentDiscovery {
  hosts: Array<{ host: DiscoveryRecord["source"]; detected: boolean; version: "unknown"; detection: "metadata-only" }>;
  plugins: Array<{ host: DiscoveryRecord["source"]; install_scope: InstallScope; plugin_id: string; version: "unknown"; path_alias: string }>;
  mcp_servers: Array<{ install_scope: InstallScope; server_id: string; path_alias: string }>;
  instruction_files: Array<{ install_scope: InstallScope; kind: "agents" | "claude" | "cursor-rule"; path_alias: string }>;
  repositories: Array<{ path_alias: "selected-project"; selected: true }>;
}

export interface DiscoveryReport {
  schema_version: 1;
  installations: DiscoveryRecord[];
  environment: EnvironmentDiscovery;
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
  maximumInventoryEntries?: number;
  maximumInventoryBytes?: number;
}

const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_BOUNDS = Object.freeze({
  maximum_hosts: 8,
  maximum_skills_per_root: 256,
  maximum_metadata_bytes: 32_768,
});
const DEFAULT_INVENTORY_BOUNDS = Object.freeze({ maximum_entries: 1_024, maximum_bytes: 8 * 1_024 * 1_024 });
const COLLECTION_NAMESPACES = new Map([
  ["compound-engineering", "compound-engineering"],
  ["gstack", "gstack"],
  ["superpowers", "superpowers"],
]);
const HOST_DIRECTORY: Record<DiscoveryRecord["source"], string[]> = {
  codex: [".agents", ".codex"],
  "claude-code": [".claude"],
  cursor: [".cursor"],
};
const MAX_ENVIRONMENT_ENTRIES = 256;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface SkillCandidate {
  directory: string;
  entryName: string;
  namespace: string | null;
}

interface InventoryResult {
  digest: string;
  safe: boolean;
  warning: "SYMLINK_SKIPPED" | "INVENTORY_LIMIT" | null;
}

async function readBoundedFile(path: string, maximumBytes: number): Promise<Buffer | null> {
  const handle = await open(path, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maximumBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1_024, maximumBytes - total + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) return Buffer.concat(chunks, total);
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function hashSkillInventory(directory: string, maximumEntries: number, maximumBytes: number): Promise<InventoryResult> {
  const pending = [{ absolute: directory, relative: "" }];
  const files: Array<{ absolute: string; relative: string; size: number }> = [];
  let entriesSeen = 0;
  let bytesSeen = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = (await readdir(current.absolute, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > maximumEntries) return { digest: digest("inventory-limit"), safe: false, warning: "INVENTORY_LIMIT" };
      const absolute = join(current.absolute, entry.name);
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) return { digest: digest("inventory-symlink"), safe: false, warning: "SYMLINK_SKIPPED" };
      if (metadata.isDirectory()) {
        pending.push({ absolute, relative });
        continue;
      }
      if (!metadata.isFile()) continue;
      bytesSeen += metadata.size;
      if (bytesSeen > maximumBytes) return { digest: digest("inventory-limit"), safe: false, warning: "INVENTORY_LIMIT" };
      files.push({ absolute, relative, size: metadata.size });
    }
  }
  files.sort((left, right) => left.relative.localeCompare(right.relative));
  const hash = createHash("sha256");
  for (const file of files) {
    const contents = await readBoundedFile(file.absolute, Math.min(file.size, maximumBytes));
    if (contents === null || contents.length !== file.size) return { digest: digest("inventory-limit"), safe: false, warning: "INVENTORY_LIMIT" };
    hash.update(`${Buffer.byteLength(file.relative, "utf8")}:`);
    hash.update(file.relative);
    hash.update(`${contents.length}:`);
    hash.update(contents);
  }
  return { digest: hash.digest("hex"), safe: true, warning: null };
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

function safeMetadataId(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return SKILL_ID.test(normalized) ? normalized : `metadata-${digest(value).slice(0, 12)}`;
}

async function isSafeDirectory(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function collectDirectoryNames(
  path: string,
  alias: string,
  warnings: DiscoveryWarning[],
): Promise<string[]> {
  if (!await isSafeDirectory(path)) return [];
  const result: string[] = [];
  const entries = (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries.slice(0, MAX_ENVIRONMENT_ENTRIES)) {
    const entryAlias = `${alias}:${safeMetadataId(entry.name)}`;
    if (entry.isSymbolicLink()) {
      warnings.push({ code: "SYMLINK_SKIPPED", path_alias: entryAlias });
      continue;
    }
    if (entry.isDirectory()) result.push(safeMetadataId(entry.name));
  }
  if (entries.length > MAX_ENVIRONMENT_ENTRIES) warnings.push({ code: "ENVIRONMENT_LIMIT", path_alias: alias });
  return result;
}

async function hasSafeFile(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function mcpNames(path: string, alias: string, warnings: DiscoveryWarning[]): Promise<string[]> {
  if (!await hasSafeFile(path)) return [];
  try {
    const bytes = await readBoundedFile(path, DEFAULT_BOUNDS.maximum_metadata_bytes);
    if (bytes === null) {
      warnings.push({ code: "METADATA_TOO_LARGE", path_alias: alias });
      return [];
    }
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    const record = value as Record<string, unknown>;
    const servers = record.mcpServers ?? record.servers;
    if (servers === null || typeof servers !== "object" || Array.isArray(servers)) throw new Error("invalid");
    return Object.keys(servers as Record<string, unknown>).slice(0, MAX_ENVIRONMENT_ENTRIES).map(safeMetadataId).sort();
  } catch {
    warnings.push({ code: "INVALID_MCP_METADATA", path_alias: alias });
    return [];
  }
}

async function discoverEnvironment(homeRoot: string, projectRoot: string | undefined, warnings: DiscoveryWarning[]): Promise<EnvironmentDiscovery> {
  const hosts: EnvironmentDiscovery["hosts"] = [];
  for (const host of ["codex", "claude-code", "cursor"] as const) {
    const detected = (await Promise.all(HOST_DIRECTORY[host].map((directory) => isSafeDirectory(join(homeRoot, directory))))).some(Boolean);
    hosts.push({ host, detected, version: "unknown", detection: "metadata-only" });
  }
  const plugins: EnvironmentDiscovery["plugins"] = [];
  for (const [host, directory] of [["codex", ".codex"], ["claude-code", ".claude"], ["cursor", ".cursor"]] as const) {
    const roots: Array<{ scope: InstallScope; path: string }> = [{ scope: "user", path: join(homeRoot, directory, "plugins") }];
    if (projectRoot) roots.push({ scope: "project", path: join(projectRoot, directory, "plugins") });
    for (const root of roots) {
      const ids = await collectDirectoryNames(root.path, `${host}:${root.scope}:plugins`, warnings);
      for (const pluginId of ids) plugins.push({ host, install_scope: root.scope, plugin_id: pluginId, version: "unknown", path_alias: `${host}:${root.scope}:plugin:${pluginId}` });
    }
  }
  const mcpServers: EnvironmentDiscovery["mcp_servers"] = [];
  if (projectRoot) {
    for (const [relative, alias] of [[".mcp.json", "project:mcp"], [".cursor/mcp.json", "cursor:project:mcp"], [".claude/mcp.json", "claude-code:project:mcp"], [".codex/mcp.json", "codex:project:mcp"]] as const) {
      for (const serverId of await mcpNames(join(projectRoot, relative), alias, warnings)) {
        mcpServers.push({ install_scope: "project", server_id: serverId, path_alias: `mcp:project:${serverId}` });
      }
    }
  }
  const instructionFiles: EnvironmentDiscovery["instruction_files"] = [];
  const candidates: Array<{ path: string; scope: InstallScope; kind: "agents" | "claude"; alias: string }> = [
    { path: join(homeRoot, "AGENTS.md"), scope: "user", kind: "agents", alias: "user:agents-md" },
    { path: join(homeRoot, "CLAUDE.md"), scope: "user", kind: "claude", alias: "user:claude-md" },
  ];
  if (projectRoot) candidates.push(
    { path: join(projectRoot, "AGENTS.md"), scope: "project", kind: "agents", alias: "project:agents-md" },
    { path: join(projectRoot, "CLAUDE.md"), scope: "project", kind: "claude", alias: "project:claude-md" },
  );
  for (const candidate of candidates) if (await hasSafeFile(candidate.path)) {
    instructionFiles.push({ install_scope: candidate.scope, kind: candidate.kind, path_alias: candidate.alias });
  }
  if (projectRoot) {
    const cursorRules = join(projectRoot, ".cursor", "rules");
    if (await isSafeDirectory(cursorRules)) {
      const entries = (await readdir(cursorRules, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries.slice(0, MAX_ENVIRONMENT_ENTRIES)) {
        if (entry.isFile() && !entry.isSymbolicLink()) instructionFiles.push({
          install_scope: "project", kind: "cursor-rule", path_alias: `cursor:project:rule:${safeMetadataId(entry.name)}`,
        });
      }
      if (entries.length > MAX_ENVIRONMENT_ENTRIES) warnings.push({ code: "ENVIRONMENT_LIMIT", path_alias: "cursor:project:rules" });
    }
  }
  plugins.sort((left, right) => left.path_alias.localeCompare(right.path_alias));
  mcpServers.sort((left, right) => left.path_alias.localeCompare(right.path_alias));
  instructionFiles.sort((left, right) => left.path_alias.localeCompare(right.path_alias));
  return {
    hosts,
    plugins,
    mcp_servers: mcpServers,
    instruction_files: instructionFiles,
    repositories: projectRoot ? [{ path_alias: "selected-project", selected: true }] : [],
  };
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

function candidateIdentity(candidate: SkillCandidate, name: string): string {
  return candidate.namespace ? `${candidate.namespace}:${name}` : name;
}

async function collectSkillCandidates(
  root: DiscoveryRoot,
  maximumSkills: number,
  warnings: DiscoveryWarning[],
): Promise<{ candidates: SkillCandidate[]; truncated: boolean }> {
  const entries = (await readdir(root.root, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  const candidates: SkillCandidate[] = [];
  let truncated = false;
  const add = (candidate: SkillCandidate): boolean => {
    if (candidates.length >= maximumSkills) {
      truncated = true;
      return false;
    }
    candidates.push(candidate);
    return true;
  };
  const selected = entries.slice(0, maximumSkills);
  if (entries.length > selected.length) truncated = true;
  for (const entry of selected) {
    const fallback = SKILL_ID.test(entry.name) ? entry.name : `invalid-${digest(entry.name).slice(0, 12)}`;
    if (entry.isSymbolicLink()) {
      warnings.push({ code: "SYMLINK_SKIPPED", path_alias: `${root.source}:${root.install_scope}:${fallback}` });
      continue;
    }
    if (!entry.isDirectory()) continue;
    const directory = join(root.root, entry.name);
    if (!add({ directory, entryName: entry.name, namespace: null })) break;
    const namespace = COLLECTION_NAMESPACES.get(entry.name);
    if (!namespace) continue;
    const nested = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const child of nested) {
      const childFallback = SKILL_ID.test(child.name) ? child.name : `invalid-${digest(child.name).slice(0, 12)}`;
      const alias = `${root.source}:${root.install_scope}:${namespace}:${childFallback}`;
      if (child.isSymbolicLink()) {
        warnings.push({ code: "SYMLINK_SKIPPED", path_alias: alias });
        continue;
      }
      if (!child.isDirectory()) continue;
      if (!add({ directory: join(directory, child.name), entryName: child.name, namespace })) break;
    }
  }
  if (truncated) warnings.push({ code: "SKILL_LIMIT", path_alias: `${root.source}:${root.install_scope}:skills-root` });
  return { candidates, truncated };
}

export async function discoverKnownHosts(options: DiscoveryOptions = {}): Promise<DiscoveryReport> {
  const bounds = {
    maximum_hosts: options.maximumHosts ?? DEFAULT_BOUNDS.maximum_hosts,
    maximum_skills_per_root: options.maximumSkillsPerRoot ?? DEFAULT_BOUNDS.maximum_skills_per_root,
    maximum_metadata_bytes: options.maximumMetadataBytes ?? DEFAULT_BOUNDS.maximum_metadata_bytes,
  };
  const selectedHomeRoot = options.homeRoot ?? homedir();
  const selectedRoots = [...(options.roots ?? defaultRoots(selectedHomeRoot, options.projectRoot))];
  const roots = selectedRoots.slice(0, bounds.maximum_hosts);
  const warnings: DiscoveryWarning[] = [];
  const inventoryBounds = {
    maximum_entries: options.maximumInventoryEntries ?? DEFAULT_INVENTORY_BOUNDS.maximum_entries,
    maximum_bytes: options.maximumInventoryBytes ?? DEFAULT_INVENTORY_BOUNDS.maximum_bytes,
  };
  let truncated = selectedRoots.length > roots.length;
  if (truncated) warnings.push({ code: "ROOT_LIMIT", path_alias: "known-host-roots" });
  const installations: DiscoveryRecord[] = [];

  for (const root of roots) {
    try {
      const rootMetadata = await lstat(root.root);
      if (rootMetadata.isSymbolicLink()) {
        warnings.push({ code: "SYMLINK_SKIPPED", path_alias: `${root.source}:${root.install_scope}:skills-root` });
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const collected = await collectSkillCandidates(root, bounds.maximum_skills_per_root, warnings);
    if (collected.truncated) truncated = true;
    for (const candidate of collected.candidates) {
      const fallbackId = SKILL_ID.test(candidate.entryName) ? candidate.entryName : `invalid-${digest(candidate.entryName).slice(0, 12)}`;
      const fallbackIdentity = candidateIdentity(candidate, fallbackId);
      const pathAlias = `${root.source}:${root.install_scope}:${fallbackIdentity}`;
      const metadataPath = join(candidate.directory, "SKILL.md");
      try {
        const metadata = await lstat(metadataPath);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          if (metadata.isSymbolicLink()) warnings.push({ code: "SYMLINK_SKIPPED", path_alias: pathAlias });
          continue;
        }
        const prefix = await readMetadataPrefix(metadataPath, bounds.maximum_metadata_bytes);
        const parsed = prefix.tooLarge ? null : parseSkillMetadata(prefix.text);
        const skillId = candidateIdentity(candidate, parsed?.name ?? fallbackId);
        const alias = `${root.source}:${root.install_scope}:${skillId}`;
        const valid = parsed !== null && parsed.name === candidate.entryName;
        const inventory = await hashSkillInventory(candidate.directory, inventoryBounds.maximum_entries, inventoryBounds.maximum_bytes);
        if (!inventory.safe && inventory.warning) {
          warnings.push({ code: inventory.warning, path_alias: alias });
          if (inventory.warning === "INVENTORY_LIMIT") truncated = true;
        }
        installations.push({
          source: root.source,
          skill_id: skillId,
          version: "unknown",
          install_scope: root.install_scope,
          path_alias: alias,
          digest: inventory.digest,
          health: valid && inventory.safe ? "healthy" : "degraded",
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
  const environment = await discoverEnvironment(selectedHomeRoot, options.projectRoot, warnings);
  return { schema_version: 1, installations, environment, warnings, truncated, bounds };
}
