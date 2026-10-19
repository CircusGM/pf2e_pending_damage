import { PACKET, PROTOCOL, SOCKET, localize } from "./constants.js";

// A session coordinates only after holding the role this long: on joining, it must
// hear from older sessions first; on a takeover, it exceeds the guard's stale-request
// limit plus a write's round trip, so a frozen predecessor's last writes arrive first.
const SETTLE = 5e3;
const PONG_TIMEOUT = 3e3;
const RELAY_CHECK = 10e3;

export const gmRecipients = () => game.users.filter(user => user.active && user.isGM).map(user => user.id);

// Elects one GM browser session to serialize claims. Foundry allows a GM account
// to connect several times, and every such session is game.user.isActiveGM.
// Sessions rank by role, then by when they joined, so a newcomer never preempts
// a working coordinator. Liveness is checked on demand: a hidden tab still answers
// socket pings while its timers are throttled.
export class SessionCoordinator {
    sessionId = foundry.utils.randomID(16);
    #peers = new Map();
    #since = 0;
    #leaderId = null;
    #leaderAt = 0;
    #ping = null;
    #echoed = false;
    #relayCheck = null;

    activate() {
        game.socket.on(SOCKET, this.#onSocket);
        if (!game.user.isGM) return;
        Hooks.on("userConnected", (user, active) => {
            if (!active) for (const peer of this.#peers.values()) if (peer.userId === user.id) this.#peers.delete(peer.sessionId);
            this.#refresh();
        });
        // A reconnecting session may have been replaced while it was away.
        game.socket.on("connect", () => this.#announce());
        globalThis.addEventListener?.("pagehide", () => this.#send({ kind: "bye" }));
        this.#announce();
    }

    get leader() {
        const sessions = [...this.#peers.values()];
        if (game.user.isGM) sessions.push({ sessionId: this.sessionId, userId: game.user.id, since: this.#since });
        let best = null;
        for (const session of sessions) {
            const user = game.users.get(session.userId);
            if (!user?.active || !user.isGM) continue;
            const rank = best && ((user.role - game.users.get(best.userId).role) || (best.since - session.since) ||
                (session.sessionId < best.sessionId ? 1 : -1));
            if (!best || rank > 0) best = session;
        }
        return best;
    }

    // Durations use the monotonic clock: a wall-clock step must not stall the role.
    isCoordinator(now = performance.now()) {
        this.#refresh(now);
        return this.#leaderId === this.sessionId && now - this.#leaderAt >= SETTLE;
    }

    // Called when requests to the coordinator go unanswered.
    suspect() {
        const leader = this.leader;
        if (!game.user.isGM || !leader || leader.sessionId === this.sessionId || this.#ping) return;
        const nonce = foundry.utils.randomID();
        const timer = setTimeout(() => {
            if (this.#ping?.nonce !== nonce) return;
            this.#ping = null;
            this.#peers.delete(leader.sessionId);
            this.#refresh();
            this.#send({ kind: "gone", target: leader.sessionId });
        // A session on a slow link allows for its own round trip.
        }, PONG_TIMEOUT + 4 * (game.time.averageLatency || 0));
        this.#ping = { nonce, timer };
        this.#send({ kind: "ping", to: leader.sessionId, nonce }, [leader.userId]);
    }

    #refresh(now = performance.now()) {
        const leader = this.leader?.sessionId ?? null;
        if (leader !== this.#leaderId) { this.#leaderId = leader; this.#leaderAt = now; }
    }

    #announce() {
        this.#since = game.time.serverTime;
        this.#leaderId = null;
        this.#refresh();
        this.#send({ kind: "presence", since: this.#since, hello: true });
        // The server echoes the hello to this session. Foundry only relays sockets of
        // modules installed when the world launched, so a new install needs a relaunch.
        clearTimeout(this.#relayCheck);
        if (this.#echoed) return;
        this.#relayCheck = setTimeout(() => {
            if (!this.#echoed && game.socket.connected !== false) ui.notifications.error(localize("socketUnavailable"), { permanent: true });
        }, RELAY_CHECK);
    }

    #send(packet, recipients = gmRecipients()) {
        if (game.socket.connected === false || !recipients.length) return;
        try {
            game.socket.emit(SOCKET, { ...packet, __type__: PACKET, v: PROTOCOL, from: this.sessionId }, { recipients });
        } catch (error) {
            console.error("PF2e Pending Damage | Could not reach other GM sessions", error);
        }
    }

    #onSocket = (packet, userId) => {
        if (packet?.__type__ !== PACKET || packet.v !== PROTOCOL || !game.user.isGM) return;
        if (packet.from === this.sessionId) {
            this.#echoed = true;
            clearTimeout(this.#relayCheck);
            return;
        }
        if (typeof packet.from !== "string" || !game.users.get(userId)?.isGM) return;
        if (packet.to && packet.to !== this.sessionId) return;
        switch (packet.kind) {
            case "presence":
                this.#peers.set(packet.from, { sessionId: packet.from, userId, since: Number(packet.since) || 0 });
                if (packet.hello) this.#send({ kind: "presence", since: this.#since }, [userId]);
                break;
            case "bye": this.#peers.delete(packet.from); break;
            case "ping": this.#send({ kind: "pong", to: packet.from, nonce: packet.nonce }, [userId]); break;
            case "pong":
                if (packet.nonce === this.#ping?.nonce) { clearTimeout(this.#ping.timer); this.#ping = null; }
                break;
            case "gone":
                // Declared unresponsive while still running: rejoin as the newest session.
                if (packet.target === this.sessionId) this.#announce();
                else this.#peers.delete(packet.target);
                break;
            default: return;
        }
        this.#refresh();
    };
}
