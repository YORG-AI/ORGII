# Test Cases: TeamInbox "Load more" pagination (A1)

Covers the load-more pagination feature wired through
`useTeamInboxDataSource.loadMore` → `TeamInboxView` → `TeamInboxList`.
Behavior is derived from the shipped implementation, not aspirational.

## Preconditions

- Team Inbox tab is open and the connected data source (`ConnectedTeamInboxView`)
  is mounted, or the injectable `TeamInboxView` is rendered with a
  `dataSource` implementing `listPage` (+ optional `loadMore`).
- Local source page size is 50 (`listLocalTeamInboxPage(..., 50)`); cloud
  mentions page size is 50 (`listTeamInboxMentions(..., 50)`).
- `hasMore` is surfaced to the view via `listPage().nextCursor != null`; the
  cursor value itself is an inert sentinel — the data source owns the real
  per-source cursors (`localCursorRef` / `cloudCursorRef`).
- The load-more control renders only inside the non-empty list branch, at the
  bottom of the scroll area, when `hasMore === true` and `onLoadMore` is defined.

## Happy Path

| # | Steps | Expected Result |
|---|-------|-----------------|
| 1 | Open inbox with > 50 assigned local items (or > 50 mentions). | First page (≤ 50 per source) renders; "Load more" button is visible at list bottom. |
| 2 | Click "Load more". | Button shows loading/disabled; next page of each source with a remaining cursor is fetched, appended, de-duplicated (`dedupeTeamInboxItems`), re-sorted by the view selectors; new items appear. |
| 3 | Keep clicking "Load more" until exhausted. | Each click appends the next page; when both `localCursorRef` and `cloudCursorRef` are null, `hasMore` becomes false and the button disappears. |
| 4 | Load more with both local + cloud having further pages. | Both sources advance one page; merged list stays newest-first after the view's `selectTeamInboxItems` (dedupe + sort). |
| 5 | After load-more, mark a newly-loaded item read. | Optimistic read state applies to the appended item exactly as for first-page items. |

## Edge Cases

| # | Scenario | Steps | Expected Result |
|---|----------|-------|-----------------|
| 1 | Empty inbox | Open inbox with 0 items. | Empty `Placeholder` renders; **no** "Load more" button (it lives in the items-present branch). |
| 2 | Single page | Open inbox where both sources returned `nextCursor == null`. | `hasMore === false`; **no** "Load more" button; list is complete. |
| 3 | Exactly one source paginates | Local has a next page, cloud does not (or vice versa). | Button shown while either cursor is non-null; each click advances only the source that still has a cursor; the exhausted source contributes nothing. |
| 4 | Multi-page to exhaustion | Click load-more repeatedly. | Cursors advance each call; button hides once both cursors are null; no duplicate rows (dedupe by canonical `kind:id`). |
| 5 | Rapid repeated clicks | Click "Load more" several times quickly. | `loadingMoreRef` guard + `disabled={loadingMore}` ensure only one in-flight load; extra clicks are no-ops; no duplicated/skipped pages. |
| 6 | Load-more with active search query | Type a query, then click "Load more". | Load-more fetches more raw items into the cache; the client-side search (`searchTeamInboxItems`) re-applies over the enlarged set. |
| 7 | Load-more with a filter tab active (mentions/assigned) | Switch filter, then load more. | Raw items append to the shared cache; the active filter (`selectTeamInboxItems`) still narrows the rendered list. |
| 8 | Duplicate item across pages | A canonical item appears in two fetched pages. | Deduped to one; the freshest `occurredAt` copy wins (`dedupeTeamInboxItems`). |
| 9 | Refresh after paginating | Load more, then trigger refresh (manual or project-change signal). | Cursors reset to page 1; `hasMore` recomputed from page-1 cursors; list resets to first page. |

## Error / Degraded States

| # | Scenario | Steps | Expected Result |
|---|----------|-------|-----------------|
| 1 | Cloud fetch fails during load-more | Cloud RPC throws while paginating. | Caught inside `loadMore` (`.catch(() => ({ mentions: [], nextCursor: undefined }))`); cloud cursor becomes null (cloud pagination stops); local page still appends; no crash. |
| 2 | Local fetch fails during load-more | `listLocalTeamInboxPage` rejects. | `Promise.all` rejects → `handleLoadMore` catch sets the error banner (`teamInbox.errors.load`); `loadingMore` resets via `finally`; existing items remain. |
| 3 | Load-more called with no cursors | `hasMore` stale-true but both cursors null. | `loadMore` early-returns (no-op); no fetch; `loadingMore` never gets stuck. |
| 4 | Signed-out / no active cloud org | Only local paginates. | Cloud branch resolves to empty; only local advances; behavior identical to Edge #3. |

## Accessibility

- [ ] "Load more" uses the design-system `Button` (keyboard focusable, Enter/Space activate).
- [ ] While loading, the button is `disabled` and shows `loading` state (no double submit).
- [ ] The button has a visible localized label (`teamInbox.loadMore`, defaultValue "Load more") — no raw i18n key leaks.
- [ ] Load-more does not steal focus from the list; existing roving-tabindex list navigation is unaffected.

## Acceptance Criteria

- [ ] Items beyond the first 50 per source are reachable (no silent truncation) via load-more.
- [ ] `hasMore` accurately reflects "either source has a next page" and the button visibility follows it.
- [ ] Appended pages are de-duplicated and correctly ordered by the view selectors.
- [ ] Concurrent/rapid load-more is guarded (single in-flight request).
- [ ] A cloud failure degrades gracefully (local still paginates); a local failure surfaces a non-blocking error banner without losing loaded items.
- [ ] Unread badge semantics are unchanged by load-more (the single-source-of-truth question, A2, is intentionally out of scope here and documented in code).
- [ ] `pnpm test` for `src/modules/MainApp/TeamInbox` passes; no new TypeScript/lint errors in edited files.

## Notes / Known limitations

- The unread badge does **not** count unread mentions that only appear on page 2+
  (badge = local full-DB unread + first-page unread mentions). This matches the
  pre-A1 direction and is deferred to the A2 "unread single source of truth" task.
- Hook-level behavior is not unit-tested (repo policy forbids `.tsx` / React
  Testing Library tests); pure logic is covered by `selectors.test.ts`
  (dedupe/sort/select) and `store.test.ts`.
