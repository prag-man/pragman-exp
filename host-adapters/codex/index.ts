import compatibility from "../compatibility.json" with { type: "json" };
import { ConcreteHostAdapter, type CreateHostAdapterOptions } from "../base.ts";

export function createCodexHostAdapter(options: CreateHostAdapterOptions): ConcreteHostAdapter {
  return new ConcreteHostAdapter("codex", options.host_version, options.runtime, compatibility.adapters.codex);
}
