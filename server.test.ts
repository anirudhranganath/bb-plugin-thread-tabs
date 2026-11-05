import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { rpcContract } from "./server.ts";
import { z } from "zod";
// Starts the plugin on a fake host with an in-memory root thread, attachments and spawn/fork; returns an RPC caller.
async function setup() {
    const threads = new Map([["root", makeThreadResponse({ id: "root", projectId: "project", environmentId: "workspace", providerId: "codex" })]]);
    const uploads = new Map<string, Uint8Array>();
    const rows = [{id:"user",kind:"conversation",role:"user",text:"Explain git worktrees",sourceSeqStart:1,sourceSeqEnd:1},{id:"assistant",kind:"conversation",role:"assistant",text:"Worktrees share one repository.",sourceSeqStart:2,sourceSeqEnd:17},{id:"later",kind:"conversation",role:"assistant",text:"Later message",sourceSeqStart:18,sourceSeqEnd:20}];
    const metadata = new Map<string, Record<string, unknown>>();
    let sequence = 0;
    const { bb, harness } = createFakePluginHost({ pluginId: "thread-tabs", sdk: { projects: { attachments: {
        upload: async args => { const path = `/attachments/${uploads.size}.md`; const source = args.clientFile; const bytes = source instanceof Uint8Array ? source : source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(await source.arrayBuffer()); uploads.set(path, bytes); return {type:"localFile",name:args.filename,path,sizeBytes:bytes.byteLength,mimeType:"text/markdown",sourceProjectId:args.projectId}; },
        read: async ({path}) => ({bytes:uploads.get(path)!,mimeType:"text/markdown",sizeBytes:uploads.get(path)!.length}),
    } }, threads: {
                timeline: async () => ({maxSeq:20,rows,timelinePage:{olderCursor:null}}),
                markRead: async ({threadId}) => threads.get(threadId),
                markUnread: async ({threadId}) => threads.get(threadId),
                getPluginMetadata: async ({ threadId }) => metadata.get(threadId) ?? {},
                get: async ({ threadId }) => { const thread = threads.get(threadId); if (!thread)
                    throw new Error("Missing thread"); return thread; },
                defaultExecutionOptions: async () => ({ model: "model-a", reasoningLevel: "medium", serviceTier: "default", permissionMode: "auto", source: "client/thread/start" }),
                spawn: async (args) => {
                    const thread = makeThreadResponse({ id: `tab-${++sequence}`, projectId: args.projectId, environmentId: "workspace", providerId: args.providerId, lifecycleOwnerThreadId: args.lifecycleOwnerThreadId, visibility: args.visibility });
                    threads.set(thread.id, thread);
                    metadata.set(thread.id, args.pluginMetadata ?? {});
                    return thread;
                },
                fork: async (args) => {
                    const thread = makeThreadResponse({ id: `fork-${++sequence}`, environmentId: "workspace", sourceThreadId: args.sourceThreadId, lifecycleOwnerThreadId: args.lifecycleOwnerThreadId, visibility: args.visibility });
                    threads.set(thread.id, thread);
                    metadata.set(thread.id, args.pluginMetadata ?? {});
                    return thread;
                },
                update: async ({ threadId, ...patch }) => { const thread = threads.get(threadId)!; Object.assign(thread, patch); return thread; },
                archive: async ({ threadId }) => { const thread = threads.get(threadId)!; thread.archivedAt = 1; return thread; },
                unarchive: async ({ threadId }) => { const thread = threads.get(threadId)!; thread.archivedAt = null; return thread; },
            } } });
    await plugin(bb);
    async function callRpc<K extends keyof typeof rpcContract>(method: K, input: unknown): Promise<z.output<(typeof rpcContract)[K]["output"]>> {
        return rpcContract[method].output.parse(await harness.behavior.callRpc(method, input)) as z.output<(typeof rpcContract)[K]["output"]>;
    }
    return { bb, harness, callRpc, threads, uploads, rows };
}
const selection = { providerId: "claude-code", model: "chosen-model", reasoningLevel: "high" };
test("new tabs save a blank draft and model without running an agent", async (t) => {
    const { harness, callRpc } = await setup();
    t.after(() => harness.lifecycle.dispose());
    const result = await callRpc("create", { threadId: "root", kind: "new", selection });
    assert.equal(result.group.tabs.length, 2);
    assert.equal(result.group.tabs[1].draft, true);
    assert.deepEqual(result.group.tabs[1].selection, selection);
    assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
    assert.equal(harness.inspection.sdk.callsTo("threads.fork").length, 0);
});
// Creates a draft, spawns its hidden session as the host would, and attaches it.
async function startDraft(context: Awaited<ReturnType<typeof setup>>) {
    const draft = await context.callRpc("create", { threadId: "root", kind: "new", selection });
    const thread = await context.bb.sdk.threads.spawn({ projectId: "project", environment: { type: "reuse", environmentId: "workspace" }, ...selection, visibility: "hidden", lifecycleOwnerThreadId: "root", pluginMetadata: { rootThreadId: "root", draftId: draft.threadId }, prompt: "Test" });
    await context.callRpc("attach", { rootThreadId: "root", draftId: draft.threadId, threadId: thread.id });
    return { ...thread, draftId: draft.threadId };
}
test("draft attachment validates workspace ownership and is idempotent", async (t) => {
    const context = await setup();
    const { harness, callRpc, threads } = context;
    t.after(() => harness.lifecycle.dispose());
    const thread = await startDraft(context);
    const group = await callRpc("attach", { rootThreadId: "root", draftId: thread.draftId, threadId: thread.id });
    assert.equal(group.tabs.length, 2);
    assert.equal(group.tabs[1].draft, false);
    const draft = await callRpc("create", { threadId: "root", kind: "new", selection });
    threads.get(thread.id)!.environmentId = "other";
    await assert.rejects(callRpc("attach", { rootThreadId: "root", draftId: draft.threadId, threadId: "root" }), /share this thread/);
    assert.equal((await callRpc("get", { threadId: "root" })).group.tabs[2].draft, true);
});
test("fork creates a fresh draft with an immutable transcript up to the selected message", async t => {
    const context = await setup(); const {harness,callRpc,rows}=context; t.after(()=>harness.lifecycle.dispose());
    const first=await startDraft(context);
    const result=await callRpc("create",{threadId:first.id,kind:"fork",sourceSeqEnd:17});
    const tab=result.group.tabs.at(-1)!;
    assert.equal(tab.title,"New chat"); assert.equal(tab.draft,true); assert.equal(tab.kind,"fork");
    assert.equal(tab.selection!.providerId,"claude-code");
    assert.equal(harness.inspection.sdk.callsTo("threads.fork").length,0);
    assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length,1);
    const preview=await callRpc("preview",{rootThreadId:"root",tabId:tab.id});
    assert.match(preview.text,/Explain git worktrees/); assert.match(preview.text,/Worktrees share/); assert.doesNotMatch(preview.text,/Later message/);
    rows[0].text="Changed later";
    assert.equal((await callRpc("preview",{rootThreadId:"root",tabId:tab.id})).text,preview.text);
    const removed=await callRpc("set_transcript",{rootThreadId:"root",tabId:tab.id,enabled:false});
    assert.equal(removed.tabs.at(-1)!.transcript!.enabled,false);
});
test("concurrent creates cannot exceed eight tabs; close frees a slot and restore respects the limit", async (t) => {
    const { harness, callRpc } = await setup();
    t.after(() => harness.lifecycle.dispose());
    const results = await Promise.allSettled(Array.from({ length: 9 }, () => callRpc("create", { threadId: "root", kind: "new", selection })));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 7);
    const before = await callRpc("get", { threadId: "root" });
    const closed = before.group.tabs[1].id;
    await callRpc("close", { rootThreadId: "root", threadId: closed });
    await callRpc("create", { threadId: "root", kind: "fork" });
    await assert.rejects(callRpc("restore", { rootThreadId: "root", threadId: closed }), /8 open tabs/);
    await callRpc("close", { rootThreadId: "root", threadId: before.group.tabs[2].id });
    await callRpc("restore", { rootThreadId: "root", threadId: closed });
    await assert.rejects(callRpc("close", { rootThreadId: "root", threadId: "root" }), /main tab stays open/);
});
test("creation failure preserves the tab list; changed workspaces and archived roots are rejected", async (t) => {
    const context = await setup();
    const { harness, callRpc, threads } = context;
    t.after(() => harness.lifecycle.dispose());
    harness.sdk.stub("threads.timeline", async () => { throw new Error("transcript failed"); });
    await assert.rejects(callRpc("create", { threadId: "root", kind: "fork" }), /transcript failed/);
    assert.equal((await callRpc("get", { threadId: "root" })).group.tabs.length, 1);
    const first = await startDraft(context);
    threads.get(first.id)!.environmentId = "other";
    await assert.rejects(callRpc("create", { threadId: first.id, kind: "fork" }), /share the main thread/);
    threads.get("root")!.archivedAt = 1;
    await assert.rejects(callRpc("create", { threadId: "root", kind: "new", selection }), /Restore the main thread/);
});

test("automatic tab names follow BB's first-message summary", async t => {
    const context = await setup();
    t.after(() => context.harness.lifecycle.dispose());
    const thread = await startDraft(context);
    context.threads.get(thread.id)!.title = "Password reset";
    const state = await context.callRpc("get", { threadId: "root" });
    assert.equal(state.group.tabs[1].title, "Password reset");
    assert.equal(state.group.tabs[1].manualTitle, false);
});

test("manual draft names survive session creation, reload and later automatic titles", async t => {
    const context = await setup();
    const { bb, harness, callRpc, threads } = context;
    t.after(() => harness.lifecycle.dispose());
    const draft = await callRpc("create", { threadId: "root", kind: "new", selection });
    const title = "A deliberately long custom title that must never be automatically replaced";
    await callRpc("rename", { rootThreadId: "root", threadId: draft.threadId, title });
    const thread = await bb.sdk.threads.spawn({ projectId: "project", environment: { type: "reuse", environmentId: "workspace" }, ...selection, visibility: "hidden", lifecycleOwnerThreadId: "root", pluginMetadata: { rootThreadId: "root", draftId: draft.threadId }, prompt: "First message" });
    await callRpc("attach", { rootThreadId: "root", draftId: draft.threadId, threadId: thread.id });
    assert.equal(threads.get(thread.id)!.title, title);
    threads.get(thread.id)!.title = "Late generated title";
    const reloaded = await harness.lifecycle.reload(plugin);
    const state = rpcContract.get.output.parse(await reloaded.harness.behavior.callRpc("get", { threadId: "root" }));
    assert.equal(state.group.tabs[1].title, title);
    assert.equal(state.group.tabs[1].manualTitle, true);
    await reloaded.harness.lifecycle.dispose();
});

test("renaming existing tabs updates their thread and rejects empty names or foreign tabs", async t => {
    const context = await setup();
    const { harness, callRpc, threads } = context;
    t.after(() => harness.lifecycle.dispose());
    const thread = await startDraft(context);
    await callRpc("rename", { rootThreadId: "root", threadId: thread.id, title: "  My title  " });
    assert.equal(threads.get(thread.id)!.title, "My title");
    await assert.rejects(callRpc("rename", { rootThreadId: "root", threadId: thread.id, title: "  " }));
    await assert.rejects(callRpc("rename", { rootThreadId: "root", threadId: "unknown", title: "Invalid" }), /Tab not found/);
});


test("unread and close-others affect only the selected group and preserve Main", async t => {
    const context=await setup(); const {harness,callRpc}=context; t.after(()=>harness.lifecycle.dispose());
    const first=await startDraft(context); const second=await startDraft(context);
    let group=await callRpc("unread",{rootThreadId:"root",tabId:first.id,unread:true});
    assert.equal(group.tabs.find(tab=>tab.id===first.id)!.unread,true);
    group=await callRpc("unread",{rootThreadId:"root",tabId:first.id,unread:false});
    assert.equal(group.tabs.find(tab=>tab.id===first.id)!.unread,false);
    group=await callRpc("close_others",{rootThreadId:"root",tabId:first.id});
    assert.equal(group.tabs.find(tab=>tab.id===second.id)!.closed,true);
    assert.equal(group.tabs[0].closed,false); assert.equal(group.tabs.find(tab=>tab.id===first.id)!.closed,false);
});

test("transcript export pages through older nested rows and distinguishes concise from full", async t => {
    const context=await setup(); const {harness,callRpc}=context; t.after(()=>harness.lifecycle.dispose());
    harness.sdk.stub("threads.timeline",async (...[args]: Parameters<typeof context.bb.sdk.threads.timeline>) => args.beforeAnchorId ? {maxSeq:50,rows:[{id:"first",kind:"conversation",role:"user",text:"First request",sourceSeqStart:1,sourceSeqEnd:1}],timelinePage:{olderCursor:null}} : {maxSeq:30,rows:[{id:"turn",kind:"turn",sourceSeqStart:2,sourceSeqEnd:30,children:[{id:"tool",kind:"work",sourceSeqStart:2,sourceSeqEnd:3,command:"pwd",output:"/workspace"},{id:"answer",kind:"conversation",role:"assistant",sourceSeqStart:4,sourceSeqEnd:20,text:"Final answer"}]}],timelinePage:{olderCursor:{anchorId:"turn",anchorSeq:2}}});
    const concise=await callRpc("transcript",{threadId:"root",full:false});
    assert.ok(concise.text.indexOf("First request")<concise.text.indexOf("Final answer"));
    assert.doesNotMatch(concise.text,/pwd/);
    const full=await callRpc("transcript",{threadId:"root",full:true});
    assert.match(full.text,/pwd/); assert.match(full.text,/\/workspace/);
    const calls=harness.inspection.sdk.callsTo("threads.timeline");
    assert.deepEqual(calls[1][0], {threadId:"root",includeNestedRows:"true",deferContent:"false",segmentLimit:"100",beforeAnchorSeq:"2",beforeAnchorId:"turn"});
});

test("transcript failure leaves the group unchanged and rejects non-advancing pagination", async t => {
    const context=await setup(); const {harness,callRpc}=context; t.after(()=>harness.lifecycle.dispose());
    harness.sdk.stub("threads.timeline",async()=>({maxSeq:1,rows:[],timelinePage:{olderCursor:{anchorId:"stuck",anchorSeq:1}}}));
    await assert.rejects(callRpc("create",{threadId:"root",kind:"fork"}),/did not advance/);
    assert.equal((await callRpc("get",{threadId:"root"})).group.tabs.length,1);
});

test("a fork of a transcript-based chat retains its earlier inherited context", async t => {
    const context=await setup(); const {harness,callRpc,bb}=context; t.after(()=>harness.lifecycle.dispose());
    const first=await callRpc("create",{threadId:"root",kind:"fork",sourceSeqEnd:17});
    const thread=await bb.sdk.threads.spawn({projectId:"project",environment:{type:"reuse",environmentId:"workspace"},...selection,visibility:"hidden",lifecycleOwnerThreadId:"root",pluginMetadata:{rootThreadId:"root",draftId:first.threadId},prompt:"Follow up"});
    await callRpc("attach",{rootThreadId:"root",draftId:first.threadId,threadId:thread.id});
    harness.sdk.stub("threads.timeline",async()=>({maxSeq:5,rows:[{id:"followup",kind:"conversation",role:"user",text:"Follow-up task",sourceSeqStart:1,sourceSeqEnd:1}],timelinePage:{olderCursor:null}}));
    const next=await callRpc("create",{threadId:thread.id,kind:"fork"});
    const preview=await callRpc("preview",{rootThreadId:"root",tabId:next.threadId});
    assert.match(preview.text,/Explain git worktrees/); assert.match(preview.text,/Follow-up task/);
});

test("root-only operations reject child aliases before changing sessions", async t => {
    const context = await setup(); t.after(() => context.harness.lifecycle.dispose());
    const child = await startDraft(context);
    await assert.rejects(context.callRpc("rename", {rootThreadId:child.id, threadId:"root", title:"Wrong owner"}), /main thread ID/);
    assert.equal(context.harness.inspection.sdk.callsTo("threads.update").length, 0);
});

test("a draft closed during startup attaches as an archived session and can be restored", async t => {
    const context = await setup(); t.after(() => context.harness.lifecycle.dispose());
    const draft = await context.callRpc("create", {threadId:"root",kind:"new"});
    await context.callRpc("close", {rootThreadId:"root",threadId:draft.threadId});
    const child = await context.bb.sdk.threads.spawn({projectId:"project",environment:{type:"reuse",environmentId:"workspace"},...selection,visibility:"hidden",lifecycleOwnerThreadId:"root",pluginMetadata:{rootThreadId:"root",draftId:draft.threadId},prompt:"Test"});
    const group = await context.callRpc("attach", {rootThreadId:"root",draftId:draft.threadId,threadId:child.id});
    assert.equal(group.tabs[1].closed, true);
    assert.equal(context.threads.get(child.id)!.archivedAt, 1);
    const restored = await context.callRpc("restore", {rootThreadId:"root",threadId:child.id});
    assert.equal(restored.tabs[1].closed, false);
});

test("a second client attaching the same draft archives the duplicate session", async t => {
    const context = await setup(); t.after(() => context.harness.lifecycle.dispose());
    const first = await startDraft(context);
    const second = await context.bb.sdk.threads.spawn({projectId:"project",environment:{type:"reuse",environmentId:"workspace"},...selection,visibility:"hidden",lifecycleOwnerThreadId:"root",pluginMetadata:{rootThreadId:"root",draftId:first.draftId},prompt:"Test"});
    const group = await context.callRpc("attach", {rootThreadId:"root",draftId:first.draftId,threadId:second.id});
    assert.equal(group.tabs[1].id, first.id);
    assert.equal(context.threads.get(second.id)!.archivedAt, 1);
});

test("oversized raw timeline records fail without uploading a partial transcript", async t => {
    const context = await setup(); t.after(() => context.harness.lifecycle.dispose());
    context.harness.sdk.stub("threads.timeline", async () => ({maxSeq:1,rows:[{id:"tool",kind:"work",sourceSeqStart:1,sourceSeqEnd:1,output:"x".repeat(16*1024*1024)}],timelinePage:{olderCursor:null}}));
    await assert.rejects(context.callRpc("create", {threadId:"root",kind:"fork"}), /too large/);
    assert.equal(context.uploads.size, 0);
});

test("long automatic names remain readable after close and reload", async t => {
    const context = await setup(); t.after(() => context.harness.lifecycle.dispose());
    const child = await startDraft(context);
    context.threads.get(child.id)!.title = "x".repeat(500);
    await context.callRpc("close", {rootThreadId:"root",threadId:child.id});
    const state = await context.callRpc("get", {threadId:"root"});
    assert.equal(state.group.tabs[1].title.length, 200);
    assert.equal(state.group.revision, 3);
});

const firstMessage = {projectId:"project",environment:{type:"reuse",environmentId:"workspace"}, ...selection, permissionMode:"auto", executionInputSources:{providerId:"explicit",model:"explicit"}, input:[{type:"text",text:"Continue",mentions:[]}]};

test("concurrent submissions start a draft once and use its current transcript and title", async t => {
    const context = await setup(); t.after(() => context.harness.lifecycle.dispose());
    const draft = await context.callRpc("create", {threadId:"root",kind:"fork"});
    await context.callRpc("rename", {rootThreadId:"root",threadId:draft.threadId,title:"Manual title"});
    const args = {rootThreadId:"root",draftId:draft.threadId,request:firstMessage};
    const results = await Promise.all([context.callRpc("start",args),context.callRpc("start",args)]);
    assert.equal(results[0].tabs[1].id,results[1].tabs[1].id);
    const calls = context.harness.inspection.sdk.callsTo("threads.spawn");
    assert.equal(calls.length,1);
    assert.ok(calls[0][0] && typeof calls[0][0] === "object");
    assert.deepEqual(calls[0][0], {...firstMessage, title:"Manual title", input:[draft.group.tabs[1].transcript!.file,...firstMessage.input], visibility:"hidden",lifecycleOwnerThreadId:"root",pluginMetadata:{rootThreadId:"root",draftId:draft.threadId},origin:"plugin",originPluginId:"thread-tabs"});
});

test("starting rejects foreign workspaces and closed drafts before creating a session", async t => {
    const context = await setup(); t.after(() => context.harness.lifecycle.dispose());
    const draft = await context.callRpc("create", {threadId:"root",kind:"new"});
    await assert.rejects(context.callRpc("start", {rootThreadId:"root",draftId:draft.threadId,request:{...firstMessage,projectId:"other"}}), /share the main/);
    await context.callRpc("close", {rootThreadId:"root",threadId:draft.threadId});
    await assert.rejects(context.callRpc("start", {rootThreadId:"root",draftId:draft.threadId,request:firstMessage}), /no longer open/);
    assert.equal(context.harness.inspection.sdk.callsTo("threads.spawn").length,0);
});

test("retrying attachment after a failure reuses the already created session", async t => {
    const context = await setup(); t.after(() => context.harness.lifecycle.dispose());
    const draft = await context.callRpc("create", {threadId:"root",kind:"fork"});
    await context.callRpc("set_transcript",{rootThreadId:"root",tabId:draft.threadId,enabled:false});
    await context.callRpc("rename",{rootThreadId:"root",threadId:draft.threadId,title:"Keep this"});
    context.harness.sdk.stub("threads.update",async () => {throw new Error("Temporary failure");});
    const args = {rootThreadId:"root",draftId:draft.threadId,request:firstMessage};
    await assert.rejects(context.callRpc("start",args),/Temporary failure/);
    context.harness.sdk.stub("threads.update",async () => context.threads.get("tab-1"));
    const group = await context.callRpc("start",args);
    assert.equal(group.tabs[1].draft,false);
    const calls = context.harness.inspection.sdk.callsTo("threads.spawn");
    assert.equal(calls.length,1);
    assert.deepEqual(z.object({input:z.unknown()}).parse(calls[0][0]).input,firstMessage.input);
});
