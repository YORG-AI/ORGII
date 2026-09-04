# iOS Remote shell lifecycle

## End-to-end path

1. `mobile-native.html` boots `mobileRemoteNativeEntry.tsx`.
2. The entry creates the Tauri platform adapter before rendering the shared `MobileRemoteRoot`.
3. Signed-out users start Supabase OAuth with PKCE in the system browser.
4. `org2remote://auth/callback` is delivered through the warm/cold deep-link adapter, exchanged, and persisted through the app-owned Keychain command boundary.
5. A pairing deep link or pasted payload is validated by the shared pairing flow and stored in an account-scoped, bounded local desktop inventory.
6. Selecting a desktop updates the active record and asks the shared provider to reconnect to that desktop.

## State machine

| State               | Entry                                   | Success                                             | Failure/retry                                    | Terminal/cleanup                                   |
| ------------------- | --------------------------------------- | --------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| Checking auth       | App launch or a newer auth intent       | Authenticated or signed out                         | Storage/read error renders the shared auth error | New intent/unmount invalidates the generation      |
| Opening sign-in     | User chooses GitHub                     | System browser opens                                | Opener rejection renders retryable error         | PKCE attempt stays bounded to the owned secure key |
| Exchanging callback | Valid auth callback                     | Session saved and root advances                     | Invalid/stale callback renders retryable error   | A newer callback wins; listener remains app-owned  |
| Awaiting pairing    | Authenticated without an active desktop | Valid pairing creates/selects a local device record | Invalid payload stays on pairing UI              | Inventory is capped and scoped to the account      |
| Connecting          | Active desktop selected                 | Shared routes/tabs render                           | Existing connection error/retry path             | Foreground socket is released when backgrounded    |
| Switching desktop   | User activates an inactive row          | Selected desktop becomes active and reconnects      | Inline shared alert; row remains retryable       | Pending state disables concurrent selection        |

## Edge cases covered

- Cold-start and warm auth callbacks
- Cold-start and warm pairing links
- Duplicate deep-link delivery
- Stale auth completion after a newer intent or unmount
- System-browser opener rejection
- Ordered concurrent secure writes
- Account isolation and bounded paired-device history
- Selection of an inactive paired desktop

## Deferred to later stacked PRs

- Session transcript/tool/file/control surfaces are the next feature layer
- APNs, background execution, offline queues, and TestFlight rollout are not claimed here
- Real-device signing, OAuth redirect allowlisting, and foreground/background measurements remain release gates
