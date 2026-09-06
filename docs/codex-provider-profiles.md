# Codex provider profiles

Settings → App connections → Codex now uses the provider-card editor also used by the two Claude targets. Create a profile, choose a vault key, enter the API base URL and actual model ID, save, test, then apply. Model discovery is optional: a gateway without a model-list endpoint can still be configured manually. The shared vault catalog is never rewritten by a profile.

The Codex form has one default request model, optional reasoning effort, context-window tokens, and an optional auto-compaction threshold. It does not expose Claude role mappings. Empty reasoning/context fields select Codex defaults. A compaction threshold requires an explicit context window and cannot exceed it. Token declarations do not increase provider capacity; a small connection test does not prove that an entire declared context window works.

Connections use Bearer authentication and the Responses API. A base URL such as `https://gateway.example/prefix/v1` produces `/prefix/v1/models` for discovery and `/prefix/v1/responses` for inference. Tests send the configured reasoning effort through a synthetic tool round trip and streaming response. Successful evidence is bound to the complete saved profile and credential revision, expires after 15 minutes, and cannot authorize another model, endpoint, effort, or token declaration.

Applying writes the user-level Codex `config.toml` using the existing ORGII-owned provider and transaction/backup system. Subscription `auth.json`, other provider definitions, MCP settings, and project files remain untouched. Existing top-level `profile` or `model_catalog_json` overrides block profile activation, since those may supersede the tested selection. Explicit launch flags, project model settings, and already-running sessions can override these defaults. This feature does not create a Codex native model-picker catalog or change Codex Desktop's independent new-thread preferences.

Saving does not activate. Editing an active profile leaves the native applied revision in place until a new test and apply. Switching profiles removes the previous profile's optional model fields before writing the new values. Leaving a profile for the existing quick/proxy connection flow clears its effort/context declarations. Restore original setup restores the original native bytes after checking for external edits; saved provider cards remain available.

## Persistence and recovery

The catalog remains version 1, per target, with a maximum of 64 profiles and a 1 MiB read bound. Existing Claude JSON keeps its exact model-settings shape. The common Rust profile type now accepts either Claude role settings or Codex model settings and validates their target pairing. Keys remain vault references in the catalog and IPC status; decrypted keys are written only to the existing sensitive native configuration path on apply.

No dependency, lockfile, SQL, or global Git configuration changes are required. Older builds cannot interpret a Codex provider-profile snapshot. Before downgrading, use Restore original setup in the current build; retain the original snapshots if native files have conflicting external edits. Do not remove the manifest or overwrite a conflicting native file to force recovery.

## Verification boundaries

Native adapter tests exercise saved selection, exact TOML, optional-field removal, immutable active revisions, cross-target rejection, external-edit conflicts, subscription preservation, and restore. Resolver and HTTP fixtures check manual IDs, path prefixes, auth, protocol, reasoning, discovery, and receipt invalidation. The installed CLI fixture uses isolated homes and a loopback endpoint with synthetic credentials. Run it with:

```sh
cargo build --manifest-path src-tauri/Cargo.toml -p agent_cli --example harness-profile-fixture
python3 scripts/verification/harness-connection-cli.py --writer <target-dir>/debug/examples/harness-profile-fixture --codex-profiles
```

Screenshots show static rendering of the actual profile components with synthetic state and the existing app stylesheet, inside a preview heading: [light](codex-provider-profiles/light.png), [dark](codex-provider-profiles/dark.png), [narrow](codex-provider-profiles/narrow.png), [empty](codex-provider-profiles/empty.png), [loading](codex-provider-profiles/loading.png), [error](codex-provider-profiles/error.png). These are not native Tauri or Codex Desktop screenshots. Native GUI, Windows runtime, CPU/RSS lifecycle measurements, and real paid gateway capacity are not verified.

Native field reference: [official Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference), [custom model providers](https://learn.chatgpt.com/docs/config-file/config-advanced). No cc-switch code or dependency is imported.
