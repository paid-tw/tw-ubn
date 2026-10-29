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
