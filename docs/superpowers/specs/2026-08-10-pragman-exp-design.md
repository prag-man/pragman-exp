# Pragman Exp v1 Design

**Date:** 2026-08-10

**Status:** Approved; implementation in progress

**Repository:** `https://github.com/prag-man/pragman-exp`

**Primary audiences:** founder/CTO operators and fast-moving technical teams

## 1. Summary

Pragman Exp is a customizable control plane for high-quality, high-speed agentic work. It combines personal, company, and project context with adaptive task shaping and capability-based routing. It uses strong existing skill collections such as gstack, Compound Engineering, and Superpowers instead of duplicating their work, while allowing native Pragman workflows to be added when they offer a measurable advantage.

The public v1 release contains eight portable skills and a local companion CLI:

1. `pragman-init`
2. `pragman-workspace`
3. `pragman-router`
4. `pragman-research`
5. `pragman-shape`
6. `pragman-prototype`
7. `pragman-analyze`
8. `pragman-unfck`

Pragman remains interactive and iterative. It asks questions when an answer can materially change the route, scope, privacy boundary, or result. It avoids ceremony for obvious low-risk work.

## 2. Problem

Agent users often install many useful skills but fail to use them consistently because:

- They cannot remember which skill applies.
- Skills lack personal, company, and project context.
- Different collections overlap but have different strengths.
- Heavy workflows are invoked for small tasks, creating excess latency.
- Ambiguous requests start implementation before their outcome is shaped.
- Long sessions accumulate scope drift, compactions, retries, and rework.
- Agent histories contain evidence about recurring workflow problems, but that evidence is rarely converted into approved improvements.
- Context, routing preferences, and learned practices do not travel cleanly across Codex, Claude Code, Cursor, and other hosts.

Pragman addresses these problems without replacing existing specialist collections.

## 3. Goals

### 3.1 Product goals

- Produce the highest-quality useful outcome with the least justified latency.
- Give users one adaptive front door for native and external skills.
- Preserve user sovereignty over workflow, tools, context, and approvals.
- Support personal, company, and project-specific customization.
- Make installed skill collections discoverable and practically usable.
- Turn session evidence into interactive, approved workflow improvements.
- Operate locally by default and avoid a hosted account or daemon.
- Work across Codex, Claude Code, and Cursor in v1.
- Publish portable skills through the open `skills.sh` ecosystem.
- Permit native Pragman workflows to evolve without breaking provider contracts.

### 3.2 Engineering goals

- Keep skill entrypoints concise through progressive disclosure.
- Use deterministic code for discovery, parsing, validation, redaction, migration, and report generation.
- Make configuration changes previewable, versioned, and reversible.
- Test skills behaviorally before release.
- Treat third-party skills and session transcripts as untrusted inputs.
- Keep implementation units independently verifiable and releasable.

## 4. Non-goals

V1 will not:

- Replace gstack, Compound Engineering, Superpowers, or other specialist collections.
- Fork or vendor third-party skills.
- Run a background daemon.
- Require a Pragman cloud account.
- Synchronize private context through a Pragman-hosted service.
- Store credentials or secret values.
- Silently rewrite public or third-party skills.
- Automatically merge context across unrelated companies or clients.
- Make autonomous production, infrastructure, or external-account mutations without the user's existing host approvals.
- Support every agent host at launch; additional hosts follow the adapter contract.
- Use opaque reinforcement or self-modifying behavior to change provider rankings.

## 5. Product principles

1. **Route before loading.** Index metadata and load full skill bodies only after selecting candidates.
2. **Ask only useful questions.** Questions must be capable of changing the route, scope, privacy boundary, authority, or acceptance criteria.
3. **Adaptive rigor.** Small tasks stay small; complex or risky tasks receive proportional shaping and verification.
4. **Evidence over ceremony.** Gates exist to improve outcomes, not to maximize process.
5. **External skills are providers.** Pragman orchestrates them through stable capability contracts.
6. **Private context stays private.** Public workflows and private user/company knowledge remain separate.
7. **Approved learning only.** Observations become configuration or skill changes only through a visible approval and evaluation flow.
8. **No hidden fallback.** Pragman discloses when a preferred provider is missing or unhealthy.
9. **Local by default.** Configuration, indexes, transcripts, and reports stay on the user's machine unless the user deliberately exports them.
10. **One verified vertical unit at a time.** The project will not batch-create untested skills.

## 6. System architecture

```text
User request
    |
    v
pragman-router
    |-- personal context
    |-- workspace context
    |-- project context
    |-- capability registry
    |-- provider health
    v
Resolved task contract
    |-- native Pragman provider
    |-- external provider
    |-- provider sequence
    v
Execution and evidence
    |
    +--> pragman-analyze
    +--> pragman-unfck
              |
              v
       approved overlay update
```

The system has four runtime responsibilities:

- **Skills:** interviewing, reasoning, routing, interpretation, and orchestration.
- **CLI:** deterministic discovery, configuration, parsing, redaction, migrations, validation, reports, and evaluations.
- **Workspace:** layered private context and approved learnings.
- **Provider registry:** normalized descriptions of native and external capabilities.

No component requires a long-running process.

## 7. Repository structure

```text
pragman-exp/
  skills/
    pragman-init/
    pragman-workspace/
    pragman-router/
    pragman-research/
    pragman-shape/
    pragman-prototype/
    pragman-analyze/
    pragman-unfck/
  packages/
    cli/
    config/
    provider-registry/
    session-adapters/
    redaction/
    reports/
  providers/
    pragman/
    gstack/
    compound-engineering/
    superpowers/
  host-adapters/
    codex/
    claude-code/
    cursor/
  evals/
    scenarios/
    fixtures/
    expected/
  docs/
    superpowers/specs/
    security/
    contributors/
  package.json
```

Each skill is independently installable and contains its own `SKILL.md`, optional references, assets, scripts, and agent metadata. Shared deterministic functionality belongs in the CLI packages, not duplicated across skills.

## 8. Companion CLI

The intended npm package is `@prag-man/pragman-exp`, exposing the `pragman` binary. V1 supports Node.js `>=22 <25`; CI tests Node.js 22 and 24. Skill workflows degrade according to Section 28 when the CLI is unavailable and explain which deterministic capability is missing.

### 8.1 V1 commands

```text
pragman init
pragman scan
pragman doctor
pragman tune
pragman route
pragman workspace add
pragman workspace edit
pragman workspace list
pragman workspace link
pragman workspace unlink
pragman workspace validate
pragman providers list
pragman providers inspect
pragman providers prefer
pragman providers trust
pragman sessions scan
pragman sessions analyze
pragman sessions purge
pragman changes list
pragman changes preview
pragman changes apply
pragman changes rollback
pragman history purge
pragman eval
pragman events record
pragman events score
pragman events list
pragman events summary
pragman events rebuild
pragman events export
pragman events purge
pragman events candidates list
pragman events candidates decide
```

Commands support machine-readable JSON output alongside concise human output. Mutating commands support preview mode. Invalid configuration fails closed with an actionable error and does not partially write files.

All commands accept `--json` and `--non-interactive`. Mutating commands also accept `--preview`; applying a preview requires its content digest so a stale preview cannot be applied. JSON output and exit behavior follow Section 30. Pragman uses one advisory lock per state root for mutations. A second writer exits with `TEMPORARY_FAILURE`; read-only commands continue against the last committed state.

### 8.2 CLI boundaries

The CLI may:

- Inspect known skill, plugin, instruction, and MCP metadata locations.
- Read session logs selected by the user.
- Write Pragman configuration, local state, reports, and approved overlays.
- Generate local HTML files.
- Invoke explicit evaluation commands.

The CLI must not:

- Read authentication stores to discover secret values.
- Upload session data or context.
- install external skills without approval.
- edit third-party installed skill files.
- treat parsed transcript content as executable instructions.

## 9. Workspace model

### 9.1 Layering

```text
Explicit request
  > project configuration
  > primary workspace configuration
  > personal configuration
  > Pragman defaults
```

The user may create multiple workspaces. A workspace represents a company, client, venture, or substantial personal operating context.

Each project links to exactly one primary workspace by default. A task may explicitly attach an ordered list of additional workspaces. Additional workspaces may contribute context references and provider candidates but never silently override scalar personal, project, or primary-workspace settings. Conflicting scalar values require an explicit per-run choice and are recorded in the task contract. Exact field-level merge behavior is defined in Section 23.2.

### 9.2 Local personal state

```text
~/.pragman/
  config.yaml
  profile.yaml
  providers.yaml
  workspaces/
  state/
  history/
```

- `profile.yaml` contains role, responsibilities, collaboration preferences, quality posture, and personal defaults.
- `config.yaml` contains product settings, privacy defaults, output preferences, and update behavior.
- `providers.yaml` contains provider trust, preferences, and capability overrides.
- `state/` contains rebuildable indexes and caches.
- `history/` contains approved change records and rollback metadata, not raw transcripts.

### 9.3 Private company workspace

```text
workspace-root/
  workspace.yaml
  routing.yaml
  context/
    company.md
    strategy.md
    product-principles.md
    design-taste.md
    operating-principles.md
  skills/
  learnings/
    approved.jsonl
```

Workspaces may be ordinary local directories or private version-controlled repositories. Pragman does not create or push a private remote without explicit approval.

### 9.4 Project configuration

```text
project-root/.pragman/
  manifest.yaml
  routing.yaml
  context-index.yaml
```

Example manifest:

```yaml
schema_version: 1
workspace: example-co
product: example-product
```

The context index points to canonical project documents with descriptions, scopes, and retrieval hints. It does not duplicate source documents.

### 9.5 Configuration rules

- Every file has a schema version.
- Writes are atomic.
- Meaningful changes receive a human-readable diff.
- Approved changes create a history record.
- Migrations are deterministic, testable, and reversible when data loss would otherwise occur.
- Secret references may be stored by name; secret values may not.
- Workspace identifiers use lowercase hyphenated slugs and are unique within a user's Pragman installation.

## 10. Capability and provider model

Pragman routes by capability, not by package name.

Example provider definition:

```yaml
schema_version: 1
id: gstack:investigate
source: garrytan/gstack
trust: curated
capabilities:
  - diagnose-software-failure
strengths:
  - browser-backed-reproduction
  - systematic-root-cause-analysis
requires:
  - skill:gstack:investigate
side_effects:
  - may-read-files
  - may-run-commands
  - may-edit-files
best_for:
  - production-bugs
  - difficult-reproduction
avoid_when:
  - explanation-only
workflow_weight: standard
```

Provider records include:

- Identity, source, and version information
- Trust tier
- Capabilities
- Triggering and exclusion guidance
- Tool and skill dependencies
- Side effects
- Output formats
- Workflow weight
- Known strengths and limitations
- Health state
- Evaluation confidence

### 10.1 Trust tiers

1. `bundled`: Pragman-owned and release-audited.
2. `curated`: reviewed external provider definition and pinned/reviewed source guidance.
3. `workspace-approved`: explicitly trusted by the user or company.
4. `discovered`: visible but never automatically installed or invoked.

### 10.2 Preference layering

Users can express broad preferences and task-specific rules:

```yaml
defaults:
  prefer:
    - pragman
rules:
  - id: production-bug-test-first
    priority: 100
    when:
      all:
        - field: task_family
          op: eq
          value: debug
        - field: downstream_impact
          op: eq
          value: high
    action:
      require_capabilities:
        - test-first-change
      prefer:
        - superpowers:test-driven-development
  - id: product-shaping-office-hours
    priority: 50
    when:
      all:
        - field: task_family
          op: eq
          value: shape
    action:
      prefer:
        - gstack:office-hours
```

Project rules override workspace rules, which override personal rules. Explicit user instructions override all stored preferences.

## 11. Adaptive router

### 11.1 Routing lanes

- **Fast:** obvious, bounded, low-risk work. No shaping interview unless required information is missing.
- **Standard:** a local artifact, project change, side effect, or multi-capability response. Produce a compact task contract.
- **Deep:** ambiguous, cross-system, or high-cost work. Shape and validate before execution.
- **Operational:** infrastructure, deployment, external accounts, credentials, destructive actions, or live data. Separate implementation from live mutation and preserve host approval boundaries.

### 11.2 Routing algorithm

1. Honor explicit user provider, method, risk, and speed instructions.
2. Resolve personal context and any selected workspace/project context. Personal-only and unlinked work are valid.
3. Classify task family, scope, risk, urgency, freshness, and uncertainty.
4. Select a lane.
5. Determine required capabilities and side-effect limits.
6. Filter providers by installation, health, trust, and compatibility.
7. Rank remaining providers using layered preferences and relevant approved outcomes.
8. Ask one question at a time only when the answer could change the route or task contract.
9. Produce the resolved task contract.
10. Proceed automatically for low-risk read-only work; request route approval when the route introduces meaningful mutation, external state, unexpected workflow weight, or a material assumption.
11. Invoke the provider or provider sequence.
12. Record route metadata and observable outcome evidence locally.

### 11.3 Task contract

```yaml
schema_version: 1
route_id: 0198a4c0-6e34-7d18-a148-2e919fb2ad42
parent_route_id: null
request_digest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
outcome: Fix inbox replies failing after mailbox expiry
lane: standard
deliverable_kind: project-change
execution_mode: serial
workspace: example-co
project: example-product
in_scope:
  - reproduce the failure
  - identify the root cause
  - implement and verify the fix
out_of_scope:
  - redesign mailbox provisioning
assumptions: []
unresolved_conflicts: []
capabilities:
  - diagnose-software-failure
  - test-first-change
providers:
  - superpowers:systematic-debugging
  - superpowers:test-driven-development
provider_sequence_policy: stop
allowed_side_effects:
  - project-file-write
  - local-command
data_inputs:
  - id: project-source
    source_alias: selected-project
    category: source-code
    sensitivity: internal
effective_sensitivity: internal
egress_approvals: []
proof:
  - focused regression test
  - inbox reply canary
stop_conditions:
  - regression test cannot reproduce reported behavior
created_at: 2026-08-10T10:00:00Z
```

### 11.4 Routing safeguards

- A route ID prevents recursive router invocation.
- Spawned agents receive the task contract and minimum task-local context, not an unrestricted personal profile.
- Missing providers produce an explicit install recommendation or disclosed fallback.
- Pragman never silently substitutes a lower-confidence provider for sensitive work.
- Provider outcome history influences recommendations only through approved learnings.
- The user may override the route at any time.

## 12. Skill requirements

### 12.1 `pragman-workspace`

Use when creating, inspecting, linking, changing, validating, or learning about personal, company, client, or project context.

Required behavior:

- Create and manage multiple workspaces.
- Link a project to one primary workspace.
- Index canonical context without duplicating it.
- Preview and validate changes.
- Preserve privacy boundaries between workspaces.
- Support later reconfiguration without rerunning full init.
- Generate a private context skill when useful, such as `company-product-context`, whose body routes to canonical sources rather than embedding the whole knowledge base.

### 12.2 `pragman-init`

Use for first-run onboarding, substantial reconfiguration, environment discovery, or explaining how Pragman can improve a user's workflow.

Discovery includes:

- Supported agent hosts and versions
- Installed skills and plugins
- Declared MCP and tool names
- Existing instruction and context files
- User-selected repositories
- Existing Pragman workspaces
- Missing, broken, duplicated, or shadowed installations

The interview adapts to discovered evidence and asks about:

- Identity, role, responsibilities, and decision authority
- Companies, products, projects, and workspaces
- Recurring work types
- Current workflow friction
- Quality, speed, autonomy, and risk posture
- Trusted tools and skill collections
- Approval boundaries
- Output and collaboration preferences
- Prohibited behavior

Init then presents a reviewable operating map, applies only approved changes, runs health checks, exercises a sample route, and may generate a local clickable HTML operating map.

### 12.3 `pragman-router`

Use as the adaptive front door for non-trivial, ambiguous, multi-domain, or explicitly routed work.

Required behavior follows Section 11. Simple requests must not be forced through an unnecessary interview.

### 12.4 `pragman-research`

Use for external, internal, technical, market, competitive, decision, or source-grounded research.

Supported methods:

- Quick reconnaissance
- Source-first technical research
- Deep multi-source research
- Fan-out research over independent questions
- Competitive and product research
- Decision research with alternatives and trade-offs
- Internal workspace research through configured connectors

The workflow begins with the decision or output the research must enable. It states source-quality and freshness requirements, distinguishes sourced fact from inference, records important disagreements, and finishes with an actionable synthesis.

### 12.5 `pragman-shape`

Use when a request is ambiguous, broad, premature, or needs to become a decision, experiment, prototype, issue, spec, or implementation-ready unit.

The shaped result contains:

- Problem and intended user
- Evidence and assumptions
- Desired outcome
- Smallest valuable experiment or deliverable
- Non-goals
- Success and kill criteria
- Dependencies and risks
- Recommended lane and provider route

It may use gstack Office Hours, Compound Engineering brainstorming, Superpowers brainstorming, or a native method.

### 12.6 `pragman-prototype`

Use for product/UI exploration where seeing and interacting with alternatives improves the decision.

Required behavior:

- Prefer a disposable, self-contained clickable HTML artifact.
- Reuse project design context and configured taste.
- Produce variants only when comparison is useful.
- Route to configured design specialists when they add value.
- Launch or explain a local preview.
- Capture structured user feedback.
- Iterate without treating prototype code as production code.
- Promote the approved direction into a shaped task contract.

### 12.7 `pragman-analyze`

Use to analyze a project, decision, incident, experiment, release, workflow, or completed body of work.

Analysis dimensions:

- Intent versus outcome
- Scope and routing quality
- Assumptions and decisions
- Context completeness
- Provider and tool fit
- Time versus value
- Rework, compactions, retries, and waits
- Verification and quality
- Human-agent collaboration
- External blockers
- Reusable learning

The result groups recommendations into `Keep`, `Change`, `Stop`, `Automate`, `Learn`, and `Test next`. It does not mutate configuration unless the user explicitly transitions to an approved change workflow.

### 12.8 `pragman-unfck`

Use when agentic work feels slow, chaotic, repetitive, over-scoped, unreliable, expensive, or poorly matched to the user's workflow.

Required behavior:

1. Ask the user to choose projects, time range, agent sources, and privacy depth, using safe defaults.
2. Ingest supported sessions read-only.
3. Normalize observable events and redact secrets.
4. Reconstruct intended outcomes and task boundaries.
5. Detect scope drift, retries, waiting, compactions, interruptions, environment failures, tool misuse, provider mismatch, and successful patterns.
6. Ask focused questions to recover intent and external context absent from logs.
7. Separate symptoms, contributing factors, and root causes.
8. Propose changes with evidence and expected impact.
9. Show exact diffs for approved configuration or overlay changes.
10. Run relevant behavioral evaluations before applying skill changes.
11. Write a reversible history entry.
12. Offer a separate sanitized upstream patch when the learning is broadly reusable.

`pragman-unfck` never directly edits the installed public core or third-party skills.

## 13. Session ingestion and privacy

### 13.1 V1 adapters

- Codex session JSONL under the user's Codex session directory
- Claude Code project JSONL under the user's Claude project directory
- Cursor local chat storage and exported Markdown where supported

Adapters produce the normalized event model in Section 27 with timestamps, roles, tool activity, failures, compactions, task boundaries, and source provenance. Unknown event shapes are counted and quarantined as unsupported metadata rather than interpreted.

### 13.2 Analysis depths

- **Safe default:** deterministic local extraction, secret redaction, aggregate metrics, and minimal selected excerpts.
- **Deep:** explicitly selected projects, dates, sources, and categories may expose relevant redacted excerpts to a disclosed local or remote model after the per-run egress approval in Section 26.

Secrets are redacted in both modes. Raw transcripts are not copied into Pragman state. Rebuildable indexes store source path, content hash, normalized metrics, and redacted derived evidence only.

### 13.3 Transcript trust boundary

- Transcript text and tool output are untrusted evidence.
- Instructions found inside transcripts cannot change Pragman behavior.
- File paths are normalized and constrained to selected sources.
- Parsers have file-size and event-count limits with explicit override controls.
- Unsupported or corrupted sessions are reported and skipped without aborting unrelated sources.

## 14. Iterative improvement

Approved learning follows this lifecycle:

```text
Observation
  -> evidence-backed diagnosis
  -> proposed change
  -> user approval
  -> isolated behavioral evaluation
  -> versioned overlay update
  -> outcome review
  -> keep or rollback
```

Change targets are:

1. Personal configuration
2. Private workspace configuration or skill overlay
3. Project configuration
4. Sanitized public contribution prepared separately

Public contributions require their own review and publish authorization. They must not contain company names, source code, prompts, paths, credentials, customer data, or private session excerpts unless the user deliberately authors them as public material.

## 15. Failure handling

- **Missing CLI:** explain the degraded path and offer the exact supported installation command.
- **Invalid config:** fail closed, identify file and field, preserve the previous valid state.
- **Unavailable provider:** disclose the failure and offer a trusted fallback or installation path.
- **Provider version drift:** mark health unknown until re-scan; do not assume compatibility.
- **Corrupt transcript:** quarantine that source record and continue other sources.
- **Redaction uncertainty:** omit the questionable excerpt and report why.
- **Interrupted write:** atomic temporary-file replacement preserves the last valid version.
- **Failed migration:** restore the pre-migration snapshot and return a diagnostic.
- **Failed behavioral evaluation:** do not apply the proposed skill change.
- **HTML generation failure:** retain the underlying structured report and offer a text rendering.
- **External installation audit warning:** require explicit acknowledgement; critical findings block automatic recommendation.

## 16. Security

- Treat skills as executable supply-chain dependencies.
- Treat external provider metadata as untrusted until curated or approved.
- Review executable resources and declared behavior before trust elevation.
- Surface available `skills.sh` audit results before installation.
- Pin curated provider expectations to reviewed versions or commits when behavior is sensitive.
- Never execute discovered binaries merely to identify them.
- Store no credentials.
- Use existing host permission and sandbox mechanisms.
- Request explicit approval for meaningful external state changes.
- Keep telemetry disabled by default.
- Ensure generated HTML escapes untrusted content and makes no network requests by default.
- Publish a security policy and private vulnerability-reporting path before v1 release.

## 17. Evaluation strategy

Each new or modified skill follows behavior-first development:

1. Define realistic baseline scenarios.
2. Run them without the skill and record failures or inconsistencies.
3. Write the minimum skill and resources that address observed failures.
4. Run the same scenarios with the skill.
5. Add ambiguity, pressure, missing-context, and counter-example scenarios.
6. Refine without expanding unrelated scope.

### 17.1 Test layers

- **Static:** frontmatter, naming, descriptions, references, provider definitions, schemas, and host manifests.
- **Unit:** config precedence, atomic writes, migrations, redaction, ranking, parsing, and report rendering.
- **Fixture:** sanitized Codex, Claude Code, and Cursor session variants.
- **Behavioral:** per-skill task scenarios on supported hosts.
- **Router:** golden requests covering fast, standard, deep, operational, overrides, missing providers, and privacy boundaries.
- **Security:** path traversal, prompt injection in transcripts, secret fixtures, malicious provider metadata, and unsafe HTML.
- **End-to-end:** init -> workspace -> scan -> route -> provider -> evidence -> analyze -> approved change -> rollback.

### 17.2 Local outcome metrics

The normative event, score, rollup, ablation, and lifecycle contracts are defined in `docs/superpowers/specs/2026-08-10-pragman-skill-events-design.md`. That additive spec governs where its narrower requirements differ from this section.

- Route acceptance or override
- Number of questions and whether answers changed the route
- Time to first useful action
- Completion and verification status
- Rework and retry loops
- Compactions and interruptions
- Provider health failures
- Explicit user quality feedback
- Approved, rejected, retained, and rolled-back learnings

Metrics remain in local storage unless the user approves a disclosed egress operation. Local storage does not imply local processing; Section 26 governs every remote model, connector, and provider boundary.

## 18. Distribution and updates

### 18.1 Public channels

- GitHub repository: `prag-man/pragman-exp`
- `skills.sh` discovery via the open skills repository format
- npm package: `@prag-man/pragman-exp`
- Native host/plugin manifests where supported

### 18.2 Installation experience

Users can install all or selected skills through the open `skills` CLI. Init scans the installation and offers the companion CLI when deterministic capabilities are required.

Third-party providers are not installed as hidden dependencies. Init recommends them with source, capability, workflow weight, trust status, and the exact installation action.

### 18.3 Versioning

- Semantic versioning for public releases.
- Schema versions for configuration and provider definitions.
- Reproducible package builds and release checksums.
- Release notes at repository level, not inside individual skill folders.
- `pragman doctor` reports core, CLI, schema, provider, and host-adapter compatibility.
- Updates never overwrite private overlays.

## 19. Private reference workspace

The first private reference workspace provides an additional local validation against real founder/CTO and team workflows.

It will:

- Model a founder/CTO role and working preferences without publishing them.
- Model a reference company and product as private context.
- Index the product's canonical documentation rather than copy it.
- Define provider preferences for research, shaping, engineering, design, QA, infrastructure, and retrospectives.
- Add a private product-context skill.
- Exercise multi-workspace and project-linking behavior.
- Supply sanitized evaluation scenarios where permitted.

The private workspace is not stored in the public `pragman-exp` repository.

## 20. Delivery units

Implementation proceeds in strict vertical units:

1. Repository foundation, schemas, CLI shell, test harness, and security baseline
2. Local skill events, scores, rollups, and evaluation comparison
3. `pragman-workspace`
4. `pragman-init`
5. Provider registry and `pragman-router`
6. `pragman-research`
7. `pragman-shape`
8. `pragman-prototype`
9. `pragman-analyze`
10. Session adapters and `pragman-unfck`
11. Cross-host validation, security review, npm release, GitHub release, and `skills.sh` publication

Each public unit receives its own behavior scenarios and must pass deterministic and behavioral gates before the next public unit begins. Implementation planning must preserve these boundaries and may split a unit further; it may not combine units into one unverified batch.

The private reference workspace is a parallel validation track, not a public delivery unit. It may begin after public units 2 and 3 establish workspace/init contracts. Its local attestation informs internal adoption and future sanitized fixtures, but it neither blocks nor satisfies public unit 10.

## 21. V1 acceptance criteria

V1 is complete only when:

- All eight skills are independently installable and valid.
- The companion CLI installs and exposes the documented v1 commands.
- Personal, multiple workspace, and project configuration layers work with documented precedence.
- Init scans supported hosts and produces an approved operating map without reading secrets.
- Router selects appropriate lanes/providers across the golden scenario suite and avoids unnecessary questions on fast tasks.
- Local skill events, delayed scores, rollups, and skill-on/off comparisons pass the additive skill-events acceptance criteria.
- Curated adapters exist for Pragman, gstack, Compound Engineering, and Superpowers.
- Research, shaping, prototype, and analysis skills pass their behavioral scenarios.
- Codex, Claude Code, and Cursor sessions can be safely scanned through supported adapters.
- `pragman-unfck` combines evidence with user questions and produces previewable, reversible improvements.
- Secret, transcript-injection, provider-injection, path, and HTML security tests pass.
- The end-to-end workflow passes on at least Codex and Claude Code; Cursor passes all portable flows and its supported session-adapter path.
- Sanitized public fixtures validate multi-layer context in reproducible CI.
- The public repository contains license, security policy, contribution guidance, installation guidance, and release automation.
- The npm package and GitHub release are published.
- The repository and all eight skills are discoverable/installable through `skills.sh` tooling.

## 22. Success measures after release

Pragman is succeeding when users:

- Use relevant installed skills more often without memorizing them.
- Reach useful action faster on simple work.
- Spend less time in avoidable long-running loops.
- Override fewer routes as workspace context improves.
- Preserve or improve verification quality while reducing cycle time.
- Convert recurring workflow friction into approved, retained improvements.
- Can explain which workflow and provider produced an outcome and why.

These measures are evaluated from local user-controlled data and voluntary qualitative feedback, not mandatory remote telemetry.

## 23. Normative v1 data contracts

This section is normative. Schemas are published as JSON Schema in `packages/config/schemas/`; YAML files are parsed into the same data model. Unless a schema explicitly allows extension fields, unknown fields are errors. Every persisted record has `schema_version: 1`. IDs are lowercase ASCII slugs for user-authored entities and UUIDv7 values for generated records. Provider IDs are `<namespace>:<slug>` and repository sources are `<owner>/<repo>`; these are the explicit exceptions, while other user-authored IDs remain lowercase ASCII slugs. Timestamps are RFC 3339 UTC. Paths are stored as normalized absolute paths only in private local state; exported artifacts replace them with stable source aliases.

### 23.1 Core records

| Record | Required fields | Optional fields and defaults | Unknown fields |
| --- | --- | --- | --- |
| Personal config | `schema_version`, `privacy`, `updates`, `output` | `telemetry.enabled=false`, `measurement.local_events=true`, `routing.default_lane=adaptive` | reject |
| Profile | `schema_version`, `profile_id`, `roles`, `responsibilities` | `preferences={}`, `prohibitions=[]`, `authority=[]` | reject |
| Workspace | `schema_version`, `workspace_id`, `name`, `root`, `context_sources` | `description`, `tools=[]`, `workflows=[]`, `sensitivity=internal` | reject |
| Project manifest | `schema_version`, `project_id`, `workspace`, `root` | `product`, `additional_workspaces=[]`, `context_index=.pragman/context-index.yaml` | reject |
| Context source | `id`, `kind`, `uri`, `description`, `sensitivity` | `scope=[]`, `retrieval_hints=[]`, `freshness_days=null` | reject |
| Routing file | `schema_version`, `defaults`, `rules` | `capability_aliases={}` | reject |
| Routing rule | `id`, `when`, `action` | `priority=0` | reject |
| Capability | `schema_version`, `id`, `stage`, `depends_on`, `result_contract` | `description`, `incompatible_with=[]` | reject |
| Provider | fields in Section 25.1 | defaults in Section 25.1 | reject |
| Task contract | fields in Section 24.2 | defaults in Section 24.2 | reject |
| Route evidence | `schema_version`, `route_id`, `decision`, `provider_results`, `started_at` | `finished_at`, `verification=[]`, `user_feedback`, `sensitive_source_aliases=[]` | reject |
| Session event | fields in Section 27.1 | defaults in Section 27.1 | preserve only inside `unsupported` event payload |
| Approved learning | `schema_version`, `learning_id`, `evidence_refs`, `target`, `change_id`, `approved_at`, `status` | `review_after`, `outcome`, `rollback_reason` | reject |
| Change record | fields in Section 23.3 | defaults in Section 23.3 | reject |

Sensitive strings use `{ value, sensitivity }`. The single ordered sensitivity enum is `public < internal < confidential < restricted`. A record's effective sensitivity is the maximum of its fields and sources; an empty input set is `public`. A task's effective sensitivity is the maximum of every selected context source, session excerpt, data input, and user-authored sensitive field in its task contract. Provenance references use `{ source_alias, source_hash, locator, observed_at }`; raw private paths are never part of model-facing task contracts. The word “private” elsewhere describes ownership or storage, not a fifth sensitivity value.

### 23.2 Merge and precedence semantics

Configuration resolves field by field in this order:

1. Explicit values in the current request
2. Project configuration
3. Primary workspace configuration
4. Personal configuration
5. Pragman defaults

Scalars use the first defined value. Maps merge by key using the same precedence. Lists are replaced unless the schema marks them `merge: ordered-set`; `prohibitions`, `require_capabilities`, and `context_sources` are ordered sets deduplicated by canonical ID. Safety prohibitions accumulate and cannot be weakened by a lower layer. Routing rules from all layers remain addressable; they sort by layer, descending `priority`, then lexical rule ID. Two matching rules at the same layer and priority that demand incompatible providers or approvals produce `AMBIGUOUS_ROUTE` and require a user choice.

Additional workspaces are evaluated only in the explicit order in `additional_workspaces`. Their context sources append as provenance-preserving ordered sets. Their routing rules may nominate candidates but cannot override any scalar or rule from the primary chain. Conflicting additional-workspace facts are surfaced with both provenance records; they are never resolved by list position.

### 23.3 Change and rollback records

A change record contains:

```yaml
schema_version: 1
change_id: uuidv7
target: personal | workspace | project
target_id: example-co
base_digest: sha256
preview_digest: sha256
operations: []
reason: string
evidence_refs: []
approved_by: local-user
approved_at: RFC3339
applied_at: RFC3339 | null
rollback:
  available: true
  snapshot_ref: local-content-address
  rolled_back_at: null
```

Operations use a constrained JSON Patch subset: `add`, `replace`, and `remove`. Apply fails when the current target digest differs from `base_digest`. Rollback restores the exact pre-change bytes atomically and records a new change event; it never deletes audit history.

### 23.4 Compatibility

Readers accept only schema versions they explicitly support. A newer version returns `INCOMPATIBLE_VERSION` without mutation. Older supported versions are migrated through pure, sequential migrations after preview and backup. No best-effort field guessing is allowed.

## 24. Normative router contract

### 24.1 Deterministic boundary

The CLI deterministically performs configuration resolution, risk flag derivation from declared side effects, provider eligibility, rule application, scoring, tie-breaking, approval calculation, and output validation. A model may classify natural-language intent into a proposed structured `RouteInput`; the CLI validates it, shows assumptions that affect the route, and never lets model prose directly select or invoke a provider.

`RouteInput` requires `request`, `task_family`, `desired_outcome`, `deliverable_kind`, `execution_mode`, `declared_side_effects`, `data_inputs`, `egress_destinations`, `urgency`, `uncertainties`, `scope_systems`, `estimated_sessions`, `downstream_impact`, `reversibility`, and `requested_capabilities`. `workspace` and `project` are nullable. `task_family` is one of `explain`, `research`, `shape`, `prototype`, `implement`, `debug`, `review`, `analyze`, `operate`, or `administer`. `deliverable_kind` is `response-only`, `local-artifact`, `project-change`, or `external-action`; it describes the highest-impact requested output, not merely intermediate tool use. `execution_mode` is `serial` or `independent-fanout`. `urgency` is `normal` or `urgent`; `estimated_sessions` is `one`, `multiple`, or `unknown`; `downstream_impact` is `low`, `medium`, or `high`; `reversibility` is `reversible`, `costly`, or `irreversible`. Each uncertainty has `{ id, description, impact }`, where impact uses the same three-level enum. Each data input has `{ id, source_alias, category, sensitivity }`. Side effects and egress destinations use the enums declared in the provider schema.

The personal layer always resolves. When both context IDs are null, the route is personal-only. A non-null workspace with a null project is a valid workspace-level route. When project is non-null, Pragman resolves its manifest; a supplied workspace must match the linked primary workspace, while a null workspace is filled from that link. An unlinked project returns `NEEDS_INPUT` before provider selection. This permits first-run init, workspace administration, personal tasks, and not-yet-linked repositories without synthetic records.

Natural-language classification may propose these fields, but every proposed enum, system ID, side effect, capability, and sensitivity is displayed as a route-affecting assumption when not explicit in the request or configured context. Missing route-changing values cause either one focused question or `NEEDS_INPUT` in non-interactive mode.

### 24.1.1 Routing predicate and action grammar

`RoutingRule.when` is a structured expression, never free text:

```yaml
when:
  all:
    - field: task_family
      op: eq
      value: debug
    - field: declared_side_effects
      op: contains
      value: project-file-write
```

An expression contains exactly one of `all`, `any`, or `not`. `all`/`any` contain 1–20 conditions or nested expressions; nesting depth is at most 3. A condition uses a whitelisted field and operator:

| Fields | Operators |
| --- | --- |
| `task_family`, `deliverable_kind`, `execution_mode`, `urgency`, `estimated_sessions`, `downstream_impact`, `reversibility`, `effective_sensitivity` | `eq`, `in` |
| `declared_side_effects`, `requested_capabilities`, `scope_systems`, `egress_destinations`, `data_categories` | `contains`, `intersects`, `contains_all` |
| `uncertainty_max_impact`, `independent_system_count` | `eq`, `gte`, `lte` |
| `workspace`, `project` | `eq`, `is_null` |

Derived fields are pure: `effective_sensitivity` follows Section 23.1; `data_categories` is the ordered unique projection of `data_inputs`; `uncertainty_max_impact` is the maximum or `low` for an empty list; `independent_system_count` is the count of unique `scope_systems`.

`RoutingRule.action` permits only `require_capabilities`, `prefer`, `avoid`, `minimum_lane`, and `require_approval`. The first three are ordered-set IDs, `minimum_lane` follows `fast < standard < deep < operational`, and `require_approval` is `route`, `egress`, `action`, `target-specific`, or null. Rules cannot directly invoke a provider or reduce a lane/approval. Unknown fields, type mismatches, and invalid provider/capability IDs fail validation.

### 24.2 Task contract fields

A validated task contract requires:

- `schema_version`, `route_id`, `parent_route_id`, `request_digest`
- `outcome`, `lane`, `deliverable_kind`, `execution_mode`, nullable `workspace`, nullable `project`
- `in_scope`, `out_of_scope`, `assumptions`, `unresolved_conflicts`
- `capabilities`, ordered `providers`, and `provider_sequence_policy`
- `allowed_side_effects`, `data_inputs`, `effective_sensitivity`, and `egress_approvals`
- `proof`, `stop_conditions`, and `created_at`

Defaults are empty arrays, `parent_route_id=null`, and `provider_sequence_policy=stop`. Contracts are immutable; a changed route creates a new ID linked through `parent_route_id`.

### 24.3 Lane derivation

Lane selection is deterministic after classification:

- `operational` if any live infrastructure, deployment, credential, destructive, paid external action, production-data write, or external-account mutation is in scope.
- Otherwise `deep` if `independent_system_count >= 2`, `estimated_sessions` is `multiple`, `uncertainty_max_impact` is `high`, or `task_family` is `shape` with `downstream_impact=high` and `reversibility=irreversible`.
- Otherwise `standard` if `deliverable_kind` is not `response-only`, `declared_side_effects` is non-empty, or `requested_capabilities` contains more than one capability.
- Otherwise `fast`.

An explicit user lane may increase rigor. It may decrease rigor only when no operational trigger exists and no workspace prohibition is violated.

### 24.4 Eligibility, scoring, and tie-breaking

A provider is eligible only when it is installed or handoff-capable, healthy, version-compatible, supplies at least one required capability, fits the active host, and its declared side effects are allowed. Its trust policy must permit the task's effective sensitivity, and `context_policy.maximum_sensitivity` must be greater than or equal to that sensitivity in the Section 23.1 ordering. A single provider or a sequence must cover every required capability.

Eligible candidates receive an integer score:

- `+1000` explicit user selection
- `+300` matching project preference
- `+200` matching primary-workspace preference
- `+100` matching personal preference
- `+40` curated provider; `+20` workspace-approved; `+10` bundled default without a preference
- `+10` per directly supplied required capability
- `+0..20` approved outcome confidence, calculated by the formula below
- `-50` heavy workflow on a fast task; `-20` heavy workflow on a standard task

Outcome confidence uses at most the 20 most recent retained outcomes for the same provider, task family, and exact effective-sensitivity value, ordered by completion timestamp then learning ID. Let `n` be outcome count, `s` be `succeeded`, and `p` be `partial`; `failed` and `rolled-back` contribute only to `n`. The score is `floor(20 * (s + 0.5 * p) / (n + 2))`, or 0 when `n=0`. Outcomes without explicit user retention are excluded.

Prohibitions and `avoid` rules remove candidates rather than subtract score. Ties resolve by higher trust; then fewer extra capability IDs beyond the required set; then workflow weight ordered `light < standard < heavy`; then lexical provider ID. Thus “narrower” has exact arithmetic: `count(provider.capabilities - required_capabilities)`. The decision output includes every eligibility rejection, score component, matched rule, conflict, and tie-break.

### 24.4.1 Deterministic sequence selection

Capability records form a directed acyclic graph. `stage` is an integer from 0 through 100; `depends_on` contains capability IDs that must finish first. Registry validation rejects cycles, missing dependencies, incompatible requested pairs, and duplicate IDs before routing.

For at most 12 eligible providers, the CLI enumerates all provider subsets of size 1 through 4 whose union covers every required capability. Above 12 candidates it first retains the 12 highest-ranked individual providers using Section 24.4; the decision explanation records the deterministic truncation. If no subset of four covers the request, routing returns `NEEDS_ROUTE_SPLIT` and does not invent a longer sequence.

Within each covering subset, every required capability is assigned to the highest-ranked provider in that subset that supplies it, using the complete individual tie-break chain in Section 24.4. Providers assigned no capability are removed. The winning normalized subset is selected by, in order:

1. Fewest providers
2. Highest sum of individual integer scores
3. Lowest summed workflow weight (`light=1`, `standard=2`, `heavy=3`)
4. Highest minimum trust (`bundled=4`, `curated=3`, `workspace-approved=2`; discovered providers are ineligible until approved)
5. Lexically smallest sorted provider-ID tuple

For `execution_mode=serial`, providers are topologically ordered by their assigned capabilities: a provider is ready only when all dependencies assigned to other providers have completed. Among ready providers, choose the lowest minimum assigned-capability stage, then highest individual score, then lexical provider ID. A provider executes all its assigned capabilities in ascending stage/ID order. For `independent-fanout`, registry validation requires no dependency path between capabilities assigned to different providers; providers may run concurrently, but the stable contract/result order is ascending minimum stage, descending individual score, then lexical provider ID. Invalid fan-out returns `INVALID_EXECUTION_MODE` with the conflicting dependency.

### 24.5 Approval matrix

| Condition | Fast/standard | Deep | Operational |
| --- | --- | --- | --- |
| Read-only, local, public/internal data | proceed | show contract; proceed unless a material assumption exists | n/a |
| Remote egress of `internal`, `confidential`, or `restricted` data | explicit per-run egress approval | explicit per-run egress approval | explicit per-run egress approval |
| File mutation inside selected project/workspace | show route and preview before first write | explicit route approval | explicit route approval |
| External message, issue, PR, purchase, account, deploy, live-data write | explicit action approval | explicit action approval | explicit route approval plus host action approval |
| Destructive or hard-to-reverse action | explicit target-specific approval | explicit target-specific approval | explicit target-specific approval |
| Unexpected provider with heavier workflow than preferred | route approval | route approval | route approval |

Host-native permission prompts remain mandatory and cannot be pre-approved by Pragman.

### 24.6 Sequences, fallback, cancellation, and recursion

Provider sequences default to `stop`: a failed, cancelled, or invalid result stops the route. `continue-independent` is valid only for explicitly independent fan-out steps. `fallback` requires a pre-ranked, equally trusted compatible provider and user approval whenever its egress, side effects, workflow weight, or confidence differs materially. Partial evidence is retained and marked incomplete.

Every invocation carries `route_id` and `router_depth`. A provider must pass both to any handoff. Router re-entry with the same route ID returns the existing contract. A new child route is allowed only for a newly discovered subtask, sets `parent_route_id`, increments depth, and stops at depth 3 with `ROUTE_RECURSION`. Cancellation propagates to active providers where the host supports it and always prevents subsequent sequence steps.

Golden router tests assert exact lane, eligible set, ordered provider IDs, score explanation, approval requirements, and error/fallback state.

## 25. Provider and host-adapter contracts

### 25.1 Canonical provider record

A provider requires `schema_version`, `id`, `source`, `source_version`, `trust`, `capabilities`, `host_support`, `invoke`, `context_policy`, `side_effects`, `workflow_weight`, and `result_contract`. Optional fields default to `requires=[]`, `strengths=[]`, `best_for=[]`, `avoid_when=[]`, `compatibility={}`, and `evaluation_confidence=0`.

`invoke` is one of:

- `native-skill`: host adapter invokes an installed skill identifier.
- `prompt-handoff`: host adapter emits a bounded handoff prompt and verifies acknowledgement.
- `cli`: invokes a declared Pragman-owned executable and argument template.
- `manual`: renders exact user instructions and returns `HANDOFF_REQUIRED`.

Arbitrary executable paths and shell strings are forbidden. `context_policy` declares accepted context classes, maximum sensitivity, and whether redacted excerpts are accepted. `result_contract` names a bundled JSON Schema.

Provider results normalize to:

```yaml
status: succeeded | partial | failed | cancelled | handoff-required
provider_id: string
route_id: uuidv7
summary: string
artifacts: []
evidence: []
verification: []
error:
  code: string | null
  retryable: false
```

### 25.2 Discovery and shadowing

Discovery adapters emit canonical identity `{source, skill_id, version, install_scope, path_alias, digest}` without executing the skill. Identical digests collapse into one candidate. For the same source and skill ID, project installation shadows user/global installation only when version compatibility and trust are equal or higher; otherwise health is `conflict` and routing is blocked pending choice. Different sources with the same display name never shadow one another.

Health states are `unknown`, `healthy`, `degraded`, `missing`, `incompatible`, `conflict`, and `quarantined`. Scan may move `unknown` to a deterministic state. Evaluation may move `healthy`/`degraded`. A digest or version change resets health to `unknown`. Only an explicit trust action can leave `quarantined`.

### 25.3 Host adapter interface

Each host adapter implements:

- `discover(): DiscoveryRecord[]`
- `capabilities(): HostCapability[]`
- `invoke(provider, contract, boundedContext): InvocationHandle`
- `cancel(handle): CancellationResult`
- `collect(handle): ProviderResult`
- `sessionSources(selection): SessionSource[]`

`boundedContext` contains only the task contract, selected public/internal context summaries, and approved redacted excerpts. It never contains the unrestricted personal profile or raw paths. If a host cannot directly invoke a skill, the adapter uses `prompt-handoff` or returns `HANDOFF_REQUIRED`; it must not claim successful invocation.

V1 publishes and tests adapter compatibility by exact host version range in `compatibility.json`. Unsupported versions remain discoverable with health `incompatible`.

## 26. Local storage, remote processing, and retention

“Local by default” means Pragman does not synchronize or upload stored data on its own. It does not mean the active model, MCP connector, research provider, or external skill is local. Before private workspace context, session-derived content, confidential source metadata, or restricted data crosses a process or network boundary, Pragman shows a per-run egress disclosure containing:

- destination, provider, and model/service when known
- selected source aliases and data categories
- sensitivity and exact redacted excerpts or structured fields
- purpose, expected retention if declared, and whether tools may make further calls
- a content digest tied to the approval

Approval is destination- and digest-specific and expires when the route ends or content changes. Restricted data is denied by default even when redacted; a workspace may prohibit it entirely. Connectors receive minimum query context, never a whole workspace. Spawned agents receive the immutable task contract and explicitly selected context only.

Default local retention:

| Data | Default | User control |
| --- | --- | --- |
| Rebuildable skill/provider index | until next rebuild or 30 days | purge anytime |
| Session metrics and redacted evidence | 30 days | per-source disable, shorten, purge |
| Generated reports | until deleted by user | configurable TTL |
| Route evidence | 90 days | shorten, export, purge |
| Change/rollback history | retained while target exists | archive; snapshots expire after 90 days unless pinned |
| Raw transcripts | never copied | source owner controls original |
| Egress approval records | 90 days, metadata and digest only | purge |

`pragman doctor` reports retention state; `pragman sessions purge` and `pragman history purge` provide previewable deletion. Export replaces paths with aliases and omits content hashes unless explicitly requested.

## 27. Session adapter contract

### 27.1 Normalized event

Each event requires `schema_version`, `event_id`, `session_id`, `source`, `source_version`, `source_alias`, `sequence`, `timestamp`, `event_type`, `sensitivity`, and `provenance`. Optional fields are `task_id`, `role`, `tool_name`, `duration_ms`, `status`, `content_ref`, `metrics`, and `unsupported`.

`event_type` is one of `session-start`, `session-end`, `user-message`, `assistant-message`, `tool-start`, `tool-end`, `tool-error`, `approval`, `compaction`, `interruption`, `handoff`, `task-boundary`, or `unsupported`. `event_id` is a hash of source alias, stable session identity, sequence, and normalized event type; `task_id` is explicit when the source supplies one and otherwise a deterministic inferred segment marked in provenance. Content references point to ephemeral redacted buffers, never copied raw text.

### 27.2 V1 sources and compatibility

- Codex: JSONL session files under a user-selected Codex session root; adapter fixtures cover the format versions listed in `compatibility.json`.
- Claude Code: project JSONL under a user-selected Claude project root; the same explicit version policy applies.
- Cursor: exported Markdown is the normative v1 baseline. Cursor local database/history reading is experimental, read-only, version-pinned, and never required for v1 acceptance.

Every adapter declares tested format digests/versions. Unknown versions scan metadata only and return `UNSUPPORTED_FORMAT` unless the user enables best-effort mode; best-effort output cannot support automatic configuration changes.

### 27.3 Selection and containment

Selection requires source adapter, canonical root, inclusive date range, project aliases, and content categories. Roots are resolved before scanning, must be user-selected or a known host root approved during init, and may not be `/`. Symlinks resolving outside an approved root are skipped. Defaults are 50 MiB per file, 500 MiB per run, and 250,000 events; overrides require an explicit preview of affected sources.

One corrupt session or unsupported event yields partial success: valid events continue, the source alias and reason enter a quarantine report, and no raw content is copied. If more than 10% of selected sessions fail or any identity collision occurs, derived recommendations are report-only and cannot be applied.

## 28. Common skill package and degradation contract

Each skill directory contains:

- `SKILL.md` with valid portable frontmatter (`name`, `description`) and a concise host-neutral workflow
- `references/` for detailed schemas, provider guidance, and host variations loaded only when needed
- optional `scripts/` limited to reviewed, skill-local deterministic helpers
- `agents/openai.yaml` and generated host metadata where supported
- `evals/` with baseline, expected invariants, and counter-examples
- `COMPATIBILITY.md` naming minimum CLI and tested hosts

Descriptions state both when to use and when not to use the skill. Skill instructions mark privacy checks, approval gates, fallback behavior, and CLI boundaries. Cross-skill references use capability IDs, not filesystem-relative calls into another installed collection.

Skills locate `pragman` through the host's executable lookup and verify `pragman --version --json` against their declared range. They never install it automatically.

| Skill | Valid without CLI | CLI-required behavior |
| --- | --- | --- |
| init | guided manual interview and operating-map draft | host/skill scan, validation, writes, health test |
| workspace | explain model and draft files for approval | schema validation, atomic writes, link/rollback |
| router | shape a transparent manual recommendation | deterministic eligibility, scoring, evidence record |
| research | full reasoning workflow | provider discovery and local structured evidence |
| shape | full reasoning workflow | persisted task contract validation/history |
| prototype | create/iterate an artifact through host tools | deterministic HTML packaging and report linking |
| analyze | analyze user-supplied material | local metrics, evidence indexing, HTML report |
| unfck | interview and analyze explicitly supplied excerpts | session discovery/parsing/redaction, diffs, rollback |

Skill-only mode must disclose that deterministic guarantees are unavailable. Acceptance criteria involving persisted config, scanning, routing scores, session ingestion, or rollback require a compatible CLI; reasoning and manual artifact criteria do not.

## 29. Reproducible acceptance matrix

Public release gates use sanitized repository fixtures only. Private reference-workspace validation produces an optional local attestation and may delay an internal rollout, but it cannot block, pass, or substitute for reproducible public CI.

| Area | Minimum scenarios | Observable oracle |
| --- | --- | --- |
| Workspace | personal + two workspaces + project + explicit secondary conflict | exact merged JSON, provenance, conflict prompt, atomic rollback |
| Init | clean install, populated install, broken/shadowed provider | no secret-store reads; exact discovered identities and proposed diff |
| Router | 8 fast, 8 standard, 8 deep, 8 operational; overrides and ties | exact lane, ordered providers, score explanation, approval matrix result |
| Research | quick, technical source-first, fan-out, decision, internal | decision answered; source/fact/inference separation; egress enforced |
| Shape | vague idea, oversized build, low-evidence bet | all shaped fields; smallest test; explicit non-goals and route |
| Prototype | one flow, useful variants, private design context | self-contained escaped HTML; no network by default; feedback promotion |
| Analyze | successful task, drifted task, blocked task | all dimensions considered; grouped actions; no unapproved mutation |
| Unfck | mixed-host history, injected transcript, corrupt source, approval/rollback | secrets absent; injections inert; partial success; exact reversible diff |
| Providers | duplicate, incompatible, changed digest, manual handoff, partial sequence | exact health and shadow state; normalized result; no false success |
| Security | traversal, symlink escape, secret corpus, malicious metadata/HTML | access denied or content redacted; no execution/egress/network HTML |

Required CI matrix:

- Ubuntu and macOS
- Node.js 22 and 24
- Skill schema/static validation on every commit
- Deterministic CLI/unit/fixture/security suites on every commit
- Recorded/simulated host-adapter contract tests for Codex, Claude Code, and Cursor Markdown export
- Live behavioral smoke tests on the latest supported Codex and Claude Code before release
- Cursor portable skill validation plus Markdown adapter acceptance before release

Behavioral graders use binary invariants first and rubric scores only for qualitative utility. Every rubric publishes its prompt, anchors, and minimum threshold. A release fails on any privacy, approval, secret-redaction, path-containment, schema, or rollback invariant regardless of aggregate score.

## 30. CLI automation contract

JSON responses use one envelope:

```json
{
  "ok": true,
  "command": "route",
  "schema_version": 1,
  "data": {},
  "warnings": [],
  "error": null
}
```

Errors set `ok=false`, `data=null`, and include `{ code, message, details, retryable }`. Exit classes are `0` success, `2` invalid input/config, `3` needs input/approval, `4` unavailable/incompatible dependency, `5` privacy/security denial, `6` temporary failure/lock, and `10` internal error. Human text is never the automation contract.

`--non-interactive` never guesses a route-changing answer or approves egress/mutation. It returns exit 3 with structured required inputs. Preview output includes the target digest, proposed operations, approval classes, and expiry. Apply requires that preview digest and obtains the mutation lock. A single atomic transaction covers all files in one Pragman state root; cross-root changes are separate previews and approvals.

## 31. Research basis and adopted patterns

V1 deliberately builds on established patterns rather than reproducing existing collections:

- The open [`skills` CLI](https://github.com/vercel-labs/skills) informs portable discovery, project/global installation, and `skills.sh` distribution.
- [gstack](https://github.com/garrytan/gstack) informs executable skill tooling, onboarding, browser-backed workflows, retrospectives, and local evidence loops.
- [Compound Engineering](https://github.com/EveryInc/compound-engineering-plugin) informs composable provider workflows, durable artifacts, and specialist skill routing.
- [Superpowers](https://github.com/obra/superpowers) informs explicit workflow gates, behavior-first development, debugging discipline, and verification before completion.
- [Anthropic's Agent Skills guidance](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) informs concise entrypoints, progressive disclosure, degrees of freedom, and evaluation-driven authoring.
- [`skills.sh` documentation](https://www.skills.sh/docs) informs installability and public discovery expectations.
- Current [agent-skill supply-chain research](https://arxiv.org/abs/2605.11418) and [enterprise skill security guidance](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/enterprise) support explicit trust tiers, executable-resource review, transcript/provider distrust, and version-aware health.

These projects are providers and references, not vendored dependencies. Their names, interfaces, and behaviors may change; curated provider records therefore pin reviewed compatibility and fail visibly on drift.
