import vm from "node:vm";
import { readFileSync } from "node:fs";

// Evaluate real runtime modules in independent GM/player globals, sharing only
// persisted documents and a simulated authenticated Foundry socket transport.
const code = ["constants", "toolbelt-adapter", "damage-guard"].map(name =>
    readFileSync(new URL(`../../scripts/${name}.js`, import.meta.url), "utf8")
        .replace(/^import .*;\n/gm, "").replace(/export \{[\s\S]*?\};/g, "")
        .replace(/export /g, "")).join("\n") + "\nglobalThis.Guard = DamageApplicationGuard;";

export const tokenUuid = "Scene.scene.Token.target";
export const state = {
    users: ["gm", "player", "other"].map(id => ({ id, active: true, isGM: id === "gm" })),
};
export const flush = () => new Promise(resolve => setImmediate(resolve));
export function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
export function reset() {
    Object.assign(state, { now: 10_000, clients: [], records: new Map(), applied: {}, owners: new Set(["player"]),
        nextId: 0, activeGM: "gm", timers: new Map(), nextTimer: 0, dropPacket: () => false });
    for (const user of state.users) { user.active = true; user.isGM = user.id === "gm"; }
}
export async function advance(ms) {
    const until = state.now + ms;
    while (true) {
        const next = [...state.timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        state.now = next[1].at;
        state.timers.delete(next[0]);
        next[1].callback();
        await flush();
    }
    state.now = until;
    await flush();
}
function merge(current, update) {
    if (!update || typeof update !== "object" || Array.isArray(update)) return update;
    return Object.fromEntries(Object.entries({ ...current, ...update }).map(([key, value]) =>
        [key, key in update ? merge(current?.[key], value) : value]));
}
export function makeClient(id) {
    const user = state.users.find(u => u.id === id);
    const client = { id, shakes: 0, dialogs: 0, errors: [], confirm: async () => true, tokens: new Map() };
    const token = {
        id: "target", uuid: tokenUuid, documentName: "Token", name: "Target", parent: { id: "scene" },
        isOwner: false, actor: { uuid: "Actor.target", get isOwner() { return user.isGM || state.owners.has(id); },
            testUserPermission: user => user.isGM || state.owners.has(user.id) },
    };
    client.token = token;
    client.tokens.set(token.uuid, token);
    const data = client.data = () => ({ type: "damage", targets: [...client.tokens.values()], splashTargets: [],
        splashIndex: client.splashIndex ?? -1, applied: state.applied });
    const message = client.message = {
        id: "message", isDamageRoll: true, rolls: [{ total: 12 }, { total: 3 }], flags: { pf2e: {} },
        isContentVisible: true, whisper: [], blind: false,
        getFlag(scope, flag) {
            if (scope === "pf2e-toolbelt") {
                const value = data();
                return { ...value, targets: value.targets.map(t => t.uuid) };
            }
            if (flag === "damageApplications") return Object.fromEntries([...state.records]
                .filter(([key]) => key.startsWith("damageApplications.")).map(([key, value]) => [key.slice("damageApplications.".length), value]));
            return state.records.get(flag);
        },
        async setFlag(_scope, flag, value) {
            await Promise.resolve(); state.records.set(flag, merge(state.records.get(flag), value));
        },
        async update(updates) {
            for (const [path, value] of Object.entries(updates)) {
                if (path.startsWith("flags.pf2e-pending-damage.")) state.records.set(path.slice("flags.pf2e-pending-damage.".length), value);
                else if (path.startsWith("flags.pf2e-toolbelt.targetHelper.applied.")) {
                    const [target, index] = path.slice("flags.pf2e-toolbelt.targetHelper.applied.".length).split(".");
                    (state.applied[target] ??= {})[index] = value;
                }
            }
        },
    };
    const context = vm.createContext({
        console: { error: (...args) => client.errors.push(args) },
        Date: class extends Date { static now() { return state.now; } },
        setTimeout: (callback, ms) => {
            const id = ++state.nextTimer; state.timers.set(id, { callback, at: state.now + ms }); return id;
        }, clearTimeout: id => state.timers.delete(id),
        foundry: { utils: { randomID: () => `request${++state.nextId}` }, applications: { api: {
            DialogV2: { confirm: async () => { client.dialogs++; return client.confirm(); } },
        } } },
        game: {
            user: { ...user, get isActiveGM() { return id === state.activeGM; } },
            users: { get: id => state.users.find(u => u.id === id), get activeGM() { return state.users.find(u => u.id === state.activeGM); } },
            messages: new Map([[message.id, message]]),
            socket: {
                on: (_channel, callback) => { client.listener = callback; },
                emit: (_channel, packet) => {
                    if (state.dropPacket(packet, id)) return;
                    for (const peer of state.clients) if (peer.id !== id) queueMicrotask(() => peer.listener?.(structuredClone(packet), id));
                },
            },
        },
        fromUuid: async uuid => client.tokens.get(uuid), fromUuidSync: uuid => client.tokens.get(uuid),
        document: { createElement: () => ({ textContent: "", get outerHTML() { return `<p>${this.textContent}</p>`; } }) },
        ui: { notifications: { error: error => client.errors.push(error) } },
    });
    vm.runInContext(code, context);
    const tool = { localize: key => key, getMessageData: data,
        pendingDamage: { shake: () => client.shakes++ },
        markDamageApplied: (...args) => vm.runInContext("markDamageApplied", context)(...args),
    };
    client.guard = new context.Guard(tool);
    client.guard.activate();
    client.apply = fn => client.guard.run(message, token, 0, fn, true);
    client.pendingApply = fn => client.guard.run(message, token, 0, fn);
    state.clients.push(client);
    return client;
}
