import compatibility from "../compatibility.json" with { type: "json" };
import { ConcreteHostAdapter, type CreateHostAdapterOptions } from "../base.ts";

export function createCursorHostAdapter(options: CreateHostAdapterOptions): ConcreteHostAdapter {
  return new ConcreteHostAdapter("cursor", options.host_version, options.runtime, compatibility.adapters.cursor, options);
}
