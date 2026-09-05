# Skeleton UI audit

The shared loading-placeholder primitive. Added in PR #1280; this pass adds the
`testId` passthrough.

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `src/components/Skeleton/index.tsx:26` | `SkeletonBar` raw `<span>` | keep with reason | This *is* the design-system primitive; it cannot be expressed in terms of itself. | None. |
| `src/components/Skeleton/index.tsx:29` | `bg-fill-2` | keep with reason | The token, not a hardcoded color. Deliberately not configurable — one fill for every placeholder is the invariant this module exists to hold. See `GLOBAL.md` D3. | None. |
| `src/components/Skeleton/index.tsx:28` | `data-testid={testId}` | keep with reason | Three suites (`ActivityRouter`, `ActivityRouter.canvasInline`, `ChatTranscript`) assert `chat-loading-block`. Passing the id through the primitive avoids a wrapper `<div>` whose only job is to carry an attribute. Renders as `undefined` (omitted) when not supplied. | None. |
| `src/components/Skeleton/index.tsx:27` | `aria-hidden` unconditional | keep with reason | Every consumer owns its own `aria-busy` / `role="status"` region. Announcing decorative shapes as well would double-announce the load. | None. |

Verdict totals: **0 fix**, **4 keep with reason**, **0 abstract**.
