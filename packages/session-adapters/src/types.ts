export type SessionAdapterId = "codex" | "claude-code" | "cursor-markdown";
export type SessionPrivacyDepth = "metadata-only" | "safe" | "deep";
export type SessionContentCategory = "messages" | "tools" | "lifecycle";
export type SessionEventType =
  | "session-start" | "session-end" | "user-message" | "assistant-message"
  | "tool-start" | "tool-end" | "tool-error" | "approval" | "compaction"
  | "interruption" | "handoff" | "task-boundary" | "unsupported";
export type Sensitivity = "public" | "internal" | "confidential" | "restricted";

export interface SessionSourceSelection {
  adapter: SessionAdapterId;
  root: string;
  project_alias: string;
  format_version?: string;
  best_effort?: boolean;
}

export interface SessionLimits {
  maximum_file_bytes: number;
  maximum_run_bytes: number;
  maximum_events: number;
  maximum_files: number;
  maximum_excerpt_characters: number;
  maximum_excerpts: number;
}

export interface SessionSelection {
  sources: SessionSourceSelection[];
  from: string;
  through: string;
  project_aliases: string[];
  content_categories: SessionContentCategory[];
  privacy_depth: SessionPrivacyDepth;
  limits?: Partial<SessionLimits>;
  override_preview_approved?: boolean;
}

export interface SessionProvenance {
  source_alias: string;
  source_hash?: string;
  locator?: string;
  observed_at?: string;
  inferred_task?: boolean;
}

export interface NormalizedSessionEvent {
  schema_version: 1;
  event_id: string;
  session_id: string;
  source: SessionAdapterId;
  source_version: string;
  source_alias: string;
  sequence: number;
  timestamp: string;
  event_type: SessionEventType;
  sensitivity: Sensitivity;
  provenance: SessionProvenance;
  task_id?: string;
  role?: "user" | "assistant" | "system" | "tool";
  tool_name?: string;
  duration_ms?: number;
  status?: "started" | "succeeded" | "partial" | "failed" | "cancelled" | "unsupported";
  content_ref?: string;
  metrics?: Record<string, number>;
  unsupported?: Record<string, unknown>;
}

export interface RedactedSessionExcerpt {
  kind: "untrusted-transcript";
  source_alias: string;
  trusted: false;
  allow_instructions: false;
  content_ref: string;
  content: string;
  sensitivity: Sensitivity;
}

export type SessionIssueCode =
  | "CORRUPT_RECORD" | "UNSUPPORTED_EVENT" | "UNSUPPORTED_FORMAT"
  | "UNSUPPORTED_FILE" | "SYMLINK_SKIPPED" | "FILE_TOO_LARGE"
  | "RUN_TOO_LARGE" | "EVENT_LIMIT" | "FILE_LIMIT" | "IDENTITY_COLLISION"
  | "SOURCE_UNREADABLE";

export interface SessionIssue {
  code: SessionIssueCode;
  source_alias: string;
  locator?: string;
}

export interface SessionMetrics {
  event_count: number;
  message_count: number;
  tool_count: number;
  tool_error_count: number;
  compaction_count: number;
  interruption_count: number;
  unsupported_count: number;
}

export interface ParsedSession {
  source_alias: string;
  project_alias: string;
  source: SessionAdapterId;
  format_version: string;
  events: NormalizedSessionEvent[];
  excerpts: RedactedSessionExcerpt[];
  quarantine: SessionIssue[];
  metrics: SessionMetrics;
  fatal: boolean;
  best_effort: boolean;
}

export interface ParseSessionOptions {
  source_alias: string;
  project_alias: string;
  selection: Omit<SessionSelection, "sources" | "limits" | "override_preview_approved">;
  format_version?: string;
  best_effort?: boolean;
  limits?: SessionLimits;
}

export interface SessionScanReport {
  schema_version: 1;
  selection: {
    sources: SessionAdapterId[];
    from: string;
    through: string;
    project_aliases: string[];
    content_categories: SessionContentCategory[];
    privacy_depth: SessionPrivacyDepth;
  };
  sessions_selected: number;
  sessions_parsed: number;
  sessions_failed: number;
  failure_ratio: number;
  identity_collision: boolean;
  report_only: boolean;
  apply_allowed: boolean;
  events: NormalizedSessionEvent[];
  excerpts: RedactedSessionExcerpt[];
  quarantine: SessionIssue[];
  warnings: SessionIssue[];
  metrics: SessionMetrics;
  limits: SessionLimits;
}

export class SessionAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SessionAdapterError";
    this.code = code;
  }
}
