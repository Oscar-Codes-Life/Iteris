# Releasing Iteris

Every release has a semantic version, an annotated Git tag, user-facing notes, and a checked package. Tags are immutable. The GitHub workflow creates a draft; a maintainer publishes it after reviewing the results.

## Version policy

- **Patch** for compatible fixes: `1.2.0` → `1.2.1`.
- **Minor** for compatible new capabilities: `1.2.0` → `1.3.0`.
- **Major** for breaking behavior or configuration changes: `1.2.0` → `2.0.0`.

Application versions and `.iteris.json` format versions are separate. Do not increment the configuration format unless its schema requires migration. The first tagged release is v1.2.0. Version 1.1.0 was prepared but never tagged, and earlier development used an untagged 1.0.0 package baseline.

## Prepare the release commit

1. Update `package.json` and `RELEASE_VERSION` in `install.sh` together. The CLI and Codex client metadata read the package version automatically.
2. Add a dated entry to `CHANGELOG.md` and write `docs/releases/vX.Y.Z.md`. Include the user benefit, commands to try, compatibility, upgrade steps, and material limitations.
3. Update the README's version, release-notes link, and tagged installation URLs. Refresh screenshots when the UI changes; label sample data.
4. Install the locked dependencies, then run:

   ```bash
   pnpm install --frozen-lockfile
   pnpm run typecheck
   pnpm test
   pnpm run release:check
   npm pack --dry-run
   git diff --check
   ```

5. Review the package contents and the full diff, then commit the release. Do not include project credentials, `.iteris` state, or generated packages. The package uses a file allowlist.

## Tag and prepare the GitHub draft

After the release commit is approved and the working tree is clean, create an annotated tag on that commit. For example, for this release:

```bash
git tag -a v1.2.0 -m "Iteris v1.2.0 — Finish the backlog"
```

When ready to share the release commit and tag:

```bash
git push --atomic origin master v1.2.0
```

If branch protection requires a PR, merge through that process first and tag the merged release commit instead. Never tag an older commit that lacks the release changes, and never move a published tag.

The **Prepare release** workflow runs the full CI matrix (Node 22 on Linux/macOS and Node 24 on Linux), checks that the tag matches the package version, builds the package, generates `SHA256SUMS`, and creates a draft GitHub release. It can update an existing draft on a rerun; it refuses to overwrite a published release. The workflow does not publish to npm.

## Publish

1. Confirm every CI job passed. Read the release notes in the GitHub draft and check that its screenshot and links resolve.
2. Download `iteris-X.Y.Z.tgz` and `SHA256SUMS`; verify with `sha256sum -c SHA256SUMS` on Linux or `shasum -a 256 -c SHA256SUMS` on macOS.
3. Smoke-test the tagged installer in a disposable checkout with a user-owned `ITERIS_INSTALL_DIR` and an existing `ITERIS_BIN_DIR` on `PATH`. Check `iteris --version`, `iteris --help`, and setup. Never point this check at a running installation.
4. Verify the Instances view at normal and narrow terminal widths. Confirm one worktree queue with your chosen authenticated harness before making claims about a live model run; automated tests use scripted harnesses.
5. Publish the reviewed draft in GitHub Releases. Tags and their raw installer URLs are publicly accessible as soon as the tag is pushed, even while the release is a draft.

## Fixes and rollback

Ship corrections with a new patch version and tag. Do not replace assets on published releases.

To opt out of parallel execution, run `iteris workspace local` for future queues. To stop a ticket from retrying, cancel it with `iteris cancel <key>` or set `recovery.maxTaskAttempts`. To install another compatible tagged release, pass `--version X.Y.Z` to the installer. Finish active work first and check that release's configuration compatibility. v1.2.0 is the first tag, so there is no earlier tag to roll back to. Keep project state and retained worktrees until their work is resolved.
