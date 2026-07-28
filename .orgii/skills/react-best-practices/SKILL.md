---
name: react-best-practices
description: ORGII-specific React 19 performance review and implementation guidance, adapted from Vercel Engineering. Use for React performance, re-render, async waterfall, bundle, heavy dependency, virtualization, high-frequency event, Context/provider, or store-subscription work. Do not trigger for styling, copy changes, or routine single-file UI bug fixes without a performance concern.
license: MIT (upstream guidance); ORGII overlay follows the repository license
metadata:
  upstream: vercel-labs/agent-skills/skills/react-best-practices
  upstream-version: "1.0.0"
  upstream-revision: dc8367e6f91c022d83361f03c3313fa05e848ee5
  adapted-for: ORGII React 19 + Webpack + Tauri client
---

# ORGII React Best Practices

Use Vercel's React performance guidance through this ORGII overlay. ORGII is a React 19 Webpack SPA running inside Tauri, not a Next.js, RSC, or SSR application. This file is authoritative whenever upstream examples conflict with ORGII's runtime, dependencies, architecture, or verification requirements.

See `UPSTREAM.md` for provenance and the pinned upstream source.

## When To Use

Load this skill when the task involves one or more of:

- React performance, lag, responsiveness, unnecessary renders, or profiling
- Async waterfalls or independent work that may safely run in parallel
- Bundle size, startup cost, lazy loading, or a new heavy dependency
- Large lists, search/filter/sort, virtualization, CodeMirror, or xterm
- Context/provider value stability, Jotai subscriptions, or derived state
- Global listeners, timers, animation frames, scroll, pointer, resize, or other high-frequency events
- A React performance-focused review or refactor

## When Not To Use

Do not load this skill solely for:

- Styling, copy, spacing, colors, or design-system consistency
- Accessibility review without a performance concern
- A routine single-file UI bug fix
- Backend-only Rust work
- General architecture cleanup without a React performance dimension

Use `frontend-ui-audit` for UI consistency and accessibility methodology. Use `architecture-audit` for broader state ownership, module boundaries, dead code, FSM, or cross-layer refactors. This skill does not replace either one.

## ORGII Applicability Filter

Before applying any rule, classify it:

| Classification        | Action                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Applicable**        | Fits React 19 in a client-side Webpack/Tauri runtime; evaluate normally.                                               |
| **Adapt**             | The principle fits but the upstream implementation is Next.js/SWR-specific; translate it to existing ORGII primitives. |
| **Evidence required** | A micro-optimization, lifecycle-sensitive change, or high-risk surface; measure or reproduce before changing.          |
| **Not applicable**    | Depends on Next.js, RSC, SSR, Server Actions, API routes, or server request lifecycle; do not apply.                   |

Never treat a rule match as automatic authorization to refactor. Preserve behavior first and prefer the smallest measurable change.

## Default Priority for ORGII

Review in this order:

1. **Correctness and lifecycle stability** — stale closures, duplicate effects/listeners, remounts, races, and cleanup.
2. **Async waterfalls** — defer unused awaits and parallelize only genuinely independent operations.
3. **Subscription and render scope** — subscribe to the smallest stable value; derive values during render when safe.
4. **Heavy work and bundle boundaries** — delay expensive modules and computations until the feature is used.
5. **Large or frequent surfaces** — virtualized rows, editor/terminal events, search/filter loops, resize/scroll/pointer paths.
6. **Micro-optimizations** — only after evidence shows the preceding categories are not the bottleneck.

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

## Explicitly Inapplicable Upstream Rules

Do not apply the following to ORGII's frontend unless the architecture later adds the relevant runtime:

- Next.js API route or Server Action patterns
- React Server Components and RSC prop serialization
- `next/dynamic`, `next/server`, `after()`, `next/headers`, or `next/cache`
- Per-request server deduplication with `React.cache()`
- Cross-request LRU server caches
- SSR hydration mismatch or no-flicker inline-script patterns
- Server component composition for parallel server fetching
- Next.js resource, route, image, font, or script behavior

React `Suspense` remains usable for client-side lazy boundaries, but upstream streaming/RSC claims do not transfer to Tauri.

## High-Risk ORGII Surfaces

Do not make speculative performance refactors in these areas. Read owners/callers, preserve lifecycle semantics, and add focused verification:

- ChatPanel send, queue, Stop, Force Send, rewind, and turn lifecycle
- Composer, ComposerBar, contenteditable input, slash/context menus, and draft restoration
- CodeMirror editor state, extensions, listeners, measurements, and document synchronization
- xterm creation/disposal, addons, WebGL fallback, fit/resize, and stream subscriptions
- Virtuoso or TanStack Virtual row identity, measurement, scroll restoration, and follow-output behavior
- Tooltip/Menu/Dropdown portals, focus, positioning, and outside-click listeners
- WorkStation shell, replay, diff, and multi-repo state ownership
- Tauri IPC and event subscriptions
- KeyVault forms, validation, secrets, and parent-owned loading/error state

For these surfaces, a lower render count is not sufficient proof. Verify the user-visible lifecycle and authoritative state.

## Working Method

1. **State the performance claim.** Name the affected interaction and expected improvement.
2. **Find the owner.** Trace the state, event, async, or bundle boundary before editing.
3. **Establish evidence.** Use a reproducible symptom, render observation, bundle analyzer, browser performance trace, or focused benchmark when practical.
4. **Classify each candidate.** Applicable, adapt, evidence required, or not applicable.
5. **Choose the smallest safe change.** Do not combine unrelated optimization classes.
6. **Sweep equivalent callers.** Classify remaining hits as fix, keep with reason, or not applicable; do not silently stop at the reported site.
7. **Verify correctness first.** Run focused tests, changed-file lint/type diagnostics, and the relevant rendered path when the claim is visual or interaction-based.
8. **Re-measure the original claim.** Do not report a performance improvement solely because code now resembles a best-practice example.

## Verification and Reporting

Match verification to the claim:

| Claim                                | Minimum evidence                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Removed render/remount issue         | Focused regression test where feasible plus before/after render or lifecycle observation             |
| Removed async waterfall              | Focused test for ordering/failure semantics plus timing or call-order evidence                       |
| Reduced bundle/startup cost          | `pnpm analyze` or equivalent chunk evidence before and after                                         |
| Improved long-list interaction       | Reproduce realistic data volume and verify scrolling, focus, selection, and empty/single-item states |
| Fixed listener/subscription overhead | Prove one registration per intended owner and symmetric cleanup                                      |
| Improved live UI responsiveness      | Run the actual Tauri/WebView path or explicitly state that live pixels/profiling were not verified   |

Do not claim runtime, WebView, startup, memory, or frame-time improvements from TypeScript, lint, or unit tests alone. If measurement was not possible, report the change as an implementation candidate with correctness checks, not a verified performance win.

## Relationship to ORGII Delivery Rules

- This skill is performance methodology, not an audit-report mandate.
- It does not replace `.cursor/rules/ui-feature-workflow.mdc` test and acceptance gates.
- It does not require a report for every React edit.
- If a task is explicitly audit-only, keep source changes separate from the audit document.
- When performance and UI consistency both matter, apply both methodologies but keep findings clearly categorized.
