import { parseJsonl, recordAt, stringAt, textContent, type JsonlAdapterDefinition, type MappedRecord, type ParsedJsonLine } from "./jsonl.ts";
import type { ParseSessionOptions, ParsedSession } from "./types.ts";

function payload(record: ParsedJsonLine): Record<string, unknown> {
  return recordAt(record.value, "payload") ?? {};
}

function mapCodex(record: ParsedJsonLine): MappedRecord[] {
  const type = stringAt(record.value, "type");
  const value = payload(record);
  const timestamp = stringAt(record.value, "timestamp") ?? stringAt(value, "timestamp");
  if (type === "session_meta") return [{ event_type: "session-start", timestamp, status: "started" }];
  if (type === "response_item") {
    const itemType = stringAt(value, "type");
    if (itemType === "message") {
      const role = stringAt(value, "role");
      if (role === "user" || role === "assistant" || role === "system") {
        return [{ event_type: role === "user" ? "user-message" : "assistant-message", role, timestamp, content: textContent(value.content) }];
      }
    }
    if (itemType === "function_call" || itemType === "custom_tool_call") {
      return [{ event_type: "tool-start", role: "tool", timestamp, tool_name: stringAt(value, "name") ?? "unknown-tool", status: "started" }];
    }
    if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
      const output = stringAt(value, "output");
      const failed = output !== undefined && /(?:^|\b)(?:error|failed|failure)(?:\b|:)/i.test(output);
      return [{ event_type: failed ? "tool-error" : "tool-end", role: "tool", timestamp, tool_name: "unknown-tool", status: failed ? "failed" : "succeeded" }];
    }
  }
  if (type === "event_msg") {
    const eventType = stringAt(value, "type");
    if (eventType === "context_compacted" || eventType === "compaction") return [{ event_type: "compaction", timestamp }];
    if (eventType === "turn_aborted" || eventType === "interrupted") return [{ event_type: "interruption", timestamp, status: "cancelled" }];
    if (eventType === "approval_request" || eventType === "approval") return [{ event_type: "approval", timestamp }];
    if (eventType === "task_boundary") return [{ event_type: "task-boundary", timestamp, task_id: stringAt(value, "task_id") }];
    if (eventType === "handoff") return [{ event_type: "handoff", timestamp }];
    if (eventType === "session_end") return [{ event_type: "session-end", timestamp, status: "succeeded" }];
  }
  return [];
}

const CODEX: JsonlAdapterDefinition = {
  source: "codex",
  tested_versions: ["1"],
  sessionIdentity(records) {
    const meta = records.find((record) => stringAt(record.value, "type") === "session_meta");
    return meta ? stringAt(meta.value, "payload", "id") : undefined;
  },
  sourceVersion(records) {
    const meta = records.find((record) => stringAt(record.value, "type") === "session_meta");
    return meta ? stringAt(meta.value, "payload", "version") : undefined;
  },
  map: mapCodex,
};

export function parseCodexJsonl(input: string, options: ParseSessionOptions): ParsedSession {
  return parseJsonl(input, options, CODEX);
}
