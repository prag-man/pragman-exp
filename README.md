# Pragman Exp

[![CI](https://github.com/prag-man/pragman-exp/actions/workflows/ci.yml/badge.svg)](https://github.com/prag-man/pragman-exp/actions/workflows/ci.yml)
[![skills.sh](https://skills.sh/b/prag-man/pragman-exp)](https://skills.sh/prag-man/pragman-exp)

Pragman Exp is an **adaptive control panel for agentic work**. Its eight portable skills and optional local CLI help an agent decide what matters, use the right capability, keep context separated, and leave evidence behind. Simple work stays fast; ambiguous or risky work gets proportionate shaping, approvals, and verification.

It works with Codex, Claude Code, and Cursor, and can discover compatible providers such as gstack, Compound Engineering, and Superpowers without silently replacing, rewriting, or trusting them.

## What it accelerates

Pragman is most useful when an agent can otherwise lose time to the wrong kind of work:

- **Less ceremony:** the router skips interviews for obvious, bounded, low-risk requests.
- **Less rework:** shape the outcome, non-goals, success evidence, and kill criteria before implementation.
- **Faster decisions:** research only until the decision threshold is met, then turn evidence into an action.
- **Safer context:** keep personal, company, client, and project context in explicit layers with privacy boundaries.
- **Better learning:** analyze completed work and tune only approved, reversible workflow overlays.
- **Visible risk:** preserve approval boundaries for writes, credentials, egress, paid actions, destructive changes, and deployments.

The skills are complementary, not a mandatory eight-step ceremony. Start with `pragman-router`, then add only the skills your workflow needs.

## Install the skills from skills.sh

Review the repository and its [skills.sh audit](https://skills.sh/prag-man/pragman-exp) before installing third-party instructions. Skills are project-local by default and remain useful without the CLI.

List the catalog:

```sh
npx skills add prag-man/pragman-exp --list
```

Install the adaptive front door for Codex, Claude Code, and Cursor:

```sh
npx skills add prag-man/pragman-exp \
  --skill pragman-router \
  --agent codex --agent claude-code --agent cursor \
  --copy --yes
```

Install the complete set for one host:

```sh
npx skills add prag-man/pragman-exp --skill '*' --agent codex --copy --yes
```

Use a skill once without keeping a project installation when your `skills` CLI supports `use`:

```sh
npx skills use prag-man/pragman-exp --skill pragman-shape --agent codex
```

To update an existing installation:

```sh
npx skills update -y
```

## Install the optional CLI from npm

The CLI package name is scoped: **`@prag-man/pragman-exp`**. `pragman` is the installed binary name, not the npm package name. The current repository version is the beta channel, so install the beta tag explicitly:

```sh
npm install --global @prag-man/pragman-exp@beta
pragman --version
pragman init
```

When a stable release is available, the normal command is:

```sh
npm install --global @prag-man/pragman-exp
```

The CLI requires Node.js 22 or 24. Check the registry before installing if you are testing a new release:

```sh
npm view @prag-man/pragman-exp@beta version
```

If that command returns `E404`, npm has not received the first public package yet; changing a local `package.json` cannot create a registry entry. The release owner must authenticate once and bootstrap the beta from a verified checkout:

```sh
npm login
npm ci
npm run build
npm run validate:skills
npm run package:verify
npm publish --access public --tag beta
```

After that, `npm install --global @prag-man/pragman-exp@beta` resolves normally. Until the bootstrap is complete, use the skills directly or install the CLI from the public repository:

```sh
npm install --global github:prag-man/pragman-exp
```

The repository's `prepare` hook builds the GitHub installation. Never paste an npm token into a prompt, issue, config file, or commit.

Skills have an honest manual fallback when the CLI is unavailable. Deterministic discovery, schema validation, routing, redaction, preview/apply, rollback, and event aggregation require a compatible CLI.

## A fast operating loop

Use the following loop instead of invoking every skill on every task:

1. **Set up once:** install the CLI, run `pragman init`, and create or link the workspaces you actually use.
2. **Route each non-trivial request:** let `pragman-router` choose Fast, Standard, Deep, or Operational work and identify the minimum capability contract.
3. **Shape only when uncertainty is expensive:** use `pragman-shape` for vague, oversized, or premature requests; use `pragman-research` when current evidence changes the decision.
4. **Make uncertainty tangible:** use `pragman-prototype` for a disposable clickable flow before committing to a product or UI direction.
5. **Keep context clean:** use `pragman-workspace` for reusable company, client, venture, or project context rather than copying it into every prompt.
6. **Close the loop:** use `pragman-analyze` after meaningful work; use `pragman-unfck` when repeated sessions are slow, chaotic, or unreliable.
7. **Measure selectively:** record content-free events only when comparing outcomes matters; never trade privacy for telemetry.

Typical combinations:

| Situation | Start with | Then use | Result |
| --- | --- | --- | --- |
| A normal coding request | `pragman-router` | The selected capability | Direct work without a needless interview |
| A vague feature idea | `pragman-shape` | `pragman-research` or `pragman-prototype` | A smallest valuable, testable bet |
| A decision needing current facts | `pragman-research` | `pragman-shape` or `pragman-router` | Evidence tied to an explicit action |
| Multiple clients or projects | `pragman-workspace` | `pragman-router` | Reusable context without cross-client leakage |
| A risky change or deployment | `pragman-router` | The approved specialist | Explicit side effects and host-native approval |
| Repeated agent friction | `pragman-unfck` | `pragman-analyze` | Reversible workflow improvements backed by evidence |

The prompts can be as simple as:

```text
Use $pragman-router for this request. Keep the fastest safe path and ask only questions that change the route.

Use $pragman-shape to turn this idea into a smallest valuable bet with success and kill criteria.

Use $pragman-research to gather the minimum current, primary evidence needed to choose between these options.
```

## The eight skills

| Skill | Use it for |
| --- | --- |
| `pragman-init` | First-time onboarding, bounded host/skill discovery, health checks, repair, and a reviewable operating map. |
| `pragman-workspace` | Personal, company, client, venture, and project context with explicit ownership, ordering, privacy, and links. |
| `pragman-router` | The adaptive front door: choose the smallest trustworthy capability sequence and preserve approval boundaries. |
| `pragman-research` | Source-first technical, market, decision, multi-source, and internal research with freshness and evidence quality. |
| `pragman-shape` | Convert vague or oversized requests into an outcome, smallest bet, non-goals, success evidence, and kill criteria. |
| `pragman-prototype` | Create safe, self-contained clickable HTML artifacts that let people decide before production implementation. |
| `pragman-analyze` | Explain outcomes from observable evidence and produce Keep/Change/Stop/Automate/Learn/Test next actions. |
| `pragman-unfck` | Analyze selected Codex, Claude Code, and Cursor sessions and propose evaluated, reversible workflow tuning. |

Each skill has a focused trigger, a portable workflow, a CLI-unavailable fallback, compatibility notes, and sanitized evaluation scenarios. The detailed descriptions and instructions are indexed individually on [skills.sh](https://skills.sh/prag-man/pragman-exp).

`pragman-router` is adaptive by default. It skips interviews for obvious bounded low-risk requests and increases rigor only when ambiguity, impact, side effects, privacy, cost, or reversibility justify it.

## CLI commands

Every command supports concise human output. The stable command contract also supports `--json` and `--non-interactive`; mutating commands support preview-before-apply and stale-preview protection.

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

Run `pragman <command> --help` for command-specific inputs. Configuration is layered personal → workspace → project, and one person can create and link multiple isolated workspaces.

`pragman route` returns an immutable route with `execution_status: not-started`; provider selection is not reported as completed work. Host integrations execute that route through `createRouteExecution`/`executeReadyRoute` in `host-adapters/orchestrator`: the seam projects each ordered `provider_assignment` into a bounded adapter contract, applies stop/fallback/independent policies, propagates cancellation, and reports success only when verified provider results cover every routed capability.

## Privacy, events, and learning

Pragman is local by default. It does not require a hosted account or daemon, store credentials, sync private context to a Pragman service, or silently edit third-party skills. Session sources are treated as untrusted input, selected explicitly, bounded, and redacted before analysis.

The CLI records content-free events for routed work and evaluation runs, and compatible host integrations can use the adapter lifecycle observer. Portable direct skill use is not automatically observable: record its lifecycle and outcome explicitly with `pragman events record` when measurement matters. Events contain identifiers, digests, lifecycle state, durations, route evidence, and approved outcome scores—not prompts, responses, session content, secrets, or workspace prose. Aggregates are the default export. Raw evidence has bounded retention and can be purged locally.

Evaluations compare immutable skill and metric digests. Observations may become evaluation candidates, but Pragman changes configuration or a learning corpus only after a visible preview, evaluation, and user approval. It never self-modifies a public or third-party skill.

## Development

```sh
npm ci
npm test
npm run build
npm run validate:skills
npm run evals
npm run package:verify
npm pack --dry-run
```

Release-only live evaluation is opt-in and offline-safe by default: `node scripts/test-live-hosts.mjs --check` performs prerequisite checks, while `--behavioral` requires authenticated hosts, an explicit environment opt-in, and a create-only content-free evidence path. See the [release checklist](docs/operations/release-checklist.md) for the Codex and Claude Code authentication gates, npm bootstrap, trusted publishing, and skills.sh verification steps.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). The project is licensed under the [MIT License](LICENSE).
