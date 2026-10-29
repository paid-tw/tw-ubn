# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Version numbers are those of the npm package [`@paid-tw/ubn`](https://www.npmjs.com/package/@paid-tw/ubn)
(`client/`), which follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The dataset pipeline (`crates/`), the Workers (`worker/`, `worker-d1/`) and the
workflows are not versioned separately; their changes are listed here as well and
ship when merged to `main`.

## [Unreleased]

### Added

- `worker`, `worker-d1`: when a ban is in neither the dataset nor FIA, look it up
  in the GCIS company registry. A dissolved, revoked or otherwise terminated
  company now answers `found: true` with `source: "gcis"`, `status: "closed"`,
  `closedDate` and the raw `companyStatus`, instead of a bare `found: false`; a
  live company not in the tax registry answers with its name and no `status`. New
  `NEGATIVE_CACHE_TTL` var (default 3600 s) for misses GCIS can't confirm
  ([#16](https://github.com/paid-tw/tw-ubn/pull/16)).
- Dataset: schools and kindergartens, nonprofits (所得稅法 §11(4) bodies) and
  Executive Yuan agencies — UBNs that are withholding units rather than
  VAT-registered businesses — are now in the dataset, from the FIA's
  `BGMOPEN99X`, `BGMOPEN99` and agency-list files. Every row, shard entry and
  lookup result carries `kind` (`business`, `nonprofit`, `school` or `agency`),
  and deregistered schools and nonprofits have `status: "closed"`. These rows
  have `useInvoice: false` and only a county/city as `address`. New `ubn-build`
  flags `--no-withholding`, `--no-nonprofit`, `--no-school`, `--no-agency` and
  `--nonprofit-csv`/`--school-csv`/`--agency-csv`
  ([#18](https://github.com/paid-tw/tw-ubn/pull/18)).

### Fixed

- `worker-d1`: fall back to the FIA API when D1 has no `ubn` table yet, instead of
  failing with a Cloudflare 1101 ([#4](https://github.com/paid-tw/tw-ubn/pull/4)).
- `worker-d1`: answer instead of failing when the FIA fallback is unreachable, and
  don't cache a miss taken while D1 or FIA was down ([#4](https://github.com/paid-tw/tw-ubn/pull/4)).
- `worker`, `worker-d1`: cache responses without CORS headers and apply the
  caller's CORS per request, so one origin's `Access-Control-Allow-Origin` is never
  served to another ([#5](https://github.com/paid-tw/tw-ubn/pull/5)).
- `worker`, `worker-d1`: when FIA can't answer, `/v1/vat/:ban` now responds
  `502` with `{ "found": null, "error": "upstream_unavailable" }` (never cached)
  instead of `200 { "found": false }`, which was indistinguishable from "no such
  business" and was cached for a day by `worker`. This changes the response
  contract: treat a non-2xx as "no answer". `found: false` is cached only when the
  dataset read succeeded and FIA returned 404 ([#15](https://github.com/paid-tw/tw-ubn/pull/15)).

### Security

- Dataset workflow: the `build` job runs in the `dataset` environment, so the R2 /
  D1 write credentials can be scoped to the default branch once they are moved
  there; admin steps in `docs/operations.md` ([#13](https://github.com/paid-tw/tw-ubn/pull/13)).
- Workflows: every action is pinned to a full commit SHA, kept current by
  Dependabot ([#13](https://github.com/paid-tw/tw-ubn/pull/13)).
- Dataset workflow: a pre-publish check fails the run before anything is released
  or written to D1 / R2 when rows drop more than 1% from the previous build, the
  build has no rows, or a manifest is malformed; a manual run can override an
  intentional shrink with `allow_shrink` ([#13](https://github.com/paid-tw/tw-ubn/pull/13)).

## [0.1.1] - 2026-10-28

### Changed

- Package metadata only (repository, `files`, `engines`, `publishConfig` with npm
  provenance, keywords); no code changes.

## [0.1.0] - 2026-10-28

### Added

- First npm release of `@paid-tw/ubn`: `validateUBN` (post-2023 `% 5` checksum),
  `shardOf`, `rocToISO`, `lookupVAT` against the published shards (resolving the
  versioned `latest.json` pointer), and `fiaRegistration` / `gcisCompany`, which
  query the live FIA and GCIS APIs and return the parsed record or `null`.

[Unreleased]: https://github.com/paid-tw/tw-ubn/compare/ubn-v0.1.1...HEAD
[0.1.1]: https://github.com/paid-tw/tw-ubn/releases/tag/ubn-v0.1.1
[0.1.0]: https://www.npmjs.com/package/@paid-tw/ubn/v/0.1.0
