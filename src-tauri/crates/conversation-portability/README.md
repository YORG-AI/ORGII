# Conversation portability

This leaf crate defines ORG2's provider-neutral conversation checkpoint. It
contains no provider readers, storage integration, transport integration, or
target-runtime writer.

## Exact-export boundary

An adapter may implement `ExactConversationReader` only when it hashes and
parses the same bytes through one open file handle, or one deterministic row
stream within the same database read transaction. Hash-then-reopen and
metadata-before-open observations are forbidden TOCTOU gaps. It must fail
closed on reader caps, skipped or unterminated records, unknown roles, and
truncated visible/tool content. A string such as `...[truncated]` is ordinary
source text, never truncation metadata. Exact adapters produce `PortableEvent`
directly, including source record/block provenance; display `ActivityChunk`,
preview-window, and truncating replay loaders are outside this boundary. No
provider adapter is enabled by this leaf crate.

The v2 IR preserves user, assistant, system, and developer messages; distinct
compaction boundaries and summaries; source record/block grouping and thread
identity; structured tool input/result linkage; and explicit pending versus
settled tool state. It never invents a successful result for a pending call
and never guesses that an arbitrary raw record is a user message. Images must
be embedded data URIs; local paths and mutable HTTP references are blocking
attachment loss.

## Fidelity and materialization

The typed loss manifest has independent visible and continuation axes:

- `is_exact_visible()` means visible content has no blocking loss.
- `is_continuation_materializable()` also requires system/developer/tool/
  compaction context needed to continue.
- `is_continuation_complete()` additionally means no opaque/private/runtime
  state was reported omitted.

Private reasoning and runtime lifecycle omissions are non-blocking but degrade
continuation fidelity, so callers cannot describe the result as
native-equivalent. Any visible message, tool content, unknown-role, or
attachment-content loss blocks materialization. This model never claims to
reproduce credentials, hidden model state, signed reasoning, live processes,
or byte-identical native files.

## Frozen encoding

Canonical JSON sorts object keys lexically, keeps array order, uses fixed
string escaping, base-10 integers, and the pinned `ryu` finite-float encoding.
The v2 golden bytes and SHA-256 freeze this behavior. Producers and decoders
enforce a 64 MiB bound and reject rather than truncate; the encoder performs a
checked payload lower-bound pass before materializing the JSON value.
