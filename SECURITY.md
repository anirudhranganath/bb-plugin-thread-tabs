# Security and privacy

Thread Tabs runs with BB's trusted plugin privileges. Install reviewed releases only. It uses public BB SDK APIs and does not start its own server, read credentials, add telemetry, or call a separate AI service. BB and the provider selected in the native composer handle agent execution and title generation.

## Conversation data

Forking saves a Markdown snapshot in the current project's BB attachments. The snapshot can contain private messages and attachment references. Full exports can also contain tool output and system records, including secrets present in that output. Treat exports like the source conversation. Sending a fork shares its enabled transcript with the provider you select, including when you switch providers. Removing the attachment before the first send prevents it from being added to that request; it does not delete the saved project attachment. Copy actions write data to the system clipboard only on request.

Tab state and manual names are kept in plugin-scoped BB storage. The browser remembers selected tab IDs. Closing a tab archives its session and retains its transcript; it does not delete either. Disabling the plugin restores BB's UI without deleting its hidden sessions. Root-thread lifecycle ownership remains BB's responsibility.

## Safeguards

The backend validates RPC inputs and stored groups, checks draft/session ownership and workspace identity, and serializes mutations and session startup per root thread. Duplicate requests reuse an attached session; a recorded session ID allows retrying a failed attachment. Client-selected project and workspace changes are rejected. Prompts are validated by BB's SDK before session creation. Export text is limited to 2 MiB, raw timeline reads to 16 MiB and 200 pages. Oversized exports fail explicitly.

Before adding a draft, the plugin rejects saved group JSON larger than 200 KiB. This leaves headroom under BB's 256 KiB per-key limit. Existing tabs are retained. If the history-full error appears, start a new thread to create more tabs.

## Remaining boundaries

The tab placement and message menu use BB DOM structure and English action labels. These are compatibility dependencies, not stable SDK contracts. Verified hosts: BB 0.48.1 and 0.49.0. Mobile layouts are not verified. Different sessions edit the same worktree concurrently, with their own native permission controls.

BB does not expose an atomic, idempotent create-and-attach transaction. A server/process crash after a provider session is created but before its recovery ID is stored may leave an orphan hidden session. Review hidden sessions before retrying after such a crash. Ordinary retries and concurrent submissions are covered by tests; crash recovery cannot promise exactly-once provider execution.

## Reporting

Use GitHub private vulnerability reporting if enabled on the repository. Otherwise contact the maintainer through their GitHub profile before disclosing exploit details. Do not put tokens or private transcripts in public issues.
