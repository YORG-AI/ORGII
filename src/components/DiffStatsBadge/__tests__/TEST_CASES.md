# Test Cases: DiffStatsBadge (`size` prop)

Covers the `size` API added to consolidate per-call-site font-size specification
(previously `text-[11px]` / `text-[12px]` Tailwind arbitrary values or SCSS
`font-size` rules) into a single intrinsic prop.

## Preconditions

- `DiffStatsBadge` renders `null` when there are no visible additions/deletions.
- `size` maps to a font-size class via `getDiffStatsSizeClass`:
  `xs → text-[11px]`, `sm → text-[12px]`, `md → text-[13px]`, `inherit → "" (no class)`.
- Default `size` is `"inherit"`, so existing usages render unchanged.

## Happy Path

| #   | Steps                                                             | Expected Result                                                                  |
| --- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | Render with `size="xs"` (e.g. `DiffSummary`)                      | Container span includes `text-[11px]`; renders at 11px.                          |
| 2   | Render with `size="sm"` (e.g. `FeedMessage` file row)             | Container span includes `text-[12px]`; renders at 12px.                          |
| 3   | Render with `size="md"`                                           | Container span includes `text-[13px]`; renders at 13px.                          |
| 4   | Render `variant="default"` with no `size`                         | No extra font-size class added; size stays the variant's baked-in `text-[12px]`. |
| 5   | Render `variant="plain"` with no `size` inside a `text-xs` parent | No font-size class added; badge inherits 12px from parent (no regression).       |

## Edge Cases

| #   | Scenario                        | Steps                                  | Expected Result                                                 |
| --- | ------------------------------- | -------------------------------------- | --------------------------------------------------------------- |
| 1   | Explicit `size="inherit"`       | Pass `size="inherit"`                  | `getDiffStatsSizeClass` returns `""`; no font-size class added. |
| 2   | Unknown size value              | Force `size={"lg"}` (cast)             | Falls back to `inherit` (`""`); never throws.                   |
| 3   | `size` + `className` together   | `size="xs"` with `className="ml-auto"` | Both applied: `text-[11px]` and `ml-auto` on the container.     |
| 4   | Zero additions and deletions    | `additions={0} deletions={0}`          | Component returns `null` regardless of `size`.                  |
| 5   | Single side via `showAdditions` | `size="xs"` + `showDeletions={false}`  | Only the additions span renders, still sized via `size`.        |

## Error / Degraded States

| #   | Scenario              | Steps                                   | Expected Result                                                 |
| --- | --------------------- | --------------------------------------- | --------------------------------------------------------------- |
| 1   | `size` is `undefined` | Omit the prop                           | Treated as `inherit`; no font-size class, no crash.             |
| 2   | Mismatched px caller  | Caller needs a non-scale px (e.g. 10px) | Caller keeps its own `text-[10px]`; not forced to a named size. |

## Accessibility

- [x] Badge is decorative inline text (`<span>`), no interactivity → no a11y obligation changed by `size`.
- [x] `size` affects font-size only; no impact on focus order or screen-reader output.

## Acceptance Criteria

- [x] `getDiffStatsSizeClass` returns the correct class for `xs`/`sm`/`md`/`inherit`.
- [x] Default rendering (no `size`) is byte-for-byte unchanged for `default`/`compact`/`chat` variants.
- [x] Migrated `plain` sites (`DiffSummary`, `FeedMessage`, `CombinedDiffView`, `CanvasApp`, `ModernSplitDiff`, `TaskImpactLine`) preserve their previous pixel size.
- [x] Sites whose size does not map to a named token (`SessionDiffWindow` 10px) are left unchanged.
- [x] Removed external font-size declarations (Tailwind `text-[Npx]` and SCSS `font-size`) leave other styling intact.
