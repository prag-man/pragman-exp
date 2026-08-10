#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

function getPath(value, path) {
  return path.split(".").reduce((current, segment) => current?.[segment], value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function safeDigest(value) {
  const serialized = value === undefined
    ? "undefined"
    : JSON.stringify(canonicalize(value));
  return createHash("sha256").update(serialized).digest("hex");
}

function safeAlias(path) {
  return basename(path)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "eval-input";
}

function validateDocument(document) {
  if (
    !document ||
    document.schema_version !== 1 ||
    !Array.isArray(document.scenarios) ||
    document.scenarios.length === 0
  ) {
    return "Invalid scenario document: expected schema_version 1 and a non-empty scenarios array";
  }

  const ids = new Set();
  const modes = new Set();
  for (const scenario of document.scenarios) {
    if (
      !scenario ||
      typeof scenario.id !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scenario.id) ||
      !["baseline", "forward-test"].includes(scenario.mode) ||
      typeof scenario.input !== "object" ||
      scenario.input === null ||
      !Array.isArray(scenario.expected_invariants) ||
      scenario.expected_invariants.length === 0
    ) {
      return `Invalid scenario: ${scenario?.id ?? "<missing-id>"}`;
    }
    if (ids.has(scenario.id)) {
      return `Invalid scenario: duplicate id ${scenario.id}`;
    }
    ids.add(scenario.id);
    modes.add(scenario.mode);
    for (const invariant of scenario.expected_invariants) {
      if (!invariant || typeof invariant.path !== "string" || !invariant.path || !("equals" in invariant)) {
        return `Invalid scenario invariant: ${scenario.id}`;
      }
    }
  }
  if (!modes.has("baseline") || !modes.has("forward-test")) {
    return "Invalid scenario document: baseline and forward-test modes are both required";
  }
  return null;
}

function parseArguments(argv) {
  const [scenarioPath, ...rest] = argv;
  const options = { scenarioPath, observedPath: undefined, outputPath: undefined };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!value) return null;
    if (flag === "--observed" && !options.observedPath) options.observedPath = value;
    else if (flag === "--output" && !options.outputPath) options.outputPath = value;
    else return null;
  }
  return options.scenarioPath && options.observedPath && options.outputPath ? options : null;
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(argv) {
  const options = parseArguments(argv);
  if (!options) {
    fail("Usage: run-evals.mjs <scenario.json> --observed <observed.json> --output <evidence.json>");
    return;
  }

  let document;
  let observed;
  try {
    document = await readJson(options.scenarioPath, "scenario document");
    observed = await readJson(options.observedPath, "observed results");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const validationError = validateDocument(document);
  if (validationError) {
    fail(validationError);
    return;
  }
  if (!observed || typeof observed !== "object" || Array.isArray(observed)) {
    fail("Invalid observed results: expected an object keyed by scenario ID");
    return;
  }
  const scenarioIds = document.scenarios.map((scenario) => scenario.id).sort();
  const observedIds = Object.keys(observed).sort();
  if (!isDeepStrictEqual(observedIds, scenarioIds)) {
    fail("Invalid observed results: keys must exactly match scenario IDs");
    return;
  }

  const results = document.scenarios.map((scenario) => {
    const observation = observed[scenario.id];
    const invariants = scenario.expected_invariants.map((invariant, invariantIndex) => {
      const actual = getPath(observation, invariant.path);
      return {
        invariant_index: invariantIndex,
        passed: isDeepStrictEqual(actual, invariant.equals),
        expected_digest: safeDigest(invariant.equals),
        observed_digest: safeDigest(actual),
      };
    });
    return {
      scenario_id: scenario.id,
      mode: scenario.mode,
      passed: invariants.every((invariant) => invariant.passed),
      invariants,
    };
  });
  const passed = results.filter((result) => result.passed).length;
  const evidence = {
    schema_version: 1,
    source_alias: safeAlias(options.scenarioPath),
    observed_source_alias: safeAlias(options.observedPath),
    summary: { total: results.length, passed, failed: results.length - passed },
    results,
  };
  await writeFile(options.outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "w" });
  process.stdout.write(`${JSON.stringify(evidence.summary)}\n`);
  if (passed !== results.length) process.exitCode = 1;
}

await main(process.argv.slice(2));
