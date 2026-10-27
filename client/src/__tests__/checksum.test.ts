import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateUBN } from '../checksum.js';
import { rocToISO } from '../rocDate.js';
import { shardOf } from '../shard.js';

describe('validateUBN', () => {
  // Real, currently-registered UBNs sampled from the FIA registry (2026-10-27).
  it.each(['22099131', '87006234', '87006591', '47529263', '38965019'])(
    'accepts real UBN %s',
    (ban) => expect(validateUBN(ban)).toBe(true),
  );

  it('rejects wrong length / non-digits', () => {
    expect(validateUBN('1234567')).toBe(false);
    expect(validateUBN('123456789')).toBe(false);
    expect(validateUBN('2209913X')).toBe(false);
    expect(validateUBN('')).toBe(false);
  });

  it('rejects a UBN with a broken check digit', () => {
    // 22099131 is valid; flip the last digit.
    expect(validateUBN('22099130')).toBe(false);
  });
});

describe('rocToISO', () => {
  it('converts ROC dates', () => {
    expect(rocToISO('0760321')).toBe('1987-03-21');
    expect(rocToISO('1120101')).toBe('2023-01-01');
  });
  it('returns null for empty / malformed', () => {
    expect(rocToISO('')).toBeNull();
    expect(rocToISO(undefined)).toBeNull();
    expect(rocToISO('0000000')).toBeNull();
  });
});

describe('shardOf', () => {
  it('is deterministic and in range', () => {
    const a = shardOf('22099131', 8192);
    expect(a).toBe(shardOf('22099131', 8192));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(8192);
  });

  // Shared vector with the Rust core test (crates/ubn-core): both impls MUST
  // bucket this UBN identically, or the client reads the wrong shard.
  it('matches the Rust core vector', () => {
    expect(shardOf('22099131', 256)).toBe(216);
  });
});

// Cross-implementation parity: the TS client must accept the exact same real
// UBNs as the Rust core, using the same fixture file.
describe('parity with Rust core', () => {
  const fixture = fileURLToPath(
    new URL('../../../crates/ubn-core/tests/fixtures/sample_bans.txt', import.meta.url),
  );
  const bans = readFileSync(fixture, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length === 8);

  it('accepts every sampled real UBN', () => {
    expect(bans.length).toBeGreaterThan(1000);
    const failures = bans.filter((b) => !validateUBN(b));
    expect(failures).toEqual([]);
  });
});
