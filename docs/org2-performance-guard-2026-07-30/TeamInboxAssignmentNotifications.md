# Team Inbox assignment notifications — performance guard

| Area | Verdict | Evidence | Change or reason kept | Verification |
| --- | --- | --- | --- | --- |
| Background work | keep | `GlobalSessionSync` owns one notification-action listener; assignment delivery remains driven by Team Inbox cache changes and adds no poller or retry loop | Register once in the global hook and return the plugin disposer from the effect cleanup | Hook test proves the disposer runs on unmount; changed frontend files pass ESLint |
| Memory | keep | The focus request atom retains one `{ itemKey, requestId }`; the existing per-store tracker uses a `WeakMap` and caps seen signatures at 1,000 | Keep constant-size focus state and the existing bounded/dereferenceable notification tracker | Tracker regression suite and notification hook tests pass |
| Scope/isolation | keep | Notification metadata contains only the canonical Team Inbox item key; tracker ownership remains per Jotai store | Route the action into the current store and singleton Team Inbox tab without adding an app-global item cache | Tests verify the exact item key is focused and disabled notification categories emit neither native nor in-app alerts |
| Rendering/hot path | keep | One toast is created only for a fresh assignment batch; no render-time scan, polling, or recurring timer was introduced beyond the toast component's bounded dismissal timer | Reuse the existing `Message` host and derive focused selection instead of synchronizing it through a render-triggering effect | View tests verify manual opening does not mark the first unread item and an explicit notification focus marks only its target |

Performance verdict: pass
