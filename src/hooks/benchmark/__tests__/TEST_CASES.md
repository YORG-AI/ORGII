# Benchmark async coordination test cases

## Task discovery

- Multiple mounted benchmark consumers requesting the same kind, source path,
  and limit share one backend request.
- A failed shared request releases its entry so a later retry can run.
- A changed kind or source path is a distinct scope and cannot reuse the old
  result.

## Status polling

- Agent-batch and benchmark-run status requests share one in-flight request per
  identifier.
- A completed status response is reused only inside the current two-second poll
  period.
- Polling never overlaps a still-running request.
- Hidden pages keep no polling timer; becoming visible runs one catch-up pass.
- Cleanup during an active request prevents any subsequent timer.
