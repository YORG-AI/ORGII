# Core UI E2E Policy

## Core UI E2E policy

`tests/e2e` is the final UI regression suite. Keep it small and clean.

Rules:

- Extend an existing core spec before creating a new one.
- Do not put historical audits, migration sweeps, subsystem experiments, or one-off debug specs under `tests/e2e`.
- Every UI spec must perform a real rendered action or assert a real rendered result. Debug helpers may seed state, but cannot be the only proof.
- Provider capacity failures, especially Gemini 429/rate-limit/capacity errors, are infra/provider issues unless ORGII mishandles the rendered error or runtime state.
- OAuth refresh failures with permanent invalid-token messages are account health blockers. ORGII should record the failure and disable the account immediately; UI E2E should report them separately from product regressions and continue through configured account/model fallback chains when available.

## Anti-false-prosperity policy

A green E2E result is not accepted unless it proves the production behavior being claimed.

- Do not mark a scenario `PASS` when the critical action is replaced by a frontend mock, synthetic success flag, debug-only responder, or helper that bypasses the production command/event path.
- Debug helpers may establish deterministic preconditions, but the user-visible action under test must still use the production click/command/dispatcher path.
- Do not use corrective follow-up prompts, extra retry prompts, or stronger second instructions to make an agent pass after the original user path failed. The first-path failure is the product signal.
- Do not count a matrix run as proof for multiple labels unless each requested label produced independent evidence. Combined fallback output is not per-label proof.
- Do not promote old green rows after prompt text, harness setup, account fallback, or product semantics changed. Rerun only the affected rows and record current-code evidence.
- For interactive cards, assert the full lifecycle: rendered reason/body, actionable button, production response command, backend/runtime state change, and final rendered state. A pill text change alone is not enough.
- For mode/tool claims, assert session-scoped effective tools (`agent_list_effective_tools_for_session`, `/agent/test/effective-tools/:session_id`, or `__e2e.listEffectiveToolsForSession`) rather than global registry or historical renderability.
- Treat provider quota/capacity blocks as `BLOCKED`, not `PASS`; never route around them silently to manufacture green coverage.

## Real-interaction regression policy

If a bug was found by a human using the rendered app, the regression test must replay the human interaction path closely enough to fail before the fix.

- Prefer `browser.keys`, real clicks, focus/blur, menu navigation, and visible-state waits over `browser.execute` text injection. Direct DOM mutation is allowed only for deterministic setup, never as proof that input handling works.
- Contenteditable tests must first prove the keystroke/input actually changed the rendered editor text before asserting menus or buttons. A keydown-only signal (menu opened but `editor.textContent` stayed empty) is a harness/product bug signal, not proof that `@query` or `/query` works.
- Prefer real keyboard clearing for contenteditable surfaces (`Cmd/Ctrl+A`, delete/backspace, then `browser.keys(...)`) and wait for the rendered editor text to stabilize before menu assertions. Do not require `document.activeElement` to remain the editor after `@` or `/` opens a portal/menu; focus may legitimately move while the editor text remains the source of truth.
- If Tauri WebDriver element-click/focus is flaky for a contenteditable surface, the spec may use `document.execCommand('insertText')` plus a real bubbling `InputEvent` to exercise the product `onInput` path, but it must assert the editor text, query consumption, and final visible result. Do not use plain `textContent = ...` as the behavior under test.
- If a test helper replaces DOM text directly, it must be limited to deterministic seed/setup. A regression for inline `@`/slash/menu behavior must use keyboard input or an `InputEvent` path that can fail when React draft state restores stale text.
- A composer/menu test must assert all user-visible invariants: previous draft text preserved, transient query text consumed, inserted pill/chip visible, focus restored when product requires it, and send/stop state correct.
- Stop/Pause/Queue tests must assert immediate button state, composer interactivity, stream cessation, queue retention/non-autoflush, and draft restoration when a not-yet-sent message is canceled.
- Use seeded events only to create durable transcript preconditions. Rendering assertions must still inspect the actual chat UI, including grouped/aggregated blocks, not only `data-testid` fragments that disappear under aggregation.
- A test helper that calls `setTextarea`, `insertText`, `ensureRepoSelected`, or a debug seed path must include a comment or assertion explaining which production behavior is still being exercised afterward.
- If a prior test used a shortcut and missed a bug, update the skill/spec so future tests forbid the shortcut for that class of interaction.
