import { createHash } from "node:crypto";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON accepts only finite numbers");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("Canonical JSON accepts only JSON values");
  if (ancestors.has(value)) throw new TypeError("Canonical JSON cannot serialize cycles");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
      if (typeof length !== "number" || keys.length !== length || keys.some((key, index) => key !== String(index))) {
        throw new TypeError("Canonical JSON arrays must be dense and property-free");
      }
      const descriptors = keys.map((key) => Object.getOwnPropertyDescriptor(value, key));
      if (descriptors.some((descriptor) => !descriptor
        || !("value" in descriptor)
        || descriptor.enumerable !== true)) {
        throw new TypeError("Canonical JSON arrays require enumerable data properties");
      }
      return `[${descriptors.map((descriptor) => serialize(descriptor!.value, ancestors)).join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype) {
      throw new TypeError("Canonical JSON accepts only plain objects");
    }
    const enumerableKeys = Object.keys(value);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== enumerableKeys.length || ownKeys.some((key) => typeof key !== "string")) {
      throw new TypeError("Canonical JSON objects cannot contain hidden or symbol properties");
    }
    if (enumerableKeys.some((key) => DANGEROUS_KEYS.has(key))) {
      throw new TypeError("Canonical JSON objects cannot contain prototype-sensitive keys");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (enumerableKeys.some((key) => !("value" in descriptors[key]!))) {
      throw new TypeError("Canonical JSON objects cannot contain accessor properties");
    }
    return `{${enumerableKeys
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serialize((value as Record<string, unknown>)[key], ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return serialize(value, new Set());
}

export function sha256Digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
