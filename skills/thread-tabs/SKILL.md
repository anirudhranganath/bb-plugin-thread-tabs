---
name: thread-tabs
description: Inspect or manage Thread Tabs plugin chat tabs using bb thread-tabs.
---

Use `bb thread-tabs list <thread-id> --json` to inspect a thread's saved tabs. A root thread owns up to eight open tabs. Extra sessions share its environment and worktree and are hidden from the sidebar. Read the plugin README for the complete command list.

`bb thread-tabs new <thread-id> <provider-id> <model> [reasoning-level] --json` creates a blank draft without starting an agent. `bb thread-tabs fork <session-id> --json` creates a draft with an immutable conversation transcript attached. Send its first message from the UI to start the selected provider.

Close and restore existing sessions with `bb thread-tabs close|restore <session-id> --json`. For a draft, pass `<draft-id> <root-thread-id>`. Closing archives; it does not delete the conversation. Main stays open. Do not close user-owned tabs as part of unrelated testing.

Fork transcripts and full exports may contain private data. Do not send or publish them without the user's instruction. Concurrent sessions modify the same files. Use BB's native model and permission controls for each session.
