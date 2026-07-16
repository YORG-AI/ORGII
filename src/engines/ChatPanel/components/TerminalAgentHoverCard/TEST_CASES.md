# TerminalAgentHoverCard acceptance cases

## Functional

- A Hermes terminal shows starting, running, waiting, blocked, and done with distinct status treatment.
- Hovering the tab exposes the latest allowlisted tool name/preview, model, working directory, and duration when present.
- Entering blocked while the app is in the background emits one approval notification.
- Repeated blocked hook events do not emit duplicate notifications.
- Clicking the approval notification activates the originating terminal tab and brings the app window forward.
- A Hermes process launched outside ORGII reads the global runtime descriptor and emits an approval notification without creating or claiming an ORGII terminal tab.

## Edge and error states

- A status event for another terminal or non-Hermes agent is ignored.
- An external event without an ORGII terminal ID is handled only by the global bridge; integrated terminal listeners ignore it.
- A missing or stale global descriptor is a silent no-op in Hermes, and global setup failure does not stop the ORGII local server.
- Missing activity fields leave their hover-card rows out without placeholders.
- Notification listener/send failures are logged and do not affect terminal state updates.
- Tool previews are truncated and redact common secrets; raw tool results, prompts, and file contents are never transported.

## Accessibility

- The tab status dot exposes the localized status as an accessible label.
- Hover-card content is supplemental; terminal selection and approval remain usable without it.
