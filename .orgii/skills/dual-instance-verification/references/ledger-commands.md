# Dual-Instance Verification Ledger Commands

## Ledger commands

Service key lives in `tests/e2e/.env` (machine-local). Snapshot:

```bash
set -a; source tests/e2e/.env; set +a
curl -s "$E2E_CLOUD_SUPABASE_URL/rest/v1/cloud_sessions?select=org_id,session_id,deleted_at,access_mode,events_count,events_frozen_seq,events_epoch,stored_bytes,updated_at&order=org_id,session_id" \
  -H "apikey: $E2E_CLOUD_SERVICE_KEY" -H "Authorization: Bearer $E2E_CLOUD_SERVICE_KEY" \
  -H "Accept-Profile: org2_cloud"
```

Snapshot every org visible to the instances, not only the org under test. Diff
the before/after JSON; explain every changed row and assert constant
`events_epoch` plus monotone `events_count` for untouched sessions. Logs live at
`~/.orgii/logs/` and `~/.orgii-instance2/logs/` — backend files are UTC-dated and
UTC-stamped, frontend files local-stamped; sweep BOTH around the UTC midnight
rollover or the window silently truncates.
