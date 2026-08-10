import { homedir } from "node:os";
import { join } from "node:path";

import {
  ConfigError,
  applyProviderOverridesChange,
  loadProviderOverrides,
  normalizeAbsolutePath,
  previewProviderOverridesChange,
  type ProviderOverrides,
  type ProviderTrustRecord,
} from "../../../config/src/index.ts";
import type { ProviderRegistry } from "../../../provider-registry/src/index.ts";
import type { CliArguments } from "../args.ts";
import { errorEnvelope, EXIT_CODES, successEnvelope } from "../envelope.ts";
import type { CommandExecution, CommandIo } from "./events.ts";
import { loadRuntimeProviderRegistry } from "./provider-support.ts";

export interface ProviderSettingsDependencies {
  loadRegistry(arguments_: CliArguments): Promise<ProviderRegistry>;
  now(): Date;
}

function defaultReviewTime(): Date {
  const current = new Date();
  return new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate()));
}

const defaults: ProviderSettingsDependencies = {
  loadRegistry: async (arguments_) => (await loadRuntimeProviderRegistry(arguments_)).registry,
  // Day precision keeps the independently re-run preview/apply command byte-stable.
  now: defaultReviewTime,
};

function execution(
  exitCode: number,
  envelope: ReturnType<typeof successEnvelope> | ReturnType<typeof errorEnvelope>,
  human: string,
  stderr = false,
): CommandExecution {
  return { exitCode, envelope, human, stderr };
}

function fail(command: string, error: unknown): CommandExecution {
  const code = error instanceof ConfigError
    ? error.code
    : typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "INTERNAL_ERROR";
  const message = error instanceof Error ? error.message : "Provider settings could not be updated";
  const details = error instanceof ConfigError ? error.details : null;
  const exitCode = code === "NEEDS_INPUT" || code === "PROVIDER_NOT_INSTALLED"
    ? EXIT_CODES.needsInput
    : code === "TRUST_ACKNOWLEDGEMENT_REQUIRED" || code === "PROVIDER_TRUST_DENIED" || code === "STALE_PREVIEW"
      ? EXIT_CODES.denied
      : code === "TEMPORARY_FAILURE"
        ? EXIT_CODES.temporary
        : code === "UNAVAILABLE"
          ? EXIT_CODES.unavailable
          : code === "INTERNAL_ERROR"
            ? EXIT_CODES.internal
            : EXIT_CODES.invalid;
  return execution(exitCode, errorEnvelope(command, code, message, details, code === "TEMPORARY_FAILURE"), message, true);
}

function personalRoot(arguments_: CliArguments): string {
  return normalizeAbsolutePath(arguments_.config ?? join(homedir(), ".pragman"));
}

function orderedUnique(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) if (!seen.has(value)) {
    seen.add(value);
    result.push(value);
  }
  return result;
}

function parseProviderIds(value: unknown): string[] {
  const selected = Array.isArray(value)
    ? value
    : value !== null && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).length === 1 && "prefer" in value
      ? (value as { prefer: unknown }).prefer
      : null;
  if (!Array.isArray(selected) || selected.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw Object.assign(new Error("Provider preference input must be an array or an object containing only prefer"), { code: "INVALID_INPUT" });
  }
  return orderedUnique(selected.map((entry) => String(entry).trim()));
}

async function preferredIds(arguments_: CliArguments, io: CommandIo): Promise<string[]> {
  if (arguments_.provider !== undefined) return parseProviderIds(arguments_.provider.split(","));
  const text = await io.readStdin();
  if (!text.trim()) throw Object.assign(new Error("Provider IDs are required through --provider or JSON input"), { code: "NEEDS_INPUT" });
  try {
    return parseProviderIds(JSON.parse(text) as unknown);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) throw error;
    throw Object.assign(new Error("Provider preference input must be valid JSON"), { code: "INVALID_INPUT" });
  }
}

function safePreview(preview: Awaited<ReturnType<typeof previewProviderOverridesChange>>) {
  return {
    mutated: false,
    target: "provider-overrides",
    base_digest: preview.record.base_digest,
    preview_digest: preview.record.preview_digest,
    approval_classes: ["local-config-write"],
    expires_at: null,
  };
}

async function prefer(
  arguments_: CliArguments,
  io: CommandIo,
  dependencies: ProviderSettingsDependencies,
): Promise<CommandExecution> {
  const command = "providers.prefer";
  const providers = await preferredIds(arguments_, io);
  const registry = await dependencies.loadRegistry(arguments_);
  const unknown = providers.filter((providerId) => registry.getProvider(providerId) === null);
  if (unknown.length > 0) {
    throw Object.assign(new Error(`Unknown provider${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`), {
      code: "UNKNOWN_PROVIDER",
    });
  }
  const root = personalRoot(arguments_);
  const current = await loadProviderOverrides(root);
  const next: ProviderOverrides = { ...current, prefer: providers };
  const preview = await previewProviderOverridesChange({
    personalRoot: root,
    next,
    reason: "Update ordered provider preferences",
    evidenceRefs: ["command:providers.prefer"],
    now: dependencies.now(),
  });
  const data = { ...safePreview(preview), prefer: providers };
  if (!arguments_.applyDigest) {
    return execution(EXIT_CODES.success, successEnvelope(command, data), `Preview provider preference update; apply digest ${preview.record.preview_digest}`);
  }
  await applyProviderOverridesChange(preview, arguments_.applyDigest, dependencies.now());
  return execution(EXIT_CODES.success, successEnvelope(command, { ...data, mutated: true }), `Updated ${providers.length} provider preferences`);
}

function trustRecord(
  registry: ProviderRegistry,
  providerId: string,
  reviewedAt: string,
): ProviderTrustRecord {
  const provider = registry.getProvider(providerId);
  if (!provider) throw Object.assign(new Error("Provider was not found"), { code: "UNKNOWN_PROVIDER" });
  const status = registry.getStatus(providerId);
  if (status.health === "conflict" || status.health === "quarantined" || status.health === "incompatible") {
    throw Object.assign(new Error(`Provider trust is blocked while health is ${status.health}`), { code: "PROVIDER_TRUST_DENIED" });
  }
  if (status.selected_digest === null) {
    throw Object.assign(new Error("Provider must have a selected installed digest before it can be trusted"), { code: "PROVIDER_NOT_INSTALLED" });
  }
  return {
    provider_id: provider.id,
    source: provider.source,
    source_version: provider.source_version,
    digest: status.selected_digest,
    reviewed_at: reviewedAt,
  };
}

async function trust(
  arguments_: CliArguments,
  dependencies: ProviderSettingsDependencies,
): Promise<CommandExecution> {
  const command = "providers.trust";
  if (!arguments_.provider) throw Object.assign(new Error("--provider is required"), { code: "NEEDS_INPUT" });
  if (arguments_.provider.includes(",")) throw Object.assign(new Error("Trust exactly one provider at a time"), { code: "INVALID_INPUT" });
  if (!arguments_.acknowledgeTrust) {
    throw Object.assign(new Error("Trust requires --acknowledge-trust after reviewing the selected provider"), {
      code: "TRUST_ACKNOWLEDGEMENT_REQUIRED",
    });
  }
  const reviewedAt = dependencies.now().toISOString();
  const registry = await dependencies.loadRegistry(arguments_);
  const selected = trustRecord(registry, arguments_.provider, reviewedAt);
  const root = personalRoot(arguments_);
  const current = await loadProviderOverrides(root);
  const existingIndex = current.trust.findIndex((record) => record.provider_id === selected.provider_id);
  const trust = [...current.trust];
  if (existingIndex < 0) trust.push(selected);
  else trust[existingIndex] = selected;
  const next: ProviderOverrides = { ...current, trust };
  const preview = await previewProviderOverridesChange({
    personalRoot: root,
    next,
    reason: `Trust reviewed provider ${selected.provider_id}`,
    evidenceRefs: [`provider:${selected.provider_id}`, `digest:${selected.digest}`],
    now: dependencies.now(),
  });
  const data = { ...safePreview(preview), trust_record: selected };
  if (!arguments_.applyDigest) {
    return execution(EXIT_CODES.success, successEnvelope(command, data), `Preview trust binding for ${selected.provider_id}; apply digest ${preview.record.preview_digest}`);
  }
  await applyProviderOverridesChange(preview, arguments_.applyDigest, dependencies.now());
  return execution(EXIT_CODES.success, successEnvelope(command, { ...data, mutated: true }), `Trusted ${selected.provider_id} at its reviewed digest`);
}

export async function executeProviderSettingsCommand(
  arguments_: CliArguments,
  io: CommandIo,
  overrides: Partial<ProviderSettingsDependencies> = {},
): Promise<CommandExecution> {
  const dependencies = { ...defaults, ...overrides };
  try {
    return arguments_.command === "providers.prefer"
      ? await prefer(arguments_, io, dependencies)
      : await trust(arguments_, dependencies);
  } catch (error) {
    return fail(arguments_.command, error);
  }
}
