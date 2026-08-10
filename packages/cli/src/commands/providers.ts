import type { CliArguments } from "../args.ts";
import { errorEnvelope, EXIT_CODES, successEnvelope } from "../envelope.ts";
import type { CommandExecution } from "./events.ts";
import { loadRuntimeProviderRegistry } from "./provider-support.ts";

function failed(command: string, error: unknown): CommandExecution {
  const message = error instanceof Error ? error.message : "Provider registry is unavailable";
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "PROVIDER_REGISTRY_INVALID";
  const invalid = code === "INVALID_INPUT" || code === "PROVIDER_REGISTRY_INVALID";
  return { exitCode: invalid ? EXIT_CODES.invalid : EXIT_CODES.unavailable, envelope: errorEnvelope(command, code, message), human: message, stderr: true };
}

export async function executeProvidersCommand(arguments_: CliArguments): Promise<CommandExecution> {
  const command = arguments_.command;
  try {
    const { registry, warnings } = await loadRuntimeProviderRegistry(arguments_);
    if (command === "providers.inspect") {
      if (!arguments_.provider) return failed(command, Object.assign(new Error("--provider is required"), { code: "INVALID_INPUT" }));
      const provider = registry.getProvider(arguments_.provider);
      if (!provider) return failed(command, Object.assign(new Error("Provider was not found"), { code: "NOT_FOUND" }));
      const status = registry.getStatus(provider.id);
      const data = {
        id: provider.id, source: provider.source, source_version: provider.source_version, trust: provider.trust,
        capabilities: provider.capabilities, host_support: provider.host_support, invocation: provider.invoke.kind,
        context_policy: provider.context_policy, side_effects: provider.side_effects, workflow_weight: provider.workflow_weight,
        result_contract: provider.result_contract, health: status.health, reason: status.reason,
      };
      return { exitCode: EXIT_CODES.success, envelope: successEnvelope(command, data, warnings), human: `${provider.id}: ${status.health}.`, stderr: false };
    }
    const providers = registry.listProviders().map((provider) => {
      const status = registry.getStatus(provider.id);
      return { id: provider.id, source: provider.source, trust: provider.trust, capabilities: provider.capabilities, health: status.health, reason: status.reason, workflow_weight: provider.workflow_weight };
    });
    return { exitCode: EXIT_CODES.success, envelope: successEnvelope(command, { providers }, warnings), human: `${providers.length} providers available in the registry.`, stderr: false };
  } catch (error) {
    return failed(command, error);
  }
}
