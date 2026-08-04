# ORGII React Performance Implementation Guidance

## Applicable Upstream Guidance

### Async work

- Check cheap synchronous exit conditions before awaiting remote or expensive work.
- Move `await` into the branch that needs its result.
- Use `Promise.all` for independent operations; preserve ordering and failure semantics.
- Start independent work early and await it at the latest safe point.

Do not use `better-all` unless it is deliberately approved as a new dependency. Native promises are the default.

### Re-render and state

- Derive values from current props/state during render instead of mirroring them through an effect.
- Put interaction-triggered side effects in the event handler rather than modeling the action as state plus effect.
- Use functional state updates when the next value depends on the previous value.
- Lazily initialize expensive state with `useState(() => initialValue)`.
- Narrow effect dependencies to the actual primitive values, without suppressing legitimate dependencies.
- Do not define component types inside another component when remounting is not intentional.
- Split unrelated computations/effects when their dependency lifecycles differ.
- Do not wrap cheap primitive expressions in `useMemo`.
- Use `startTransition` or `useDeferredValue` only for demonstrably non-urgent rendering work; do not hide correctness or stale-data issues.
- Stabilize Context provider values when unstable identity fans out renders to consumers.

`memo`, `useMemo`, and `useCallback` are tools, not defaults. Add them only when they create a meaningful bailout or stable contract. Confirm whether React Compiler is enabled before relying on compiler-provided memoization; do not assume it is enabled.

### Rendering and high-frequency browser work

- Prefer existing virtualization (`react-virtuoso`, `@tanstack/react-virtual`) for large lists rather than rendering every item.
- Consider `content-visibility` only where it is compatible with measurement, focus, scrolling, and virtualization behavior.
- Hoist truly static JSX or stable default arrays/objects/functions when identity matters.
- Use passive touch/wheel listeners only when the listener never calls `preventDefault()`.
- Batch DOM style mutations through classes where imperative DOM work is required.
- Clean up listeners, observers, timers, animation frames, terminal/editor subscriptions, and async continuations symmetrically.

### JavaScript hot paths

Use `Map`/`Set`, combined iterations, cached lookups, hoisted regular expressions, or hand-written loops only when data volume or profiling justifies them. Prefer readable immutable code on ordinary UI paths.

## Required Adaptations

### Dynamic imports

Do not use `next/dynamic`. Use Webpack-compatible imports:

```tsx
import { Suspense, lazy } from "react";

const HeavyPanel = lazy(() => import("./HeavyPanel"));

export function PanelHost() {
  return (
    <Suspense fallback={<PanelSkeleton />}>
      <HeavyPanel />
    </Suspense>
  );
}
```

For event-triggered utilities, use `await import("./heavyUtility")` at the point of use. Preserve error handling and avoid turning a frequently used path into repeated load churn.

### Data fetching and subscriptions

Do not introduce SWR, React Query, or another cache/subscription framework just to satisfy an upstream example. First reuse the existing owner:

- Jotai atoms and derived atoms
- Existing Context/provider contracts
- Existing module service/cache/store
- Tauri command and event ownership
- Existing deduplication or in-flight request logic

A new data library requires an explicit architecture decision and migration boundary.

### Bundle imports

Direct imports are candidates, not a blanket ban on barrel files. Before rewriting imports:

1. Inspect whether Webpack tree-shakes the package/module correctly.
2. Measure the affected chunk with the existing `pnpm analyze` path when bundle impact is the claim.
3. Preserve public module boundaries where the barrel is an intentional API.
4. Prefer lazy feature boundaries over noisy import churn with no measured result.

### Persistence

For browser storage, prefer ORGII's existing persistence owner. If direct `localStorage` or `sessionStorage` access is necessary, version the schema, store minimal non-sensitive data, and handle read/write failures. Never persist credentials, OAuth tokens, or KeyVault secrets there.
