# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Version numbers are those of the npm package [`@paid-tw/ubn`](https://www.npmjs.com/package/@paid-tw/ubn)
(`client/`), which follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The dataset pipeline (`crates/`), the Workers (`worker/`, `worker-d1/`) and the
workflows are not versioned separately; their changes are listed here as well and
ship when merged to `main`.

## [Unreleased]

### Fixed

- `worker-d1`: fall back to the FIA API when D1 has no `ubn` table yet, instead of
  failing with a Cloudflare 1101 ([#4](https://github.com/paid-tw/tw-ubn/pull/4)).
- `worker-d1`: answer instead of failing when the FIA fallback is unreachable, and
  don't cache a miss taken while D1 or FIA was down ([#4](https://github.com/paid-tw/tw-ubn/pull/4)).
- `worker`, `worker-d1`: cache responses without CORS headers and apply the
  caller's CORS per request, so one origin's `Access-Control-Allow-Origin` is never
  served to another ([#5](https://github.com/paid-tw/tw-ubn/pull/5)).

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
