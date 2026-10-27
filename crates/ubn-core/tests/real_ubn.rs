//! Property check: every real, currently-registered UBN must pass the checksum.
//!
//! `fixtures/sample_bans.txt` is a stratified sample (every 857th row) of the
//! 1.71M active UBNs in the 2026-10-27 FIA snapshot. If this ever drops below
//! 100%, the checksum rule has regressed.

use ubn_core::validate_ubn;

#[test]
fn all_sampled_real_ubns_validate() {
    let data = include_str!("fixtures/sample_bans.txt");
    let bans: Vec<&str> = data
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    assert!(bans.len() > 1000, "fixture should hold a meaningful sample");

    let failures: Vec<&str> = bans.iter().copied().filter(|b| !validate_ubn(b)).collect();
    assert!(
        failures.is_empty(),
        "{} of {} real UBNs failed validation: {:?}",
        failures.len(),
        bans.len(),
        &failures[..failures.len().min(10)],
    );
}

#[test]
fn flipping_a_digit_mostly_breaks_the_checksum() {
    // Sanity that the checksum actually discriminates: mutating the last digit
    // of a valid UBN should usually (not always) break it.
    let data = include_str!("fixtures/sample_bans.txt");
    let mut broken = 0usize;
    let mut total = 0usize;
    for ban in data
        .lines()
        .map(str::trim)
        .filter(|l| l.len() == 8)
        .take(500)
    {
        total += 1;
        let last = ban.as_bytes()[7];
        let bumped = format!(
            "{}{}",
            &ban[..7],
            if last == b'9' {
                '0'
            } else {
                (last + 1) as char
            }
        );
        if !validate_ubn(&bumped) {
            broken += 1;
        }
    }
    // The % 5 rule means ~4 in 5 single-digit bumps break it; assert a floor.
    assert!(
        broken * 2 > total,
        "expected most digit bumps to break: {broken}/{total}"
    );
}
