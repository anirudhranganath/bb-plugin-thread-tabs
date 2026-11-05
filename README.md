# Thread Tabs

A BB plugin that adds up to eight chat tabs inside each thread, sharing its project and workspace.

- **+** opens a blank tab. Choose any installed provider/model in its native composer; the first message starts an independent session.
- In the **⋯ Message actions** menu below an output, **Fork into new tab** opens a fresh **New chat** draft with a Markdown transcript attached through that message. Choose any provider/model before sending; preview or remove the transcript attachment. The original session is unaffected, and later messages do not change the saved transcript. Repeated forks retain earlier inherited context.
- The same output menu offers BB’s native **Fork into new thread**, which clones the provider history into a separate sidebar thread at the selected turn boundary, using the same workspace. Availability follows the provider’s native fork support. There is no top-level Fork button.
- Tab names use BB’s first-message summary (or the first-message fallback while generation is unavailable). New tabs and fork drafts start as **New chat**, without numbers. The configured BB title service supplies its normal summary after the first message; the plugin does not run a separate LLM or force a 1–3 word limit. Right-click and choose **Rename tab**, or use double-click or F2 to rename a tab; custom names survive reloads and future title generation. Long names truncate visually and show in a tooltip after 500 ms of hover.
- Right-click tabs for **Mark as unread**, **Rename tab**, **Copy concise transcript**, **Copy full transcript**, **Copy link**, **Close tab**, and **Close others**. Concise transcripts contain messages; full transcripts also include the available tool/system records. Attachment references are retained, but their original file contents are not duplicated. Copied links select that tab, including after a draft starts its session.
- **×** closes and archives a session. The history button restores closed tabs. Main stays open with its thread.
- Tabs and drafts persist. The selected tab is remembered per client. Tabs can work concurrently, so they edit the same files.
- Archiving or deleting the main thread also archives or deletes its sessions through BB's lifecycle ownership.

The sidebar and workspace panel remain attached to the main thread. Extra sessions are hidden BB threads, rendered with the public `ThreadChat` component. A composer banner portals the tab strip into the chat's `data-thread-window` element; a cleanup-safe content script moves the tab-fork action from the inline message buttons into the native three-dot menu, preserving the native thread-fork action. These two DOM integrations may need adjustment after BB UI updates. Disabling the plugin restores the original UI; it does not delete sessions. Hidden sessions stay accessible by ID with the CLI.

## CLI

```
bb thread-tabs list <thread-id> --json
bb thread-tabs rename <tab-id> <root-thread-id> "Custom name" --json
bb thread-tabs new <thread-id> <provider-id> <model> [reasoning-level] --json
bb thread-tabs fork <source-session-id> --json
bb thread-tabs transcript <session-id> [full] --json
bb thread-tabs unread <session-id> --json
bb thread-tabs read <session-id> --json
bb thread-tabs preview-transcript <tab-id> <root-thread-id> --json
bb thread-tabs detach-transcript <draft-id> <root-thread-id> --json
bb thread-tabs restore-transcript <draft-id> <root-thread-id> --json
bb thread-tabs close-others <session-id> --json
bb thread-tabs close <session-id> --json
bb thread-tabs restore <session-id> --json
bb thread-tabs close <draft-id> <root-thread-id> --json
bb thread-tabs restore <draft-id> <root-thread-id> --json
```

`new` creates an empty draft tab; send its first message from the UI. `fork` snapshots the transcript into a draft without starting or cloning an agent session. Transcript exports are limited to 2 MB and fail explicitly rather than truncating. The plugin RPC contract in `server.ts` exposes the same operations. The native composer sends its typed request to the plugin backend, which serializes session creation, applies the current attachment and custom title, and attaches the session. Concurrent submissions reuse the first session.

## Development

```
npm ci
npm run verify
bb plugin build
bb plugin install . --yes
```

BB builds the bundle against the running host's runtime. No core app files are patched.

## Compatibility and security

Verified on BB 0.48.1. The manifest limits installs to BB 0.48.x because the two DOM integrations depend on the host UI. Automated source tests use the newest publicly available SDK (0.6.94); the installed host builds against SDK 0.6.104. `bb plugin types --check` currently reports this upstream publication gap. Recheck and repin when that SDK is published.

No extra account or service is required beyond BB and your installed providers. Fork snapshots can contain private conversation data; sending one shares it with the selected provider. Full transcript exports can include sensitive tool output. See [SECURITY.md](SECURITY.md) for data handling, resource limits, and crash-recovery boundaries. Saved closed-tab history consumes BB's finite per-key storage; the plugin refuses new drafts near the limit without deleting old tabs.

GitHub CI runs type checks, backend/UI tests and a dependency audit. Release builds additionally require the BB CLI and live smoke testing. See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under MIT; scaffold notices are preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
