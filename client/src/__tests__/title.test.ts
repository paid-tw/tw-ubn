import { describe, expect, it } from 'vitest';
import { hasPrivateUse, isSameTitle } from '../title.js';

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

describe('isSameTitle', () => {
  it.each([
    ['identical', '台灣積體電路製造股份有限公司', '台灣積體電路製造股份有限公司'],
    ['臺 vs 台', '臺灣積體電路製造股份有限公司', '台灣積體電路製造股份有限公司'],
    ['臺 on both sides, several times', '臺北市臺灣商行', '台北市台灣商行'],
    ['full-width vs half-width digits', '第１２３商行', '第123商行'],
    ['full-width vs half-width Latin', 'ＡＢＣ科技有限公司', 'ABC科技有限公司'],
    ['full-width vs half-width parentheses', '台灣（股）公司', '台灣(股)公司'],
    ['full-width space U+3000', '台灣　積體電路', '台灣積體電路'],
    ['ASCII spaces, tabs and edges', '  台灣 積體\t電路 ', '台灣積體電路'],
    ['Latin case', 'Apple Asia LLC 台灣分公司', 'APPLE ASIA LLC台灣分公司'],
    ['full-width lower vs half-width upper', 'ａｂｃ商行', 'ABC商行'],
  ])('matches %s', (_label, a, b) => {
    expect(isSameTitle(a, b)).toBe(true);
    expect(isSameTitle(b, a)).toBe(true);
  });

  it.each([
    ['different names', '台灣積體電路製造股份有限公司', '聯華電子股份有限公司'],
    ['legal form not abbreviated', '台灣積體電路製造股份有限公司', '台灣積體電路製造(股)公司'],
    ['legal form not stripped', '台灣積體電路製造股份有限公司', '台灣積體電路製造'],
    ['punctuation kept', 'A.B.C.商行', 'ABC商行'],
    ['different digits', '第123商行', '第124商行'],
    ['both empty', '', ''],
    ['both whitespace only', ' 　', '\t'],
    ['one empty', '台灣商行', ''],
  ])('does not match %s', (_label, a, b) => {
    expect(isSameTitle(a, b)).toBe(false);
    expect(isSameTitle(b, a)).toBe(false);
  });
});
