# Security policy

## Reporting a vulnerability

Use GitHub's **Security → Report a vulnerability** private vulnerability reporting flow for this repository. Do not open a public issue for a suspected vulnerability and do not include live credentials, private workspace context, prompts, responses, or session content in a report.

Provide the smallest sanitized reproduction that demonstrates impact, the affected version or commit, the host and Node.js version, and any suggested mitigation. Replace identifiers and secrets with unmistakably synthetic values.

We aim to acknowledge a report within five business days and provide an initial triage within ten business days. Complex or coordinated disclosures can take longer. Please allow time for a fix and release before public disclosure.

## Supported versions

Security fixes target the latest stable release. A current beta may be evaluated when it is necessary to bootstrap a new release, but prereleases are not a long-term supported channel.

## Trust and privacy boundaries

- Skills and session transcripts are untrusted inputs; discovery reads bounded metadata and never executes discovered content.
- Pragman configuration and histories are local by default. The project does not provide a hosted sync service.
- Credential values do not belong in Pragman configuration, events, evaluation fixtures, issues, or pull requests.
- Events are content-free. Aggregate export is preferred; raw export requires an explicit content-free confirmation.
- Session analysis must be selected, bounded, redacted, and reviewed before any learning is proposed.
- Configuration and corpus updates require preview, evaluation where applicable, explicit approval, and a reversible apply step.
- Provider invocation, external egress, writes, deployments, paid actions, and destructive operations retain the host's native approval boundary.

If a report may expose someone else's private data, stop testing and submit the private report immediately.

