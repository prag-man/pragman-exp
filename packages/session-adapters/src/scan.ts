import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";

import { parseClaudeJsonl } from "./claude.ts";
import { parseCodexJsonl } from "./codex.ts";
import { parseCursorMarkdown } from "./cursor-markdown.ts";
import { emptyMetrics, sha256 } from "./jsonl.ts";
import { resolveSessionLimits, validateSessionSelection } from "./limits.ts";
import { SessionAdapterError, type NormalizedSessionEvent, type ParsedSession, type SessionIssue, type SessionMetrics, type SessionScanReport, type SessionSelection, type SessionSourceSelection } from "./types.ts";

interface CandidateFile { absolute: string; relative: string; source: SessionSourceSelection; root_digest: string }

function contained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function aliasFor(source: SessionSourceSelection, rootDigest: string, relativePath: string): string {
  return `${source.adapter}-${sha256(`${source.project_alias}\0${rootDigest}\0${relativePath}`).slice(0, 16)}`;
}

function extensionSupported(adapter: SessionSourceSelection["adapter"], path: string): boolean {
  return adapter === "cursor-markdown" ? extname(path).toLowerCase() === ".md" : extname(path).toLowerCase() === ".jsonl";
}

async function discover(
  source: SessionSourceSelection,
  limits: ReturnType<typeof resolveSessionLimits>,
  warnings: SessionIssue[],
): Promise<CandidateFile[]> {
  let root: string;
  try {
    root = await realpath(source.root);
    const metadata = await lstat(root);
    if (!metadata.isDirectory()) throw new TypeError("not-directory");
  } catch {
    warnings.push({
      code: "SOURCE_UNREADABLE",
      source_alias: `${source.adapter}-root-${sha256(`${source.project_alias}\0${source.root}`).slice(0, 12)}`,
    });
    return [];
  }
  const rootDigest = sha256(root);
  const files: CandidateFile[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relativePath = relative(root, absolute);
      const sourceAlias = aliasFor(source, rootDigest, relativePath);
      if (entry.isSymbolicLink()) {
        warnings.push({ code: "SYMLINK_SKIPPED", source_alias: sourceAlias });
        continue;
      }
      if (!contained(root, absolute)) {
        warnings.push({ code: "SYMLINK_SKIPPED", source_alias: sourceAlias });
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!extensionSupported(source.adapter, absolute)) {
        warnings.push({ code: "UNSUPPORTED_FILE", source_alias: sourceAlias });
        continue;
      }
      if (files.length >= limits.maximum_files) {
        warnings.push({ code: "FILE_LIMIT", source_alias: `${source.adapter}-file-limit` });
        return;
      }
      files.push({ absolute, relative: relativePath, source, root_digest: rootDigest });
    }
  };
  await walk(root);
  return files;
}

function addMetrics(target: SessionMetrics, source: SessionMetrics): void {
  for (const key of Object.keys(target) as Array<keyof SessionMetrics>) target[key] += source[key];
}

function parseFile(input: string, file: CandidateFile, selection: SessionSelection, limits: ReturnType<typeof resolveSessionLimits>): ParsedSession {
  const sourceAlias = aliasFor(file.source, file.root_digest, file.relative);
  const options = {
    source_alias: sourceAlias,
    project_alias: file.source.project_alias,
    selection: {
      from: selection.from, through: selection.through, project_aliases: selection.project_aliases,
      content_categories: selection.content_categories, privacy_depth: selection.privacy_depth,
    },
    ...(file.source.format_version ? { format_version: file.source.format_version } : {}),
    ...(file.source.best_effort ? { best_effort: true } : {}),
    limits,
  };
  if (file.source.adapter === "codex") return parseCodexJsonl(input, options);
  if (file.source.adapter === "claude-code") return parseClaudeJsonl(input, options);
  return parseCursorMarkdown(input, options);
}

export async function scanSessions(
  selection: SessionSelection,
  options: { releaseExcerptDigest?: string } = {},
): Promise<SessionScanReport> {
  validateSessionSelection(selection);
  const limits = resolveSessionLimits(selection.limits);
  const warnings: SessionIssue[] = [];
  const groups = await Promise.all(selection.sources.map((source) => discover(source, limits, warnings)));
  const discoveredFiles = groups.flat().sort((left, right) => left.source.adapter.localeCompare(right.source.adapter) || left.relative.localeCompare(right.relative));
  const files = discoveredFiles.slice(0, limits.maximum_files);
  if (discoveredFiles.length > files.length) warnings.push({ code: "FILE_LIMIT", source_alias: "selected-sessions" });
  const events: NormalizedSessionEvent[] = [];
  const excerpts: SessionScanReport["excerpts"] = [];
  const quarantine: SessionIssue[] = [];
  const metrics = emptyMetrics();
  let bytesRead = 0;
  let sessionsParsed = 0;
  let sessionsFailed = 0;
  let eventLimit = false;

  for (const file of files) {
    const sourceAlias = aliasFor(file.source, file.root_digest, file.relative);
    let parsed: ParsedSession;
    let handle;
    try {
      handle = await open(file.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new TypeError("not-file");
      const size = metadata.size;
      if (size > limits.maximum_file_bytes) {
        quarantine.push({ code: "FILE_TOO_LARGE", source_alias: sourceAlias });
        sessionsFailed += 1;
        continue;
      }
      if (bytesRead + size > limits.maximum_run_bytes) {
        quarantine.push({ code: "RUN_TOO_LARGE", source_alias: sourceAlias });
        sessionsFailed += 1;
        continue;
      }
      const body = await handle.readFile();
      if (body.byteLength > limits.maximum_file_bytes || bytesRead + body.byteLength > limits.maximum_run_bytes) {
        quarantine.push({ code: body.byteLength > limits.maximum_file_bytes ? "FILE_TOO_LARGE" : "RUN_TOO_LARGE", source_alias: sourceAlias });
        sessionsFailed += 1;
        continue;
      }
      bytesRead += body.byteLength;
      parsed = parseFile(body.toString("utf8"), file, selection, { ...limits, maximum_events: Math.max(1, limits.maximum_events - events.length) });
    } catch {
      quarantine.push({ code: "SOURCE_UNREADABLE", source_alias: sourceAlias });
      sessionsFailed += 1;
      continue;
    } finally {
      await handle?.close().catch(() => undefined);
    }
    if (parsed.fatal) sessionsFailed += 1;
    else sessionsParsed += 1;
    quarantine.push(...parsed.quarantine);
    events.push(...parsed.events);
    excerpts.push(...parsed.excerpts.slice(0, Math.max(0, limits.maximum_excerpts - excerpts.length)));
    addMetrics(metrics, parsed.metrics);
    if (events.length >= limits.maximum_events) {
      eventLimit = true;
      break;
    }
  }
  if (eventLimit) warnings.push({ code: "EVENT_LIMIT", source_alias: "selected-sessions" });

  let identityCollision = false;
  const identities = new Map<string, string>();
  for (const event of events) {
    const digest = sha256(JSON.stringify(event));
    const previous = identities.get(event.event_id);
    if (previous && previous !== digest) identityCollision = true;
    else identities.set(event.event_id, digest);
  }
  if (identityCollision) quarantine.push({ code: "IDENTITY_COLLISION", source_alias: "selected-sessions" });
  const failureRatio = files.length === 0 ? 0 : sessionsFailed / files.length;
  const reportOnly = failureRatio > 0.1 || identityCollision || selection.sources.some((source) => source.best_effort === true);
  const releaseDigest = excerpts.length === 0 || selection.privacy_depth === "metadata-only" ? null : sha256(JSON.stringify({
    destination: "command-output",
    selection: {
      sources: [...new Set(selection.sources.map((source) => source.adapter))].sort(),
      from: selection.from,
      through: selection.through,
      project_aliases: [...selection.project_aliases],
      content_categories: [...selection.content_categories],
      privacy_depth: selection.privacy_depth,
    },
    excerpts: excerpts.map((excerpt) => ({ source_alias: excerpt.source_alias, content_ref: excerpt.content_ref, sensitivity: excerpt.sensitivity })),
  }));
  if (options.releaseExcerptDigest && options.releaseExcerptDigest !== releaseDigest) {
    throw new SessionAdapterError("STALE_PREVIEW", "Excerpt release approval does not match the current redacted selection");
  }
  const releaseExcerpts = releaseDigest !== null && options.releaseExcerptDigest === releaseDigest;

  return {
    schema_version: 1,
    selection: {
      sources: [...new Set(selection.sources.map((source) => source.adapter))].sort(),
      from: selection.from,
      through: selection.through,
      project_aliases: [...selection.project_aliases],
      content_categories: [...selection.content_categories],
      privacy_depth: selection.privacy_depth,
    },
    sessions_selected: files.length,
    sessions_parsed: sessionsParsed,
    sessions_failed: sessionsFailed,
    failure_ratio: failureRatio,
    identity_collision: identityCollision,
    report_only: reportOnly,
    apply_allowed: !reportOnly,
    events,
    excerpts: releaseExcerpts ? excerpts : [],
    excerpt_release: {
      required: releaseDigest !== null,
      released: releaseExcerpts,
      preview_digest: releaseDigest,
      destination: "command-output",
    },
    quarantine,
    warnings,
    metrics,
    limits,
  };
}
