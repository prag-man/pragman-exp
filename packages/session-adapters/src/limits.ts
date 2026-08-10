import { isAbsolute, parse as parsePath } from "node:path";

import { SessionAdapterError, type SessionLimits, type SessionSelection } from "./types.ts";

export const DEFAULT_SESSION_LIMITS: Readonly<SessionLimits> = Object.freeze({
  maximum_file_bytes: 50 * 1024 * 1024,
  maximum_run_bytes: 500 * 1024 * 1024,
  maximum_events: 250_000,
  maximum_files: 10_000,
  maximum_excerpt_characters: 2_048,
  maximum_excerpts: 8,
});

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const CATEGORIES = new Set(["messages", "tools", "lifecycle"]);
const PRIVACY = new Set(["metadata-only", "safe", "deep"]);
const ADAPTERS = new Set(["codex", "claude-code", "cursor-markdown"]);

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function resolveSessionLimits(
  overrides: Partial<SessionLimits> = {},
): SessionLimits {
  const result = { ...DEFAULT_SESSION_LIMITS };
  for (const key of Object.keys(overrides) as Array<keyof SessionLimits>) {
    const value = overrides[key];
    if (!positiveInteger(value)) throw new SessionAdapterError("INVALID_LIMIT", "Session limits must be positive integers");
    if (value > DEFAULT_SESSION_LIMITS[key]) {
      throw new SessionAdapterError("LIMIT_OVERRIDE_UNSUPPORTED", "Raising a session limit is unavailable in v1; narrow the selected sources instead");
    }
    result[key] = value;
  }
  return result;
}

export function validateSessionSelection(selection: SessionSelection): void {
  const invalidTime = !UTC.test(selection.from) || !UTC.test(selection.through)
    || !Number.isFinite(Date.parse(selection.from)) || !Number.isFinite(Date.parse(selection.through))
    || Date.parse(selection.from) > Date.parse(selection.through);
  if (selection.sources.length === 0 || selection.project_aliases.length === 0
    || selection.content_categories.length === 0 || invalidTime || !PRIVACY.has(selection.privacy_depth)) {
    throw new SessionAdapterError("INVALID_SELECTION", "Select at least one source, project, category, privacy depth, and an inclusive UTC range");
  }
  if (selection.project_aliases.some((alias) => !SLUG.test(alias))
    || selection.content_categories.some((category) => !CATEGORIES.has(category))) {
    throw new SessionAdapterError("INVALID_SELECTION", "Selection aliases or content categories are invalid");
  }
  for (const source of selection.sources) {
    if (!ADAPTERS.has(source.adapter) || !SLUG.test(source.project_alias)) {
      throw new SessionAdapterError("INVALID_SELECTION", "Source adapter or project alias is invalid");
    }
    if (!selection.project_aliases.includes(source.project_alias)) {
      throw new SessionAdapterError("PROJECT_NOT_SELECTED", "Every source must belong to an explicitly selected project alias");
    }
    if (!isAbsolute(source.root) || source.root === parsePath(source.root).root) {
      throw new SessionAdapterError("UNSAFE_ROOT", "Session roots must be explicit absolute directories and cannot be a filesystem root");
    }
  }
  resolveSessionLimits(selection.limits);
}
