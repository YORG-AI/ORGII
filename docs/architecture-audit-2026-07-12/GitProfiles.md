# Architecture Audit — Git Profiles

Scope: reusable Git profile persistence and parsing in TypeScript, global Git config commands in Rust, and the Tauri command boundary.

## Acceptance criteria

- Multiple named identities persist locally and can be created, duplicated, edited, deleted, and selected.
- Activating a profile writes `user.name`, `user.email`, optional `user.signingKey`, and `commit.gpgSign` at global scope.
- Optional signing state from a previous profile cannot leak into the next profile.
- Existing Git connection and preference behavior remains on the Connections tab.
- Raw profile config supports exactly the identity fields the backend applies and rejects unsupported sections/keys.
- TypeScript, focused tests, Git crate compilation, and full desktop command registration pass.

## Ten-layer audit

| Line                                            | Element                                   | Verdict | Reason                                                                                                                                                                                                                | Suggested change |
| ----------------------------------------------- | ----------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `gitProfiles.ts:1`, `util.rs:502`               | 1. Compilation correctness                | pass    | `npm run typecheck`, focused ESLint, `cargo check -p git`, and full `cargo check` pass.                                                                                                                               | None.            |
| `GitProfilesTab.tsx:61`, `util.rs:555`          | 2. Dead code and structural deduplication | pass    | Live path is tab mount → `get_git_global_profile` → editor state → `set_git_global_profile`. Existing config read/write helpers are reused; no parallel Git subprocess implementation was introduced.                 | None.            |
| `gitProfiles.ts:3`, `util.rs:505`               | 3. Naming consistency                     | pass    | `GitProfile` is the saved ORGII record; `GitGlobalProfile` is the wire/global-config shape; `GitUserIdentity` remains the effective repository identity lookup. Names distinguish persistence and resolution scopes.  | None.            |
| `GitProfilesTab.tsx:39`, `util.rs:502`          | 4. Semantic overloading                   | pass    | “Profile” consistently means an author/signing identity. “Connection” remains GitHub authentication/repository access and is not reused for identity switching.                                                       | None.            |
| `util.rs:590`                                   | 5. Default branch analysis                | pass    | Optional signing keys are explicitly written or unset. Commit signing is explicitly written as true or false. No catch-all branch silently retains the prior profile.                                                 | None.            |
| `gitProfiles.ts:1`, `util.rs:490`               | 6. Cross-domain leakage                   | pass    | UI persistence stays in the Git integration module; subprocess/config operations stay in the Git crate. GitHub connection records only supply email suggestions and do not own Git author identity.                   | None.            |
| `GitProfilesTab.tsx:163`, `util.rs:572`         | 7. New-developer clarity                  | pass    | “Activate” is the only path that mutates global Git config. Editing saved values only clears the active marker, making saved state versus applied state explicit.                                                     | None.            |
| `gitProfiles.ts:16`, `util.rs:504`              | 8. Wire protocol and serialization        | pass    | The camel-cased frontend payload is intentionally mapped by Tauri to the snake-cased Rust struct fields. The payload contains four bounded scalar fields and no generated schema or hidden data.                      | None.            |
| `handler_list.inc:365`, `GitProfilesTab.tsx:61` | 9. Init parity                            | pass    | There is one production read entry point and one production apply entry point, both registered in the canonical handler list. Empty local storage imports the same global shape later used for matching and applying. | None.            |
| `gitProfiles.ts:68`, `util.rs:557`              | 10. Resolver symmetry                     | pass    | Name, email, signing key, and signing toggle are read from global scope and applied to global scope. All four fields participate in active-profile matching.                                                          | None.            |

## Term overloading table

| Term           | Meaning                                                           | Owner                      | Verdict |
| -------------- | ----------------------------------------------------------------- | -------------------------- | ------- |
| Git connection | Authentication/repository access for a Git provider               | Sync connections API       | keep    |
| Git profile    | Reusable author and commit-signing identity                       | Git Profiles settings      | keep    |
| Global profile | Identity values currently written to global Git config            | Git crate command boundary | keep    |
| Active profile | Saved profile whose every applied field matches global Git config | Git Profiles state         | keep    |

## Resolver and entry-point matrices

| Field        | Read global | Persist saved profile | Compare active | Apply global | Clear when absent |
| ------------ | ----------- | --------------------- | -------------- | ------------ | ----------------- |
| Author name  | yes         | yes                   | yes            | yes          | required          |
| Email        | yes         | yes                   | yes            | yes          | required          |
| Signing key  | yes         | yes                   | yes            | yes          | yes               |
| Sign commits | yes         | yes                   | yes            | yes          | explicit false    |

| Entry point              | Validate              | Blocking isolation | Shared helpers      | Result surfaced        |
| ------------------------ | --------------------- | ------------------ | ------------------- | ---------------------- |
| `get_git_global_profile` | Git output normalized | `spawn_blocking`   | global read helper  | typed Tauri result     |
| `set_git_global_profile` | name/email required   | `spawn_blocking`   | write/unset helpers | error or success toast |

No systematic sweep candidates or deferred architecture fixes remain in this scope.
