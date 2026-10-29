# Operations: the dataset workflow

`.github/workflows/dataset.yml` writes the data that checkout pages use to
autofill invoice titles, so whoever can run it with the R2 / D1 credentials
decides what company names users see (#12). This note covers the guards around
it and what a repository admin still has to set up.

## Credentials: the `dataset` environment

The `build` job declares `environment: dataset`. Environment secrets override
repository secrets of the same name, and repository secrets stay visible to the
job, so the R2 / D1 credentials belong in the environment only.

State (verified 2026-10-29):

- The `dataset` environment exists, with deployment branches restricted to
  `main` (a custom branch policy). A run from any other branch cannot read its
  secrets.
- No R2 / D1 secrets are set anywhere yet (none at repository level either), so
  the D1 and R2 steps currently log "secrets not set; skipping".

Admin steps (Settings → Environments → `dataset`):

1. Add these as **environment** secrets (not repository secrets):
   `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, `R2_BUCKET`,
   `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE`.
2. Run the workflow manually once from `main` and confirm the D1 and R2 steps
   run instead of logging "secrets not set; skipping".
3. Optional: add required reviewers to the environment if every publish should
   need a human approval (this also pauses the nightly schedule until approved).

If repository-level copies of these secrets are ever added, delete them: they
would be readable from any branch.

Whoever rotates the R2 token (yearly) writes the new value to the `dataset`
environment, not to repository secrets.

## Sanity check before publishing

Before "Publish release", the job runs `scripts/check-dataset.mjs`, comparing
`dist/manifest.json` with the previous `manifest.json` on the `data-latest`
release. It fails the run, before anything is written (dated release,
`data-latest` state, D1, R2 shards and `latest.json`), when:

- rows dropped by more than `DATASET_MAX_DROP_PCT` percent (a repository
  variable; unset means 1),
- the new manifest has 0 rows, or
- either manifest is missing `.rows` or is not valid JSON.

A first run (GitHub confirms `data-latest` does not exist) passes with a notice.
Any other failure to look up `data-latest`, or a `data-latest` without
`manifest.json`, fails the run rather than skipping the check. Increases
always pass.

**Intentional shrink**: Actions → Build dataset → Run workflow → tick
`allow_shrink`. This skips only the drop check; scheduled runs cannot set it.

Tests: `node --test scripts/check-dataset.test.mjs` (also the `scripts` job in
CI).

## Pinned actions

Every `uses:` is pinned to a full commit SHA with the version as a trailing
comment. Dependabot (`.github/dependabot.yml`) opens a weekly PR to bump them.
`dtolnay/rust-toolchain` is pinned to a commit on its `master` branch (its
README requires the SHA to be in master's history) and is given
`toolchain: stable` explicitly, since a SHA ref no longer implies the toolchain.
