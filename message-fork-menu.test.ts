// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { mountMessageForkMenu } from "./message-fork-menu";

let dispose = () => {};
afterEach(() => { dispose(); document.body.innerHTML = ""; });
// Adds a message row with an inline fork button and a Message actions trigger.
function message(id: string) {
    const row = document.createElement("div");
    const action = document.createElement("button");
    action.setAttribute("aria-label", "Fork into new tab");
    const fork = vi.fn();
    action.addEventListener("click", fork);
    const trigger = document.createElement("button");
    trigger.id = id;
    trigger.setAttribute("aria-label", "Message actions");
    row.append(action, trigger);
    document.body.append(row);
    return { action, trigger, fork };
}
// Adds a native actions menu for a trigger; `overflow` adds a host-provided "Fork into new tab" item.
function menu(triggerId: string, overflow = false) {
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-labelledby", triggerId);
    const copy = document.createElement("div");
    copy.setAttribute("role", "menuitem"); copy.textContent = "Copy link"; copy.tabIndex = -1;
    const thread = document.createElement("div");
    thread.setAttribute("role", "menuitem"); thread.textContent = "Fork into new thread"; thread.tabIndex = -1;
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("data-icon-root", ""); icon.setAttribute("aria-hidden", "true"); icon.setAttribute("class", "size-4");
    thread.prepend(icon);
    const forkThread = vi.fn(); thread.addEventListener("click", forkThread);
    menu.append(copy);
    if (overflow) { const tab = document.createElement("div"); tab.setAttribute("role", "menuitem"); tab.textContent = "Fork into new tab"; menu.append(tab); }
    menu.append(thread);
    document.body.append(menu);
    return { menu, copy, thread, forkThread };
}
// Mounts the content script with a signal that is never aborted.
function mount() { dispose = mountMessageForkMenu(new AbortController().signal); }

test("an already aborted content script does not change the host UI", () => {
    const source = message("cancelled"); const native = menu(source.trigger.id);
    const controller = new AbortController(); controller.abort();
    dispose = mountMessageForkMenu(controller.signal);
    expect(source.action.hasAttribute("data-session-tabs-inline-fork")).toBe(false);
    expect(native.menu.querySelector('[data-session-tabs-fork-item]')).toBeNull();
});

test("message menu contains both destinations and preserves BB's native thread action", () => {
    const source = message("output-1"); const native = menu(source.trigger.id); mount();
    expect(source.action.hasAttribute("data-session-tabs-inline-fork")).toBe(true);
    const options = Array.from(native.menu.querySelectorAll('[role="menuitem"]'));
    expect(options.map(item => item.textContent)).toEqual(["Copy link", "Fork into new tab", "Fork into new thread"]);
    expect(options[1].querySelector("svg")?.outerHTML).toBe(native.thread.querySelector("svg")?.outerHTML);
    fireEvent.click(options[1]); expect(source.fork).toHaveBeenCalledTimes(1);
    fireEvent.click(native.thread); expect(native.forkThread).toHaveBeenCalledTimes(1);
    expect(native.thread.hasAttribute("data-session-tabs-native-fork")).toBe(false);
});

test("fork routes to the selected output rather than another message", async () => {
    const first = message("first"); const second = message("second"); mount();
    const native = menu(second.trigger.id);
    await waitFor(() => expect(native.menu.querySelector('[data-session-tabs-fork-item]')).toBeTruthy());
    fireEvent.click(native.menu.querySelector('[data-session-tabs-fork-item]')!);
    expect(first.fork).not.toHaveBeenCalled(); expect(second.fork).toHaveBeenCalledTimes(1);
});

test("the inserted fork action participates in keyboard navigation and Enter activation", () => {
    const source = message("output"); const native = menu(source.trigger.id); mount();
    const item = native.menu.querySelector<HTMLButtonElement>('[data-session-tabs-fork-item]')!;
    native.copy.focus(); fireEvent.keyDown(native.copy, { key: "ArrowDown" }); expect(document.activeElement).toBe(item);
    fireEvent.keyDown(item, { key: "ArrowDown" }); expect(document.activeElement).toBe(native.thread);
    fireEvent.keyDown(native.thread, { key: "ArrowUp" }); expect(document.activeElement).toBe(item);
    fireEvent.keyDown(item, { key: "Enter" }); expect(source.fork).toHaveBeenCalledTimes(1);
});

test("native overflow entries are not duplicated and cleanup restores the original UI", () => {
    const source = message("output"); const native = menu(source.trigger.id, true); mount();
    expect(Array.from(native.menu.querySelectorAll('[role="menuitem"]')).filter(item => item.textContent === "Fork into new tab")).toHaveLength(1);
    dispose(); expect(source.action.hasAttribute("data-session-tabs-inline-fork")).toBe(false);
    native.menu.remove(); const next = menu(source.trigger.id); mount();
    expect(next.menu.querySelector('[data-session-tabs-fork-item]')).toBeTruthy();
    dispose(); expect(next.menu.querySelector('[data-session-tabs-fork-item]')).toBeNull();
});
