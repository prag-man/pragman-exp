# Compatibility

- Pragman CLI/router/registry: `>=0.1.0-beta.0 <1.0.0`
- Node.js: `>=22 <25`
- Tested skill hosts: Codex, Claude Code, Cursor portable skill mode

Native invocation depends on the active host adapter. Prompt and manual handoff remain available when a capability cannot be invoked natively, but degradation and success verification must be explicit.
