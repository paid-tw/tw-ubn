import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hasPrivateUse, isSameTitle } from '../title.js';

// Shared with the Ruby gem (ruby/test/title_test.rb): both implementations
// MUST agree on every vector.
const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../fixtures/title-vectors.json', import.meta.url)),
    'utf8',
  ),
) as {
  privateUse: [string, string][];
  notPrivateUse: [string, string][];
  same: [string, string, string][];
  different: [string, string, string][];
};

describe('hasPrivateUse', () => {
  it.each(vectors.privateUse)('flags %s', (_label, s) => expect(hasPrivateUse(s)).toBe(true));

  it.each(vectors.notPrivateUse)('does not flag %s', (_label, s) =>
    expect(hasPrivateUse(s)).toBe(false),
  );
});

describe('isSameTitle', () => {
  it.each(vectors.same)('matches %s', (_label, a, b) => {
    expect(isSameTitle(a, b)).toBe(true);
    expect(isSameTitle(b, a)).toBe(true);
  });

  it.each(vectors.different)('does not match %s', (_label, a, b) => {
    expect(isSameTitle(a, b)).toBe(false);
    expect(isSameTitle(b, a)).toBe(false);
  });
});
