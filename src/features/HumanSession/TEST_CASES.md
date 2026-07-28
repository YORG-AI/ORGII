# Work log (Human session) acceptance cases

## Creation

- Select **Work log** from **Built-ins** in the regular session creator; the same composer and `SessionInfoLine` remain visible with the regular repository, branch, and location/worktree selectors, while model, attachment, and agent-only controls remain removed.
- Enter an optional title in the upper Create Work item-style header row, outside the note composer; the title is trimmed, limited to 80 characters, and becomes the canonical sidebar/session name.
- The creator retains the regular `+` menu and compact round-arrow submit button; the submit button's accessible name remains **Create work log**.
- Leave the optional title blank; the canonical title is derived from the first note as before.
- Type `/` in the creator and select a workspace or user skill; the shared skill pill is inserted and persisted with the first note.
- Type `@` in the creator and select any supported context item, including a session; the shared context pill is inserted and persisted with the first note.
- Enter one non-empty note and submit it; a `humansession-…` row appears in the Human sidebar group and opens like any other session.
- The explicit or derived session title remains stable as more notes are appended.
- An empty initial note cannot be submitted.
- Open **Create Work item** after leaving the regular session creator on **Work log**; the embedded composer starts with **SDE Agent**, and Work log is not offered in its agent picker.

## Appending notes

- Open a work log; its history uses the same connected timeline cards, headers, timestamps, and copy actions as Work item activity, without introducing a Work-log-specific history layout.
- Append another non-empty note from the same floating `InputArea` used at the bottom of regular sessions.
- The new item appears after existing items with its own timestamp, persists after restart, and moves the session according to its updated time in the sidebar.
- The configured send shortcut and the standard composer send button share the same append path; rapid repeated submission cannot create duplicate items while a request is active.
- Type `/` to insert a workspace or user skill, or type `@` to insert regular context items. Agent-only commands, modes, models, prompt polish, voice, and file attachments are not offered.
- Literal agent commands such as `/compact` are stored as note text rather than being executed.
- Existing notes are append-only in this version: there are no edit, polish, summarize, link-form, or screenshot actions.

## Session references

- Drag any session row from the sidebar into the creator or shared bottom composer; dropping inserts a session pill at the caret.
- Type `@`, choose **Sessions**, search, and select a session; the same kind of pill is inserted.
- Reopen the work log; mentioned sessions rehydrate from `Display name [session:<session-id>]` without embedding a transcript.

## Session metadata

- Hover a work log anywhere a session hover card is available; the first metadata row shows **Human** without a model icon or model name, followed by repository/branch location, paths, and timestamps. Other local session hover cards use the same type-first row order.

## Deletion

- Delete a work log through the standard sidebar action; the canonical Human-session row and all appended entries are removed by the database cascade.
