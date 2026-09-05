# Message UI audit

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `src/components/Message/MessageContainer.tsx:148` | Error and warning severity icon slot | fix | The severity border already communicates the state, and the product requirement is to omit the redundant icon for these two toast types | Render an icon slot only for success and info toasts |
| `src/components/Message/MessageContainer.tsx:148` | Success and info icon slot | keep with reason | Positive and neutral messages retain their established visual indicator, and the slot is now limited to those types | None |
| `src/components/Message/MessageContainer.tsx:173` | Toast action buttons | keep with reason | These compact text actions are part of the toast's one-off layout and own their auto-dismiss behavior; no shared button primitive fits that constrained interaction | None |
| `src/components/Message/MessageContainer.tsx:205` | Toast close button | keep with reason | The icon-only control has an accessible label and is deliberately compact to preserve space for notification content | None |

Verdict totals: **1 fix**, **3 keep with reason**, **0 abstract**.
