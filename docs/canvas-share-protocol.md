# Canvas Share Protocol

Canvas sharing is independent from ORG2 Cloud session replay sharing. It
publishes one immutable Canvas snapshot and never reads or serializes the
owning session, conversation, repository, or later revisions.

## Ownership and path

```text
Canvas toolbar click
→ getCanvasShareAvailability(selectedPayload)
→ createCanvasShareEnvelope(selectedPayload)
→ gzip + base64url
→ POST https://canvas.org2.dev/api/canvas-shares
→ https://canvas.org2.dev/#/s/<opaque-id>
  ↳ upload unavailable: #/share/g1/<embedded-payload>
→ public viewer validates the envelope
→ HTML/React runs in a sandbox without allow-same-origin
```

The ORGII generator is owned by `src/features/CanvasShare`. The public decoder,
renderer, and same-origin API proxy are owned by
`ORGII-cloud-infra/apps/canvas-share`; the authoritative snapshot API and
persistence remain in `ORGII-cloud-infra/apps/org2-cloud-web`. The service
stores only the compressed envelope and never receives session, conversation,
repository, or account data. All boundaries must keep the versioned envelope
compatible.

## State machines

The desktop dialog owns one operation at a time:

```text
closed --share--> ready(cached, still valid)
      \--share--> preparing --upload succeeds--> ready(short)
                           \--upload fails-------> ready(self-contained)
                           \--encode/size fails--> error --retry--> preparing
preparing/ready/error --close--> closed (supersede this dialog subscriber)
```

The viewer is independent:

```text
route change --> loading --fetch/decode/validate--> ready
                       \--missing/expired/invalid--> error
loading --route change or unmount--> abort
```

## Version 1 envelope

```ts
interface CanvasShareEnvelopeV1 {
  version: 1;
  canvas: {
    mode: "html" | "react" | "a2ui" | "url";
    title?: string;
    content?: string;
    url?: string;
  };
}
```

`eventId`, `revisesEventId`, `streaming`, `sessionId`, events, messages, and
repository metadata are intentionally absent.

The default viewer deployment can be replaced at build time with
`REACT_APP_CANVAS_SHARE_VIEWER_URL`. The viewer URL must use HTTPS, except for
localhost development. The upload endpoint can be replaced with
`REACT_APP_CANVAS_SHARE_API_URL`; the viewer uses the corresponding
`VITE_CANVAS_SHARE_API_URL` setting.

The canonical ORG2-owned viewer URL is `https://canvas.org2.dev/`. Existing
`https://beruro.github.io/canvas-share/` links remain valid as frozen legacy
compatibility links, but the desktop app no longer generates them by default.

## Limits and failure policy

- A Canvas cannot be shared while it is streaming or being revised.
- Payloads whose mode is not one of `html`, `react`, `a2ui`, or `url` are
  rejected before encoding (`unsupported-mode`), matching what the decode
  validator accepts.
- URL mode accepts publicly routable HTTP(S) URLs only. Both the producing
  availability gate and the decode validator reject (reason `local-url`):
  non-HTTP(S) schemes; `localhost`, `*.localhost`, `*.local`, and
  `*.internal` hostnames; IPv4 loopback (127.0.0.0/8), RFC 1918 ranges
  (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), link-local (169.254.0.0/16),
  and 0.0.0.0/8 literals; and IPv6 loopback (`::1`), unspecified (`::`),
  unique-local (`fc00::/7`), link-local (`fe80::/10`), and IPv4-mapped
  private literals.
- Uncompressed source is limited to 512 KiB.
- Hosted compressed payloads are limited to 768 KiB and are validated again at
  the server's producing boundary before storage.
- The final self-contained link is limited to 64 KiB.
- Hosted IDs contain 128 random bits, are immutable, and expire after one year.
- Anonymous writes are limited to 20 snapshots per IP hash per hour. Expired
  rows and stale rate counters are removed in bounded batches during writes;
  the rate check runs before JSON parsing or gzip decompression, and there is
  no poller or background client work.
- Upload has an 8-second deadline. Any network, service, or rate-limit failure
  falls back to the legacy self-contained link. If the snapshot fits the
  hosted upload but exceeds the 64 KiB self-contained link cap while the
  service is down, the dialog reports a retryable service outage
  (`short-link-unavailable-too-large`) instead of claiming the Canvas is too
  large. A misconfigured `REACT_APP_CANVAS_SHARE_API_URL` fails loudly with a
  configuration error; it is never converted into the retryable fallback.
- A link whose envelope declares a protocol version newer than the app
  supports is reported as "created by a newer version"
  (`unsupported-version`), distinct from a corrupted or incomplete link.
- Closing or unmounting the dialog supersedes that UI subscriber, so stale
  results cannot reopen it. The bounded app-level cache may finish the shared
  in-flight generation so returning to the same Canvas tab does not upload the
  same immutable snapshot again.
- The common eligibility path uses constant-time string bounds instead of
  allocating an encoded copy during render. Exact UTF-8 measurement runs only
  for large ambiguous inputs.
- The app runtime keeps a bounded LRU of at most 16 immutable snapshots and at
  most 1 Mi retained characters, counting both the snapshot fields and, once
  an entry is ready, its generated link (self-contained links can reach the
  64 KiB link cap each). The bound is re-enforced when an entry transitions
  to ready, so the worst case is 1 Mi retained characters (~2 MiB of UTF-16
  string memory). Duplicate opens share one in-flight generation; failures
  are removed immediately; expired short links are regenerated; eviction
  aborts pending work without surfacing an error to subscribers that shared
  the evicted generation. The cache is never persisted or shared across app
  launches.
- Anyone with the complete link can view the snapshot. Hosted IDs are unlisted,
  not encrypted; legacy fragment links remain fully self-contained and
  backward compatible.

## Failure and recovery matrix

| Journey                                              | Authoritative behavior                                                                                                                                                   | Recovery                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Upload offline, timeout, 404, 429, or 5xx            | Desktop keeps the encoded envelope and produces the legacy link; if that link would exceed the 64 KiB cap, the dialog reports a retryable outage instead of a size error | User can copy/open immediately, or retry later; retrying may produce a short link   |
| Dialog closes or the Canvas tab unmounts during work | That dialog subscriber ignores completion; the bounded cache may finish and reuse the result after remount                                                               | Reopen Share for the same snapshot, or explicitly share the newly selected snapshot |
| Short ID missing or expired                          | Viewer shows a bounded unavailable state; it never guesses or lists IDs                                                                                                  | Ask the sender for a new snapshot                                                   |
| Stored or embedded payload is malformed/oversized    | Viewer rejects before rendering; server rejects malformed writes before persistence                                                                                      | Generate a fresh link from a valid Canvas                                           |
| React/HTML runtime throws after validation           | The existing sandbox/runtime error UI owns the failure                                                                                                                   | Reload or ask for a corrected Canvas                                                |
