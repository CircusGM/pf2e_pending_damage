import { MODULE_ID, PACKET, PROTOCOL, SOCKET, visibleTo } from "./constants.js";
import { SessionCoordinator, gmRecipients } from "./coordinator.js";
import { LEASE, claimStatus, claimsOf, recordKey } from "./records.js";
import { applicationFootprint, isDamageApplied } from "./toolbelt-adapter.js";

const DUPLICATE_INTERVAL = 2e3;
const RETRY_INTERVAL = 1e3;
const REQUEST_TIMEOUT = 20e3;
// A grant older than this on arrival is withdrawn rather than used, leaving PF2e
// at least half the lease to apply it. Slow links get a few fresh attempts.
const GRANT_AGE = LEASE / 2;
const ATTEMPTS = 3;
const RELEASE_TIMEOUT = 10 * 60e3;
const SUSPECT_AFTER = 3;
// Claims sent longer ago are answered "slow" rather than acted on, so a frozen
// coordinator does not work through its backlog. Safety does not depend on it.
const STALE = 3e3;

class SyncError extends Error {
    constructor(code, sent = false) { super(`Damage synchronization failed: ${code}`); this.code = code; this.sent = sent; }
}

// Claim -> apply -> release. The coordinating GM session serializes claims per
// message in an append-only log; the clicking client changes HP through PF2e.
// Requests are retried until answered, but HP callbacks never are.
class DamageApplicationGuard {
    constructor(tool) {
        this.tool = tool;
    }
    coordinator = new SessionCoordinator();
    #queues = new Map();
    #inflight = new Map();
    #watched = new Map();
    #withdrawn = new Set();
    #answered = new Map();
    #clicks = new Set();
    #requests = new Map();
    activate() {
        this.coordinator.activate();
        game.socket.on(SOCKET, this.#onSocket);
    }
    async run(message, token, rollIndex, { apply, verify = () => null, allowRepeat = false }) {
        const key = `${message.id}.${token.uuid}.${rollIndex}`;
        if (this.#clicks.has(key)) {
            this.tool.pendingDamage.shake();
            return false;
        }
        this.#clicks.add(key);
        const target = { messageId: message.id, tokenUuid: token.uuid, rollIndex };
        if (this.tool.protected === false) {
            try { return await this.#applyDirectly(token, apply, verify); }
            finally { this.#clicks.delete(key); }
        }
        try {
            let repeatOf, attempts = 0;
            while (true) {
                const id = foundry.utils.randomID();
                let reply;
                try {
                    reply = await this.#request({ ...target, operation: "claim", id, allowRepeat, repeatOf });
                } catch (error) {
                    // The coordinator may still grant this claim after we stop waiting.
                    if (error.sent !== false) void this.#release(target, id, "abandoned");
                    throw error;
                }
                if (reply.status === "confirm") {
                    if (!await this.#confirm(token, reply)) return false;
                    repeatOf = reply.basis;
                    continue;
                }
                // A grant that arrives late, or expired before its reply got through,
                // is withdrawn so it cannot block the target, then claimed afresh.
                const late = reply.status === "granted" ? game.time.serverTime - reply.grantedAt > GRANT_AGE
                    : reply.status === "blocked" && reply.reason === "stale";
                if (late) {
                    await this.#settle(target, id, "abandoned");
                    if (++attempts < ATTEMPTS) continue;
                    throw new SyncError("slow");
                }
                if (reply.status !== "granted") {
                    this.#explain(token, reply);
                    return false;
                }
                const problem = verify();
                if (problem) {
                    await this.#settle(target, id, "abandoned");
                    ui.notifications.warn(problem);
                    return false;
                }
                try {
                    await apply();
                } catch (error) {
                    console.error("PF2e Pending Damage | Damage application failed", error);
                    // Errors before PF2e's actor update leave HP untouched: no attempt to record.
                    await this.#settle(target, id, error.untouched ? "abandoned" : "failed", error);
                    ui.notifications.error(error.untouched ? this.tool.localize("sync.invalid", { target: token.name, error: error.message })
                        : this.tool.localize("sync.failed", { target: token.name, error: error.message }));
                    return false;
                }
                if (!await this.#settle(target, id, "applied")) {
                    ui.notifications.warn(this.tool.localize("sync.unrecorded", { target: token.name }));
                }
                return true;
            }
        } catch (error) {
            console.error("PF2e Pending Damage | Damage synchronization failed", error);
            ui.notifications.error(error.code === "noGM" ? this.tool.localize("sync.noGM")
                : error.code === "timeout" ? this.tool.localize("sync.timeout")
                : error.code === "slow" ? this.tool.localize("sync.slow")
                : this.tool.localize("sync.error", { error: error.message }));
            return false;
        } finally {
            this.#clicks.delete(key);
        }
    }
    // Duplicate protection is off: no GM, claim or record is involved.
    async #applyDirectly(token, apply, verify) {
        const problem = verify();
        if (problem) {
            ui.notifications.warn(problem);
            return false;
        }
        try {
            await apply();
            return true;
        } catch (error) {
            console.error("PF2e Pending Damage | Damage application failed", error);
            ui.notifications.error(error.untouched ? this.tool.localize("sync.invalid", { target: token.name, error: error.message })
                : this.tool.localize("sync.error", { error: error.message }));
            return false;
        }
    }
    // Waits for the outcome to be recorded, but leaves a slow release running.
    async #settle(target, claimId, outcome, error) {
        let timer;
        const recorded = await Promise.race([this.#release(target, claimId, outcome, error),
            new Promise(resolve => { timer = setTimeout(resolve, REQUEST_TIMEOUT, false); })]);
        clearTimeout(timer);
        return recorded;
    }
    // Releases retry for minutes, even across GM reloads: a lost "applied" report
    // would otherwise leave the claim uncertain.
    #release(target, claimId, outcome, error) {
        const packet = { ...target, operation: "release", id: foundry.utils.randomID(), claimId, outcome,
            error: error ? String(error.message ?? error).slice(0, 300) : null };
        return this.#request(packet, { timeout: RELEASE_TIMEOUT, waitForGM: true }).then(reply => reply.status === "ok", error => {
            console.error("PF2e Pending Damage | Could not record a damage application", error);
            return false;
        });
    }
    #confirm(token, reply) {
        const user = game.users.get(reply.userId)?.name;
        const data = { target: token.name, user: user ?? this.tool.localize("sync.someone") };
        const content = document.createElement("p");
        content.textContent = reply.reason === "failed" ? this.tool.localize("repeat.failed", data)
            : reply.reason === "uncertain" ? this.tool.localize("repeat.uncertain", data)
            : user ? this.tool.localize("repeat.applied", data) : this.tool.localize("repeat.content", data);
        const detail = document.createElement("p");
        detail.textContent = reply.error ?? "";
        return foundry.applications.api.DialogV2.confirm({
            window: { title: this.tool.localize("repeat.title") },
            content: content.outerHTML + (reply.error ? detail.outerHTML : ""),
            yes: { default: false },
            no: { default: true },
            rejectClose: false
        });
    }
    #explain(token, reply) {
        this.tool.pendingDamage.shake();
        const data = { target: token.name, user: game.users.get(reply.userId)?.name ?? this.tool.localize("sync.someone") };
        if (reply.status === "blocked") {
            // Repeated clicks by the same user only shake.
            if (reply.reason === "recent" && reply.userId === game.user.id) return;
            if (reply.reason === "busy") ui.notifications.info(this.tool.localize("sync.busy", data));
            else if (reply.reason === "changed") ui.notifications.info(this.tool.localize("sync.superseded", data));
            else if (["failed", "uncertain"].includes(reply.reason)) ui.notifications.warn(this.tool.localize("sync.interrupted", data));
            else ui.notifications.info(this.tool.localize("sync.applied", data));
        } else if (reply.status === "denied") {
            ui.notifications.error(reply.reason === "notOwner" ? this.tool.localize("sync.notOwner", data)
                : reply.reason === "hidden" ? this.tool.localize("sync.hidden", data) : this.tool.localize("sync.missing", data));
        } else if (reply.status === "version") {
            ui.notifications.error(this.tool.localize("sync.version"));
        } else {
            ui.notifications.error(this.tool.localize("sync.error", { error: reply.error ?? reply.status }));
        }
    }
    #request(packet, { timeout = REQUEST_TIMEOUT, waitForGM = false } = {}) {
        if (!waitForGM && !gmRecipients().length) return Promise.reject(new SyncError("noGM", false));
        const request = { ...packet, __type__: PACKET, v: PROTOCOL, kind: "request", from: this.coordinator.sessionId };
        return new Promise((resolve, reject) => {
            let retry, sends = 0, slow = false;
            const settle = (callback, value) => {
                if (!this.#requests.delete(request.id)) return;
                clearTimeout(timer);
                clearTimeout(retry);
                callback(value);
            };
            const send = () => {
                if (!this.#requests.has(request.id)) return;
                retry = setTimeout(send, RETRY_INTERVAL);
                request.sentAt = game.time.serverTime;
                if (this.coordinator.isCoordinator() && game.socket.connected !== false) {
                    sends++;
                    void this.#serve(request, game.user.id).then(reply => reply && settle(resolve, reply), error => settle(reject, error));
                    return;
                }
                // Socket.IO buffers disconnected emits; retries must not build a backlog.
                const recipients = gmRecipients();
                if (game.socket.connected === false || !recipients.length) return;
                if (++sends === SUSPECT_AFTER || sends % 10 === 0) this.coordinator.suspect();
                try {
                    game.socket.emit(SOCKET, request, { recipients });
                } catch (error) {
                    settle(reject, error);
                }
            };
            const timer = setTimeout(() => settle(reject, new SyncError(slow ? "slow" : gmRecipients().length ? "timeout" : "noGM", sends > 0)), timeout);
            // "slow" describes one stale copy; a fresher retry may still be answered.
            this.#requests.set(request.id, { resolve: reply => reply.status === "slow" ? slow = true : settle(resolve, reply) });
            send();
        });
    }
    #onSocket = (packet, userId) => {
        if (packet?.__type__ !== PACKET) return;
        if (packet.kind === "reply") {
            if (packet.to === this.coordinator.sessionId) this.#requests.get(packet.id)?.resolve(packet);
            return;
        }
        if (packet.kind !== "request" || !game.user.isGM || typeof packet.id !== "string" ||
            typeof packet.from !== "string" || packet.from === this.coordinator.sessionId) return;
        if (!this.coordinator.isCoordinator()) {
            this.#watch(packet);
            return;
        }
        // A retry of a queued request is answered when the original finishes.
        if (this.#inflight.has(`${userId}:${packet.id}`)) return;
        void this.#serve(packet, userId).then(reply => {
            if (reply && game.socket.connected !== false) {
                game.socket.emit(SOCKET, { ...reply, to: packet.from }, { recipients: [userId] });
            }
        }).catch(error => console.error("PF2e Pending Damage | Could not reply to damage request", error));
    };
    // Every GM session sees every request. Repeated retries mean the coordinator
    // has not answered, so check that it is still there.
    #watch(packet) {
        const count = (this.#watched.get(packet.id) ?? 0) + 1;
        this.#watched.set(packet.id, count);
        if (this.#watched.size > 500) this.#watched.delete(this.#watched.keys().next().value);
        if (count === SUSPECT_AFTER || count % 10 === 0) this.coordinator.suspect();
    }
    #serve(request, userId) {
        if (request.v !== PROTOCOL) return Promise.resolve(this.#reply(request, "version"));
        if (typeof request.messageId !== "string") return Promise.resolve(null);
        // Recording an outcome is safe whenever it arrives; a claim is not.
        if (request.operation === "claim" && game.time.serverTime - request.sentAt > STALE) return Promise.resolve(this.#reply(request, "slow"));
        // One queued operation per request, however often it is retried. A retry that
        // crosses a refusal gets the same refusal, not a grant nobody will use.
        const key = `${userId}:${request.id}`;
        if (this.#inflight.has(key)) return this.#inflight.get(key);
        if (this.#answered.has(key)) return Promise.resolve(this.#answered.get(key));
        // Claims only overlap within a message. A slow document write must not hold
        // up unrelated rolls, but the same message must remain serialized.
        const queue = this.#queues.get(request.messageId) ?? Promise.resolve();
        const result = queue.then(() => this.#handle(request, userId)).then(reply => {
            if (reply && reply.status !== "granted") this.#answered.set(key, reply);
            if (this.#answered.size > 500) this.#answered.delete(this.#answered.keys().next().value);
            return reply;
        });
        const tail = result.catch(() => {}).finally(() => {
            if (this.#queues.get(request.messageId) === tail) this.#queues.delete(request.messageId);
            this.#inflight.delete(key);
        });
        this.#queues.set(request.messageId, tail);
        this.#inflight.set(key, result);
        return result;
    }
    #reply(request, status, data = {}) {
        return { __type__: PACKET, v: PROTOCOL, kind: "reply", id: request.id, status, ...data };
    }
    async #handle(request, userId) {
        const reply = (status, data) => this.#reply(request, status, data);
        try {
            // Leadership may have moved while this request was queued.
            const user = game.users.get(userId);
            if (!this.coordinator.isCoordinator() || !user?.active) return null;
            const message = game.messages.get(request.messageId);
            if (request.operation === "release") return await this.#finish(request, user, message, reply);
            if (request.operation !== "claim") return reply("error", { error: "unknown operation" });
            const token = typeof request.tokenUuid === "string" ? await fromUuid(request.tokenUuid) : null;
            if (!message || !message.isDamageRoll || token?.documentName !== "Token" || !token.actor ||
                !Number.isInteger(request.rollIndex) || request.rollIndex < 0 || !message.rolls.at(request.rollIndex)) {
                return reply("denied", { reason: "missing" });
            }
            if (!visibleTo(message, user)) return reply("denied", { reason: "hidden" });
            if (!(user.isGM || token.actor.testUserPermission(user, "OWNER"))) return reply("denied", { reason: "notOwner" });
            return await this.#claim(request, user, message, token, reply);
        } catch (error) {
            console.error("PF2e Pending Damage | Damage claim failed", error);
            return reply("error", { error: error.message });
        }
    }
    async #claim(request, user, message, token, reply) {
        // Decide from the server's copy: this session may have missed broadcasts.
        const current = await this.#fetch(message);
        if (!current) return reply("denied", { reason: "missing" });
        // Server time is shared by every client, whatever their clocks say.
        const now = game.time.serverTime;
        const key = recordKey(token.uuid, request.rollIndex);
        const claims = claimsOf(current);
        const own = claims.find(claim => claim.id === request.id);
        if (own) {
            return claimStatus(own, now) === "active" && own.userId === user.id ? reply("granted", { grantedAt: own.at }) : reply("blocked", { reason: "stale" });
        }
        if (this.#withdrawn.has(request.id)) return reply("blocked", { reason: "stale" });
        // Main/splash rolls can consume one another, so their claims must conflict too.
        const footprint = applicationFootprint(current, token, request.rollIndex);
        const overlaps = claim => claim.key === key || claim.footprint?.some(k => footprint.includes(k));
        const busy = claims.find(claim => claimStatus(claim, now) === "active" && overlaps(claim));
        if (busy) return reply("blocked", { reason: "busy", userId: busy.userId });
        // History: this roll's own claims, and interrupted or failed claims on a roll it shares HP with.
        const latest = claims.filter(claim => claim.key === key ? claimStatus(claim, now)
            : ["failed", "uncertain"].includes(claimStatus(claim, now)) && overlaps(claim))
            .sort((a, b) => (Number(!a.legacy) - Number(!b.legacy)) || (a.at - b.at) || (a.id < b.id ? -1 : 1)).at(-1);
        const status = latest && claimStatus(latest, now);
        const since = latest && now - (latest.doneAt ?? latest.at);
        if (since >= 0 && since < DUPLICATE_INTERVAL) {
            return reply("blocked", { reason: status === "applied" ? "recent" : status, userId: latest.userId });
        }
        // Toolbelt's own flag, or a completed claim on a roll that consumed this one.
        const basis = latest?.id ?? (isDamageApplied(current, token, request.rollIndex) ? "legacy" : null);
        if (basis) {
            const history = { reason: status ?? "applied", userId: latest?.userId ?? null, error: latest?.error ?? null };
            if (!user.isGM || !request.allowRepeat) return reply("blocked", history);
            if (request.repeatOf !== basis) return request.repeatOf ? reply("blocked", { ...history, reason: "changed" }) : reply("confirm", { ...history, basis });
        }
        const path = `flags.${MODULE_ID}.applications.${key}.${request.id}`;
        await message.update({ [path]: { userId: user.id, at: now, footprint, basis } });
        // The server orders reads after the writes before them. Of two sessions granting
        // at once, at most one reads no rival written since its first read; it may be neither.
        const seen = new Set(claims.map(claim => claim.id));
        const after = await this.#fetch(message);
        const rival = after ? claimsOf(after).find(claim => claim.id !== request.id && !seen.has(claim.id) && claim.state !== "void" && overlaps(claim)) : null;
        if (!after || rival) {
            await message.update({ [`${path}.outcome`]: "void", [`${path}.doneAt`]: game.time.serverTime });
            return rival ? reply("blocked", { reason: "busy", userId: rival.userId }) : reply("denied", { reason: "missing" });
        }
        return reply("granted", { grantedAt: now });
    }
    async #fetch(message) {
        const cls = message.constructor;
        const [current] = await cls.database.get(cls, { query: { _id: message.id } });
        return current ?? null;
    }
    async #finish(request, user, message, reply) {
        const current = message && await this.#fetch(message);
        const claim = current && claimsOf(current).find(claim => claim.id === request.claimId && !claim.legacy);
        if (!claim) {
            // Withdrawn before it was processed: refuse the claim if it arrives later.
            if (request.outcome === "abandoned") this.#withdrawn.add(request.claimId);
            if (this.#withdrawn.size > 500) this.#withdrawn.delete(this.#withdrawn.values().next().value);
            return reply("ok");
        }
        if (claim.userId !== user.id) return reply("denied", { reason: "notOwner" });
        if (typeof request.tokenUuid !== "string" || claim.key !== recordKey(request.tokenUuid, request.rollIndex)) {
            return reply("error", { error: "release does not match its claim" });
        }
        const state = { applied: "applied", failed: "failed", abandoned: "void" }[request.outcome];
        if (!state) return reply("error", { error: "unknown outcome" });
        if (claim.state !== "pending") return reply("ok");
        const path = `flags.${MODULE_ID}.applications.${claim.key}.${claim.id}`;
        const updates = { [`${path}.outcome`]: state, [`${path}.doneAt`]: game.time.serverTime, [`${path}.error`]: request.error ?? null };
        // An expired lease can still be completed: the applying client knows what happened.
        if (state === "applied") {
            await this.tool.markDamageApplied(message, request.tokenUuid.split(".").at(-1), request.rollIndex, updates);
        } else {
            await message.update(updates);
        }
        return reply("ok");
    }
}
export {
    DamageApplicationGuard
};
