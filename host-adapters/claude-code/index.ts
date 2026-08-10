import compatibility from "../compatibility.json" with { type: "json" };
import { ConcreteHostAdapter, type CreateHostAdapterOptions } from "../base.ts";

export function createClaudeCodeHostAdapter(options: CreateHostAdapterOptions): ConcreteHostAdapter {
  return new ConcreteHostAdapter("claude-code", options.host_version, options.runtime, compatibility.adapters["claude-code"]);
}
