#!/usr/bin/env node
// Sanity check run by .github/workflows/dataset.yml before anything is
// published: a broken build must not replace the live dataset.
//
//   node scripts/check-dataset.mjs <current manifest.json> [<previous manifest.json>]
//
// Fails (exit 1) when the current manifest is missing or malformed, has no
// rows, or has more than MAX_DROP_PCT percent (default 1) fewer rows than the
// previous manifest. A missing previous manifest (first run) passes with a
// notice. ALLOW_SHRINK=true skips the drop check for an intentional shrink;
// the zero-row and malformed checks (on both manifests) still apply.
// No dependencies.

import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Parse a manifest's text; returns { rows } or throws with a reason. */
export function parseManifest(text, label) {
  let m;
  try {
    m = JSON.parse(text);
  } catch (e) {
    throw new Error(`${label} manifest is not valid JSON: ${e.message}`);
  }
  if (m === null || typeof m !== 'object' || Array.isArray(m)) {
    throw new Error(`${label} manifest is not a JSON object`);
  }
  const rows = m.rows;
  if (!Number.isSafeInteger(rows) || rows < 0) {
    throw new Error(`${label} manifest has no valid .rows (got ${JSON.stringify(rows)})`);
  }
  return { rows };
}

/**
 * Pure decision. `previous` is the previous manifest's text, or null when
 * there is none. Returns { ok, level, message } where level is a GitHub
 * Actions annotation level (notice / warning / error).
 */
export function check({ current, previous, maxDropPct = 1, allowShrink = false }) {
  if (!Number.isFinite(maxDropPct) || maxDropPct < 0) {
    return { ok: false, level: 'error', message: `invalid MAX_DROP_PCT: ${maxDropPct}` };
  }
  let cur;
  try {
    cur = parseManifest(current, 'current');
  } catch (e) {
    return { ok: false, level: 'error', message: e.message };
  }
  if (cur.rows === 0) {
    return { ok: false, level: 'error', message: 'current manifest has 0 rows' };
  }
  if (previous == null) {
    return {
      ok: true,
      level: 'notice',
      message: `no previous manifest (first run); current rows=${cur.rows}`,
    };
  }
  // A supplied previous manifest is validated even under allowShrink: the
  // override skips only the row-drop comparison.
  let prev;
  try {
    prev = parseManifest(previous, 'previous');
  } catch (e) {
    return { ok: false, level: 'error', message: e.message };
  }
  if (allowShrink) {
    return {
      ok: true,
      level: 'warning',
      message: `row-drop check skipped (allow_shrink); rows ${prev.rows} -> ${cur.rows}`,
    };
  }
  const summary = `rows ${prev.rows} -> ${cur.rows}`;
  if (prev.rows === 0 || cur.rows >= prev.rows) {
    return { ok: true, level: 'notice', message: `${summary}; ok` };
  }
  const dropPct = ((prev.rows - cur.rows) / prev.rows) * 100;
  const pct = `${dropPct.toFixed(3)}%`;
  if (dropPct > maxDropPct) {
    return {
      ok: false,
      level: 'error',
      message:
        `${summary}: dropped ${pct}, over the ${maxDropPct}% limit. ` +
        'If intentional, re-run manually with allow_shrink=true.',
    };
  }
  return { ok: true, level: 'notice', message: `${summary}: dropped ${pct}, within ${maxDropPct}%` };
}

function main(argv, env) {
  const [curPath, prevPath] = argv;
  if (!curPath) {
    console.error('usage: check-dataset.mjs <current manifest.json> [<previous manifest.json>]');
    return 2;
  }
  let result;
  if (!existsSync(curPath)) {
    result = { ok: false, level: 'error', message: `current manifest not found: ${curPath}` };
  } else {
    const maxDropRaw = env.MAX_DROP_PCT ?? '';
    result = check({
      current: readFileSync(curPath, 'utf8'),
      previous: prevPath && existsSync(prevPath) ? readFileSync(prevPath, 'utf8') : null,
      maxDropPct: maxDropRaw.trim() === '' ? 1 : Number(maxDropRaw),
      allowShrink: (env.ALLOW_SHRINK ?? '').trim().toLowerCase() === 'true',
    });
  }
  console.log(`::${result.level} title=Dataset sanity check::${result.message}`);
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
