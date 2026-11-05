const TAB_LABEL = "Fork into new tab";
const THREAD_LABEL = "Fork into new thread";
const INLINE_MARKER = "data-session-tabs-inline-fork";

/** Hides the inline "Fork into new tab" button and adds that action to the native message-actions menu; the returned cleanup (also run on abort) restores the original UI. */
export function mountMessageForkMenu(signal: AbortSignal) {
    if (signal.aborted) return () => {};
    const hidden = new Set<HTMLButtonElement>();
    const injections = new Map<HTMLElement, { item: HTMLButtonElement; controller: AbortController }>();
    const label = (element: Element) => element.getAttribute("aria-label") ?? element.textContent?.trim();
    // Finds inline "Fork into new tab" buttons under an element and marks them for hiding.
    function scanInline(element: HTMLElement) {
        const buttons = element instanceof HTMLButtonElement ? [element] : Array.from(element.querySelectorAll<HTMLButtonElement>("button"));
        for (const button of buttons) {
            if (label(button) === TAB_LABEL && button.getAttribute("role") !== "menuitem" && !button.closest('[role="menu"]')) {
                button.setAttribute(INLINE_MARKER, "");
                hidden.add(button);
            }
        }
    }
    // Removes stale injected items and adds missing tab-fork actions to open message menus.
    function updateMenus() {
        for (const button of hidden) if (!button.isConnected) hidden.delete(button);
        for (const [menu, entry] of injections) {
            if (!menu.isConnected || !entry.item.isConnected) {
                entry.controller.abort();
                entry.item.remove();
                injections.delete(menu);
            }
        }
        for (const menu of Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]'))) {
            if (injections.has(menu)) continue;
            const triggerId = menu.getAttribute("aria-labelledby");
            const trigger = triggerId ? document.getElementById(triggerId) : null;
            if (!trigger || label(trigger) !== "Message actions") continue;
            const existing = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
            if (existing.some(item => label(item) === TAB_LABEL)) continue;
            const action = trigger.parentElement?.querySelector<HTMLButtonElement>(`button[aria-label="${TAB_LABEL}"]`);
            if (!action) continue;
            const threadAction = existing.find(item => label(item) === THREAD_LABEL);
            const reference = threadAction ?? existing.at(-1);
            if (!reference) continue;
            const item = document.createElement("button");
            const controller = new AbortController();
            const options = { signal: controller.signal };
            item.type = "button";
            item.setAttribute("role", "menuitem");
            item.setAttribute("data-session-tabs-fork-item", "");
            item.tabIndex = -1;
            item.className = reference.className;
            item.style.width = "100%";
            item.style.textAlign = "left";
            item.textContent = TAB_LABEL;
            const icon = threadAction?.querySelector("[data-icon-root], svg") ?? action.querySelector("[data-icon-root], svg");
            if (icon) item.prepend(icon.cloneNode(true));
            item.disabled = action.disabled;
            item.addEventListener("pointermove", () => item.focus(), options);
            item.addEventListener("focus", () => item.setAttribute("data-highlighted", ""), options);
            item.addEventListener("blur", () => item.removeAttribute("data-highlighted"), options);
            item.addEventListener("click", () => {
                if (!action.isConnected || action.disabled) return;
                document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
                action.click();
            }, options);
            item.addEventListener("keydown", event => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                item.click();
            }, options);
            // The injected item must participate in keyboard navigation alongside host items.
            menu.addEventListener("keydown", event => {
                if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).filter(candidate => candidate.getAttribute("aria-disabled") !== "true" && !(candidate instanceof HTMLButtonElement && candidate.disabled) && getComputedStyle(candidate).display !== "none");
                if (!items.length) return;
                const focused = document.activeElement?.closest('[role="menuitem"]');
                const index = items.findIndex(candidate => candidate === focused);
                const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (index + 1) % items.length : index <= 0 ? items.length - 1 : index - 1;
                event.preventDefault();
                event.stopImmediatePropagation();
                items[next].focus();
            }, { ...options, capture: true });
            injections.set(menu, { item, controller });
            reference.parentElement?.insertBefore(item, threadAction ?? reference.nextSibling);
        }
    }
    const observer = new MutationObserver(records => {
        for (const record of records) {
            record.addedNodes.forEach(node => { if (node instanceof HTMLElement) scanInline(node); });
        }
        updateMenus();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    scanInline(document.body);
    updateMenus();
    // Stops observing, unhides inline buttons, and removes injected menu items.
    const dispose = () => {
        observer.disconnect();
        for (const button of hidden) button.removeAttribute(INLINE_MARKER);
        hidden.clear();
        for (const { item, controller } of injections.values()) { controller.abort(); item.remove(); }
        injections.clear();
    };
    signal.addEventListener("abort", dispose, { once: true });
    return () => { signal.removeEventListener("abort", dispose); dispose(); };
}
