import { createHash } from "node:crypto";

import { redactText, sanitizeTranscriptExcerpt } from "../../redaction/src/index.ts";
import {
  SessionAdapterError,
  type NormalizedSessionEvent, type ParseSessionOptions, type ParsedSession, type RedactedSessionExcerpt,
  type SessionAdapterId, type SessionEventType, type SessionIssue, type SessionMetrics,
} from "./types.ts";
import { DEFAULT_SESSION_LIMITS } from "./limits.ts";

export interface ParsedJsonLine {
  line: number;
  value: Record<string, unknown>;
}

export interface MappedRecord {
  event_type: SessionEventType;
  timestamp?: string | undefined;
  role?: NormalizedSessionEvent["role"];
  tool_name?: string | undefined;
  status?: NormalizedSessionEvent["status"];
  task_id?: string | undefined;
  duration_ms?: number;
  content?: string | undefined;
  unsupported?: Record<string, unknown>;
  sub_sequence?: number;
}

export interface JsonlAdapterDefinition {
  source: Exclude<SessionAdapterId, "cursor-markdown">;
  tested_versions: readonly string[];
  sessionIdentity(records: readonly ParsedJsonLine[]): string | undefined;
  sourceVersion(records: readonly ParsedJsonLine[]): string | undefined;
  map(record: ParsedJsonLine): MappedRecord[];
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const SOURCE_ALIAS = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateParseOptions(options: ParseSessionOptions): void {
  if (!SOURCE_ALIAS.test(options.source_alias) || !SOURCE_ALIAS.test(options.project_alias)) {
    throw new SessionAdapterError("INVALID_SOURCE_ALIAS", "Session source and project aliases must be canonical slugs");
  }
}

export function emptyMetrics(): SessionMetrics {
  return {
    event_count: 0, message_count: 0, tool_count: 0, tool_error_count: 0,
    compaction_count: 0, interruption_count: 0, unsupported_count: 0,
  };
}

export function metricsFor(events: readonly NormalizedSessionEvent[]): SessionMetrics {
  const metrics = emptyMetrics();
  metrics.event_count = events.length;
  for (const event of events) {
    if (event.event_type === "user-message" || event.event_type === "assistant-message") metrics.message_count += 1;
    if (event.event_type === "tool-start") metrics.tool_count += 1;
    if (event.event_type === "tool-error") metrics.tool_error_count += 1;
    if (event.event_type === "compaction") metrics.compaction_count += 1;
    if (event.event_type === "interruption") metrics.interruption_count += 1;
    if (event.event_type === "unsupported") metrics.unsupported_count += 1;
  }
  return metrics;
}

export function canonicalUtc(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return fallback;
  return new Date(value).toISOString();
}

function categoryFor(type: SessionEventType): "messages" | "tools" | "lifecycle" {
  if (type === "user-message" || type === "assistant-message") return "messages";
  if (type === "tool-start" || type === "tool-end" || type === "tool-error") return "tools";
  return "lifecycle";
}

function canonicalToolName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().slice(0, 128);
  return cleaned.length > 0 ? cleaned : undefined;
}

function createExcerpt(
  content: string,
  sourceAlias: string,
  maximumCharacters: number,
): RedactedSessionExcerpt {
  const safe = sanitizeTranscriptExcerpt(content.slice(0, maximumCharacters), sourceAlias);
  const contentRef = `memory-redacted:${sha256(safe.content)}`;
  return Object.freeze({ ...safe, content_ref: contentRef, sensitivity: "confidential" as const });
}

export function parseJsonl(
  input: string,
  options: ParseSessionOptions,
  adapter: JsonlAdapterDefinition,
): ParsedSession {
  validateParseOptions(options);
  const limits = options.limits ?? DEFAULT_SESSION_LIMITS;
  if (Buffer.byteLength(input, "utf8") > limits.maximum_file_bytes) {
    const quarantine = [{ code: "FILE_TOO_LARGE" as const, source_alias: options.source_alias }];
    return {
      source_alias: options.source_alias,
      project_alias: options.project_alias,
      source: adapter.source,
      format_version: options.format_version ?? "1",
      events: [],
      excerpts: [],
      quarantine,
      metrics: emptyMetrics(),
      fatal: true,
      best_effort: false,
    };
  }
  const records: ParsedJsonLine[] = [];
  const quarantine: SessionIssue[] = [];
  const lines = input.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("record");
      records.push({ line: index + 1, value: value as Record<string, unknown> });
    } catch {
      quarantine.push({ code: "CORRUPT_RECORD", source_alias: options.source_alias, locator: `line-${index + 1}` });
    }
  }

  const sourceVersion = options.format_version ?? adapter.sourceVersion(records) ?? "1";
  const supported = adapter.tested_versions.includes(sourceVersion);
  if (!supported && options.best_effort !== true) {
    quarantine.push({ code: "UNSUPPORTED_FORMAT", source_alias: options.source_alias });
    return {
      source_alias: options.source_alias, project_alias: options.project_alias, source: adapter.source,
      format_version: sourceVersion, events: [], excerpts: [], quarantine, metrics: emptyMetrics(),
      fatal: true, best_effort: false,
    };
  }

  const rawIdentity = adapter.sessionIdentity(records) ?? options.source_alias;
  const sessionId = sha256(`${adapter.source}\0${options.source_alias}\0${rawIdentity}`);
  const sourceHash = sha256(input);
  const events: NormalizedSessionEvent[] = [];
  const excerpts: RedactedSessionExcerpt[] = [];
  const from = Date.parse(options.selection.from);
  const through = Date.parse(options.selection.through);
  let eventLimitReached = false;

  for (const record of records) {
    const mapped = adapter.map(record);
    if (mapped.length === 0) {
      quarantine.push({ code: "UNSUPPORTED_EVENT", source_alias: options.source_alias, locator: `line-${record.line}` });
      mapped.push({ event_type: "unsupported", status: "unsupported", unsupported: { reason_code: "UNSUPPORTED_EVENT", shape: "unknown" } });
    }
    for (const item of mapped) {
      if (events.length >= limits.maximum_events) {
        if (!eventLimitReached) quarantine.push({ code: "EVENT_LIMIT", source_alias: options.source_alias });
        eventLimitReached = true;
        break;
      }
      const timestamp = canonicalUtc(item.timestamp, options.selection.from);
      if (Date.parse(timestamp) < from || Date.parse(timestamp) > through) continue;
      if (!options.selection.content_categories.includes(categoryFor(item.event_type))) continue;
      const sequence = (record.line - 1) * 100 + (item.sub_sequence ?? 0);
      const redacted = item.content ? redactText(item.content) : undefined;
      const canExcerpt = redacted !== undefined && options.selection.privacy_depth !== "metadata-only"
        && excerpts.length < limits.maximum_excerpts;
      const excerpt = canExcerpt ? createExcerpt(redacted, options.source_alias, limits.maximum_excerpt_characters) : undefined;
      if (excerpt) excerpts.push(excerpt);
      const base = {
        schema_version: 1 as const,
        event_id: sha256(`${options.source_alias}\0${sessionId}\0${sequence}\0${item.event_type}`),
        session_id: sessionId,
        source: adapter.source,
        source_version: sourceVersion,
        source_alias: options.source_alias,
        sequence,
        timestamp,
        event_type: item.event_type,
        sensitivity: "confidential" as const,
        provenance: {
          source_alias: options.source_alias,
          source_hash: sourceHash,
          locator: `line-${record.line}`,
          observed_at: timestamp,
          inferred_task: item.task_id === undefined,
        },
      };
      const event: NormalizedSessionEvent = {
        ...base,
        ...(item.role === undefined ? {} : { role: item.role }),
        ...(canonicalToolName(item.tool_name) === undefined ? {} : { tool_name: canonicalToolName(item.tool_name)! }),
        ...(item.status === undefined ? {} : { status: item.status }),
        ...(item.task_id === undefined ? {} : { task_id: sha256(`${sessionId}\0${item.task_id}`) }),
        ...(item.duration_ms === undefined ? {} : { duration_ms: Math.max(0, Math.trunc(item.duration_ms)) }),
        ...(excerpt === undefined ? {} : { content_ref: excerpt.content_ref }),
        ...(item.unsupported === undefined ? {} : { unsupported: item.unsupported }),
      };
      events.push(event);
    }
    if (eventLimitReached) break;
  }

  return {
    source_alias: options.source_alias, project_alias: options.project_alias, source: adapter.source,
    format_version: sourceVersion, events, excerpts, quarantine, metrics: metricsFor(events),
    fatal: events.length === 0 && quarantine.some((issue) => issue.code === "CORRUPT_RECORD" || issue.code === "UNSUPPORTED_FORMAT"),
    best_effort: !supported,
  };
}

export function stringAt(value: unknown, ...path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : undefined;
}

export function recordAt(value: unknown, ...path: string[]): Record<string, unknown> | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current !== null && typeof current === "object" && !Array.isArray(current)
    ? current as Record<string, unknown> : undefined;
}

export function textContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    return typeof record.text === "string" ? [record.text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}
