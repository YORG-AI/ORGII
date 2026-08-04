# E2E Layer Selection and Commands

## Choosing the right layer

| Claim                                  | Required coverage                                                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Runtime state/tool behavior is correct | Rust `e2e-test` or deterministic debug endpoint                                                                                    |
| Tauri command shape is correct         | Command call plus TypeScript contract/type check                                                                                   |
| Card/button/menu/slash action works    | WDIO rendered-app test                                                                                                             |
| Configurable UI field works            | Five-layer alignment plus rendered submit-path coverage                                                                            |
| Unsupported feature is gone            | Negative UI assertion and/or backend action-list assertion                                                                         |
| Provider returns 429/capacity          | classify as provider capacity unless ORGII mishandles it                                                                           |
| Agent has the right tools              | session-scoped effective-tools API plus backend schema/policy negative+positive test; add UI smoke only when the tools are visible |

## Commands

Rust runtime:

```bash
cd src-tauri
cargo run -p e2e-test -- --list
cargo run -p e2e-test -- --scenario plan-mode-denies-writes
cargo run -p e2e-test -- --group memory
cargo check -p e2e-test
cargo fmt -p e2e-test
```

Core UI:

```bash
cd tests/e2e
# Full matrix (requires E2E_ALLOW_PORT_CLEANUP=1 if dev app is running)
E2E_ALLOW_PORT_CLEANUP=1 npm test -- --spec './specs/core/session-controls-ui.spec.mjs'

# Single scenario
E2E_ALLOW_PORT_CLEANUP=1 E2E_CONTROL_SCENARIOS=rewind npm test -- --spec './specs/core/session-controls-ui.spec.mjs'
E2E_ALLOW_PORT_CLEANUP=1 E2E_CONTROL_SCENARIOS=plan-build-direct npm test -- --spec './specs/core/session-controls-ui.spec.mjs'
E2E_ALLOW_PORT_CLEANUP=1 E2E_CONTROL_SCENARIOS=plan-update npm test -- --spec './specs/core/session-controls-ui.spec.mjs'
E2E_ALLOW_PORT_CLEANUP=1 E2E_CONTROL_SCENARIOS=plan-edit-resend npm test -- --spec './specs/core/session-controls-ui.spec.mjs'

# Core UI:
E2E_ALLOW_PORT_CLEANUP=1 npm test -- --spec './specs/core/chat-rendering-ui.spec.mjs'
```
