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
- `lookupTitle(ban, { baseUrl, signal?, timeoutMs?, fetchImpl? })` queries a
  deployed Worker's `/v1/vat/:ban` and resolves to `{ found: true, name, status?, … }`,
  `{ found: false }` (the Worker says there is no such registration), or `null`
  (no answer: bad checksum, timeout, abort, network error, any non-2xx including
  `502 upstream_unavailable`, a malformed body, or a name that is empty or has
  Private Use Area glyphs). Unlike `lookupVAT`, it never throws
  ([#14](https://github.com/paid-tw/tw-ubn/pull/14)).
- `isSameTitle(a, b)` compares two invoice titles while ignoring full-/half-width
  forms (NFKC), 臺/台, whitespace and Latin case. It never rewrites legal forms
  such as 股份有限公司 ([#14](https://github.com/paid-tw/tw-ubn/pull/14)).
- `hasPrivateUse(s)` reports whether a string contains Unicode Private Use Area
  characters (the registry's custom glyphs), which should not be auto-filled as a
  title ([#14](https://github.com/paid-tw/tw-ubn/pull/14)).
- Types: `RegistryStatus` adds `'closed'`, and `UBNRecord` gains optional `kind`
  (`'business' | 'nonprofit' | 'school' | 'agency'`) and `nameHasPrivateUse`
  ([#14](https://github.com/paid-tw/tw-ubn/pull/14)).

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
