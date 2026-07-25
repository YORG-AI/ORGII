# ORG2 real HEAD rebuild / install / Feishu E2E — 2026-07-25

## Verdict

The 01:26 artifact was rejected and was **not installed**. A clean, source-verified build from commit `4b732980f47d952d2bd147b4422e3ff79c515c4d` was built, validated, installed, and launched as one process.

Real artifact directory:

`/mnt/panshuainan/org2-unified-20260724/artifacts/tree-mindmap-feishu-head-REAL-20260725-114119`

## Root cause of the false HEAD artifact

Container `org2_release_head_20260725` mounted:

- current repo → `/work` read-only (correct source),
- pre-existing Docker volume `orgii_session_memory_embedding_target` → `/work/src-tauri/target`,
- artifact destination → `/artifacts`.

The build command produced `/work/src-tauri/target/release/org2`, but its copy step incorrectly copied
`/work/src-tauri/target/x86_64-unknown-linux-gnu/release/org2`. That stale cross-target binary in the reused
volume had mtime `2026-07-24 15:07:39Z` and SHA `31c007b3130b15a9a39447ba875f69da0564f2993d60a8717e4c05503edd81de`; the false artifact and older sol-org2-final
have exactly that SHA and build-id `500068bdc59fcf2e954df706fb09af5ba17d7eb9`. Meanwhile the actually built release binary in the same volume
was SHA `59639eb042131c0703a5e7831d1ddb369f62c32ece5b38c764ea6762df9134ef`. Therefore the source mount was not
the problem; the reused target volume + wrong copy path selected an old output.

## Clean build and tests

- Recorded HEAD and source hashes in `BUILD_PROVENANCE.txt`.
- Frontend production webpack build ran first into a fresh timestamped directory.
- Focused frontend tests: **17/17 passed**.
- Feishu routing regression test: **1/1 passed**.
- Cargo/Tauri release used a brand-new Docker target volume and explicitly removed both release directories before build.
- Copied only the actual Tauri output `src-tauri/target/release/org2`.

Real SHA/build evidence:

- binary: `59639eb042131c0703a5e7831d1ddb369f62c32ece5b38c764ea6762df9134ef`
- AppImage: `d91cf701c10badaf721faf4bbabeae22a1f01c83d45252705180e5e4d251d595`
- deb: `ae7ff6f57a7b5f4cbb5adc3eaae41ec41963a1333cb3218c90e88d37efd114c7`
- build-id: `e8eca8b6fec9aaa347e03a69922b254f19712b15`
- binary mtime: `2026-07-25 12:06:44.831537811 +0800`
- old binary SHA/build-id: `31c007b3130b15a9a39447ba875f69da0564f2993d60a8717e4c05503edd81de` / `500068bdc59fcf2e954df706fb09af5ba17d7eb9`

The new binary differs from the old artifact in SHA, size, mtime, and build-id. The exact new routing source
was asserted inside Docker by SHA before both test and release. The focused test
`reinjected_error_response_targets_original_transport` passed and proves Feishu/error replies target the
original transport. Release log compilation includes current `agent_core` after that assertion.

Package extraction is documented in `PACKAGE_BINARY_VERIFICATION.txt`. Tauri patches the binary once per
bundle type, so package payload SHA values differ, but standalone/deb/AppImage payloads all share build-id
`e8eca8b6fec9aaa347e03a69922b254f19712b15` and the same compiler metadata. This explains the expected packaging difference.

## Install and runtime

- Backup: `/home/panshuainan/.local/opt/org2-fork/backups/org2.pre-feishu-real-20260725-120843` (SHA `879c9719df642d6f91945ec72ef1cbcba9e52600be1b72a480569a3009d8da34`)
- Old PIDs 3424676 and 3428754 received SIGTERM and exited gracefully.
- Installed binary SHA equals real artifact SHA: `59639eb042131c0703a5e7831d1ddb369f62c32ece5b38c764ea6762df9134ef`.
- New PID: `1118322`.
- Environment inherited exactly: `DISPLAY=:1`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus`,
  `XDG_RUNTIME_DIR=/run/user/1001`.
- Exactly one installed ORG2 process is running.
- New log contains exactly one Feishu worker start and one successful WebSocket connection; evidence is in
  `RUNTIME_CHANNEL_LOG_EVIDENCE.txt`.

## Feishu outbound E2E

Using the existing `~/.orgii` Feishu account and the latest persisted Feishu test chat binding, sent exactly:

`ORG2 channel e2e test`

Feishu returned `code=0`, `msg=success`, and a message ID. No secret or target ID was printed. Evidence:
`FEISHU_E2E.txt`.

Inbound was not claimed; user can reply to the ORG2 bot for an inbound round trip. Outbound and single-worker
requirements passed.

## Stripped-binary routing feature evidence

The release executable is stripped, so private Rust helper/test symbols and source comments are intentionally absent from
`strings`. Verification therefore uses a chain rather than pretending comments survived optimization: exact
`workers.rs` SHA was checked inside Docker before test and release; the targeted routing test passed; the new ELF has
a fresh build-id; and the machine-code/data window around the retained routing error literal differs from the old binary.
See `ROUTING_BINARY_FEATURE_EVIDENCE.txt`.
