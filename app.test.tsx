// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { z } from "zod";
import type { NewThreadComposerProps } from "@get-bb/plugin-sdk/app";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@get-bb/plugin-sdk/app", async importOriginal => ({
    ...await importOriginal<typeof import("@get-bb/plugin-sdk/app")>(),
    ThreadChat: () => <div>Started session</div>,
    experimental_NewThreadComposer: (props: NewThreadComposerProps) => <button onClick={() => void Promise.resolve(props.onSubmit({
        projectId: "project", providerId: "claude-code", model: "chosen-model", reasoningLevel: "high", permissionMode: "auto",
        executionInputSources: { providerId: "explicit", model: "explicit" }, environment: { type: "reuse", environmentId: "workspace" },
        input: [{ type: "text", text: "Continue this conversation", mentions: [] }],
    })).catch(() => {})}>Send in Claude</button>,
}));

let unmount = () => {};
afterEach(() => { unmount(); document.body.innerHTML = ""; localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); });

// Renders the tab banner on thread "root" with a selected fork draft that carries a transcript.
async function mount() {
    const app = await loadPluginApp(() => import("./app"));
    const Mount = app.composerCustomizations[0].banners![0].component;
    const file = { type: "localFile" as const, path: "/attachments/transcript.md", name: "Transcript of Test workspace.md", sizeBytes: 100, sourceProjectId: "project", mimeType: "text/markdown" };
    const group = { rootThreadId: "root", revision: 0, tabs: [
        { id: "root", title: "Test workspace", kind: "main", closed: false, draft: false, manualTitle: false, selection: null, transcript: null, unread: false },
        { id: "draft:fork", title: "New chat", kind: "fork", closed: false, draft: true, manualTitle: false, unread: false,
          selection: { providerId: "codex", model: "source-model", reasoningLevel: "medium" },
          transcript: { enabled: true, sourceThreadId: "root", sourceTitle: "Test workspace", sourceSeqEnd: 20, file } },
    ] };
    localStorage.setItem("thread-tabs:root", "draft:fork");
    const slot = renderSlot({ component: () => <div data-thread-window=""><Mount /></div> }, {}, {
        pluginId: "thread-tabs", context: { projectId: "project", threadId: "root" }, composer: { scope: { kind: "thread", threadId: "root" } },
        rpc: {
            get: () => ({ group, projectId: "project", environmentId: "workspace", permissionMode: "auto", selection: { providerId: "codex", model: "source-model", reasoningLevel: "medium" } }),
            start: () => { Object.assign(group.tabs[1], {id:"new-session", draftId:"draft:fork", draft:false}); return group; },
            unread: () => group,
            set_transcript: () => { group.tabs[1].transcript!.enabled = false; return group; },
        },
    });
    unmount = () => slot.lifecycle.unmount();
    await screen.findByRole("button", { name: "Send in Claude" });
    return { slot, file };
}

test("fork draft sends its transcript through a fresh session with the user's chosen provider", async () => {
    const { slot, file } = await mount();
    expect(screen.getByRole("button", { name: file.name })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fork" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send in Claude" }));
    await screen.findByText("Started session");
    const call = slot.inspection.rpcCalls.find(call => call.method === "start");
    const request = z.object({request:z.record(z.string(),z.unknown())}).parse(call?.input).request;
    expect(request).toMatchObject({ providerId: "claude-code", model: "chosen-model", environment: { type: "reuse", environmentId: "workspace" } });
    expect(request.input).toEqual([{ type: "text", text: "Continue this conversation", mentions: [] }]);
    expect(request.title).toBeUndefined();
});

test("removing a transcript attachment excludes it from the submitted request", async () => {
    const { slot, file } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Remove transcript attachment" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: file.name })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Send in Claude" }));
    await screen.findByText("Started session");
    const call = slot.inspection.rpcCalls.find(call => call.method === "start");
    const request = z.object({request:z.record(z.string(),z.unknown())}).parse(call?.input).request;
    expect(request.input).toEqual([{ type: "text", text: "Continue this conversation", mentions: [] }]);
});

test("the tab's right-click menu includes the observed Conductor actions", async () => {
    await mount();
    fireEvent.contextMenu(screen.getByRole("tab", { name: "New chat" }), { button: 2, clientX: 10, clientY: 10 });
    for (const name of ["Mark as unread", "Rename tab", "Copy concise transcript", "Copy full transcript", "Copy link", "Close tab", "Close others"]) {
        expect(await screen.findByRole("menuitem", { name })).toBeTruthy();
    }
});

test("a repeated submit does not start a second agent session", async () => {
    const {slot} = await mount();
    const button = screen.getByRole("button", {name:"Send in Claude"});
    fireEvent.click(button);
    // Repeat the callback while the first submission is still pending.
    fireEvent.click(button);
    await screen.findByText("Started session");
    expect(slot.inspection.rpcCalls.filter(call => call.method === "start")).toHaveLength(1);
});
