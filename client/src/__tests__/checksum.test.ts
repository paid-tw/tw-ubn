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
});
