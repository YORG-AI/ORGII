//! Pure-logic tests for the per-window sleep-inhibitor refcount state machine.
//!
//! The real FFI (IOKit / SetThreadExecutionState) is not exercised here — it
//! needs the OS at runtime. What IS exercised is the contract the Tauri
//! commands enforce on top of the FFI: the process-wide assertion is created
//! only when the first window label registers, survives releases from other
//! windows, and is dropped exactly when the last holder leaves. Releasing a
//! label that never acquired must not disturb existing holders.
//!
//! If these tests drift from the command implementation, a detached session
//! window closing could again tear the assertion out from under the main
//! window mid-agent-run (the original multi-window bug), or we could leak
//! macOS IOPMAssertions until process exit.

use std::collections::HashSet;

use crate::power::{decide_acquire, decide_release, Transition};

fn set(labels: &[&str]) -> HashSet<String> {
    labels.iter().map(|label| (*label).to_owned()).collect()
}

#[test]
fn first_acquire_applies_and_registers_the_holder() {
    let mut holders = HashSet::new();
    assert_eq!(
        decide_acquire(&mut holders, false, "main"),
        Transition::Apply
    );
    assert_eq!(holders, set(&["main"]));
}

#[test]
fn second_window_acquire_skips_the_platform_call_but_registers_the_holder() {
    let mut holders = set(&["main"]);
    assert_eq!(
        decide_acquire(&mut holders, true, "app-window-session-abc"),
        Transition::Skip
    );
    assert_eq!(holders, set(&["main", "app-window-session-abc"]));
}

#[test]
fn re_acquire_from_the_same_window_is_a_noop() {
    let mut holders = set(&["main"]);
    assert_eq!(decide_acquire(&mut holders, true, "main"), Transition::Skip);
    assert_eq!(holders, set(&["main"]));
}

#[test]
fn release_with_other_holders_remaining_keeps_the_assertion() {
    let mut holders = set(&["main", "app-window-session-abc"]);
    assert_eq!(
        decide_release(&mut holders, true, "app-window-session-abc"),
        Transition::Skip
    );
    assert_eq!(holders, set(&["main"]));
}

#[test]
fn release_of_the_last_holder_drops_the_assertion() {
    let mut holders = set(&["main"]);
    assert_eq!(decide_release(&mut holders, true, "main"), Transition::Apply);
    assert!(holders.is_empty());
}

#[test]
fn release_of_a_non_holder_label_is_a_noop_and_keeps_existing_holders() {
    let mut holders = set(&["main"]);
    assert_eq!(
        decide_release(&mut holders, true, "app-window-session-missing"),
        Transition::Skip
    );
    assert_eq!(holders, set(&["main"]));
}

#[test]
fn release_when_nothing_is_held_is_a_noop() {
    let mut holders = HashSet::new();
    assert_eq!(
        decide_release(&mut holders, false, "main"),
        Transition::Skip
    );
    assert!(holders.is_empty());
}

/// Walk the exact multi-window sequence from the original bug: the main
/// window acquires, a detached session window joins, and the detached window
/// releases (its session converges first, or it closes) — the assertion must
/// survive until the main window's own release.
#[test]
fn detached_window_release_does_not_strand_the_main_window() {
    let mut holders: HashSet<String> = HashSet::new();
    let mut held = false;

    // Main window starts an agent run → creates the platform assertion.
    assert_eq!(decide_acquire(&mut holders, held, "main"), Transition::Apply);
    held = true;

    // A detached session window also sees "working" and acquires → shares
    // the existing assertion, no second platform call.
    assert_eq!(
        decide_acquire(&mut holders, held, "app-window-session-s1"),
        Transition::Skip
    );

    // The detached window releases first: main still holds, so the OS
    // assertion must NOT be dropped.
    assert_eq!(
        decide_release(&mut holders, held, "app-window-session-s1"),
        Transition::Skip
    );
    assert_eq!(holders, set(&["main"]));

    // A duplicate release for the already-gone window (JS unmount cleanup
    // and the Destroyed-event cleanup both firing) is a no-op.
    assert_eq!(
        decide_release(&mut holders, held, "app-window-session-s1"),
        Transition::Skip
    );
    assert_eq!(holders, set(&["main"]));

    // Main finishes: the last holder out drops the assertion.
    assert_eq!(decide_release(&mut holders, held, "main"), Transition::Apply);
    held = false;
    assert!(holders.is_empty());

    // Acquire again after a full release → applies again.
    assert_eq!(decide_acquire(&mut holders, held, "main"), Transition::Apply);
}
