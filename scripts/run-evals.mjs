#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

function getPath(value, path) {
  return path.split(".").reduce((current, segment) => current?.[segment], value);
}

function validateDocument(document) {
  if (!document || document.schema_version !== 1 || !Array.isArray(document.scenarios)) {
    return "Invalid scenario document: expected schema_version 1 and scenarios array";
  }

  const ids = new Set();
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
    for (const invariant of scenario.expected_invariants) {
      if (!invariant || typeof invariant.path !== "string" || !("equals" in invariant)) {
        return `Invalid scenario invariant: ${scenario.id}`;
      }
    }
  }
  return null;
}

async function main(argv) {
  const [scenarioPath, outputFlag, outputPath, ...extra] = argv;
  if (!scenarioPath || (outputFlag !== undefined && outputFlag !== "--output") || extra.length > 0) {
    fail("Usage: run-evals.mjs <scenario.json> --output <evidence.json>");
    return;
  }

  let document;
  try {
    document = JSON.parse(await readFile(scenarioPath, "utf8"));
  } catch (error) {
    fail(`Invalid scenario document: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const validationError = validateDocument(document);
  if (validationError) {
    fail(validationError);
    return;
  }

  if (outputFlag !== "--output" || !outputPath) {
    fail("Usage: run-evals.mjs <scenario.json> --output <evidence.json>");
    return;
  }

  const results = document.scenarios.map((scenario) => {
    const invariants = scenario.expected_invariants.map((invariant) => ({
      path: invariant.path,
      expected: invariant.equals,
      actual: getPath(scenario.input, invariant.path),
      passed: Object.is(getPath(scenario.input, invariant.path), invariant.equals),
    }));
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
    source_alias: basename(scenarioPath),
    summary: { total: results.length, passed, failed: results.length - passed },
    results,
  };
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "w" });
  process.stdout.write(`${JSON.stringify(evidence.summary)}\n`);
  if (passed !== results.length) {
    process.exitCode = 1;
  }
}

await main(process.argv.slice(2));
