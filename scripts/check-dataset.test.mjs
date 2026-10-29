// node --test scripts/check-dataset.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check-dataset.mjs';

const m = (rows) => JSON.stringify({ dataDate: '2026-10-28', rows });

test('no previous manifest passes with a notice', () => {
  const r = check({ current: m(1000), previous: null });
  assert.equal(r.ok, true);
  assert.equal(r.level, 'notice');
  assert.match(r.message, /first run/);
});

test('equal row counts pass', () => {
  assert.equal(check({ current: m(1000), previous: m(1000) }).ok, true);
});

test('an increase passes', () => {
  assert.equal(check({ current: m(1_112_000), previous: m(1_000_000) }).ok, true);
});

test('a drop under the threshold passes', () => {
  const r = check({ current: m(995), previous: m(1000) }); // 0.5%
  assert.equal(r.ok, true);
  assert.match(r.message, /within 1%/);
});

test('a drop of exactly the threshold passes', () => {
  assert.equal(check({ current: m(990), previous: m(1000) }).ok, true);
});

test('a drop exactly at a non-default threshold passes despite float rounding', () => {
  // (1e6 - 930000) / 1e6 * 100 === 7.000000000000001 in IEEE 754.
  assert.equal(check({ current: m(930_000), previous: m(1_000_000), maxDropPct: 7 }).ok, true);
  assert.equal(check({ current: m(929_999), previous: m(1_000_000), maxDropPct: 7 }).ok, false);
  assert.equal(check({ current: m(999), previous: m(1000), maxDropPct: 0.1 }).ok, true);
  assert.equal(check({ current: m(998), previous: m(1000), maxDropPct: 0.1 }).ok, false);
});

test('a drop over the threshold fails', () => {
  const r = check({ current: m(989), previous: m(1000) }); // 1.1%
  assert.equal(r.ok, false);
  assert.equal(r.level, 'error');
  assert.match(r.message, /over the 1% limit/);
});

test('the threshold is configurable', () => {
  assert.equal(check({ current: m(950), previous: m(1000), maxDropPct: 5 }).ok, true);
  assert.equal(check({ current: m(999), previous: m(1000), maxDropPct: 0 }).ok, false);
});

test('allowShrink overrides a large drop', () => {
  const r = check({ current: m(10), previous: m(1000), allowShrink: true });
  assert.equal(r.ok, true);
  assert.equal(r.level, 'warning');
});

test('zero rows fail, even with allowShrink', () => {
  assert.equal(check({ current: m(0), previous: null }).ok, false);
  assert.equal(check({ current: m(0), previous: m(1000), allowShrink: true }).ok, false);
});

test('malformed current manifest fails', () => {
  for (const bad of ['{not json', '[]', 'null', '{}', m('1000'), m(-1), m(1.5)]) {
    const r = check({ current: bad, previous: m(1000) });
    assert.equal(r.ok, false, bad);
    assert.equal(r.level, 'error');
  }
});

test('malformed previous manifest fails, even with allowShrink', () => {
  assert.equal(check({ current: m(1000), previous: '{oops' }).ok, false);
  assert.equal(check({ current: m(1000), previous: '{oops', allowShrink: true }).ok, false);
  assert.equal(check({ current: m(1000), previous: '{}', allowShrink: true }).ok, false);
});

test('allowShrink with no previous manifest passes as a first run', () => {
  assert.equal(check({ current: m(1000), previous: null, allowShrink: true }).ok, true);
});

test('invalid threshold fails', () => {
  assert.equal(check({ current: m(1000), previous: m(1000), maxDropPct: NaN }).ok, false);
});

// CLI wrapper: exit codes, env handling, and missing files.
const script = join(dirname(fileURLToPath(import.meta.url)), 'check-dataset.mjs');
const dir = mkdtempSync(join(tmpdir(), 'check-dataset-'));
const file = (name, text) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};
const run = (args, env = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });

test('cli: passes with no previous file and prints a notice', () => {
  const r = run([file('a.json', m(1000)), join(dir, 'missing.json')]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^::notice /);
});

test('cli: fails on a large drop, passes with ALLOW_SHRINK=true', () => {
  const cur = file('b.json', m(900));
  const prev = file('c.json', m(1000));
  assert.equal(run([cur, prev]).status, 1);
  assert.match(run([cur, prev]).stdout, /^::error /);
  assert.equal(run([cur, prev], { ALLOW_SHRINK: 'true' }).status, 0);
  assert.equal(run([cur, prev], { ALLOW_SHRINK: 'false' }).status, 1);
});

test('cli: MAX_DROP_PCT from env', () => {
  const cur = file('d.json', m(900));
  const prev = file('e.json', m(1000));
  assert.equal(run([cur, prev], { MAX_DROP_PCT: '10' }).status, 0);
  assert.equal(run([cur, prev], { MAX_DROP_PCT: 'abc' }).status, 1);
});

test('cli: fails when the current manifest is missing', () => {
  assert.equal(run([join(dir, 'nope.json')]).status, 1);
  assert.equal(run([]).status, 2);
});
