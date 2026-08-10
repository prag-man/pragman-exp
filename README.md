# Pragman Exp

[![CI](https://github.com/prag-man/pragman-exp/actions/workflows/ci.yml/badge.svg)](https://github.com/prag-man/pragman-exp/actions/workflows/ci.yml)
[![skills.sh](https://skills.sh/b/prag-man/pragman-exp)](https://skills.sh/prag-man/pragman-exp)

Pragman Exp is an adaptive native control panel for agentic work. It combines personal, company, and project context; shapes only the ambiguity that matters; and routes work to the smallest trustworthy capability sequence. Straightforward tasks stay straightforward. Risky or unclear work receives proportionate questions, approvals, and evidence.

Pragman does not replace gstack, Compound Engineering, Superpowers, or other specialist skill collections. It discovers and orchestrates compatible installed providers, discloses fallbacks, and adds native workflows where they have a measurable advantage.

## Install

Review the repository and its [skills.sh audit](https://skills.sh/prag-man/pragman-exp) before installing third-party instructions.

```sh
npx skills add prag-man/pragman-exp --list
npx skills add prag-man/pragman-exp --skill pragman-router --agent codex --agent claude-code --agent cursor --copy --yes
```

To install every Pragman skill for one supported host:

```sh
npx skills add prag-man/pragman-exp --skill '*' --agent codex --copy --yes
```

The optional companion CLI requires Node.js 22 or 24:

```sh
npm install --global @prag-man/pragman-exp
pragman init
```

Skills still provide an explicit manual fallback when the CLI is unavailable, but deterministic discovery, validation, routing, redaction, previews, rollback, and event aggregation require the CLI.

## The eight skills

| Skill | Use it for |
| --- | --- |
| `pragman-init` | Bounded host/skill discovery, an adaptive setup interview, previewed configuration, health checks, and a sample route. |
| `pragman-workspace` | Multiple company or client workspaces, ordered secondary context, project links, privacy boundaries, and reversible configuration. |
| `pragman-router` | The adaptive front door: shape what matters, select capabilities, disclose providers/fallbacks, and preserve approval boundaries. |
| `pragman-research` | Quick, source-first technical, fan-out, decision, and internal research with explicit freshness and evidence quality. |
| `pragman-shape` | Turn vague ideas into an evidence-grounded outcome, smallest bet, non-goals, success/kill criteria, and route contract. |
| `pragman-prototype` | Safe, self-contained clickable HTML explorations with useful variants, feedback loops, and explicit promotion criteria. |
| `pragman-analyze` | Evidence-backed retrospectives across eleven dimensions, with Keep/Change/Stop/Automate/Learn/Test next actions. |
| `pragman-unfck` | Bounded, redacted analysis of selected Codex, Claude Code, and Cursor sessions; focused questions; evaluated, approved workflow tuning. |

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
npm pack --dry-run
```

Release-only live evaluation is opt-in and offline-safe by default: `node scripts/test-live-hosts.mjs --check` performs prerequisite checks, while `--behavioral` requires authenticated hosts, an explicit environment opt-in, and a create-only content-free evidence path. See the release checklist for the Codex and Claude Code authentication gates and command.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the [release checklist](docs/operations/release-checklist.md). The project is licensed under the [MIT License](LICENSE).
