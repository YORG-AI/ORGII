# Claude Desktop connections

Open **Settings → App connections → Claude Desktop**. Claude Code CLI and Codex have separate selectors and independent applied connections. The existing `app/harness-connections` settings URL is unchanged.

Choose a saved API connection card, or add a connection through the key vault. Set the Desktop API endpoint, authentication scheme (Bearer token or x-api-key), and full model ID. **Test connection** checks a synthetic tool round trip and streaming against that exact endpoint, credential, and model. **Use this connection** saves the native Desktop configuration. Fully quit and reopen Claude Desktop after applying or restoring.

**Copy from Claude Code CLI** copies the currently configured key/model selection into the Desktop editor for review. It does not apply either app's configuration. Desktop endpoint changes do not edit the vault key or the CLI's endpoint. The same saved key can therefore serve different endpoints in each app.

## Compatibility

This first delivery implements direct Anthropic Messages connections for full `claude-sonnet-*`, `claude-opus-*`, `claude-haiku-*`, and `claude-fable-*` IDs, optionally prefixed by `anthropic/`. Model availability is determined by the configured endpoint. IDs can be entered manually without changing the shared vault model list.

The native adapter targets Claude Desktop 1.46388.1 and newer on macOS and Windows. The local macOS installation inspected during development was 1.46388.4. Version detection supports `/Applications/Claude.app`, user Applications installs, and Windows `%LOCALAPPDATA%/Claude/Claude.exe`. Other Windows installation layouts are not detected by this delivery. Linux is explicitly unsupported by this adapter, even though newer upstream Desktop versions document Linux configuration.

Native Desktop UI/runtime behavior, including separate Chat/Cowork/Code sessions, has not been exercised. A protocol test or generated profile does not establish native-app runtime compatibility. This change neither launches nor restarts Desktop automatically.

Arbitrary upstream model mapping, per-role aliases, context declarations, protocol translation, and the broader Codex/ORGII model catalog expansion remain the following implementation phases. Desktop does not offer ORGII proxy routing in this delivery.

## Configuration ownership and recovery

The adapter writes four user-owned files: normal Desktop configuration, 3P Desktop configuration, the profile catalog, and a distinct ORGII profile. On macOS these live under `~/Library/Application Support/Claude` and `Claude-3p`; on Windows under the corresponding local application-data directories. An isolated `ORGII_EXTERNAL_HISTORY_HOME` redirects all these paths.

Only the deployment-mode selector is changed in each app config. Other fields and catalog entries are preserved. ORGII does not change network-egress permissions or suppress the native mode chooser. Existing inline enterprise configuration and detected managed preferences/policy block local switching. This check is conservative: even an app-behavior-only managed policy is currently reported as externally controlled.

All four files participate in the existing locked, journaled config transaction. The adapter refuses stale previews, existing unowned profile-ID collisions, malformed configuration, and conflicting external edits. **Restore original setup** restores the exact pre-switch files, including the previous mode/profile selection, and removes files that were originally absent. It does not necessarily select official login if the prior setup was already third-party. Native account credentials are not changed.

Direct configuration continues to work after ORGII exits. A vault key deletion or rotation does not revoke/rewrite credentials already exported to Desktop: test and reapply the updated key, or restore the original configuration. Restore Desktop before downgrading ORGII to a release that lacks this adapter. There is no database migration; the existing manifest format and CLI target identities are preserved.

The Windows-only `winreg` dependency reads policy without launching a subprocess; its version was already in the lockfile. Windows installation version lookup uses a bounded, cancellable PowerShell read of executable metadata and never runs Claude.

## References

The separate configuration boundary follows [Anthropic's Desktop gateway documentation](https://code.claude.com/docs/en/llm-gateway-connect#desktop-app). Local profile storage, auth schemes, and model fields follow the [Desktop configuration reference](https://claude.com/docs/third-party/claude-desktop/configuration). The UI workflow was informed by [cc-switch's Desktop guide](https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/2-providers/2.6-claude-desktop.md); no upstream implementation was copied.
