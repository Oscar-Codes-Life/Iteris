# Review quality evaluation

This is a **synthetic smoke corpus**, not historical production data and not a claim of measured accuracy. Its 30 cases comprise 12 seeded defects, 12 clean controls, three acceptance gaps, and three structural changes. Expected observations are authored hypotheses; the structural cases especially need human adjudication. Before/after files all parse as JavaScript modules.

Build and list cases without calling a model:

```sh
npm run eval:review
```

Run one case, or explicitly spend provider usage on the full corpus:

```sh
npm run eval:review -- --case zero-default --harness codex
npm run eval:review -- --all --harness claude --model opus
```

The runner uses your installed/authenticated CLI. It does not install providers, repair code, create remotes, push, or open PRs. Every case gets a temporary local Git repository and `node --check` as its configured check. Syntax checks deliberately do not expose the seeded behavioral bugs. Actual intent is supplied in the ticket; expected findings are withheld from the reviewer. Temporary repositories are removed after each case. Evidence is retained under `.iteris/evaluations/<timestamp>/` or `--out DIR`.

Each run writes the ordinary review artifacts plus `adjudications.json`. Fill its `human` fields with finding IDs and explanatory notes. Confirm that findings point to real behavior, rather than merely matching words in the expected observation. Record a false block for a clean control rejected without a valid reason. Missing findings on known-defect cases are false negatives. Structural findings should explain a useful simplification and preservation of behavior.

For comparison, run the same cases with the same provider, model, effort, deadline, and check configuration. Preserve the existing version's review prompt and outputs as a baseline; the legacy prompt is available in Git history. Do not let that legacy fix-and-push prompt publish anything when reproducing the baseline. Use a disposable environment and a review-only adaptation, recording the deviation. Do not use an agent's own acceptance of its suggestions as the correctness label.

Compute blocking precision as human-confirmed blocking findings divided by all reported blocking findings. Compute known-defect recall against the labeled defects; report false blocks on clean controls separately. Track incomplete runs, latency (median and p95), duplicate findings, and reviewer disagreements. Cost is currently unavailable from the normalized CLI transport and must not be inferred. This harness disables repair; assess repair-induced regressions on a separate human-reviewed pilot with repairs enabled.

Use these cases for development, then add historical real-world changes and a held-out set before tuning prompts against a reported score. Repeat selected cases to estimate nondeterminism. A provisional target is 90% precision on blockers with improved recall and no rise in false blocks; it is a target, not a result. The pipeline tests use fake agents and cannot establish any of these metrics.
