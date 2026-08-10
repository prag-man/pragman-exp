import { readFile } from "node:fs/promises";
import { normalize } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { parse } from "yaml";

import personalSchema from "../schemas/personal-config.schema.json" with { type: "json" };
import projectSchema from "../schemas/project.schema.json" with { type: "json" };
import workspaceSchema from "../schemas/workspace.schema.json" with { type: "json" };
import { normalizeAbsolutePath, personalConfigPath, projectManifestPath, resolveContainedPath, workspaceConfigPath } from "./paths.ts";
import { ConfigError, type JsonObject, type LoadedConfigurationContext, type PersonalConfig, type ProjectManifest, type WorkspaceConfig } from "./types.ts";

const ajv = new Ajv2020({ allErrors: true, strict: true, useDefaults: false, removeAdditional: false, coerceTypes: false });
const validators = {
  personal: ajv.compile(personalSchema) as ValidateFunction<PersonalConfig>,
  workspace: ajv.compile(workspaceSchema) as ValidateFunction<WorkspaceConfig>,
  project: ajv.compile(projectSchema) as ValidateFunction<ProjectManifest>,
};

async function parseAndValidate<T extends JsonObject>(path: string, validator: ValidateFunction<T>, kind: string): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ConfigError("NOT_FOUND", `${kind} configuration was not found`);
    throw error;
  }
  let value: unknown;
  try {
    value = parse(raw, { uniqueKeys: true });
  } catch {
    throw new ConfigError("INVALID_CONFIGURATION", `${kind} configuration is not valid YAML`);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const version = (value as Record<string, unknown>).schema_version;
    if (typeof version === "number" && version > 1) {
      throw new ConfigError("INCOMPATIBLE_VERSION", `${kind} schema version ${version} is newer than supported version 1`, { supportedVersion: 1 });
    }
  }
  if (!validator(value)) {
    throw new ConfigError("INVALID_CONFIGURATION", `${kind} configuration failed schema validation`, {
      issues: (validator.errors ?? []).map((issue) => `${issue.instancePath || "/"} ${issue.message ?? "is invalid"}`),
    });
  }
  return value;
}

export async function loadPersonalConfig(personalRoot: string): Promise<PersonalConfig> {
  return parseAndValidate(personalConfigPath(personalRoot), validators.personal, "personal");
}

export async function loadWorkspaceConfig(personalRoot: string, workspaceId: string): Promise<WorkspaceConfig> {
  const config = await parseAndValidate(workspaceConfigPath(personalRoot, workspaceId), validators.workspace, "workspace");
  if (config.workspace_id !== workspaceId) {
    throw new ConfigError("INVALID_CONFIGURATION", "Workspace id does not match its registry path");
  }
  if (normalize(config.root) !== config.root) {
    throw new ConfigError("INVALID_CONFIGURATION", "Workspace root must be a normalized absolute path");
  }
  for (const source of config.context_sources) {
    if ((source.kind === "file" || source.kind === "directory") && !source.uri.includes("://")) {
      resolveContainedPath(config.root, source.uri);
    }
  }
  return config;
}

export async function loadProjectManifest(projectRoot: string): Promise<ProjectManifest> {
  const normalizedRoot = normalizeAbsolutePath(projectRoot);
  const config = await parseAndValidate(projectManifestPath(normalizedRoot), validators.project, "project");
  if (config.root !== normalizedRoot) {
    throw new ConfigError("INVALID_CONFIGURATION", "Project root does not match the selected project directory");
  }
  resolveContainedPath(normalizedRoot, config.context_index ?? ".pragman/context-index.yaml");
  return config;
}

export async function loadConfigurationContext(options: {
  personalRoot: string;
  workspaceId?: string;
  projectRoot?: string;
}): Promise<LoadedConfigurationContext> {
  const personalRoot = normalizeAbsolutePath(options.personalRoot);
  const personalPath = personalConfigPath(personalRoot);
  const personal = await loadPersonalConfig(personalRoot);
  if (options.projectRoot) {
    const projectRoot = normalizeAbsolutePath(options.projectRoot);
    const project = await loadProjectManifest(projectRoot);
    if (options.workspaceId && options.workspaceId !== project.workspace) {
      throw new ConfigError("WORKSPACE_MISMATCH", "Selected workspace does not match the project's linked primary workspace", {
        selected: options.workspaceId,
        linked: project.workspace,
      });
    }
    const primaryWorkspace = await loadWorkspaceConfig(personalRoot, project.workspace);
    const additionalIds = project.additional_workspaces ?? [];
    const additionalWorkspaces = await Promise.all(additionalIds.map((id) => loadWorkspaceConfig(personalRoot, id)));
    return {
      mode: "project-linked",
      personal,
      primaryWorkspace,
      project,
      additionalWorkspaces,
      paths: {
        personal: personalPath,
        primaryWorkspace: workspaceConfigPath(personalRoot, project.workspace),
        project: projectManifestPath(projectRoot),
        additionalWorkspaces: additionalIds.map((id) => workspaceConfigPath(personalRoot, id)),
      },
    };
  }
  if (options.workspaceId) {
    return {
      mode: "workspace-only",
      personal,
      primaryWorkspace: await loadWorkspaceConfig(personalRoot, options.workspaceId),
      additionalWorkspaces: [],
      paths: {
        personal: personalPath,
        primaryWorkspace: workspaceConfigPath(personalRoot, options.workspaceId),
        additionalWorkspaces: [],
      },
    };
  }
  return { mode: "personal-only", personal, additionalWorkspaces: [], paths: { personal: personalPath, additionalWorkspaces: [] } };
}
