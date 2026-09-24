import { JSDOM } from "jsdom";

export const dom = new JSDOM("<!doctype html><body></body>");
globalThis.document = dom.window.document;
globalThis.foundry = {
    utils: { debounce: () => () => {}, deepClone: structuredClone, randomID: () => Math.random().toString(36).slice(2) },
    applications: { api: { ApplicationV2: class {
        rendered = false;
        async _renderFrame() {
            const frame = document.createElement("div");
            frame.innerHTML = '<header><h4 class="window-title"></h4></header><section class="window-content"></section>';
            return frame;
        }
        async render() {
            this.element ??= await this._renderFrame({});
            const content = await this._renderHTML();
            this._replaceHTML(content, this.element.querySelector(".window-content"));
            this.rendered = true;
            this._onRender?.();
            return this;
        }
        async close() { this.rendered = false; }
    }, DialogV2: {} } },
};
export const settings = new Map();
export const tokens = new Map();
export const hooks = new Map();
export const wrappers = new Map();
export const errors = [];
export function reset() {
    document.body.replaceChildren();
    settings.clear(); tokens.clear(); hooks.clear(); wrappers.clear(); errors.length = 0;
    for (const key of ["pf2e-pending-damage.enabled", "pf2e-pending-damage.showWindow",
        "pf2e-toolbelt.targetHelper.enabled", "pf2e-toolbelt.targetHelper.targets"]) settings.set(key, true);
    globalThis.CONFIG = { PF2E: { chatDamageButtonShieldToggle: false } };
    globalThis.game = {
        user: { id: "gm", isGM: true, isActiveGM: true, getActiveTokens: () => [...tokens.values()] },
        users: { activeGM: { id: "gm" }, get: () => ({ id: "gm", isGM: true, active: true }) },
        messages: new Map(), pf2e: { settings: { metagame: { results: true } } },
        settings: { get: (scope, key) => settings.get(`${scope}.${key}`) },
        socket: { on() {}, emit() {} },
        i18n: { localize: key => key, format: key => key },
    };
    globalThis.fromUuidSync = uuid => tokens.get(uuid);
    globalThis.fromUuid = async uuid => tokens.get(uuid);
    globalThis.ui = { notifications: { error: error => errors.push(error), warn: error => errors.push(error) } };
    globalThis.Hooks = {
        on: (name, fn) => { if (!hooks.has(name)) hooks.set(name, []); hooks.get(name).push(fn); },
        once: (name, fn) => Hooks.on(name, fn),
    };
    globalThis.libWrapper = { register: (_id, path, fn, type) => wrappers.set(path, { fn, type }) };
}
export function fire(name, ...args) { return Promise.all((hooks.get(name) ?? []).map(fn => fn(...args))); }
export function token(id = "target", owned = true) {
    const result = { id, uuid: `Scene.scene.Token.${id}`, parent: { id: "scene" }, documentName: "Token",
        name: `Name ${id}`, isOwner: false, flags: {}, actor: { uuid: `Actor.${id}`, isOwner: owned,
            testUserPermission: () => owned, getSelfRollOptions: () => ["self:type:character"],
            getContextualClone() { return this; }, applyDamage: async () => {} } };
    tokens.set(result.uuid, result);
    return result;
}
function getPath(object, path) { return path.split(".").reduce((value, key) => value?.[key], object); }
function setPath(object, path, value) {
    const parts = path.split(".");
    const last = parts.pop();
    for (const part of parts) object = object[part] ??= {};
    object[last] = value;
}
export function message(targets = [...tokens.values()], id = "message") {
    const result = {
        id, isDamageRoll: true, isContentVisible: true, item: { name: "Longsword", isOfType: () => false },
        flags: { pf2e: {}, "pf2e-toolbelt": { targetHelper: { type: "damage", targets: targets.map(t => t.uuid),
            splashTargets: [], applied: {}, splashIndex: -1 } } },
        rolls: [{ total: 12, alter: (multiplier, addend) => ({ total: 12 * multiplier + addend }) }],
        getFlag: (scope, path) => getPath(result.flags[scope], path),
        setFlag: async (scope, path, value) => { setPath(result.flags, `${scope}.${path}`, value); },
        update: async updates => {
            for (const [path, value] of Object.entries(updates)) setPath(result, path, value);
            await fire("updateChatMessage", result);
        },
        renderHTML: async () => chat(result),
    };
    game.messages.set(id, result);
    return result;
}
export function chat(message, { includeTargets = true } = {}) {
    const html = document.createElement("li");
    html.className = "chat-message message";
    html.dataset.messageId = message.id;
    const controls = (index, uuid) => {
        const row = document.createElement("div");
        row.className = "damage-application";
        row.dataset.rollIndex = String(index);
        if (uuid) { row.dataset.targetUuid = uuid; row.dataset.targetRollIndex = String(index); }
        const prefix = uuid ? "target-" : "";
        row.innerHTML = [0.5, 1, 2, 3, -1].map(multiplier =>
            `<button data-action="${prefix}applyDamage" data-multiplier="${multiplier}"><i>icon</i>${multiplier}</button>`).join("") +
            `<button data-action="${prefix}shieldBlock">Shield</button>`;
        html.append(row);
    };
    for (let index = 0; index < message.rolls.length; index++) controls(index);
    if (includeTargets) for (const uuid of message.flags["pf2e-toolbelt"].targetHelper.targets) {
        for (let index = 0; index < message.rolls.length; index++) controls(index, uuid);
    }
    return html;
}
export function click(button, options = {}) {
    return button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...options }));
}
export const flush = () => new Promise(resolve => setImmediate(resolve));
