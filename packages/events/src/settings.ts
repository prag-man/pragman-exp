import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import * as formatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import { parse as parseYaml } from "yaml";

import personalConfigSchema from "../../config/schemas/personal-config.schema.json" with { type: "json" };
import { appendBestEffort, type BestEffortDependencies, type BestEffortResult } from "./store.ts";
import type { SkillEvent } from "./types.ts";

export const DEFAULT_PERSONAL_CONFIG_PATH = join(homedir(), ".pragman", "config.yaml");

export type MeasurementSettingsResolution =
  | { ok: true; local_events: boolean; telemetry_enabled: false }
  | { ok: false; code: "CONFIG_INVALID" | "CONFIG_VERSION_UNSUPPORTED"; local_events: false; telemetry_enabled: false };

export type LoadedEventSettings = MeasurementSettingsResolution & { config_path: string };

const ajv = new Ajv2020({ allErrors: true, coerceTypes: false, removeAdditional: false, strict: true, useDefaults: false });
const addFormats = ("default" in formatsModule ? formatsModule.default : formatsModule) as unknown as FormatsPlugin;
addFormats(ajv);
const validatePersonalConfig = ajv.compile(personalConfigSchema);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

export function resolveMeasurementSettings(value: unknown): MeasurementSettingsResolution {
  if (!isPlainObject(value)) return { ok: false, code: "CONFIG_INVALID", local_events: false, telemetry_enabled: false };
  if (value.schema_version !== 1) {
    return { ok: false, code: "CONFIG_VERSION_UNSUPPORTED", local_events: false, telemetry_enabled: false };
  }
  const normalized = structuredClone(value);
  if (normalized.measurement === undefined) normalized.measurement = { local_events: true };
  else if (isPlainObject(normalized.measurement) && normalized.measurement.local_events === undefined) {
    normalized.measurement = { ...normalized.measurement, local_events: true };
  }
  if (!validatePersonalConfig(normalized)) return { ok: false, code: "CONFIG_INVALID", local_events: false, telemetry_enabled: false };
  const measurement = normalized.measurement as { local_events: boolean };
  return { ok: true, local_events: measurement.local_events, telemetry_enabled: false };
}

export async function loadEventSettings(selectedPath: string = DEFAULT_PERSONAL_CONFIG_PATH): Promise<LoadedEventSettings> {
  let text: string;
  try {
    text = await readFile(selectedPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, config_path: selectedPath, local_events: true, telemetry_enabled: false };
    }
    return { ok: false, code: "CONFIG_INVALID", config_path: selectedPath, local_events: false, telemetry_enabled: false };
  }
  let parsed: unknown;
  try {
    parsed = selectedPath.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  } catch {
    return { ok: false, code: "CONFIG_INVALID", config_path: selectedPath, local_events: false, telemetry_enabled: false };
  }
  return { ...resolveMeasurementSettings(parsed), config_path: selectedPath };
}

export type ObservationResult = BestEffortResult | { recorded: false; reason: "DISABLED" | "CONFIG_INVALID" };

export async function observeSkillEvent(
  settings: Pick<MeasurementSettingsResolution, "ok" | "local_events">,
  event: SkillEvent,
  dependencies: BestEffortDependencies,
): Promise<ObservationResult> {
  if (!settings.ok) return { recorded: false, reason: "CONFIG_INVALID" };
  if (!settings.local_events) return { recorded: false, reason: "DISABLED" };
  return appendBestEffort(dependencies, event);
}
