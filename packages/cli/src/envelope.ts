export const EXIT_CODES = Object.freeze({
  success: 0,
  invalid: 2,
  needsInput: 3,
  unavailable: 4,
  denied: 5,
  temporary: 6,
  internal: 10,
} as const);

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export interface AutomationError {
  code: string;
  message: string;
  details: unknown;
  retryable: boolean;
}

export interface SuccessEnvelope<T> {
  ok: true;
  command: string;
  schema_version: 1;
  data: T;
  warnings: string[];
  error: null;
}

export interface ErrorEnvelope {
  ok: false;
  command: string;
  schema_version: 1;
  data: null;
  warnings: string[];
  error: AutomationError;
}

export function successEnvelope<T>(
  command: string,
  data: T,
  warnings: string[] = [],
): SuccessEnvelope<T> {
  return {
    ok: true,
    command,
    schema_version: 1,
    data,
    warnings,
    error: null,
  };
}

export function errorEnvelope(
  command: string,
  code: string,
  message: string,
  details: unknown = null,
  retryable = false,
  warnings: string[] = [],
): ErrorEnvelope {
  return {
    ok: false,
    command,
    schema_version: 1,
    data: null,
    warnings,
    error: { code, message, details, retryable },
  };
}
