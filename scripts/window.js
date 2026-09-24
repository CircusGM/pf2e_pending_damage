import { localize } from "./constants.js";

export class PendingDamageWindow extends foundry.applications.api.ApplicationV2 {
    static DEFAULT_OPTIONS = {
        id: "pf2e-pending-damage", classes: ["pf2e-pending-damage", "pf2e-toolbelt"],
        window: { title: "pf2e-pending-damage.title", resizable: true },
        position: { width: 550, height: "auto", top: 120, left: 120 },
    };
    constructor(controller) { super(); this.controller = controller; }
    async _renderFrame(options) {
        const frame = await super._renderFrame(options);
        const clear = document.createElement("button");
        clear.type = "button";
        clear.className = "header-control pending-clear";
        clear.textContent = localize("clearAll");
        clear.addEventListener("click", () => this.controller.clear());
        frame.querySelector(".window-title")?.after(clear);
        return frame;
    }
    async _renderHTML() {
        const list = document.createElement("ol");
        list.className = "pending-list";
        for (const entry of this.controller.store.entries.values()) {
            const li = document.createElement("li");
            li.className = "pending-entry";
            li.dataset.pendingKey = entry.key;
            li.classList.toggle("applying", !!entry.applying);
            const source = document.createElement("span");
            source.className = "source";
            source.textContent = entry.sourceLabel;
            source.title = entry.sourceLabel;
            const name = document.createElement("span");
            name.className = "target-name";
            name.textContent = entry.targetName;
            const total = document.createElement("span");
            total.className = "total";
            total.textContent = entry.total ?? "—";
            const controls = entry.row.cloneNode(true);
            controls.classList.remove("hidden");
            controls.classList.add("small");
            for (const icon of controls.querySelectorAll("img, i")) icon.remove();
            for (const button of controls.querySelectorAll("button")) {
                button.disabled = !!entry.applying;
                if (button.dataset.action?.toLowerCase().includes("shield")) {
                    button.classList.toggle("shield-activated", !!entry.shield);
                    button.setAttribute("aria-pressed", String(!!entry.shield));
                }
            }
            const dismiss = document.createElement("button");
            dismiss.type = "button";
            dismiss.className = "dismiss";
            dismiss.textContent = "×";
            dismiss.title = dismiss.ariaLabel = localize("dismiss");
            dismiss.addEventListener("click", () => this.controller.dismiss(entry.key));
            controls.addEventListener("click", event => this.controller.onPanelClick(event, entry.key));
            li.append(source, name, total, controls, dismiss);
            list.append(li);
        }
        if (!list.children.length) {
            const empty = document.createElement("p");
            empty.className = "empty";
            empty.textContent = localize("empty");
            return empty;
        }
        return list;
    }
    _replaceHTML(result, content) { content.replaceChildren(result); }
    _onRender() {
        const button = this.element.querySelector(".pending-clear");
        if (button) button.disabled = !this.controller.store.entries.size;
    }
    shake() {
        this.element?.animate?.([{ transform: "translateX(0)" }, { transform: "translateX(-4px)" },
            { transform: "translateX(4px)" }, { transform: "translateX(0)" }], { duration: 180 });
    }
}
