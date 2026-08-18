# Compatibility

- Pragman CLI/runtime: `>=0.1.0-beta.0 <1.0.0` for deterministic HTML packaging
- Node.js: `>=22 <25`
- Tested skill hosts: Codex, Claude Code, Cursor portable skill mode

The bundled HTML starter works without the CLI. Host-specific design or browser skills are optional capabilities selected through the provider registry; their absence must not block the portable fallback.
