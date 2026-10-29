/**
 * Helpers for working with invoice titles (發票抬頭).
 */

/**
 * Unicode Private Use Area code points (general category `Co`):
 * U+E000–U+F8FF, U+F0000–U+FFFFD and U+100000–U+10FFFD.
 */
const PRIVATE_USE = /\p{Co}/u;

/**
 * True when `s` contains any Unicode Private Use Area character.
 *
 * The tax registry writes some names with custom glyphs (造字) mapped into the
 * PUA (#10). They render as boxes in ordinary fonts and an e-invoice platform
 * will not accept them, so such a name must not be auto-filled as a title.
 */
export function hasPrivateUse(s: string): boolean {
  return PRIVATE_USE.test(s);
}

/**
 * Normalize a title for comparison only (never for display or submission).
 * See `isSameTitle` for the rules.
 */
function normalizeTitle(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/臺/g, '台')
    .replace(/\s+/gu, '')
    .toLowerCase();
}

/**
 * True when two invoice titles name the same entity once incidental typing
 * differences are ignored — e.g. a buyer-typed title vs the registered name.
 *
 * It ignores:
 * - full-width vs half-width forms (Unicode NFKC: `ＡＢＣ１２３` = `ABC123`,
 *   `（股）` = `(股)`);
 * - 臺 vs 台;
 * - all whitespace, including the full-width space U+3000 and spaces between
 *   words;
 * - Latin letter case (`ABC` = `abc`), since registered names and what buyers
 *   type differ in case freely.
 *
 * It deliberately does NOT:
 * - strip or abbreviate legal forms (`股份有限公司` ≠ `(股)公司` ≠ `公司`);
 * - drop punctuation other than what NFKC unifies (`A.B` ≠ `AB`);
 * - map other variant characters (only 臺/台) or Private Use Area glyphs;
 * - treat an empty title as matching anything — two titles that normalize to
 *   the empty string compare as different.
 */
export function isSameTitle(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  return na !== '' && na === normalizeTitle(b);
}
