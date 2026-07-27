# Test Cases: Tutorial Overlay Frame Scheduling

## Preconditions

- A tutorial or guide highlight is open.
- Its target element is rendered and has a measurable bounding rectangle.

## Happy Path

| #   | Steps                        | Expected Result                                                                                     |
| --- | ---------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | Open the general layout tour | The current target is highlighted after the next animation frame.                                   |
| 2   | Open the code editor tour    | The current target is highlighted; delayed retries still locate targets rendered shortly afterward. |
| 3   | Show a guide highlight       | The target and popover are positioned and the auto-dismiss timer remains active.                    |

## Edge Cases

| #   | Scenario                     | Steps                                                                  | Expected Result                                            |
| --- | ---------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | Repeated events in one frame | Dispatch several resize/scroll invalidations before flushing the frame | The measurement callback runs once.                        |
| 2   | Later frame                  | Flush the pending frame, then schedule another invalidation            | A second measurement is allowed.                           |
| 3   | Close before frame           | Schedule an update and close/unmount before the frame runs             | Pending work is cancelled and does not update state.       |
| 4   | Target not yet rendered      | Open the code editor tour before its target appears                    | Existing delayed retries continue scheduling measurements. |

## Error / Degraded States

| #   | Scenario         | Steps                              | Expected Result                                                          |
| --- | ---------------- | ---------------------------------- | ------------------------------------------------------------------------ |
| 1   | Missing target   | Open a step with no visible target | No exception is thrown; fallback positioning behavior remains unchanged. |
| 2   | Rapid open/close | Repeatedly open and close a tour   | Listeners, timers, and pending animation frames are removed on cleanup.  |

## Accessibility

- [ ] Keyboard navigation remains available while the tour is open.
- [ ] Escape still closes the active tour.
- [ ] Focus and click behavior are unchanged by frame scheduling.

## Acceptance Criteria

- [ ] Scroll and resize events trigger at most one target measurement per animation frame per active overlay.
- [ ] Initial target measurement still occurs after opening.
- [ ] General layout retry at 180 ms remains present.
- [ ] Code editor retries at 220 ms and 520 ms remain present.
- [ ] Cleanup cancels pending frame work and removes the same listener callbacks that were registered.
- [ ] Scheduler unit tests, changed-file lint, and TypeScript diagnostics pass.
