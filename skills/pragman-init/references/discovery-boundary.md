# Discovery Boundary

Use discovery to inventory known host metadata, not to search a home directory.

## Allowed inputs

- Fixed Codex, Claude Code, and Cursor skill metadata roots.
- A repository root explicitly selected by the user.
- Portable `SKILL.md` frontmatter (`name`, `description`) within the CLI byte/count bounds.
- File existence and stable path aliases for approved instruction/context metadata.

## Forbidden inputs and actions

- Never read credential, secret, token, authentication, keychain, `.env`, browser-profile, or session-content stores.
- Never recurse beyond the known skill-directory shape.
- Never follow symbolic links outside an approved root.
- Never parse or quote a skill body during scan.
- Never execute, import, source, install, or invoke discovered content.
- Never emit absolute paths; use aliases such as `codex:user:review`.

## Health and shadowing

Emit `{source, skill_id, version, install_scope, path_alias, digest}`. Valid metadata begins `healthy`; malformed or oversized metadata is `degraded`. Identical metadata may let a project installation shadow a user installation. Different digests for the same source and skill ID are `conflict`; block configuration writes until the user chooses. Different sources with the same display name do not shadow each other.

When scan limits are reached, mark the result truncated. Do not infer health for omitted entries.
