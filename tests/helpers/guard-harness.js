import vm from "node:vm";
import { readFileSync } from "node:fs";

// Evaluate the real runtime modules in independent browser sessions. Sessions
// share only a simulated Foundry server: authoritative message flags, serialized
// writes broadcast to every session, and a socket relay that delivers to every
// session of each recipient user, as Foundry does.
const code = ["constants", "records", "toolbelt-adapter", "coordinator", "damage-guard"].map(name =>
    readFileSync(new URL(`../../scripts/${name}.js`, import.meta.url), "utf8")
        .replace(/^import [\s\S]*?;\n/gm, "").replace(/export \{[\s\S]*?\};/g, "")
        .replace(/export /g, "")).join("\n") + "\nglobalThis.Guard = DamageApplicationGuard;";

export const tokenUuid = "Scene.scene.Token.target";
export const state = {};
const ROLES = { gm: 4, gm2: 4, assistant: 3, player: 1, other: 1 };
export const flush = async (times = 5) => { for (let i = 0; i < times; i++) await new Promise(resolve => setImmediate(resolve)); };
export function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const clone = value => value === undefined ? undefined : structuredClone(value);
const isObject = value => value && typeof value === "object" && !Array.isArray(value);
function mergeAt(target, path, value) {
    const parts = path.split(".");
    const last = parts.pop();
    for (const part of parts) target = isObject(target[part]) ? target[part] : (target[part] = {});
    if (isObject(value) && isObject(target[last])) {
        for (const [key, inner] of Object.entries(value)) mergeAt(target[last], key, inner);
    } else target[last] = clone(value);
}
const getPath = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);
const applyFlags = (flags, updates) => {
    for (const [path, value] of Object.entries(updates)) if (path.startsWith("flags.")) mergeAt(flags, path.slice(6), value);
};

export function addMessage(id, data = {}) {
    state.docs.set(id, {
        data: { id, isDamageRoll: true, rolls: [{ total: 12 }, { total: 3 }], flags: { pf2e: {} },
            isContentVisible: true, whisper: [], blind: false, ...data },
        flags: { "pf2e-toolbelt": { targetHelper: { type: "damage", targets: [tokenUuid], splashTargets: [], splashIndex: -1, applied: {} } } },
    });
    for (const client of state.clients) client.addMessage(id);
}
export function reset() {
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, {
        now: 10_000, clients: [], timers: new Map(), nextTimer: 0, nextId: 0, packets: [], writes: [], docs: new Map(),
        dropPacket: () => false, beforeWrite: async () => {}, owners: new Set(["player"]), tokens: ["target"],
        users: Object.entries(ROLES).map(([id, role]) => ({ id, name: id, role, isGM: role >= 3,
            get active() { return state.clients.some(client => client.userId === id && client.connected); } })),
    });
    serverQueue = Promise.resolve();
    addMessage("message");
    state.message = state.docs.get("message").data;
    state.flags = state.docs.get("message").flags;
}
export const user = id => state.users.find(candidate => candidate.id === id);
export const records = (id = "message") => getPath(state.docs.get(id).flags, "pf2e-pending-damage.applications") ?? {};
export const claims = (id = "message") => Object.values(records(id)).flatMap(entries => Object.values(entries));
export const applied = (id = "message") => state.docs.get(id).flags["pf2e-toolbelt"].targetHelper.applied;

function timer(ms, callback) {
    const id = ++state.nextTimer;
    state.timers.set(id, { callback, at: state.now + ms });
    return id;
}
// Zero latency uses microtasks; otherwise packets wait for advance(). A frozen
// session (a blocked main thread) receives its deliveries and timers when it thaws.
const transmit = (ms, callback) => ms > 0 ? timer(ms, callback) : queueMicrotask(callback);
function deliver(client, ms, callback) {
    transmit(ms, () => client.frozen || client.backlog.length ? client.backlog.push(callback) : callback());
}
export async function advance(ms) {
    const until = state.now + ms;
    await flush();
    while (true) {
        const next = [...state.timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        state.now = Math.max(state.now, next[1].at);
        state.timers.delete(next[0]);
        next[1].callback();
        await flush();
    }
    state.now = until;
    await flush();
}

// Writes are applied in arrival order, then acknowledged and broadcast.
let serverQueue = Promise.resolve();
function write(client, id, updates) {
    const done = deferred();
    // beforeWrite models a slow round trip for one document, before the server's queue.
    const send = () => transmit(client.latency, async () => {
        await state.beforeWrite(client, updates, id);
        serverQueue = serverQueue.then(async () => {
            if (!state.docs.get(id) || !state.clients.includes(client)) return;
            state.writes.push({ session: client.label, id, at: state.now, updates: clone(updates) });
            applyFlags(state.docs.get(id).flags, updates);
            for (const peer of state.clients) {
                if (!peer.connected) continue;
                deliver(peer, peer.latency, () => {
                    applyFlags(peer.docs.get(id), updates);
                    if (peer === client) done.resolve();
                });
            }
        });
    });
    // Socket.IO buffers a disconnected client's emits and sends them on reconnect.
    if (client.connected) send();
    else client.buffered.push(send);
    return done.promise;
}
function read(client, id) {
    const done = deferred();
    const send = () => transmit(client.latency, () => {
        serverQueue = serverQueue.then(() => {
            const doc = state.docs.get(id);
            const copy = doc && Object.assign(Object.create(doc.data), { flags: clone(doc.flags) });
            if (copy) copy.getFlag = (scope, path) => clone(getPath(copy.flags[scope], path));
            deliver(client, client.latency, () => done.resolve(copy ? [copy] : []));
        });
    });
    if (client.connected) send();
    else client.buffered.push(send);
    return done.promise;
}
function relay(sender, channel, packet, options) {
    const targets = options?.recipients ? state.clients.filter(peer => options.recipients.includes(peer.userId))
        : state.clients.filter(peer => peer !== sender);
    for (const peer of targets) {
        if (!peer.connected) continue;
        deliver(peer, peer.latency, () => {
            if (peer.connected) for (const fn of peer.listeners.get(channel) ?? []) fn(clone(packet), sender.userId);
        });
    }
}
export function fireAll(name, ...args) {
    for (const client of state.clients) {
        if (!client.connected) continue;
        for (const fn of client.hooks.get(name) ?? []) client.frozen || client.backlog.length ? client.backlog.push(() => fn(...args)) : fn(...args);
    }
}

export function makeClient(userId, { label = userId, latency = 0, confirm = async () => true } = {}) {
    const self = user(userId);
    const client = { userId, label, latency, connected: true, frozen: false, backlog: [], buffered: [], shakes: 0,
        dialogs: 0, errors: [], notes: [], confirm, listeners: new Map(), hooks: new Map(), pagehide: [],
        docs: new Map(), messages: new Map(), tokens: new Map() };
    for (const id of state.tokens) {
        const uuid = `Scene.scene.Token.${id}`;
        client.tokens.set(uuid, { id, uuid, documentName: "Token", name: id, parent: { id: "scene" }, isOwner: false,
            actor: { uuid: `Actor.${id}`, get isOwner() { return self.isGM || state.owners.has(userId); },
                testUserPermission: candidate => candidate.isGM || state.owners.has(candidate.id) } });
    }
    client.token = client.tokens.get(tokenUuid);
    client.addMessage = id => {
        const doc = state.docs.get(id);
        client.docs.set(id, clone(doc.flags));
        const message = Object.create(doc.data);
        Object.assign(message, {
            constructor: { database: { get: () => read(client, id) } },
            getFlag: (scope, path) => clone(getPath(client.docs.get(id)[scope], path)),
            setFlag: (scope, path, value) => write(client, id, { [`flags.${scope}.${path}`]: value }),
            update: updates => write(client, id, updates),
        });
        client.messages.set(id, message);
    };
    for (const id of state.docs.keys()) client.addMessage(id);
    client.message = client.messages.get("message");
    const view = u => ({ id: u.id, name: u.name, role: u.role, isGM: u.isGM,
        get active() { return client.connected || !client.snapshot ? u.active : client.snapshot.get(u.id); } });
    const views = new Map(state.users.map(u => [u.id, view(u)]));
    const users = {
        get: id => views.get(id), filter: fn => [...views.values()].filter(fn), find: fn => [...views.values()].find(fn),
        [Symbol.iterator]: () => views.values(),
    };
    client.socket = {
        get connected() { return client.connected; },
        on: (channel, fn) => { if (!client.listeners.has(channel)) client.listeners.set(channel, []); client.listeners.get(channel).push(fn); },
        emit: (channel, packet, options) => {
            state.packets.push({ sender: userId, session: label, packet: clone(packet), recipients: options?.recipients });
            if (!client.connected || state.dropPacket(packet, client)) return;
            const copy = clone(packet);
            transmit(client.latency, () => relay(client, channel, copy, options));
        },
    };
    const context = vm.createContext({
        console: { error: (...args) => client.errors.push(args) },
        // clockSkew moves only this machine's wall clock; skew also moves its server-time estimate.
        Date: class extends Date { static now() { return state.now + (client.skew ?? 0) + (client.clockSkew ?? 0); } },
        performance: { now: () => state.now },
        setTimeout: (callback, ms, ...args) => timer(ms ?? 0, () => client.frozen || client.backlog.length
            ? client.backlog.push(() => callback(...args)) : callback(...args)),
        clearTimeout: id => state.timers.delete(id),
        addEventListener: (event, fn) => { if (event === "pagehide") client.pagehide.push(fn); },
        Hooks: { on: (name, fn) => { if (!client.hooks.has(name)) client.hooks.set(name, []); client.hooks.get(name).push(fn); } },
        foundry: { utils: { randomID: () => `id${String(++state.nextId).padStart(14, "0")}` }, applications: { api: {
            DialogV2: { confirm: async options => { client.dialogs++; client.lastDialog = options; return client.confirm(options); } },
        } } },
        game: {
            user: views.get(userId), users, socket: client.socket, messages: client.messages,
            time: { get serverTime() { return state.now + (client.skew ?? 0); }, get averageLatency() { return client.latency; } },
            i18n: Object.fromEntries(["localize", "format"].map(fn => [fn, key => key.replace(/^pf2e-pending-damage\./, "")])),
        },
        fromUuid: async uuid => client.tokens.get(uuid), fromUuidSync: uuid => client.tokens.get(uuid),
        document: { createElement: () => ({ textContent: "", get outerHTML() { return `<p>${this.textContent}</p>`; } }) },
        ui: { notifications: Object.fromEntries(["info", "warn", "error"].map(level => [level, text => client.notes.push([level, text])])) },
    });
    vm.runInContext(code, context);
    const tool = { localize: key => key, pendingDamage: { shake: () => client.shakes++ },
        markDamageApplied: (...args) => vm.runInContext("markDamageApplied", context)(...args) };
    client.guard = new context.Guard(tool);
    client.run = (fn, options = {}, { rollIndex = 0, token = client.token, message = client.message } = {}) =>
        client.guard.run(message, token, rollIndex, { apply: fn, allowRepeat: true, ...options });
    client.apply = (fn, options) => client.run(fn, options);
    client.pendingApply = (fn, options) => client.run(fn, { allowRepeat: false, ...options });
    client.noted = key => client.notes.some(([, text]) => text === key);
    // A lost connection: the session keeps running on its last view and comes back with reconnect().
    client.disconnect = () => {
        client.snapshot = new Map(state.users.map(u => [u.id, u.active]));
        client.connected = false;
        if (!self.active) fireAll("userConnected", self, false);
    };
    // Closing a tab fires pagehide; a crash does not.
    client.close = ({ graceful = true } = {}) => {
        if (graceful) for (const fn of client.pagehide) fn();
        client.connected = false;
        if (!self.active) fireAll("userConnected", self, false);
    };
    client.reconnect = () => {
        const wasActive = self.active;
        client.connected = true;
        client.snapshot = null;
        for (const send of client.buffered.splice(0)) send();
        if (!wasActive) fireAll("userConnected", self, true);
        for (const fn of client.listeners.get("connect") ?? []) fn();
    };
    client.freeze = () => { client.frozen = true; };
    // Runs fn as a task of this session: after its backlog when frozen.
    client.later = fn => client.frozen ? client.backlog.push(fn) : fn();
    // A thawed browser runs each queued event in order as its own task, with promise
    // jobs between them; events arriving meanwhile wait behind the backlog.
    client.thaw = async () => {
        client.frozen = false;
        while (client.backlog.length) { client.backlog[0](); client.backlog.shift(); await flush(); }
    };
    const wasActive = self.active;
    state.clients.push(client);
    if (!wasActive) fireAll("userConnected", self, true);
    client.guard.activate();
    return client;
}

// Joins sessions in order and lets the coordinator election settle.
export async function join(...ids) {
    const clients = [];
    for (const id of ids) { clients.push(makeClient(id)); await flush(); }
    await advance(5000);
    return clients;
}

// Advances virtual time until a promise settles.
export async function until(promise, ms = 60_000) {
    let done = false, value, error, failed = false;
    promise.then(v => { done = true; value = v; }, e => { done = true; failed = true; error = e; });
    for (let waited = 0; !done && waited < ms; waited += 100) await advance(100);
    if (!done) throw new Error(`still pending after ${ms} ms`);
    if (failed) throw error;
    return value;
}
export const sleep = ms => new Promise(resolve => timer(ms, resolve));
