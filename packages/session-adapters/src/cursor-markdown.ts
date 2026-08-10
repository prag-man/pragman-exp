import { redactText, sanitizeTranscriptExcerpt } from "../../redaction/src/index.ts";
import { DEFAULT_SESSION_LIMITS } from "./limits.ts";
import { canonicalUtc, metricsFor, sha256, validateParseOptions } from "./jsonl.ts";
import type { NormalizedSessionEvent, ParseSessionOptions, ParsedSession, RedactedSessionExcerpt, SessionEventType } from "./types.ts";

interface Section { heading: string; body: string; line: number }

function frontmatter(input: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(input);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator > 0) result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return result;
}

function sections(input: string): Section[] {
  const lines = input.split(/\r?\n/);
  const result: Section[] = [];
  let active: { heading: string; line: number; body: string[] } | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^##\s+(.+?)\s*$/.exec(lines[index]!);
    if (match) {
      if (active) result.push({ heading: active.heading, body: active.body.join("\n").trim(), line: active.line });
      active = { heading: match[1]!, line: index + 1, body: [] };
    } else if (active) active.body.push(lines[index]!);
  }
  if (active) result.push({ heading: active.heading, body: active.body.join("\n").trim(), line: active.line });
  return result;
}

function headingSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
  return slug || "unknown";
}

export function parseCursorMarkdown(input: string, options: ParseSessionOptions): ParsedSession {
  validateParseOptions(options);
  const limits = options.limits ?? DEFAULT_SESSION_LIMITS;
  const metadata = frontmatter(input);
  const version = options.format_version ?? metadata.format_version ?? "1";
  if (version !== "1" && options.best_effort !== true) {
    const quarantine = [{ code: "UNSUPPORTED_FORMAT" as const, source_alias: options.source_alias }];
    return { source_alias: options.source_alias, project_alias: options.project_alias, source: "cursor-markdown", format_version: version, events: [], excerpts: [], quarantine, metrics: metricsFor([]), fatal: true, best_effort: false };
  }
  const baseTimestamp = canonicalUtc(metadata.exported_at, options.selection.from);
  const sessionId = sha256(`cursor-markdown\0${options.source_alias}\0${metadata.session ?? options.source_alias}`);
  const sourceHash = sha256(input);
  const candidates: Array<{ type: SessionEventType; body?: string; line: number; unsupported?: Record<string, unknown>; role?: "user" | "assistant"; status?: "started" | "unsupported" }> = [
    { type: "session-start", line: 1, status: "started" },
  ];
  for (const section of sections(input)) {
    const slug = headingSlug(section.heading);
    if (slug === "user") candidates.push({ type: "user-message", role: "user", body: section.body, line: section.line });
    else if (slug === "assistant") candidates.push({ type: "assistant-message", role: "assistant", body: section.body, line: section.line });
    else if (slug === "compaction") candidates.push({ type: "compaction", line: section.line });
    else if (slug === "interruption") candidates.push({ type: "interruption", line: section.line });
    else candidates.push({ type: "unsupported", status: "unsupported", line: section.line, unsupported: { reason_code: "UNSUPPORTED_SECTION", shape: slug } });
  }
  const from = Date.parse(options.selection.from);
  const through = Date.parse(options.selection.through);
  const events: NormalizedSessionEvent[] = [];
  const excerpts: RedactedSessionExcerpt[] = [];
  for (let index = 0; index < candidates.length && events.length < limits.maximum_events; index += 1) {
    const candidate = candidates[index]!;
    const timestamp = new Date(Date.parse(baseTimestamp) + index).toISOString();
    if (Date.parse(timestamp) < from || Date.parse(timestamp) > through) continue;
    const category = candidate.type.includes("message") ? "messages" : "lifecycle";
    if (!options.selection.content_categories.includes(category)) continue;
    let excerpt: RedactedSessionExcerpt | undefined;
    if (candidate.body && options.selection.privacy_depth !== "metadata-only" && excerpts.length < limits.maximum_excerpts) {
      const safe = sanitizeTranscriptExcerpt(redactText(candidate.body).slice(0, limits.maximum_excerpt_characters), options.source_alias);
      excerpt = { ...safe, content_ref: `memory-redacted:${sha256(safe.content)}`, sensitivity: "confidential" };
      excerpts.push(excerpt);
    }
    const sequence = index;
    events.push({
      schema_version: 1,
      event_id: sha256(`${options.source_alias}\0${sessionId}\0${sequence}\0${candidate.type}`),
      session_id: sessionId,
      source: "cursor-markdown",
      source_version: version,
      source_alias: options.source_alias,
      sequence,
      timestamp,
      event_type: candidate.type,
      sensitivity: "confidential",
      provenance: { source_alias: options.source_alias, source_hash: sourceHash, locator: `section-${index}`, observed_at: timestamp, inferred_task: true },
      ...(candidate.role ? { role: candidate.role } : {}),
      ...(candidate.status ? { status: candidate.status } : {}),
      ...(candidate.unsupported ? { unsupported: candidate.unsupported } : {}),
      ...(excerpt ? { content_ref: excerpt.content_ref } : {}),
    });
  }
  const quarantine = events.filter((event) => event.event_type === "unsupported")
    .map((event) => ({
      code: "UNSUPPORTED_EVENT" as const,
      source_alias: options.source_alias,
      ...(event.provenance.locator ? { locator: event.provenance.locator } : {}),
    }));
  return { source_alias: options.source_alias, project_alias: options.project_alias, source: "cursor-markdown", format_version: version, events, excerpts, quarantine, metrics: metricsFor(events), fatal: false, best_effort: version !== "1" };
}
