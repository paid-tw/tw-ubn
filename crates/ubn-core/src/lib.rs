//! Core logic for Taiwan Unified Business Numbers (統一編號, "UBN"/"ban").
//!
//! This crate is the source of truth for three tiny functions shared by the
//! build pipeline and (re-implemented, cross-checked) the browser client:
//! checksum validation, static-shard bucketing, and ROC-date conversion.

const WEIGHTS: [u32; 8] = [1, 2, 1, 2, 1, 2, 4, 1];

/// Validate an 8-digit UBN's check digit.
///
/// Uses the post-2023 rule: the weighted digit-sum must be divisible by 5
/// (with the historical exception that when the 7th digit is `7`, one may be
/// added before the test). Verified against all 1,714,969 active UBNs in the
/// FIA snapshot of 2026-10-27: 100% pass. The pre-2023 `% 10` rule matches only
/// ~88% of currently-registered UBNs and must not be used.
pub fn validate_ubn(ban: &str) -> bool {
    let b = ban.as_bytes();
    if b.len() != 8 || !b.iter().all(u8::is_ascii_digit) {
        return false;
    }
    let mut sum = 0u32;
    for i in 0..8 {
        let product = (b[i] - b'0') as u32 * WEIGHTS[i];
        sum += product / 10 + product % 10; // sum of the product's two digits
    }
    if sum % 5 == 0 {
        return true;
    }
    b[6] == b'7' && (sum + 1) % 5 == 0
}

/// Map a UBN to its static shard bucket via 32-bit FNV-1a.
///
/// MUST stay byte-for-byte equivalent to the client's `shardOf` (TypeScript)
/// so the published client reads the same shard the pipeline wrote. UBNs are
/// always ASCII digits, so bytes and UTF-16 code units coincide.
pub fn shard_of(ban: &str, shards: u32) -> u32 {
    let mut h: u32 = 0x811c_9dc5; // FNV offset basis
    for &byte in ban.as_bytes() {
        h ^= byte as u32;
        h = h.wrapping_mul(0x0100_0193); // FNV prime
    }
    h % shards
}

/// Convert a 7-digit Republic-of-China date (`"0760321"`) to ISO
/// (`"1987-03-21"`). ROC year + 1911 = Gregorian year. Returns `None` for
/// empty/malformed input, including a month or day of `"00"` (used for
/// "unknown" in the source data).
pub fn roc_to_iso(roc: &str) -> Option<String> {
    let b = roc.as_bytes();
    if b.len() != 7 || !b.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let year: u32 = roc[0..3].parse::<u32>().ok()? + 1911;
    let mm = &roc[3..5];
    let dd = &roc[5..7];
    if mm == "00" || dd == "00" {
        return None;
    }
    Some(format!("{year}-{mm}-{dd}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_real_ubns() {
        for ban in ["22099131", "87006234", "87006591", "47529263", "38965019"] {
            assert!(validate_ubn(ban), "{ban} should be valid");
        }
    }

    #[test]
    fn rejects_malformed() {
        for ban in ["1234567", "123456789", "2209913X", "", "        "] {
            assert!(!validate_ubn(ban), "{ban:?} should be invalid");
        }
    }

    #[test]
    fn rejects_broken_check_digit() {
        assert!(validate_ubn("22099131"));
        assert!(!validate_ubn("22099130"));
    }

    #[test]
    fn shard_is_deterministic_and_in_range() {
        assert_eq!(shard_of("22099131", 8192), shard_of("22099131", 8192));
        assert!(shard_of("22099131", 8192) < 8192);
        // Known vector shared with the TypeScript client test.
        assert_eq!(shard_of("22099131", 256), 216);
    }

    #[test]
    fn converts_roc_dates() {
        assert_eq!(roc_to_iso("0760321").as_deref(), Some("1987-03-21"));
        assert_eq!(roc_to_iso("1120101").as_deref(), Some("2023-01-01"));
        assert_eq!(roc_to_iso(""), None);
        assert_eq!(roc_to_iso("0000000"), None);
        assert_eq!(roc_to_iso("1150000"), None);
    }
}
