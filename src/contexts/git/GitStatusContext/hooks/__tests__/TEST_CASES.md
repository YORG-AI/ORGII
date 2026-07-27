# File index invalidation test cases

## Preconditions

- Git watcher events identify a repository with `repo_id`.
- File-path index invalidation is a cheap state transition; it does not scan.
- Content-only modifications do not change the indexed path set.

## Happy path

- Created, deleted, renamed, or unknown file events schedule invalidation.
- Aggregate `repo:changed` events invalidate only when `change_type` is `files`.
- Multiple events for one repository inside 250 ms produce one invalidation.
- Simultaneous events for different repositories invalidate each root once.

## Edge cases

- `modified` events are ignored because filenames and paths are unchanged.
- Disposing the listener clears pending invalidations.
- Empty paths are not scheduled.

## Error path

- A rejected Tauri invalidation request is reported through the supplied error callback and does not create an unhandled rejection.

## Accessibility

- Not applicable: this lifecycle change has no rendered UI or input behavior.

## Acceptance criteria

- No timer causes indexing or repeated background scans.
- A watcher burst produces at most one cheap invalidation call per root.
- Listener teardown leaves no pending timer.
