# Protocol Descriptors

These checked-in binary descriptor sets keep protobuf consumers reproducible
without requiring `protoc` during normal ORGII builds.

## Cursor Agent

`cursor_agent_v1.descriptor.pb` is a binary `FileDescriptorSet` containing the
full `agent.v1` proto schema used by Cursor's internal gRPC / Connect API at
`api2.cursor.sh`.

## Provenance

Extracted from [opencode-cursor](https://github.com/ephraimduncan/opencode-cursor)'s
generated TypeScript file `src/proto/agent_pb.ts`. That file embeds the original
bufbuild-compiled `FileDescriptorProto` as a base64 blob inside a
`fileDesc("...")` call. The descriptor was decoded with:

```python
import re, base64
src = open("opencode-cursor/src/proto/agent_pb.ts").read()
b64 = re.search(r'fileDesc\(\s*"([^"]+)"', src).group(1)
b64 += "=" * (-len(b64) % 4)
fdp = base64.b64decode(b64)
```

Then wrapped as a single-file `FileDescriptorSet` (field 1, length-delimited)
so `prost-build` / `protoc` can consume it directly.

## Why binary, not `.proto` source

The `agent.v1` schema has ~300 messages across ~80KB. Shipping the binary
descriptor avoids maintaining hand-written `.proto` files that drift from
Cursor's schema. When Cursor changes the schema, re-run the extraction above
against an updated `agent_pb.ts`.

## Usage

The `agent-core` crate consumes this descriptor at build time:

```rust
// src-tauri/crates/agent-core/build.rs
let descriptor_bytes = fs::read(&descriptor_path)?;
let file_descriptor_set = FileDescriptorSet::decode(&*descriptor_bytes)?;
prost_build::Config::new().compile_fds(file_descriptor_set)?;
```

`src-tauri/crates/agent-core/src/core/providers/cursor_native/proto.rs` includes
the generated `agent.v1.rs` file from `OUT_DIR`, and the Cursor native provider
uses those `pb::*` types to encode requests, decode streaming responses, and
handle native tool-call messages for `/agent.v1.AgentService/Run`.

## Warp Multi-Agent

`warp_multi_agent_v1.descriptor.pb` is a binary `FileDescriptorSet` containing
Warp's published `warp.multi_agent.v1` schema and all of its protobuf imports.
ORGII uses the descriptor through `prost-reflect` to decode task transcript
blobs stored in Warp's local `warp.sqlite` database.

### Provenance

- Source: `warpdotdev/warp-proto-apis`
- Commit: `2d0e8ddf5a946a663f7e0952144ccbced0068a81`
- Source crate: `apis/multi_agent/v1/gen/rust`
- Generator: the source crate's `build.rs`, using `protoc` 25.9
- SHA-256: `ed37419257376d6176d818effaa25f2e323a82a56694a6a964f9ec1cd6a90dc3`
- Upstream license: AGPL-3.0-only

The upstream build script normalizes Warp's Edition 2023 sources for `prost`,
then emits `file_descriptor_set.bin`. To update the bundled schema, check out
the recorded or desired upstream commit, build that source crate with the
documented `protoc` version, replace this descriptor with the generated
`OUT_DIR/file_descriptor_set.bin`, update the commit and checksum above, and
run the `orgtrack_core` Warp history tests.
