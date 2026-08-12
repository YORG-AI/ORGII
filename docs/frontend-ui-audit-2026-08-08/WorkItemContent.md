# Work Item Content UI audit

Scope: the Work Item Discussion, custom properties, subscription, and PR readiness UI changed by `codex/durable-workitem-runs`.

## Verdict

- Fix: 6
- Keep with reason: 3
- Abstract: 0

## Fixed

1. Typed property controls use the shared `Input`, `Select`, `Checkbox`, `Button`, and `InlineAlert` components.
2. Removed the custom arbitrary grid-template value from property rows in favor of standard flex sizing utilities.
3. Discussion actions are real shared buttons with accessible labels and native keyboard behavior.
4. Resolve, reopen, and reply controls are hidden when their callback is unavailable, so read-only views do not expose dead actions.
5. New user-facing labels use translation keys with English fallback text.
6. Loading, empty, error, resolved, conclusion, and reply states have visible text in addition to icons or color.

## Kept with reason

1. Avatar colors remain inline CSS variables because member colors are runtime data, not fixed design tokens.
2. `<time>` remains a native element because it carries the correct document semantics and has no design-system replacement.
3. Existing compact `text-[11px]`, `text-[12px]`, and `text-[13px]` utilities in the surrounding Work Item output/history surfaces remain unchanged to preserve their established dense layout; the new custom-properties surface uses standard `text-xs` and `text-sm` sizes.

## Abstraction review

No new cross-surface abstraction is warranted. Discussion threads are specific to Work Item history, while typed value editors are intentionally colocated with the Work Item custom-properties section. Shared primitives are reused at the component boundary.
