import { parseJsonl, recordAt, stringAt, textContent, type JsonlAdapterDefinition, type MappedRecord, type ParsedJsonLine } from "./jsonl.ts";
import type { ParseSessionOptions, ParsedSession } from "./types.ts";

function mapClaude(record: ParsedJsonLine): MappedRecord[] {
  const type = stringAt(record.value, "type");
  const timestamp = stringAt(record.value, "timestamp");
  if (type === "user") {
    return [{ event_type: "user-message", role: "user", timestamp, content: textContent(recordAt(record.value, "message")?.content) }];
  }
  if (type === "assistant") {
    const message = recordAt(record.value, "message");
    const content = message?.content;
    if (Array.isArray(content)) {
      const tools = content.flatMap((entry, index): MappedRecord[] => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
        const block = entry as Record<string, unknown>;
        return block.type === "tool_use" && typeof block.name === "string"
          ? [{ event_type: "tool-start", role: "tool", timestamp, tool_name: block.name, status: "started", sub_sequence: index }]
          : [];
      });
      if (tools.length > 0) return tools;
    }
    return [{ event_type: "assistant-message", role: "assistant", timestamp, content: textContent(content) }];
  }
  if (type === "tool_result" || type === "tool") {
    const result = recordAt(record.value, "toolUseResult") ?? recordAt(record.value, "message");
    const status = stringAt(result, "status");
    const failed = status === "error" || status === "failed" || record.value.is_error === true;
    return [{ event_type: failed ? "tool-error" : "tool-end", role: "tool", timestamp, tool_name: stringAt(record.value, "toolName") ?? "unknown-tool", status: failed ? "failed" : "succeeded" }];
  }
  if (type === "summary" || type === "compact") return [{ event_type: "compaction", timestamp }];
  if (type === "queue-operation" && stringAt(record.value, "operation") === "remove") return [{ event_type: "interruption", timestamp }];
  if (type === "system" && stringAt(record.value, "subtype") === "turn_duration") return [{ event_type: "task-boundary", timestamp }];
  return [];
}

const CLAUDE: JsonlAdapterDefinition = {
  source: "claude-code",
  tested_versions: ["1"],
  sessionIdentity(records) {
    for (const record of records) {
      const id = stringAt(record.value, "sessionId") ?? stringAt(record.value, "session_id");
      if (id) return id;
    }
    return undefined;
  },
  sourceVersion(records) {
    for (const record of records) {
      const version = stringAt(record.value, "version") ?? stringAt(record.value, "formatVersion");
      if (version) return version;
    }
    return undefined;
  },
  map: mapClaude,
};

export function parseClaudeJsonl(input: string, options: ParseSessionOptions): ParsedSession {
  return parseJsonl(input, options, CLAUDE);
}
