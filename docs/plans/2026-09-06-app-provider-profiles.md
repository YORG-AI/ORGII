# App provider profiles: distinguish Claude Desktop and CLI first

Status: proposed plan, no implementation changes
Date: 2026-09-06

## Outcome and completion criteria

The first deliverable separates Claude Desktop from Claude Code CLI in settings, persistence, native configuration, testing, and restoration. Subsequent work adds the requested model mapping and custom provider experience to each supported app.

- [ ] Settings has explicit Claude Code CLI, Claude Desktop, and Codex entries, with separate active connections and compatibility status
- [ ] Applying or restoring Desktop never writes CLI configuration, and vice versa; shared credentials are references, not shared active selections
- [ ] Desktop has a working custom endpoint / credential / test / apply / restore flow, with restart instructions and platform/version detection
- [ ] Existing CLI connections and backups remain usable; an existing `claude_code` selection is never reinterpreted as Desktop
- [ ] Users can copy a connection between apps with a preview of compatible settings, without silently changing the source
- [ ] The subsequent mapping editor supports distinct role-to-request-model assignments and optional display names, rather than replacing every role with one model
- [ ] Manual model IDs work without model discovery; discovered models are suggestions, not a permanent allowlist
- [ ] ORGII's own model picker and Codex configuration receive their own appropriate model settings
- [ ] Exact request-model routing, external-edit conflicts, rollback, secret redaction, and lifecycle behavior have regression coverage

## Current implementation and verified distinction

PR #1308 delivered two CLI connection editors. `HarnessConnectionsSection.tsx` passes `claude_code` and `codex` to the shared editor. The direct writer in `src-tauri/crates/agent-cli/src/managed_config/direct.rs` handles only those targets. It currently clears Claude role aliases and writes one selected model. Custom URLs already exist through vault `base_url`; the missing pieces are per-app profiles, a complete endpoint editor, and richer model configuration.

Anthropic documents that Desktop gateway routing uses third-party inference configuration, rather than the CLI's `ANTHROPIC_BASE_URL` or `settings.json`. Desktop also contains Chat, Cowork, and Code surfaces: support for one surface must not be used as evidence for the others. [Gateway configuration](https://code.claude.com/docs/en/llm-gateway-connect#desktop-app), [Desktop reference](https://code.claude.com/docs/en/desktop)

cc-switch likewise exposes separate Claude Code and Claude Desktop entries. Its Desktop integration uses a 3P profile and distinguishes direct providers from routes that require its local gateway. Switching Desktop requires a restart. This is a configuration adapter difference, not just a naming difference. [cc-switch Desktop guide](https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/2-providers/2.6-claude-desktop.md)

Research reference: cc-switch checkout `5a04034816e63e034d5ba9031eb10cec2190e8d1`, particularly `src-tauri/src/claude_desktop_config.rs` and `src/components/providers/forms/ClaudeDesktopProviderForm.tsx`. Documentation and code differ on some model roles, so installed-version compatibility must govern supported fields.

## First deliverable: separate and support the two Claude targets

### Settings experience

Keep the existing Harness connections route and search entry. Replace the stacked editors with an app selector and provider cards. Use explicit names rather than cc-switch's shortened “Claude” label.

```text
Settings / Harness connections

[Claude Code CLI] [Claude Desktop] [Codex]

Claude Desktop                             [+ Add connection]
Installed version • compatibility status    [Copy from Claude Code CLI]

Official sign-in                 [Active]
Work gateway                    [Test] [Use] [Edit …]
  Endpoint • connection mode • model summary

Edit connection
  Name                    [Work gateway                  ]
  Credential              [Select saved key / Add key    ]
  API endpoint            [https://gateway.example      ]
  Authentication          [Bearer token / API key        ]
  Models                  [Use provider's compatible list]

  [Test connection]         [Save] [Save and use]
  Restart Claude Desktop to apply this connection
```

Each target has its own active badge, installation status, tested revision, configuration conflict state, and restore action. Saving a profile does not activate it. Applying a third-party profile requires the existing compatibility test gate. The Desktop empty state offers reuse of an existing CLI connection without claiming it is already applied.

### Backend boundary

1. Introduce a typed configuration target distinct from credential provider and runtime agent type. Preserve the existing `claude_code` serialized identity; add `claude_desktop`. Do not register Desktop as a runnable CLI agent merely to reuse a switch statement.
2. Reuse the transaction, file locking, snapshot, and read-back primitives. Implement separate target adapters for file discovery, native schema generation, status, apply, and restore. Wire each new type through the production command and UI in the same phase.
3. Implement Desktop's local 3P configuration on macOS and Windows against supported schema fixtures. Detect managed configuration and report it as externally controlled. Other platform/version combinations remain explicitly unsupported until verified.
4. Use an ORGII-owned profile identity. Preserve other profiles, metadata, MCP settings, and existing login state. Include every touched Desktop file in the transaction, and restore only files/fields owned by that transaction when no conflicting external edit exists.
5. Do not copy upstream's broad network/egress defaults or profile identifiers. Derive only endpoint-related configuration required for the user's selected connection, respecting existing policy.
6. Start with direct Anthropic Messages-compatible Desktop connections and accepted native model IDs. Arbitrary model IDs that need route translation belong to the next mapping phase and must not produce a misleading successful apply.
7. Copy/import creates a new target-specific profile referring to the existing vault credential. Preview dropped or unsupported settings. Existing cc-switch source files stay read-only.

### First-deliverable verification

Use isolated filesystem fixtures for both targets. Configure different endpoints, apply Desktop, and verify CLI bytes and manifest remain unchanged; repeat in the other direction. Verify both restore paths, absent files, interrupted multi-file writes, externally edited files, malformed input, managed settings, and unsupported versions/platforms. Check production UI selectors, not only a mocked editor. A successful HTTP probe is distinct from a confirmed native-app configuration load.

Record which Desktop surfaces and versions have actually been exercised. Native GUI validation requires the user's explicit computer-control opt-in; source and automated verification can proceed independently. Do not claim Desktop runtime validation based only on generated JSON.

## Following deliverables: model mapping and more providers

### Claude configuration

Add a CC-switch-style table inside each app's connection editor:

| Role               | Menu display name | Actual request model         | Declared 1M context  |
| ------------------ | ----------------- | ---------------------------- | -------------------- |
| Sonnet             | Optional label    | Search or type model ID      | Where supported      |
| Opus               | Optional label    | Search or type model ID      | Where supported      |
| Fable              | Optional label    | Search or type model ID      | Version dependent    |
| Haiku              | Optional label    | Search or type model ID      | Capability dependent |
| Subagent, CLI only | No menu label     | Inherit or explicit model ID | Where supported      |

Provide **Fetch models**, **Add model manually**, and **Use one model for all roles**. Show inherited values explicitly. Do not silently infer all mappings from the first available model. Keep the initial/default selection separate from role assignments.

For CLI, generate native role environment settings and companion labels where supported. For Desktop, generate its accepted model catalog and use a local route-to-upstream-model map when native configuration cannot represent an arbitrary ID. Display names never replace request IDs. A context declaration does not increase upstream capacity. Current Claude documentation includes Fable and role configuration; expose them according to tested installed-version support. [Claude model configuration](https://code.claude.com/docs/en/model-config)

Extend the existing proxy so different requested roles are not collapsed to the previous single selected model. Start with Anthropic Messages upstream parity; treat protocol conversion as explicit compatibility work with streaming and tool-call fixtures before advertising other upstream protocols. Mapping through a local gateway must show “Requires ORGII running” and expose unavailable-route states after shutdown or a crash.

### Codex and ORGII

Codex gets provider endpoint, actual model ID, default selection, and supported reasoning/context settings. Use Codex's own configuration model rather than fabricating Sonnet/Opus roles. Its documented custom providers configure base URL, authentication, and model selection. Custom picker/catalog integration must be verified separately from whether the runtime accepts a model ID. [Codex custom providers](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers)

For ORGII's own runtime, extend the existing vault model catalog and picker to retain manually entered models and user labels. Reuse existing `ModelAlias` display-label semantics and `ModelVariant` capabilities; do not repurpose them as external app role mappings. Trace selection through the actual session resolver and provider request writer before changing model validation.

### Profile ownership and discovery

- A saved app profile owns target, credential reference, endpoint override, authentication scheme, protocol, default model, and target-specific options
- Credentials remain in the vault; frontend status and profile serialization contain references and redacted summaries
- Separate provider protocol, model ID, label, role, and capability declaration. “OpenAI compatible” alone is insufficient proof of the required API behavior
- Endpoint overrides belong to a profile so editing Desktop cannot redirect CLI or ORGII sessions sharing the same key
- Discovery is user-triggered, cancellable, bounded, and optional. Preserve endpoint path prefixes; prevent credential forwarding across redirects; report unsupported discovery without blocking manual entry
- Test each distinct mapped model once, deduplicating identical assignments. Bind the receipt to the complete profile revision including target, endpoint, auth, credential revision, mappings, and relevant capabilities
- Existing selections become profiles for their original targets only. Preserve backup readability and document downgrade recovery before any persisted format change

## Implementation order

1. **Claude target separation plus working Desktop direct connection UI** — first feature to review and deliver
2. **Per-target model mapping** — native CLI mappings, Desktop catalog/routes, complete mapping table, import translation, and proxy lifecycle behavior
3. **Broader model/provider setup** — optional discovery, manual IDs, Codex-specific settings, and ORGII's model picker/runtime integration

Each step includes its Rust/TypeScript contract, production wiring, UI, and behavioral tests. Keep phases bounded to roughly 20 files where practical. Remove only obsolete code replaced by the feature; avoid unrelated cleanup. The latter two steps remain part of the requested expansion, ordered after the Claude separation.

## Architecture review coverage

Design review using `.orgii/skills/architecture-audit/SKILL.md`; all ten layers considered. This is a plan, not a passed implementation audit.

| Layer                  | Design decision / implementation check                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1 Compilation          | Run frontend typechecking and Rust all-target checks for each contract change                                     |
| 2 Deduplication        | Share transactions and credentials; keep native schema writers target-specific; wire new abstractions immediately |
| 3 Naming               | Explicit Claude Desktop / Claude Code CLI names across settings, imports, errors, and docs                        |
| 4 Semantic overloading | Target, provider, credential, profile, role, display name, and request model remain distinct concepts             |
| 5 Defaults             | Exhaustive target dispatch; unknown Desktop schema never falls through to the CLI writer                          |
| 6 Domain boundaries    | Desktop configuration does not create a fake CLI runtime agent; role semantics stay in adapters                   |
| 7 Discoverability      | Each adapter owns a documented native-file set, activation behavior, and capability matrix                        |
| 8 Wire/serialization   | Inspect exact native config and synthetic upstream requests; no credential-bearing debug payloads                 |
| 9 Entry-point parity   | Settings, harness details, imports, test, apply, and proxy use the same resolved profile revision                 |
| 10 Resolver symmetry   | Endpoint/auth/model/mapping resolve from one coherent target profile and credential revision                      |

Performance plan: no idle discovery or polling. Bound model lists, active tests, cached results, and listeners. Cancel abandoned discovery/probes; keep proxy lifetime tied to actual active target ownership, with crash recovery and conflict-aware restore. Run the performance guard when implementing these paths, and the frontend UI audit for the redesigned components.

## Delivery checks

Planned commands: `pnpm typecheck`, `pnpm lint`, `pnpm test`; in `src-tauri`, `cargo check --workspace --all-targets`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace --no-fail-fast`. Add focused adapter, discovery, routing, persistence, and rendered UI tests according to `.github/CONTRIBUTING.md`.

UI review covers light/dark themes, narrow layouts, keyboard use, loading/empty/error states, inherited mappings, and separate active badges. Settings descriptions follow the repository punctuation convention. Record actual checks and unverified native/platform paths at delivery. Any eventual commits and GitHub PR use the requested lake profile and the repository PR rules.

No tests or native configuration changes were performed for this planning document.
