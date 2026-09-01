# React Compiler spike — 2026-09-01

Measured feasibility spike for adopting React Compiler (babel-plugin-react-compiler
1.0.0) on React 19.2.6 with the existing swc-loader webpack pipeline. Everything
below was measured on this repo at this date; nothing here is enabled by default.

## How to run it

```bash
ORGII_REACT_COMPILER=true pnpm build          # production
ORGII_REACT_COMPILER=true pnpm dev:frontend   # dev server (SWC pipeline only)
```

The flag chains a minimal Babel pass (only `babel-plugin-react-compiler`, TS/JSX
enabled as parse-only parser plugins) in front of swc-loader for `src/**/*.tsx`.
swc remains the transpiler — types, JSX lowering, and dev Fast Refresh are
untouched. `FAST_DEV` / `FAST_PROD` / `ORGII_LIGHT_DEV` builds skip the pass
entirely (esbuild branch), so a compiler-enabled build must not combine the flag
with those. Compiler builds use their own webpack cache directory
(`react-compiler-*`), so toggling the flag does not invalidate the warm
non-compiler dev cache.

## Coverage (standalone scan, all 4782 non-test `.ts`/`.tsx` files)

| Metric | Value |
| --- | --- |
| Candidate functions (components + hooks, `compilationMode: infer`) | 3516 |
| Compiled successfully | **2880 (81.9%)** |
| — components in `.tsx` | 2225 |
| — hooks in `.ts` | 655 |
| Bailouts | 636 |

The flag as wired compiles `.tsx` only (the 2225 components). Extending the same
chain to the `.ts` rule would add the 655 hooks at roughly proportional build
cost (~4400 more files through Babel).

Bailout breakdown (a bailout means the function is left exactly as written —
safe by construction):

- **~490 compiler todos around `try`/`finally` and `try` without `catch`**
  (`lowerStatement: Handle TryStatement with a finalizer`, etc.). Largest
  unlock; shrinks as the upstream compiler adds support, no code change needed.
- **45** dynamic `import()` inside component bodies (unsupported expression).
- **26** "Cannot access refs during render" — real rule violations, e.g.
  `src/components/Tooltip/index.tsx`, `src/components/VirtualizedStickyTree/index.tsx`,
  `src/features/CodeMirror/Editor/index.tsx`. Worth fixing independently.
- **23** components skipped because of `eslint-disable react-hooks/*`
  suppressions (44 files carry such suppressions).
- **8** "Use of incompatible library" warnings (memo-wrapped virtualization
  components: `TurnPageList`, `ChannelMessageList`, `KanbanColumn`).

## Build cost (M-series Mac, cold caches, prod cache dir wiped between runs)

| Build | Baseline | With compiler | Delta |
| --- | --- | --- | --- |
| `pnpm build` (prod, SWC + Terser) | 65.9 s | 120.9 s | **+55 s (+83%)** |
| One-shot dev build (SWC + Refresh) | 49.9 s | 92.5 s | **+43 s (+85%)** |
| Total minified JS (prod) | 27.06 MB | 29.19 MB | **+2.13 MB (+7.9%)** |

- Vendor chunks are byte-identical; the entire size delta is app chunks
  (injected memo-cache slot logic; the sampled `settings-slot` chunk grew
  687 → 921 KB). Gzip delta will be proportionally smaller — the cache-slot
  code is highly repetitive.
- The time delta is the single-threaded Babel parse+transform of 1706 `.tsx`
  files. It is a **cold-build** cost; warm incremental rebuilds (HMR) only run
  Babel on the edited file (~tens of ms per edit).
- 3021 modules in the emitted dev bundle import `react/compiler-runtime`,
  confirming compiled components actually ship.

## Gotcha: Babel 8 silently cripples the compiler

`pnpm add @babel/core` resolves to Babel **8**, and under Babel 8's AST,
`babel-plugin-react-compiler@1.0.0` bails on every function whose parameters
destructure with defaults (`({ size = 32 }) => …`) with
`(BuildHIR::lowerAssignment) Expected object property value to be an LVal`.
That idiom appears in 844 files here — coverage collapsed to 17% until
`@babel/core` was pinned to `^7.29.0`. Do not bump it to 8 until the compiler
declares support.

## Verdict and suggested path

The compiler compiles four fifths of the codebase today with zero source
changes, and bailouts are safe (function left as written). Runtime perf was NOT
measured in this spike — that needs the flag on in a real workload (June's
re-render fan-out surfaces would be the target).

1. Land the flag-gated wiring (this PR) — default off, zero impact.
2. Dev-dogfood with `ORGII_REACT_COMPILER=true` on the dev server; watch for
   behavioral regressions and measure re-renders on the known fan-out surfaces
   (React DevTools profiler).
3. Fix the 26 refs-during-render violations independently — they are latent
   bugs regardless of the compiler.
4. Decide default-on for prod after an E2E pass over a compiled build, and
   decide whether `FAST_PROD` (esbuild path, used for local .app builds) must
   also gain the pass to keep local and release builds behaviorally identical.
5. Later: extend the pass to `.ts` (hooks, +655 functions), and only then
   consider deleting hand-rolled `memo`/`useMemo`/`useCallback` sites — removal
   before default-on would be a regression wherever the compiler bails.
