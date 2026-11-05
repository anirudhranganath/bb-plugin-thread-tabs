// Thread Tabs backend: stores each thread's tab group, starts hidden sessions for tabs, and serves the RPC and CLI.
import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { collectTranscript } from "./transcript.ts";
const id = z.string().trim().min(1).max(200);
const selectionSchema = z.object({ providerId: id, model: id, reasoningLevel: id, serviceTier: id.optional() });
const transcriptSchema = z.object({
    sourceThreadId: id, sourceTitle: z.string(), sourceSeqEnd: z.number().int().nonnegative(), enabled: z.boolean(),
    file: z.object({ type: z.literal("localFile"), path: z.string(), name: z.string(), sizeBytes: z.number(), mimeType: z.string().optional(), sourceProjectId: z.string().optional() }),
});
const tabSchema = z.object({ id, title: z.string().max(200), manualTitle: z.boolean().default(false), kind: z.enum(["main", "new", "fork"]), closed: z.boolean(), draft: z.boolean().default(false), selection: selectionSchema.nullable().default(null), draftId: id.optional(), transcript: transcriptSchema.nullable().default(null), unread: z.boolean().default(false) });
const groupSchema = z.object({ rootThreadId: id, revision: z.number().int().nonnegative().default(0), tabs: z.array(tabSchema).min(1) }).refine(group =>
    group.tabs[0].id === group.rootThreadId && group.tabs[0].kind === "main" && !group.tabs[0].closed && !group.tabs[0].draft &&
    group.tabs.filter(tab => tab.kind === "main").length === 1 && new Set(group.tabs.map(tab => tab.id)).size === group.tabs.length &&
    group.tabs.filter(tab => !tab.closed).length <= 8, "Invalid tab group");
export type TabGroup = z.infer<typeof groupSchema>;
const stateSchema = z.object({ projectId: id, group: groupSchema, environmentId: z.string().nullable(), selection: selectionSchema.nullable(), permissionMode: z.enum(["accept-edits", "auto", "full"]) });
export type TabState = z.infer<typeof stateSchema>;
const createSchema = z.object({ threadId: id, kind: z.enum(["new", "fork"]), sourceSeqEnd: z.number().int().nonnegative().optional(), selection: selectionSchema.optional() }).strict();
const startSchema = z.object({ rootThreadId: id, draftId: id, request: z.object({
    projectId: id, providerId: id, model: id, reasoningLevel: id, serviceTier: id.optional(),
    permissionMode: z.enum(["accept-edits", "auto", "full"]),
    environment: z.object({type:z.literal("reuse"), environmentId:id}).strict(),
    executionInputSources: z.record(z.string(), z.enum(["explicit", "client-preference"])),
    sessionOptions: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
    input: z.array(z.json()).min(1).max(256), sendAt:z.number().finite().optional(),
}).strict() }).strict();
export const rpcContract = defineRpcContract({
    get: { input: z.object({ threadId: id }).strict(), output: stateSchema },
    create: { input: createSchema, output: z.object({ group: groupSchema, threadId: id }) },
    attach: { input: z.object({ rootThreadId: id, draftId: id, threadId: id }).strict(), output: groupSchema },
    start: { input:startSchema, output:groupSchema },
    close: { input: z.object({ threadId: id, rootThreadId: id }).strict(), output: groupSchema },
    transcript: { input: z.object({ threadId: id, full: z.boolean().default(false) }).strict(), output: z.object({ text: z.string() }) },
    preview: { input: z.object({ rootThreadId: id, tabId: id }).strict(), output: z.object({ text: z.string(), name: z.string() }) },
    set_transcript: { input: z.object({ rootThreadId: id, tabId: id, enabled: z.boolean() }).strict(), output: groupSchema },
    unread: { input: z.object({ rootThreadId: id, tabId: id, unread: z.boolean() }).strict(), output: groupSchema },
    close_others: { input: z.object({ rootThreadId: id, tabId: id }).strict(), output: groupSchema },
    rename: { input: z.object({ rootThreadId: id, threadId: id, title: z.string().trim().min(1).max(200) }).strict(), output: groupSchema },
    restore: { input: z.object({ threadId: id, rootThreadId: id }).strict(), output: groupSchema },
});
// Registers the tab RPC handlers and the `thread-tabs` CLI.
export default async function plugin(bb: BbPluginApi) {
    const queues = new Map<string, Promise<unknown>>();
    const startingSessions = new Map<string, string>();
    // Runs operations for one root thread one at a time.
    async function locked<T>(root: string, run: () => Promise<T>): Promise<T> {
        const previous = queues.get(root) ?? Promise.resolve();
        const pending = previous.catch(() => { }).then(run);
        queues.set(root, pending);
        try {
            return await pending;
        }
        finally {
            if (queues.get(root) === pending)
                queues.delete(root);
        }
    }
    // Loads the tab group containing this thread (a Main-only group if none is saved); throws if the thread is not a tab.
    async function read(threadId: string): Promise<TabGroup> {
        const metadata = await bb.sdk.threads.getPluginMetadata({ threadId });
        const root = id.safeParse(metadata.rootThreadId);
        const rootThreadId = root.success ? root.data : threadId;
        const saved = await bb.storage.kv.get(`group:${rootThreadId}`);
        const group = saved == null ? { rootThreadId, revision: 0, tabs: [{ id: rootThreadId, title: "Main", kind: "main" as const, closed: false, draft: false, selection: null, manualTitle: false, transcript: null, unread: false }] } : groupSchema.parse(saved);
        if (group.rootThreadId !== rootThreadId) throw new Error("Stored tab group has an invalid owner.");
        if (!group.tabs.some(tab => tab.id === threadId))
            throw new Error("This session does not belong to this thread's tabs.");
        return group;
    }
    // Refreshes automatic titles, bumps the revision, validates, persists, and notifies clients.
    async function save(group: TabGroup) {
        group.tabs = await Promise.all(group.tabs.map(async tab => {
            if (tab.draft || tab.closed || tab.manualTitle) return tab;
            return {...tab, title:sessionTitle(await bb.sdk.threads.get({threadId:tab.id}), tab.title)};
        }));
        group.revision++;
        groupSchema.parse(group);
        await bb.storage.kv.set(`group:${group.rootThreadId}`, group);
        bb.realtime.publish("changed", { rootThreadId: group.rootThreadId });
    }
    // Like `read`, but requires the main thread's ID.
    async function readRoot(rootThreadId: string) {
        const group = await read(rootThreadId);
        if (group.rootThreadId !== rootThreadId) throw new Error("Use the main thread ID for this operation.");
        return group;
    }
    // Picks a session's title, then its fallback title, then `fallback`, capped at 200 characters.
    function sessionTitle(session: { title: string | null; titleFallback?: string | null }, fallback: string) {
        return (session.title ?? session.titleFallback ?? fallback).slice(0, 200);
    }
    // Returns the main thread, throwing if it is archived or deleted.
    async function requireLive(group: TabGroup) {
        const root = await bb.sdk.threads.get({ threadId: group.rootThreadId });
        if (root.archivedAt !== null || root.deletedAt !== null)
            throw new Error("Restore the main thread before changing tabs.");
        return root;
    }
    // Throws when the group already has 8 open tabs.
    function capacity(group: TabGroup) {
        if (group.tabs.filter(tab => !tab.closed).length >= 8)
            throw new Error("A thread can have up to 8 open tabs. Close a tab first.");
    }
    // Returns the tab group with refreshed automatic titles, plus the project, workspace and execution defaults the UI needs.
    async function get(threadId: string): Promise<TabState> {
        const group = await read(threadId);
        const [thread, execution] = await Promise.all([bb.sdk.threads.get({ threadId }), bb.sdk.threads.defaultExecutionOptions({ threadId })]);
        group.tabs = await Promise.all(group.tabs.map(async tab => {
            if (tab.draft || tab.closed || tab.manualTitle) return tab;
            const session = tab.id === threadId ? thread : await bb.sdk.threads.get({ threadId: tab.id });
            return { ...tab, title: sessionTitle(session, tab.title) };
        }));
        return { projectId: thread.projectId, group, environmentId: thread.environmentId, selection: execution ? { providerId: thread.providerId, model: execution.model, reasoningLevel: execution.reasoningLevel, serviceTier: execution.serviceTier } : null, permissionMode: execution?.permissionMode ?? "auto" };
    }
    // Builds a session's Markdown transcript, prefixed with its enabled inherited transcript; limited to 2 MB.
    async function transcriptFor(threadId: string, sourceSeqEnd?: number, full = false) {
        const group = await read(threadId);
        const snapshot = await collectTranscript(bb.sdk, threadId, sourceSeqEnd, full);
        const inherited = group.tabs.find(tab => tab.id === threadId)?.transcript;
        if (inherited?.enabled) {
            const source = await bb.sdk.threads.get({ threadId });
            const file = await bb.sdk.projects.attachments.read({ projectId: source.projectId, path: inherited.file.path });
            if (file.bytes.byteLength > 2 * 1024 * 1024) throw new Error("The inherited transcript exceeds 2 MB.");
            snapshot.text = new TextDecoder().decode(file.bytes) + "\n\n---\n\n" + snapshot.text;
            if (Buffer.byteLength(snapshot.text, "utf8") > 2 * 1024 * 1024) throw new Error("The combined conversation transcript exceeds 2 MB.");
        }
        return snapshot;
    }
    // Adds a draft tab; a fork also uploads the immutable transcript snapshot as its attachment.
    async function create(input: z.infer<typeof createSchema>) {
        const { rootThreadId } = await read(input.threadId);
        return locked(rootThreadId, async () => {
            const group = await read(input.threadId);
            capacity(group);
            if (Buffer.byteLength(JSON.stringify(group), "utf8") > 200 * 1024) throw new Error("This thread's saved tab history is full. Start a new thread to create more tabs.");
            const root = await requireLive(group);
            const source = await bb.sdk.threads.get({ threadId: input.threadId });
            if (source.archivedAt !== null || !group.tabs.some(tab => tab.id === source.id && !tab.closed))
                throw new Error("Restore this tab before creating another.");
            if (!root.environmentId || source.environmentId !== root.environmentId || source.projectId !== root.projectId)
                throw new Error("All tabs must share the main thread's workspace.");
            const title = "New chat";
            const draftId = `draft:${randomUUID()}`;
            let transcript: z.infer<typeof transcriptSchema> | null = null;
            if (input.kind === "fork") {
                const snapshot = await transcriptFor(source.id, input.sourceSeqEnd);
                const sourceTitle = source.title ?? source.titleFallback ?? "chat";
                const filename = `Transcript of ${sourceTitle.replace(/[\/\\:*?"<>|\u0000-\u001f]/g, " ").slice(0, 100)}.md`;
                const file = await bb.sdk.projects.attachments.upload({ projectId: root.projectId, filename, mimeType: "text/markdown", clientFile: Buffer.from(snapshot.text, "utf8") });
                transcript = transcriptSchema.parse({ sourceThreadId: source.id, sourceTitle, sourceSeqEnd: snapshot.sourceSeqEnd, enabled: true, file });
            }
            const execution = input.selection ? null : await bb.sdk.threads.defaultExecutionOptions({ threadId: source.id });
            const selection = input.selection ?? (execution ? { providerId: source.providerId, model: execution.model, reasoningLevel: execution.reasoningLevel, serviceTier: execution.serviceTier } : null);
            group.tabs.push({ id: draftId, title, kind: input.kind, closed: false, draft: true, selection, manualTitle: false, transcript, unread: false });
            await save(group);
            return { group, threadId: draftId };
        });
    }
    // Closes (archives) or restores (unarchives) a non-main tab.
    async function setClosed(rootThreadId: string, threadId: string, closed: boolean) {
        return locked(rootThreadId, async () => {
            const group = await readRoot(rootThreadId);
            await requireLive(group);
            if (threadId === rootThreadId)
                throw new Error("The main tab stays open with its thread.");
            const tab = group.tabs.find(tab => tab.id === threadId);
            if (!tab)
                throw new Error("Tab not found in this thread.");
            if (tab.closed === closed)
                return group;
            if (!closed)
                capacity(group);
            if (!tab.draft) {
                if (!tab.manualTitle) {
                    const session = await bb.sdk.threads.get({ threadId });
                    tab.title = sessionTitle(session, tab.title);
                }
                if (closed)
                    await bb.sdk.threads.archive({ threadId });
                else
                    await bb.sdk.threads.unarchive({ threadId });
            }
            tab.closed = closed;
            await save(group);
            return group;
        });
    }
    // Makes a started session the tab for its draft; the caller holds the root lock.
    async function attachUnlocked({ rootThreadId, draftId, threadId }: {
        rootThreadId: string;
        draftId: string;
        threadId: string;
    }) {
            const group = await readRoot(rootThreadId);
            if (group.tabs.some(tab => tab.id === threadId && tab.draftId === draftId))
                return group;
            const root = await requireLive(group);
            const [thread, metadata] = await Promise.all([bb.sdk.threads.get({ threadId }), bb.sdk.threads.getPluginMetadata({ threadId })]);
            if (thread.environmentId !== root.environmentId || thread.projectId !== root.projectId || thread.lifecycleOwnerThreadId !== rootThreadId || thread.visibility !== "hidden" || metadata.rootThreadId !== rootThreadId || metadata.draftId !== draftId)
                throw new Error("The new session must belong to this draft and share this thread's workspace.");
            const existing = group.tabs.find(tab => tab.draftId === draftId);
            if (existing) {
                // Two clients can submit the same draft; retain only the first attached session.
                await bb.sdk.threads.archive({ threadId });
                return group;
            }
            const tab = group.tabs.find(tab => tab.id === draftId && tab.draft);
            if (!tab) throw new Error("The draft tab no longer exists.");
            if (tab.manualTitle) await bb.sdk.threads.update({ threadId, title: tab.title });
            else tab.title = sessionTitle(thread, tab.title);
            // A draft can be closed in another window while the native composer starts it.
            if (tab.closed) await bb.sdk.threads.archive({ threadId });
            tab.id = threadId;
            tab.draft = false;
            tab.draftId = draftId;
            await save(group);
            return group;
    }
    // Locked entry point for `attachUnlocked`.
    const attach = (input: {rootThreadId:string; draftId:string; threadId:string}) => locked(input.rootThreadId, () => attachUnlocked(input));
    // Spawns the hidden session for a draft and attaches it. The stored session ID lets a retry attach instead of spawning again.
    async function start({rootThreadId, draftId, request}: z.infer<typeof startSchema>) {
        return locked(rootThreadId, async () => {
            const group = await readRoot(rootThreadId);
            if (group.tabs.some(tab => tab.draftId === draftId)) return group;
            const root = await requireLive(group);
            const tab = group.tabs.find(tab => tab.id === draftId && tab.draft && !tab.closed);
            if (!tab) throw new Error("This draft is no longer open.");
            if (request.projectId !== root.projectId || request.environment.environmentId !== root.environmentId) throw new Error("Chat tabs must share the main thread's project and workspace.");
            const recoveryKey = `started:${draftId}`;
            const recovered = startingSessions.get(draftId) ?? id.nullish().parse(await bb.storage.kv.get(recoveryKey));
            let threadId = recovered;
            if (!threadId) {
                // BB validates the complete PromptInput union before creating the session.
                const input = request.input as NonNullable<Parameters<typeof bb.sdk.threads.spawn>[0]["input"]>;
                const thread = await bb.sdk.threads.spawn({...request, input:tab.transcript?.enabled ? [tab.transcript.file, ...input] : input, ...(tab.manualTitle ? {title:tab.title} : {}), visibility:"hidden", lifecycleOwnerThreadId:rootThreadId, pluginMetadata:{rootThreadId,draftId}});
                threadId = thread.id;
                startingSessions.set(draftId, threadId);
                await bb.storage.kv.set(recoveryKey, threadId);
            }
            const attached = await attachUnlocked({rootThreadId, draftId, threadId});
            startingSessions.delete(draftId);
            return attached;
        });
    }
    // Sets a tab's custom title; the title is then no longer refreshed automatically.
    async function rename(rootThreadId: string, threadId: string, title: string) {
        return locked(rootThreadId, async () => {
            const group = await readRoot(rootThreadId);
            const tab = group.tabs.find(tab => tab.id === threadId);
            if (!tab) throw new Error("Tab not found in this thread.");
            if (!tab.draft) await bb.sdk.threads.update({ threadId, title });
            tab.title = title;
            tab.manualTitle = true;
            await save(group);
            return group;
        });
    }
    // Attaches or detaches a draft tab's transcript for its first message.
    async function setTranscript(rootThreadId: string, tabId: string, enabled: boolean) {
        return locked(rootThreadId, async () => {
            const group = await readRoot(rootThreadId);
            const tab = group.tabs.find(tab => tab.id === tabId);
            if (!tab?.draft || !tab.transcript) throw new Error("This draft has no transcript attachment.");
            tab.transcript.enabled = enabled;
            await save(group);
            return group;
        });
    }
    // Reads a tab's stored transcript attachment (up to 2 MB) and its file name.
    async function preview(rootThreadId: string, tabId: string) {
        const group = await readRoot(rootThreadId);
        const tab = group.tabs.find(tab => tab.id === tabId);
        if (!tab?.transcript) throw new Error("This tab has no transcript attachment.");
        const root = await bb.sdk.threads.get({ threadId: rootThreadId });
        const file = await bb.sdk.projects.attachments.read({ projectId: root.projectId, path: tab.transcript.file.path });
        if (file.bytes.byteLength > 2 * 1024 * 1024) throw new Error("The transcript exceeds 2 MB.");
        return { text: new TextDecoder().decode(file.bytes), name: tab.transcript.file.name };
    }
    // Marks a tab unread or read, mirroring the state on its session unless it is a draft.
    async function unread(rootThreadId: string, tabId: string, value: boolean) {
        return locked(rootThreadId, async () => {
            const group = await readRoot(rootThreadId);
            const tab = group.tabs.find(tab => tab.id === tabId);
            if (!tab) throw new Error("Tab not found in this thread.");
            if (tab.unread === value) return group;
            if (!tab.draft) {
                if (value) await bb.sdk.threads.markUnread({ threadId: tabId });
                else await bb.sdk.threads.markRead({ threadId: tabId });
            }
            tab.unread = value;
            await save(group);
            return group;
        });
    }
    // Closes every open tab except the given one and Main.
    async function closeOthers(rootThreadId: string, tabId: string) {
        const group = await readRoot(rootThreadId);
        if (!group.tabs.some(tab => tab.id === tabId && !tab.closed)) throw new Error("This tab is not open.");
        for (const tab of group.tabs) {
            if (!tab.closed && tab.id !== tabId && tab.id !== rootThreadId) await setClosed(rootThreadId, tab.id, true);
        }
        return readRoot(rootThreadId);
    }
    bb.rpc.register(rpcContract, {
        start,
        transcript: ({ threadId, full }) => transcriptFor(threadId, undefined, full),
        preview: ({ rootThreadId, tabId }) => preview(rootThreadId, tabId),
        set_transcript: ({ rootThreadId, tabId, enabled }) => setTranscript(rootThreadId, tabId, enabled),
        unread: ({ rootThreadId, tabId, unread: value }) => unread(rootThreadId, tabId, value),
        close_others: ({ rootThreadId, tabId }) => closeOthers(rootThreadId, tabId),
        rename: ({ rootThreadId, threadId, title }) => rename(rootThreadId, threadId, title), attach, get: ({ threadId }) => get(threadId), create, close: ({ rootThreadId, threadId }) => setClosed(rootThreadId, threadId, true), restore: ({ rootThreadId, threadId }) => setClosed(rootThreadId, threadId, false) });
    bb.cli.register({
        name: "thread-tabs", summary: "List, create, fork, close, and restore chat tabs within a thread",
        commands: ["list", "new", "fork", "close", "restore", "rename", "transcript", "unread", "read", "close-others", "detach-transcript", "restore-transcript", "preview-transcript"].map(name => ({ name, summary: `${name} thread tabs`, usage: name === "rename" ? "bb thread-tabs rename <tab-id> <root-thread-id> <title...> [--json]" : `bb thread-tabs ${name} <thread-id> [--json]` })),
        async run(argv) {
            const args = argv.filter(arg => arg !== "--json");
            const [command, threadId, providerId, model, reasoningLevel = "medium"] = args;
            if (!threadId || !["list", "new", "fork", "close", "restore", "rename", "transcript", "unread", "read", "close-others", "detach-transcript", "restore-transcript", "preview-transcript"].includes(command ?? ""))
                return { exitCode: 1, stderr: "Usage: bb thread-tabs list|fork <thread-id> [--json]\n       bb thread-tabs transcript <session-id> [full] [--json]\n       bb thread-tabs unread|read|close-others <tab-id> [root-thread-id for a draft] [--json]\n       bb thread-tabs detach-transcript|restore-transcript|preview-transcript <tab-id> <root-thread-id> [--json]\n       bb thread-tabs close|restore <tab-id> [root-thread-id for a draft] [--json]\n       bb thread-tabs new <thread-id> <provider-id> <model> [reasoning-level] [--json]\n       bb thread-tabs rename <tab-id> <root-thread-id> <title...> [--json]" };
            let result;
            if (command === "detach-transcript" || command === "restore-transcript") result = await setTranscript(id.parse(providerId), id.parse(threadId), command === "restore-transcript");
            else if (command === "preview-transcript") result = await preview(id.parse(providerId), id.parse(threadId));
            else if (command === "transcript") result = await transcriptFor(id.parse(threadId), undefined, providerId === "full");
            else if (command === "unread" || command === "read" || command === "close-others") {
                const root = threadId.startsWith("draft:") ? id.parse(providerId) : (await read(threadId)).rootThreadId;
                result = command === "close-others" ? await closeOthers(root, threadId) : await unread(root, threadId, command === "unread");
            }
            else if (command === "rename")
                result = await rename(id.parse(providerId), id.parse(threadId), z.string().trim().min(1).max(200).parse(args.slice(3).join(" ")));
            else if (command === "list")
                result = await get(id.parse(threadId));
            else if (command === "close" || command === "restore")
                result = await setClosed(threadId.startsWith("draft:") ? id.parse(providerId) : (await read(threadId)).rootThreadId, id.parse(threadId), command === "close");
            else
                result = await create(createSchema.parse({ threadId, kind: command === "fork" ? "fork" : "new", ...(command === "new" ? { selection: { providerId, model, reasoningLevel } } : {}) }));
            return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
        },
    });
}
