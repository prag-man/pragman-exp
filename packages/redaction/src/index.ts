const REDACTIONS: ReadonlyArray<readonly [RegExp, string | ((substring: string, ...args: string[]) => string)]> = [
  [
    /-----BEGIN (?:RSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/gi,
    "[REDACTED:PRIVATE_KEY]",
  ],
  [
    /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:/@]+:)([^\s@/]+)(@[^\s]+)/gi,
    (_match, prefix, _password, suffix) => `${prefix}[REDACTED:PASSWORD]${suffix}`,
  ],
  [
    /\b(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi,
    (_match, prefix) => `${prefix}[REDACTED:BEARER_TOKEN]`,
  ],
  [
    /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/g,
    (_match, prefix) => `${prefix}[REDACTED:SECRET]`,
  ],
  [
    /(["'](?:token|secret|password|passwd|api[_-]?key|access[_-]?key)["']\s*:\s*["'])[^"']+(["'])/gi,
    (_match, prefix, suffix) => `${prefix}[REDACTED:SECRET]${suffix}`,
  ],
  [/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g, "[REDACTED:TOKEN]"],
  [/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED:ACCESS_KEY]"],
  [/\b(?:xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})\b/g, "[REDACTED:TOKEN]"],
];

export function redactText(input: string): string {
  let output = input;
  for (const [pattern, replacement] of REDACTIONS) {
    output = output.replace(pattern, replacement as never);
  }
  return output;
}

export interface SanitizedTranscriptExcerpt {
  kind: "untrusted-transcript";
  source_alias: string;
  trusted: false;
  allow_instructions: false;
  content: string;
}

export function sanitizeTranscriptExcerpt(
  content: string,
  sourceAlias: string,
): Readonly<SanitizedTranscriptExcerpt> {
  return Object.freeze({
    kind: "untrusted-transcript",
    source_alias: sourceAlias,
    trusted: false,
    allow_instructions: false,
    content: redactText(content),
  });
}
