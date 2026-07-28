# Architecture Audit — Select Ghost Consolidation

**Scope:** consolidating `Select`'s `variant="ghost"` and `ghostTextOnly`
behaviors into one canonical ghost contract, migrating every consumer, and
removing the obsolete prop, selector branch, and callsite overrides.

## Acceptance criteria

- [x] `SelectProps` exposes one ghost control: `variant="ghost"`.
- [x] Ghost selects are borderless, backgroundless, normal-weight, and use
      muted-to-primary text feedback for hover/open state.
- [x] The default Select variant is unchanged.
- [x] All source hits for `ghostTextOnly`, its CSS class, and its old custom
      background variables are removed.
- [x] `SelectGhostTrigger` and every explicit ghost Select consume the same
      canonical CSS path.
- [x] TypeScript, changed-file ESLint, focused tests, formatting, and whitespace
      validation pass.

## 10-layer review

| Layer | Coverage                             | Verdict          | Notes                                                                                                                                                                                                |
| ----: | ------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     1 | Compilation correctness              | pass             | Full `tsc --noEmit`, changed-file ESLint, and the focused 10-test suite pass.                                                                                                                        |
|     2 | Dead code / structural deduplication | pass             | Removed the redundant prop, destructuring/default branch, conditional class, CSS subtype, one callsite flag, and dead hover/open background variables.                                               |
|     3 | Naming consistency                   | pass             | `ghost` is now the only Select name for the transparent text interaction; no legacy name remains in source or tests.                                                                                 |
|     4 | Semantic overloading                 | keep with reason | Select, Button, and TabPill each expose a component-appropriate ghost prop, but all now mean a transparent supporting control with color-only feedback. Select no longer has two meanings for ghost. |
|     5 | Default branches                     | pass             | `variant="default"` remains the default. Only explicit ghost consumers enter the consolidated style path; no catch-all changed.                                                                      |
|     6 | Cross-domain leakage                 | pass             | The shared Select owns ghost behavior. Feature callsites only select the variant and retain layout-specific sizing/width overrides.                                                                  |
|     7 | New-developer clarity                | pass             | One prop maps to one wrapper class and one documented CSS block. `SelectGhostTrigger` documentation now describes text-state styling rather than removed background fills.                           |
|     8 | Wire protocol / serialization        | not applicable   | No request, response, IPC, persistence, or serialized payload changed.                                                                                                                               |
|     9 | Init parity                          | not applicable   | No initialization or registration path changed; all rendered Select entry points share the same component implementation.                                                                            |
|    10 | Resolver symmetry                    | not applicable   | No multi-source resolver or fallback chain changed.                                                                                                                                                  |

## Call path

`Select variant="ghost"` → `select-ghost` wrapper class → one shared SCSS
contract for rest, hover, open, suffix, and arrow states.

`SelectGhostTrigger` intentionally joins the same path by rendering
`select-ghost` around the shared design-system Button.

## Systematic sweeps

- Inspected all 23 `variant="ghost"` source hits; all 17 live Select callsites
  share the canonical CSS path, while the remaining hits belong to documented
  examples or separate component APIs.
- Removed the only feature-level `ghostTextOnly` callsite.
- Removed the only callsite that reintroduced a ghost hover background.
- Removed the only two custom properties supporting the old filled hover/open
  behavior.
- Verified zero source hits for the removed prop, CSS subtype, and custom
  properties.

No Rust, backend, wire-schema, initialization, or resolver layer changed.
