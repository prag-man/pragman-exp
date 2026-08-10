# Pragman Exp release checklist

This runbook has two deliberate stages: one authenticated beta bootstrap, then stable OIDC trusted publishing. Never publish from a dirty tree, an unreviewed package archive, or a local path outside a clean clone.

## 1. Prepare the release candidate

- [ ] Confirm Node.js 22 and 24 CI is green on macOS and Ubuntu.
- [ ] Confirm the branch contains exactly eight public skills and the documented CLI contract.
- [ ] Run `npm ci`, `npm test`, `npm run build`, `npm run validate:skills`, and `npm run evals` in a clean clone.
- [ ] Run `npm pack --dry-run`, then create one archive with `npm pack --json` and pass that exact archive to `node scripts/verify-package.mjs <archive>`.
- [ ] Inspect the file list, package size, license, repository metadata, private-path/secret scan, and checksum.
- [ ] Run `node scripts/test-live-hosts.mjs --check` and resolve every prerequisite before opting into sanitized live tests.
- [ ] Run the live Codex and Claude Code smoke tests and the Cursor Markdown adapter acceptance. Save only content-free results.

## 2. Bootstrap `0.1.0-beta.0`

The first scope/package publication cannot use trusted publishing until npm knows the package. This is the only token/session-authenticated publication step.

- [ ] Set the package version to `0.1.0-beta.0` without creating a release tag.
- [ ] Rerun the complete gate and verify the newly packed archive.
- [ ] Run `npx npm@11.5.1 whoami`. If it fails, stop at this **mandatory credential gate** and ask the package owner to authenticate locally. Do not request or copy a token into configuration, chat, logs, or GitHub Actions.
- [ ] Publish the verified archive once: `npx npm@11.5.1 publish <archive> --access public --tag beta`.
- [ ] Confirm npm resolves `@prag-man/pragman-exp@beta` to `0.1.0-beta.0` with the expected integrity and repository.
- [ ] Install the beta into a temporary prefix and run its `pragman doctor --json`.
- [ ] Do not call v1 complete and do not create the stable GitHub release from the beta.

## 3. Configure stable trusted publishing

- [ ] In npm package settings, add a GitHub Actions trusted publisher for organization `prag-man`, repository `pragman-exp`, and workflow `release.yml`; explicitly allow `npm publish`. Add an environment only if the workflow is updated to use the same environment.
- [ ] Keep `id-token: write` and `contents: write`; do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN`.
- [ ] Confirm the workflow installs npm `11.5.1` or newer, publishes with `--provenance`, and creates the GitHub release only after npm succeeds.
- [ ] Protect the release workflow and `main` with review/CI rules appropriate to the repository.

## 4. Publish stable `0.1.0`

- [ ] Change only the version from the verified beta source to stable `0.1.0` and rerun every local gate.
- [ ] Merge the version commit and confirm `main` CI is green.
- [ ] Create a signed annotated tag: `git tag -s v0.1.0 -m "Pragman Exp v0.1.0"` (or SSH-sign it with a signing key registered and verified on GitHub).
- [ ] Verify locally with `git verify-tag v0.1.0`, then push only the tag.
- [ ] Watch `release.yml`. It must verify the GitHub-verified tag signature, main ancestry, package/tag version match, tests, skills, evals, exact package archive, checksum, OIDC publication with provenance, and GitHub release creation.
- [ ] Confirm npm stable metadata, provenance, tarball integrity, GitHub tag/commit, release archive, and checksum all resolve to the same source commit.

## 5. Verify remote install and skills.sh

- [ ] Set `PRAGMAN_REMOTE_INSTALL_TESTS=1` only in a disposable clean clone, then run `node scripts/test-remote-install.mjs --run`.
- [ ] Verify `npx skills add prag-man/pragman-exp --list` returns exactly the eight expected skill names.
- [ ] Verify one-skill and all-skill copy installs in isolated Codex, Claude Code, and Cursor project roots. Do not use global install paths.
- [ ] Verify the installed `pragman-router` copy contains exactly the tagged repository files; pinned `skills@1.5.9` has no `use` subcommand.
- [ ] Check [skills.sh/prag-man/pragman-exp](https://skills.sh/prag-man/pragman-exp) after the documented indexing/cache interval. Recheck rather than republishing if the first lookup is stale.
- [ ] Run a fresh clone of `origin/main` through the full gate after publication.
- [ ] Record only commit/tag, public URLs, versions, checksums, pass/fail invariants, and timestamps. Never record home/worktree paths, tokens, environment values, prompts, responses, or session content.

## 6. Close

- [ ] Confirm the npm stable package, GitHub release, and skills.sh all expose the same eight skills.
- [ ] Confirm no beta tag was promoted implicitly and `latest` points to stable `0.1.0`.
- [ ] Remove local package archives and disposable install roots.
- [ ] Publish a concise, content-free release note and retain the checksum as public evidence.
