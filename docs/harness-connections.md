# Connect Claude Code and Codex to saved API keys

Open **Settings → Harness connections**. Add an API connection using the existing Key Vault wizard, or import a saved cc-switch connection. Select the connection and model under Claude Code or Codex, test it, and choose **Use this connection**. Start a new CLI session after applying.

The same controls are available in each harness's detail view. API keys remain managed in Key Vault; this feature sets the local CLI default. It does not change hosted ORGII session profiles, Codex cloud, or existing running sessions. Project settings, explicit CLI profiles, command-line flags and environment variables may override the default.

## Supported scope

| Harness     | Minimum accepted version | Native protocol                                  | Configuration                                                          |
| ----------- | ------------------------ | ------------------------------------------------ | ---------------------------------------------------------------------- |
| Claude Code | 2.1.238                  | Anthropic Messages with tool calls and streaming | settings.json under CLAUDE_CONFIG_DIR or the default .claude directory |
| Codex CLI   | 0.148.0                  | OpenAI Responses with tool calls and streaming   | config.toml under CODEX_HOME or the default .codex directory           |

These minimums match the installed versions exercised during development, rather than claiming untested older versions work. Gemini and OpenCode direct adapters are future work. Other existing harness proxy controls remain available through their original detail pages.

**Direct** is the default and keeps working after ORGII closes. It writes an API credential into the CLI's native configuration with restricted file access. Codex uses its custom provider bearer-token field, so its saved OpenAI login is preserved. Claude's saved subscription credentials are also preserved; conflicting settings-level API authentication is replaced as part of the exported configuration and can be restored.

**Advanced → Through ORGII** retains the existing local proxy behavior and requires ORGII to remain open. Clean shutdown restores managed profiles when no external edits conflict.

A saved configuration records what ORGII wrote. It does not prove that a running session uses it. Editing or removing a vault key does not revoke a credential previously exported in direct mode; apply the updated connection, restore the original setup, or revoke the key with its provider as appropriate.

## Compatibility testing

Third-party endpoints require a successful test for the exact selected credential, endpoint, protocol and model before applying. The test sends a synthetic echo function call and returns its result in a second request, then checks streaming completion. It runs no workspace tools and sends no workspace content. Provider usage charges may apply. The test is cancellable, times out after 45 seconds, and bounds each response to 256 KiB. Successful evidence expires after 15 minutes or an application restart.

A provider's “OpenAI compatible” label does not prove Responses support. A Chat Completions-only response fails the Codex test. Passing the synthetic test does not guarantee every coding task, large context, model-specific option or future CLI version works. No commercial gateway has been certified by this change. Support for non-Claude models in Claude Code is also not a claim of Anthropic vendor support.

## Import and recovery

Import reads cc-switch's existing SQLite profiles without changing its database. Claude/Codex model metadata is retained when present; proxy-managed sentinel credentials are excluded. Imported profiles use the existing vault import results and duplicate detection. A profile without usable model metadata may need editing in Key Vault before it can be selected. Import does not apply a profile or execute upstream scripts.

Before the first switch, ORGII snapshots the original files. **Restore original setup** returns to that snapshot. Unrelated settings are preserved on apply; Codex TOML comments are preserved as well. External edits block apply and restore rather than being silently overwritten. Refresh the view and review the native file and stored snapshot. A configuration-directory change requires restoring the original root before another switch.

If a transaction was interrupted, the next operation attempts recovery. If another tool changed the target in the meantime, ORGII preserves the journal and reports the conflict. Keep copies of both versions, reconcile the target with the intended original/applied snapshot, then retry. Existing versioned backups are retained and may contain credentials; treat the ORGII data directory accordingly. Restore original setup before downgrading to a version that does not understand direct profiles.

## Development evidence

The loopback verification script uses the real installed CLIs with temporary HOME, CODEX_HOME, CLAUDE_CONFIG_DIR and ORGII_HOME directories and synthetic credentials:

```sh
cargo build --locked --manifest-path src-tauri/Cargo.toml -p agent_cli --example harness-profile-fixture
python3 scripts/verification/harness-connection-cli.py --writer <cargo-target>/debug/examples/harness-profile-fixture
```

Both macOS CLI fixtures passed: generated profile → selected Authorization/model/endpoint → rendered response. Separate application protocol tests cover tool-result request bodies and streaming completion. Configuration tests cover repeated switching, original-login preservation, restore, direct shutdown persistence, malformed input, provider-name collisions, stale previews, symlinks, file permissions, advisory locks and interrupted recovery.

Windows/Linux runtime behavior, Windows ACLs, real paid gateways and real Tauri visual/lifecycle measurements remain unverified. No desktop computer control was used. See the feature's architecture, UI and performance review reports for boundaries and gaps.

Research reference: [cc-switch at the inspected revision](https://github.com/farion1231/cc-switch/tree/5a04034816e63e034d5ba9031eb10cec2190e8d1). This implementation reuses ORGII's own vault and transaction layer; it does not depend on a cc-switch SDK or copy upstream implementation code.
