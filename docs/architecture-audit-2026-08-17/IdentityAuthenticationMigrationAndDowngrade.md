# Identity migration, rollback, and downgrade notes

Date: 2026-08-18

## Current migration boundary

- Hosted Service credentials are native-Broker only. Upgrade schema 3 deletes the retired Hosted access/refresh, PKCE verifier, processed-code, user, and Supabase session keys from both the migration store and the current WebView local storage. Existing users may need to reconnect Hosted Service once.
- ORG2 Cloud still has one explicit migration-only envelope because the official Cloud deployment did not expose `/api/auth/desktop/config` on 2026-08-18 (the read-only probe returned HTTP 404). The new desktop OAuth server implementation is prepared in `/Users/junyu/github/ORGII-cloud-infra-identity-auth`, but it has not been deployed.
- The macOS WebKit database scanner and `debug_import_bundled_org2_cloud_auth` command are removed. Development uses its own Broker runtime profile and signs in through the production UI path.

## Final Cloud cutover gate

After the Cloud OAuth deployment is live and its Code + PKCE contract passes the real-account smoke test:

1. Enable Broker Cloud OAuth by default.
2. Remove the fragment-token callback, local loopback compatibility receiver, Cloud legacy envelope writer/import command, and `shared-service-auth.json` migration store.
3. Run the forbidden-string and release-artifact secret scans again.
4. Observe migration success and realm-specific reauthentication rates before removing the server-side compatibility route.

## Downgrade behavior

- Credential formats are not downgraded or copied back into plaintext storage.
- An older application version may ask the user to sign in again because it cannot read Broker-owned credentials.
- Local projects, workspaces, chat/session history, settings unrelated to credentials, and BYOK provider credentials are not removed or rewritten by identity migration.
- Rolling back application code is safe for local data; account recovery is reauthentication, not restoration of old token files.
