# Architecture Audit — Canvas session state

**Scope:** `canvasPreviewAtom`, `useCanvasForTurn`, and Canvas consumers in Chat, SessionCore, and WorkStation  
**Date:** 2026-07-14  
**Auditor:** Codex

## Acceptance criteria

- [x] Session matching is defined once for all Canvas-derived UI state.
- [x] Dismiss and clear operations cannot mutate another session's entry.
- [x] Inline card, latest-canvas shortcut, pinned pill, and Simulator-open state have explicit ownership rules.
- [x] The compatibility hook and duplicated test-only implementations are removed.
- [x] Production consumers use the canonical hook or the small store-level transition helpers.
- [x] TypeScript, targeted ESLint, and Canvas lifecycle tests pass.

## 10-layer audit

### Layer 1 — Compilation correctness

- `pnpm typecheck` passes.
- Targeted ESLint passes for all changed Canvas TypeScript and TSX files.
- Canvas lifecycle and hook suites pass (53 tests).

### Layer 2 — Dead code and structural deduplication

- Removed `useCanvasPreviewForSession`, which only relayed a subset of `useCanvasForTurn`.
- Replaced test-local copies of session matching and dismiss behavior with exported pure helpers used by production.
- Swept remaining `canvasPreviewAtom` reads. Direct access remains only in integration owners that write jump/simulator state; Chat, pinned actions, and the WorkStation renderer use the canonical session-scoped hook.

### Layer 3 — Naming consistency

- `latestPayload` means the newest matching payload even after dismissal.
- `payload` means the payload still eligible for inline rendering.
- `isDismissed`, `openedInSimulator`, and `allowsLatestCanvasShortcut` name distinct UI decisions instead of overloading one visibility flag.

### Layer 4 — Semantic overloading

| Term            | Meaning                                  | Verdict                                           |
| --------------- | ---------------------------------------- | ------------------------------------------------- |
| latest payload  | Matching session's stored Canvas payload | Keep; may remain available after inline dismissal |
| visible payload | Payload eligible for the inline card     | Keep as `payload`; derived from dismissal state   |
| clear           | Remove the matching session's entry      | Keep; distinct from soft dismiss                  |

No term drives more than one state transition.

### Layer 5 — Default branch analysis

- Missing or mismatched session IDs derive an empty snapshot and leave mutations unchanged.
- `allowsLatestCanvasShortcut` defaults to allowed when no matching global entry exists, so another session cannot suppress the current session's event-store fallback.
- Dismiss and clear helpers use explicit guards rather than catch-all mutation branches.

### Layer 6 — Cross-domain leakage

- Store-level helpers contain only session matching and immutable transitions.
- The hook owns Chat-specific shortcut eligibility.
- WorkStation tab closure and Simulator jump behavior remain in their existing UI integration layers.

### Layer 7 — New-developer confusion test

- The snapshot interface documents the difference between stored, visible, dismissed, and Simulator-open state.
- Callers consume named snapshot fields rather than reconstructing conditions from the raw atom.
- The deleted compatibility shim no longer creates two apparent public APIs for the same state.

### Layer 8 — Wire protocol and serialization

- No wire payload or persisted schema changes. Canvas state remains an in-memory Jotai entry containing the existing `CanvasInlinePayload`.

### Layer 9 — Init and entry-point parity

| Consumer                | Read path                                 | Mutation path                        |
| ----------------------- | ----------------------------------------- | ------------------------------------ |
| Streaming `ChatVariant` | `useCanvasForTurn().snapshot.payload`     | none                                 |
| `ChatView` shortcut     | `latestPayload` plus shortcut eligibility | existing Simulator jump action       |
| `PinnedActionsBar`      | `snapshot.isDismissed`                    | session-scoped clear                 |
| WorkStation Canvas tab  | `snapshot.latestPayload`                  | session-scoped clear plus tab close  |
| New-turn sync           | none                                      | shared session-scoped dismiss helper |

All entry points use the same session predicate.

### Layer 10 — Resolver symmetry

- `latestPayload`, dismissal, and Simulator-open state all resolve from the same matching entry.
- Both mutation helpers apply the same session guard. There is no field-specific fallback chain.

## Systematic sweep

- Swept `canvasPreviewAtom`, `useCanvasPreviewForSession`, `cardDismissed`, and `openedInSimulator` usages.
- No remaining compatibility-hook caller or duplicated session-scoped mutation was found.
- The remaining direct atom integrations intentionally own Simulator selection or backend-stream state writes and are not duplicate Chat presentation paths.
