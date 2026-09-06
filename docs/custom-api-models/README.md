# Custom API model catalog

Custom API connections can be saved without model discovery. In the Key Vault
wizard, select Custom API, choose the protocol, enter an HTTP(S) endpoint and API
key, then add and enable the exact request IDs accepted by that endpoint. Each row
has an optional display name and icon. Discovery remains optional; saving manual
configuration does not claim that a provider request succeeded.

Manual row edits do not issue automatic availability probes for Custom API. The
existing Validate action remains available. The API key, endpoint and at least
one complete enabled model are required for manual setup. Native OAuth setup
continues to use its existing authentication gates.

## Persistence and refresh

`ModelKey.model_aliases[].alias` is the existing persisted user-specified request
ID; `display_name` is presentation metadata. A manual row creates this record even
when its display name is blank. No SQL migration or new wire field is introduced.

`KeyService::save_key` validates explicit IDs before writing and includes them in
`available_models`. IDs are nonempty, at most 256 UTF-8 bytes, and contain no
whitespace or control characters. Display names are trimmed, limited to 256
bytes, and cannot contain control characters. Duplicate explicit IDs are rejected
atomically. Empty draft rows have a transient `isDraft` marker and are omitted
from the save request; no prefix is reserved in user IDs.

Health/catalog refresh owns discovered models, while explicit aliases and their
enabled choices remain user-owned. Empty discovery does not erase the manual
catalog. Explicit saves can disable or remove manual rows. Explicitly enabled
dated IDs are no longer removed by CRUD filters; automatic discovery defaults
still follow the existing frontend selection policy.

The wizard preserves manual labels and selection during validation, including
edits made while a validation is in flight. Results from an older endpoint or
credential input cannot overwrite the new wizard catalog. When a manually
configured ID also appears in discovery, its editable row is shown once.

## Selection and request behavior

Key-first selection looks up labels by key ID plus model ID. Ambiguous labels are
not published as one global label. Custom API entries appear as individual
request IDs, including names such as `deployment-high` or dated snapshots.

For the Custom API provider, OpenAI-compatible Chat Completions and
Anthropic-compatible Messages preserve the complete request ID in streaming and
non-streaming requests. The provider does not expand Claude shorthand or strip
reasoning suffixes. Display names never become request IDs. Known provider types
retain their existing shorthand/variant behavior.

This is a compatibility change for old Custom API configurations that relied on
ORGII interpreting a suffix such as `-high` as a synthetic reasoning variant.
Those configurations should use the real endpoint model ID. There is no schema
migration, but reverting this change also restores the former prefix/suffix
interpretation and refresh behavior. To recover after rollback, retain the
credential JSON and re-enter any manual IDs removed by an older refresh.
Historical malformed records are not deleted or rewritten automatically.

## UI evidence

The images are headless static renders of the actual `ApiSetup`, `ModelsDisplay`,
ModelTable and design-system controls. Hooks use synthetic data; the credential
setup subcomponent is omitted to isolate the changed model section. These are
component previews, not a native desktop interaction run. Existing app CSS and
local icon assets are used. No real credentials or endpoint calls were involved.

- [Light](light.png) and [dark](dark.png): configured rows and enabled choices
- [Narrow](narrow.png): 720 px preview; long IDs scroll within their input
- [Empty](empty.png): Add Model remains available before discovery; save disabled
- [Loading](loading.png): save pending
- [Error](error.png): discovery error alongside usable manual configuration

Native desktop interaction, Windows rendering and native CPU/RSS measurements
were not performed. Automated tests cover the save request, refresh persistence,
row identity, selection and HTTP request boundaries separately.
