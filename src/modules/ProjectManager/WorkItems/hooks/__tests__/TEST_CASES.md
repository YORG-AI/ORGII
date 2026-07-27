# Work Items async loading test cases

## View-data requests

- The mount effect and a same-scope project-data event share one request.
- Filtered reads with the same project, status, and search query share only
  their active IPC request; a later intentional refresh still reaches Rust.
- Changing project, status, or debounced search supersedes the prior scope.
- A late response from the superseded scope cannot replace the visible data,
  error, or loading state.
- Failed requests release their scope so the same filters can retry.

## Workspace aggregates

- Mount, manual refresh, and a project-data event share equal in-flight work.
- Switching org or external-source mode starts a new generation.
- Linear and local results from an older generation cannot overwrite the new
  workspace selection.
