// Thread Tabs UI: a tab strip above each thread's chat, with native composers for new tabs and a message action that forks into a tab.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { definePluginApp, useComposer, useRpc, useRealtime, useRealtimeConnectionState, useBbNavigate, experimental_copyToClipboard as copyToClipboard, Markdown, experimental_NewThreadComposer as NewThreadComposer, ThreadChat, experimental_ThreadStatusGlyph as ThreadStatusGlyph, experimental_useSidebarThreads } from "@get-bb/plugin-sdk/app";
import type { ThreadChatMessageReference, NewThreadRequest } from "@get-bb/plugin-sdk/app";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Tooltip from "@radix-ui/react-tooltip";
import { toast } from "sonner";
import type { rpcContract, TabGroup, TabState } from "./server";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./components/ui/dialog";
import { usePortalScopeProps } from "./lib/portal-scope";
import { Icon } from "./components/ui/icon";
import "./app.css";
import { mountMessageForkMenu } from "./message-fork-menu";
const FORK_EVENT = "thread-tabs:fork";
// Shows an error as a toast.
function report(error: unknown) { toast.error(error instanceof Error ? error.message : String(error)); }
// The tab strip, its dialogs, and the active tab's chat or draft composer for one main thread.
function TabWorkspace({ rootThreadId, host, windowElement }: {
    rootThreadId: string;
    host: HTMLElement;
    windowElement: HTMLElement;
}) {
    const rpc = useRpc<typeof rpcContract>();
    const portalScope = usePortalScopeProps();
    const navigate = useBbNavigate();
    const navigation = useRef(navigate);
    navigation.current = navigate;
    const { threads } = experimental_useSidebarThreads();
    const connection = useRealtimeConnectionState();
    const [state, setState] = useState<TabState | null>(null);
    const [active, setActive] = useState(() => new URLSearchParams(location.search).get("chatTab") ?? localStorage.getItem(`thread-tabs:${rootThreadId}`) ?? rootThreadId);
    const [preview, setPreview] = useState<{ name: string; text: string } | null>(null);
    const [dialog, setDialog] = useState(false);
    const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
    const [pending, setPending] = useState(false);
    const submitting = useRef(false);
    const [error, setError] = useState<string | null>(null);
    // Reloads the tab state, ignoring a result older than the one already shown.
    const refresh = useCallback(() => { rpc.call("get", { threadId: rootThreadId }).then(value => { setState(current => current && current.group.revision > value.group.revision ? current : value); setError(null); }, cause => setError(cause instanceof Error ? cause.message : String(cause))); }, [rpc, rootThreadId]);
    useEffect(refresh, [refresh, connection]);
    useRealtime("changed", refresh);
    const canonicalRoot = state?.group.rootThreadId;
    useEffect(() => {
        if (canonicalRoot && canonicalRoot !== rootThreadId) {
            localStorage.setItem(`thread-tabs:${canonicalRoot}`, rootThreadId);
            navigation.current.toThread(canonicalRoot);
        }
    }, [canonicalRoot, rootThreadId]);
    // Adopts a group returned by the server unless it is older than the one shown.
    const applyGroup = (group: TabGroup) => setState(value => value && value.group.revision <= group.revision ? { ...value, group } : value);
    // Activates a tab, remembers it for this client, and marks it read.
    const select = useCallback((threadId: string) => {
        setActive(threadId); localStorage.setItem(`thread-tabs:${rootThreadId}`, threadId);
        rpc.call("unread", { rootThreadId, tabId: threadId, unread: false }).catch(report);
    }, [rootThreadId, rpc]);
    const openTabs = state?.group.tabs.filter(tab => !tab.closed) ?? [];
    const titleRefreshKey = openTabs.filter(tab => !tab.draft && !tab.manualTitle).map(tab => tab.id).join(",");
    useEffect(() => {
        if (!titleRefreshKey) return;
        const timers = [1000, 5500].map(delay => setTimeout(refresh, delay));
        return () => timers.forEach(clearTimeout);
    }, [titleRefreshKey, refresh]);
    const activeId = openTabs.find(tab => tab.id === active || tab.draftId === active)?.id ?? rootThreadId;
    const childActive = activeId !== rootThreadId;
    const activeTab = openTabs.find(tab => tab.id === activeId);
    useLayoutEffect(() => {
        host.toggleAttribute("data-show-session", childActive);
        windowElement.toggleAttribute("data-session-tabs-active", childActive);
        return () => { windowElement.removeAttribute("data-session-tabs-active"); };
    }, [host, windowElement, childActive]);
    // Creates a fork draft (optionally up to a message) and selects it; ignored while another operation is pending.
    const fork = useCallback(async (threadId: string, sourceSeqEnd?: number) => {
        if (pending)
            return;
        setPending(true);
        try {
            const result = await rpc.call("create", { threadId, kind: "fork", ...(sourceSeqEnd === undefined ? {} : { sourceSeqEnd }) });
            applyGroup(result.group);
            select(result.threadId);
        }
        catch (cause) {
            report(cause);
        }
        finally {
            setPending(false);
        }
    }, [rpc, select, pending]);
    useEffect(() => {
        const listener = (event: Event) => {
            if (!(event instanceof CustomEvent))
                return;
            const message = event.detail as ThreadChatMessageReference;
            if (message.threadId === rootThreadId)
                void fork(message.threadId, message.sourceSeqEnd);
        };
        document.addEventListener(FORK_EVENT, listener);
        return () => document.removeEventListener(FORK_EVENT, listener);
    }, [fork, rootThreadId]);
    // Creates and selects a blank draft with model defaults from the active session or Main.
    async function newTab() {
        setPending(true);
        try {
            const current = await rpc.call("get", { threadId: activeTab?.draft ? rootThreadId : activeId });
            const result = await rpc.call("create", { threadId: activeTab?.draft ? rootThreadId : activeId, kind: "new", ...(current.selection ? { selection: current.selection } : {}) });
            applyGroup(result.group);
            select(result.threadId);
        }
        catch (cause) {
            report(cause);
        }
        finally {
            setPending(false);
        }
    }
    // Closes a tab; returns to Main if it was active.
    async function close(threadId: string) {
        setPending(true);
        try {
            applyGroup(await rpc.call("close", { rootThreadId, threadId }));
            if (activeId === threadId)
                select(rootThreadId);
        }
        catch (cause) {
            report(cause);
        }
        finally {
            setPending(false);
        }
    }
    // Reopens a closed tab and selects it.
    async function restore(threadId: string) {
        setPending(true);
        try {
            applyGroup(await rpc.call("restore", { rootThreadId, threadId }));
            select(threadId);
            setDialog(false);
        }
        catch (cause) {
            report(cause);
        }
        finally {
            setPending(false);
        }
    }
    // Saves the custom name entered in the rename dialog.
    async function rename() {
        if (!renameTarget || pending) return;
        setPending(true);
        try {
            applyGroup(await rpc.call("rename", { rootThreadId, threadId: renameTarget.id, title: renameTarget.title.trim() }));
            setRenameTarget(null);
        } catch (cause) { report(cause); }
        finally { setPending(false); }
    }
    // Copies text to the clipboard and reports the outcome in a toast.
    async function copy(text: string) {
        if (await copyToClipboard({ text })) toast.success("Copied");
        else toast.error("Could not copy to the clipboard");
    }
    // Copies a tab's concise or full transcript.
    async function copyTranscript(threadId: string, full: boolean) {
        try { await copy((await rpc.call("transcript", { threadId, full })).text); }
        catch (cause) { report(cause); }
    }
    // Copies a link to the main thread that opens the given tab.
    function copyLink(tabId: string) {
        const link = new URL(`/projects/${state?.projectId}/threads/${rootThreadId}`, location.origin);
        link.searchParams.set("chatTab", tabId);
        void copy(link.href);
    }
    // Marks a tab unread.
    async function markUnread(tabId: string) {
        try { applyGroup(await rpc.call("unread", { rootThreadId, tabId, unread: true })); }
        catch (cause) { report(cause); }
    }
    // Closes all tabs except this one and Main, then selects this one.
    async function closeOthers(tabId: string) {
        setPending(true);
        try { applyGroup(await rpc.call("close_others", { rootThreadId, tabId })); select(tabId); }
        catch (cause) { report(cause); }
        finally { setPending(false); }
    }
    // Opens the preview dialog for a draft's transcript attachment.
    async function showTranscript(tabId: string) {
        try { setPreview(await rpc.call("preview", { rootThreadId, tabId })); }
        catch (cause) { report(cause); }
    }
    // Detaches a draft's transcript so its first message is sent without it.
    async function removeTranscript(tabId: string) {
        try { applyGroup(await rpc.call("set_transcript", { rootThreadId, tabId, enabled: false })); }
        catch (cause) { report(cause); }
    }
    const menuItem = "flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:opacity-50";
    const full = openTabs.length >= 8;
    return <Tooltip.Provider delayDuration={500} skipDelayDuration={0}>
    <div className="flex shrink-0 items-center gap-1 border-b border-border bg-background px-2 py-1.5" aria-label="Chat tabs">
      <div role="tablist" aria-label="Agent sessions" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        {openTabs.map((tab, index) => {
            const thread = threads.find(thread => thread.id === tab.id);
            const title = tab.title;
            const edit = () => setRenameTarget({ id: tab.id, title });
            return <ContextMenu.Root key={tab.id}><ContextMenu.Trigger asChild><div className={`flex shrink-0 items-center rounded-md ${activeId === tab.id ? "bg-muted" : ""}`}>
            <Tooltip.Root><Tooltip.Trigger asChild><button role="tab" aria-selected={activeId === tab.id} aria-controls={activeId !== rootThreadId ? `session-${rootThreadId}` : undefined} id={`session-tab-${tab.id}`} tabIndex={activeId === tab.id ? 0 : -1} className="flex max-w-48 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm hover:bg-muted focus-visible:outline focus-visible:outline-2" onClick={() => select(tab.id)} onDoubleClick={edit} onKeyDown={event => {
                    if (event.key === "F2") { event.preventDefault(); edit(); return; }
                    let next = index;
                    if (event.key === "ArrowRight")
                        next = (index + 1) % openTabs.length;
                    else if (event.key === "ArrowLeft")
                        next = (index + openTabs.length - 1) % openTabs.length;
                    else if (event.key === "Home")
                        next = 0;
                    else if (event.key === "End")
                        next = openTabs.length - 1;
                    else
                        return;
                    event.preventDefault();
                    select(openTabs[next].id);
                    document.getElementById(`session-tab-${openTabs[next].id}`)?.focus();
                }} aria-label={title}>
              {thread && <ThreadStatusGlyph indicator={thread.indicator}/>}
              {tab.unread && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
              <span className={`min-w-0 truncate ${tab.unread ? "font-semibold" : ""}`}>{title}</span>
            </button></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content {...portalScope} side="bottom" sideOffset={8} className="z-50 max-w-sm break-words rounded-md border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md">{title}<Tooltip.Arrow className="fill-popover" /></Tooltip.Content></Tooltip.Portal></Tooltip.Root>
            {tab.kind !== "main" && <button className="mr-1 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" disabled={pending} onClick={() => void close(tab.id)} aria-label={`Close ${tab.title}`} title="Close tab and archive its chat"><Icon name="X" className="size-3"/></button>}
          </div></ContextMenu.Trigger><ContextMenu.Portal><ContextMenu.Content {...portalScope} className="z-50 min-w-40 rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md"><ContextMenu.Item disabled={pending} onSelect={() => void markUnread(tab.id)} className={menuItem}>Mark as unread</ContextMenu.Item>
            <ContextMenu.Item disabled={pending} onSelect={edit} className={menuItem}>Rename tab</ContextMenu.Item>
            <ContextMenu.Separator className="my-1 h-px bg-border" />
            <ContextMenu.Item disabled={tab.draft} onSelect={() => void copyTranscript(tab.id, false)} className={menuItem}>Copy concise transcript</ContextMenu.Item>
            <ContextMenu.Item disabled={tab.draft} onSelect={() => void copyTranscript(tab.id, true)} className={menuItem}>Copy full transcript</ContextMenu.Item>
            <ContextMenu.Item onSelect={() => copyLink(tab.id)} className={menuItem}>Copy link</ContextMenu.Item>
            <ContextMenu.Separator className="my-1 h-px bg-border" />
            <ContextMenu.Item disabled={pending || tab.kind === "main"} onSelect={() => void close(tab.id)} className={menuItem}>Close tab</ContextMenu.Item>
            <ContextMenu.Item disabled={pending || !openTabs.some(other => other.id !== tab.id && other.kind !== "main")} onSelect={() => void closeOthers(tab.id)} className={menuItem}>Close others</ContextMenu.Item></ContextMenu.Content></ContextMenu.Portal></ContextMenu.Root>;
        })}
      </div>
      <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={() => void newTab()} disabled={pending || full || !state?.environmentId} aria-label="New chat tab"><Icon name="Plus" className="size-4"/></Button>
      {state?.group.tabs.some(tab => tab.closed) && <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={() => setDialog(true)} aria-label="Restore closed tab"><Icon name="History" className="size-4"/></Button>}
      <span className="text-xs text-muted-foreground" title="Open chat tabs">{openTabs.length}/8</span>
    </div>
    {error && <div role="alert" className="flex items-center gap-2 p-2 text-sm text-destructive">{error}<Button size="sm" variant="ghost" onClick={refresh}>Retry</Button></div>}
    {childActive && <div className="flex min-h-0 flex-1 flex-col" role="tabpanel" id={`session-${rootThreadId}`} aria-labelledby={`session-tab-${activeId}`}>
      {activeTab?.draft && state?.environmentId ? <div className="flex min-h-0 flex-1 flex-col justify-center overflow-auto p-4" data-session-tabs-draft="">
        {activeTab.transcript?.enabled && <div className="mx-auto mb-3 flex w-full max-w-3xl items-center gap-2 rounded-md border border-border bg-muted p-2 text-sm">
          <Icon name="FileText" className="size-4 shrink-0" />
          <button className="min-w-0 flex-1 truncate text-left underline-offset-2 hover:underline" onClick={() => void showTranscript(activeId)} title={activeTab.transcript.file.name}>{activeTab.transcript.file.name}</button>
          <button className="rounded p-1 hover:bg-accent" aria-label="Remove transcript attachment" onClick={() => void removeTranscript(activeId)}><Icon name="X" className="size-3.5" /></button>
        </div>}
        <NewThreadComposer key={activeId} draftKey={`thread-tabs:${activeId}`} defaultProjectId={state.projectId} defaultEnvironment={{ type: "reuse", environmentId: state.environmentId }} defaultProviderId={activeTab.selection?.providerId ?? state.selection?.providerId} defaultModel={activeTab.selection?.model ?? state.selection?.model} defaultReasoningLevel={activeTab.selection?.reasoningLevel ?? state.selection?.reasoningLevel} defaultServiceTier={activeTab.selection?.serviceTier ?? state.selection?.serviceTier} defaultPermissionMode={state.permissionMode} onSubmit={async (request: NewThreadRequest) => {
                    if (submitting.current) throw new Error("This chat is already starting.");
                    submitting.current = true;
                    setPending(true);
                    try {
                    if (request.projectId !== state.projectId || request.environment.type !== "reuse" || request.environment.environmentId !== state.environmentId)
                        throw new Error("Chat tabs share this thread's project and workspace. Keep the current workspace selected.");
                    const attached = await rpc.call("start", {rootThreadId, draftId:activeId, request:{...request, environment:request.environment}});
                    applyGroup(attached);
                    const tab = attached.tabs.find(tab => tab.draftId === activeId);
                    select(tab && !tab.closed ? tab.id : rootThreadId);
                    } finally { submitting.current = false; setPending(false); }
                }}/>
      </div> : <ThreadChat key={activeId} threadId={activeId} variant="full" permissionPolicy="editable" className="min-h-0 flex-1" focusRequest={1} messageActions={[{ id: "fork-tab", title: "Fork into new tab", icon: "Fork", run: message => fork(message.threadId, message.sourceSeqEnd) }]}/>}
    </div>}
    <Dialog open={dialog} onOpenChange={setDialog}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>Closed tabs</DialogTitle><DialogDescription>Restore a chat with its conversation intact.</DialogDescription></DialogHeader>
      {state?.group.tabs.filter(tab => tab.closed).map(tab => <Button variant="outline" key={tab.id} onClick={() => void restore(tab.id)} disabled={pending || full}>Reopen {tab.title}</Button>)}
    </DialogContent></Dialog>
    <Dialog open={preview !== null} onOpenChange={open => { if (!open) setPreview(null); }}><DialogContent className="sm:max-w-3xl"><DialogHeader><DialogTitle>{preview?.name}</DialogTitle><DialogDescription>Conversation copied at the fork point. Later source messages do not change this attachment.</DialogDescription></DialogHeader><div className="max-h-96 overflow-auto"><Markdown content={preview?.text ?? ""} /></div></DialogContent></Dialog>
    <Dialog open={renameTarget !== null} onOpenChange={open => { if (!open) setRenameTarget(null); }}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>Rename tab</DialogTitle><DialogDescription>Your custom name will stay as you set it.</DialogDescription></DialogHeader>
      <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void rename(); }}>
        <input aria-label="Tab name" autoFocus value={renameTarget?.title ?? ""} onFocus={event => event.currentTarget.select()} onChange={event => setRenameTarget(target => target ? { ...target, title: event.target.value } : null)} maxLength={200} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" />
        <Button type="submit" disabled={pending || !renameTarget?.title.trim()}>Save name</Button>
      </form>
    </DialogContent></Dialog>
  </Tooltip.Provider>;
}
// Composer banner that mounts the tab strip at the top of the thread window, and removes it on cleanup.
function TabsMount() {
    const composer = useComposer();
    const marker = useRef<HTMLSpanElement>(null);
    const [target, setTarget] = useState<{
        host: HTMLElement;
        windowElement: HTMLElement;
    } | null>(null);
    const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
    useLayoutEffect(() => {
        const element = marker.current;
        if (!threadId || !element || element.closest("[data-session-tabs]"))
            return;
        const windowElement = element.closest<HTMLElement>("[data-thread-window]");
        if (!windowElement)
            return;
        const host = document.createElement("div");
        host.setAttribute("data-session-tabs", "");
        host.setAttribute("data-bb-plugin-root", "");
        host.setAttribute("data-bb-plugin", "thread-tabs");
        windowElement.prepend(host);
        setTarget({ host, windowElement });
        return () => { host.remove(); windowElement.removeAttribute("data-session-tabs-active"); };
    }, [threadId]);
    return <><span ref={marker} hidden/>{target && threadId && createPortal(<TabWorkspace rootThreadId={threadId} {...target}/>, target.host)}</>;
}
// Registers the tab strip banner, the fork message action, and the native-menu content script.
export default definePluginApp(app => {
    app.composer.customize({ id: "session-tabs", scopes: ["thread"], banners: [{ id: "tabs", chrome: "bare", component: TabsMount }] });
    app.slots.messageAction({ id: "fork-tab", title: "Fork into new tab", icon: "Fork", run: ({ message }) => { document.dispatchEvent(new CustomEvent(FORK_EVENT, { detail: message })); } });
    app.contentScripts.register({ id: "message-fork-menu", mount: ({ signal }) => mountMessageForkMenu(signal) });
});
