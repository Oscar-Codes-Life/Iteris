# Iteris review policy

Apply these rules to changed behavior and the affected callers. Cite the exact relevant rule when reporting a policy violation. Prefer a concrete failure mechanism or a simpler behavior-preserving alternative over stylistic preferences.

- A ticket may complete only after the exact published commit passes its required reviews and configured checks.
- Missing, stale, timed-out, cancelled, or malformed review evidence must never be treated as successful validation.
- A ticket and its automatic repair rounds retain the same execution selection and review/check configuration.
- Retrying delivery must reuse an existing branch PR and preserve the author's PR description when updating review evidence.
- GitHub issue labels, Trello card transitions, and custom task completion must remain isolated to their respective providers.
- Review investigation cannot edit the ticket checkout or publish changes; repair requires a new independent review.
- Related persisted state must remain consistent after failure. Config migration must preserve the original configuration when validation fails.
- Do not expose credentials in model context, persisted reports, or logs.

For `src/review/**` and `src/agent/runner.ts`, examine both failure and retry paths, final commit identity, and cancellation. For `src/harness/**`, verify that restricted phases cannot inherit configured write-capable flags. For `src/custom/**`, preserve task identity and source isolation. For UI changes, keep blocked and incomplete outcomes visibly distinct from success.

Size and complexity metrics are prompts for investigation, not automatic violations. A structural blocker needs a demonstrated regression and a concrete, scoped alternative. Broad unrelated redesign should remain a follow-up proposal.
