import { describe, expect, it } from 'vitest';
import { hasPrivateUse } from '../title.js';

describe('hasPrivateUse', () => {
  // Code points seen in data-20261029 (#10) plus each range's boundaries.
  it.each([
    ['BMP PUA seen in the data (U+F585)', '某某商行'],
    ['U+E000 (BMP start)', ''],
    ['U+F8FF (BMP end)', 'ab'],
    ['U+F0000 (plane 15 start)', '\u{F0000}'],
    ['U+FA3FE (most frequent in the data)', '台北\u{FA3FE}行'],
    ['U+FFFFD (plane 15 end)', '\u{FFFFD}'],
    ['U+100000 (plane 16 start)', '\u{100000}'],
    ['U+10FFFD (plane 16 end)', '\u{10FFFD}'],
  ])('flags %s', (_label, s) => expect(hasPrivateUse(s)).toBe(true));

  it.each([
    ['empty', ''],
    ['ordinary CJK', '台灣積體電路製造股份有限公司'],
    ['full-width Latin and space', 'ＡＢＣ　有限公司'],
    ['U+DFFF neighbour U+D7FF', '퟿'],
    ['U+F900 (CJK compatibility, just past BMP PUA)', '豈'],
    ['plane-2 CJK (not PUA)', '\u{20000}'],
    ['U+EFFFF (just before plane 15)', '\u{EFFFF}'],
    ['U+FFFFE (noncharacter, not PUA)', '\u{FFFFE}'],
  ])('does not flag %s', (_label, s) => expect(hasPrivateUse(s)).toBe(false));
});
