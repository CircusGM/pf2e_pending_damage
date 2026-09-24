import { MODULE_ID, SOCKET, visibleTo } from "./constants.js";
import { applicationFootprint, isDamageApplied } from "./toolbelt-adapter.js";

const SOCKET_TYPE = "damageGuard.v1";
const DUPLICATE_INTERVAL = 2e3;
const REQUEST_RETRY_INTERVAL = 1e3;
const REQUEST_TIMEOUT = 15e3;
// Reserve -> start -> complete. Requests may be replayed, but HP callbacks never
// are. A started claim cannot expire: a disconnected client may have changed HP.
class DamageApplicationGuard {
  constructor(tool) {
    this.tool = tool;
  }
  #queues = new Map();
  #incoming = new Set();
  #clicks = /* @__PURE__ */ new Set();
  #requests = /* @__PURE__ */ new Map();
  activate() {
    game.socket.on(SOCKET, this.#onSocket);
  }
  async run(message, token, rollIndex, apply, allowRepeat = false) {
    const key = `${message.id}.${token.uuid}.${rollIndex}`;
    if (this.#clicks.has(key)) {
      this.tool.pendingDamage.shake();
      return false;
    }
    this.#clicks.add(key);
    try {
      let confirmation;
      while (true) {
        const reply = await this.#request({
          operation: "claim",
          messageId: message.id,
          tokenUuid: token.uuid,
          rollIndex,
          confirmation,
          allowRepeat
        });
        if (reply.status === "blocked") {
          this.tool.pendingDamage.shake();
          return false;
        }
        if (reply.status === "confirm") {
          const content = document.createElement("p");
          content.textContent = this.tool.localize("repeat.content", { target: token.name });
          const accepted = await foundry.applications.api.DialogV2.confirm({
            window: { title: this.tool.localize("repeat.title") },
            content: content.outerHTML,
            yes: { default: false },
            no: { default: true },
            rejectClose: false
          });
          if (!accepted)
            return false;
          confirmation = reply.claimId;
          continue;
        }
        if (reply.status !== "granted" || !reply.claimId)
          throw new Error("Damage claim was not granted");
        const finish = (operation) => this.#request({
          operation,
          messageId: message.id,
          tokenUuid: token.uuid,
          rollIndex,
          claimId: reply.claimId
        }, reply.gmId);
        const started = await this.#request({
          operation: "start",
          messageId: message.id,
          tokenUuid: token.uuid,
          rollIndex,
          claimId: reply.claimId
        }, reply.gmId);
        if (started.status === "blocked") {
          this.tool.pendingDamage.shake();
          return false;
        }
        if (started.status !== "granted")
          throw new Error("Damage start was not acknowledged");
        try {
          await apply();
        } catch (error) {
          await finish("failed");
          throw error;
        }
        const completed = await finish("complete");
        if (completed.status !== "applied")
          throw new Error("Damage completion was not acknowledged");
        return true;
      }
    } catch (error) {
      console.error("PF2e Pending Damage | Damage synchronization failed", error);
      ui.notifications.error(this.tool.localize("repeat.unavailable"));
      return false;
    } finally {
      this.#clicks.delete(key);
    }
  }
  #request(options, gmId = game.users.activeGM?.id) {
    if (!gmId)
      return Promise.reject(new Error("No active GM available"));
    const request = { ...options, __type__: SOCKET_TYPE, kind: "request", id: foundry.utils.randomID(), gmId };
    return new Promise((resolve, reject) => {
      let retry, timeout;
      const settle = (callback, value) => {
        if (!this.#requests.delete(request.id)) return;
        clearTimeout(timeout);
        clearTimeout(retry);
        callback(value);
      };
      const send = () => {
        if (!this.#requests.has(request.id)) return;
        retry = setTimeout(send, REQUEST_RETRY_INTERVAL);
        // Socket.IO buffers disconnected emits; retries must not build a backlog.
        if (game.socket.connected === false) return;
        try {
          game.socket.emit(SOCKET, request, { recipients: [gmId] });
        } catch (error) {
          settle(reject, error);
        }
      };
      timeout = setTimeout(() => settle(reject, new Error("Damage synchronization timed out")), REQUEST_TIMEOUT);
      this.#requests.set(request.id, {
        gmId,
        resolve: (reply) => settle(resolve, reply)
      });
      if (game.user.id === gmId && game.user.isActiveGM) {
        void this.#enqueue(request, game.user.id).then(reply => settle(resolve, reply), error => settle(reject, error));
      } else send();
    });
  }
  #onSocket = (packet, userId) => {
    if (packet?.__type__ !== SOCKET_TYPE)
      return;
    if (packet.kind === "reply") {
      const pending = this.#requests.get(packet.id);
      if (!pending || packet.userId !== game.user.id || pending.gmId !== userId)
        return;
      pending.resolve(packet);
    } else if (packet.kind === "request" && game.user.isActiveGM && packet.gmId === game.user.id) {
      if (typeof packet.id !== "string" || typeof packet.messageId !== "string" || !game.users.get(userId)?.active) return;
      const key = `${userId}:${packet.id}`;
      // One queued operation and one reply per in-flight request, including retries.
      if (this.#incoming.has(key)) return;
      this.#incoming.add(key);
      void this.#enqueue(packet, userId)
        .then(reply => {
          if (game.socket.connected !== false) game.socket.emit(SOCKET, reply, { recipients: [userId] });
        })
        .catch(error => console.error("PF2e Pending Damage | Could not reply to damage request", error))
        .finally(() => this.#incoming.delete(key));
    }
  };
  #enqueue(request, userId) {
    // Claims only overlap within a message. A slow document write must not hold
    // up unrelated rolls, but the same message must remain serialized.
    const queue = this.#queues.get(request.messageId) ?? Promise.resolve();
    const result = queue.then(() => this.#handleRequest(request, userId));
    const tail = result.catch(() => {}).finally(() => {
      if (this.#queues.get(request.messageId) === tail) this.#queues.delete(request.messageId);
    });
    this.#queues.set(request.messageId, tail);
    return result;
  }
  async #handleRequest(request, userId) {
    const reply = (status, claimId) => ({
      __type__: SOCKET_TYPE,
      kind: "reply",
      id: request.id,
      userId,
      gmId: game.user.id,
      status,
      claimId
    });
    try {
      if (!game.user.isActiveGM || request.gmId !== game.user.id || !["claim", "start", "complete", "failed"].includes(request.operation))
        return reply("error");
      const user = game.users.get(userId);
      const message = game.messages.get(request.messageId);
      const token = await fromUuid(request.tokenUuid);
      if (!user?.active || !message || !visibleTo(message, user) || !message.isDamageRoll || !token?.actor || token.documentName !== "Token" || !Number.isInteger(request.rollIndex) || request.rollIndex < 0 || !message.rolls.at(request.rollIndex) || !(user.isGM || token.actor.testUserPermission(user, "OWNER")))
        return reply("error");
      const flag = `damageApplications.${token.uuid.replaceAll(".", "_")}_${request.rollIndex}`;
      let previous = message.getFlag(MODULE_ID, flag);
      const now = Date.now();
      const footprint = applicationFootprint(message, token, request.rollIndex);
      // Main/splash rolls can consume one another, so their reservations must
      // conflict too. Flags from Toolbelt alone cannot close this in-flight race.
      if (["claim", "start"].includes(request.operation)) {
        const claims = message.getFlag(MODULE_ID, "damageApplications") ?? {};
        for (const claim of Object.values(claims)) {
          if (claim.id === previous?.id) continue;
          const locked = claim.state === "pending" ||
            (claim.state === "reserved" && now - claim.at < REQUEST_RETRY_INTERVAL);
          if (locked && claim.footprint?.some(key => footprint.includes(key))) return reply("blocked");
        }
      }
      if (request.operation === "claim") {
        if (previous?.state === "reserved") {
          if (previous.id === request.id && previous.userId === userId) {
            return reply("granted", previous.id);
          }
          if (now - previous.at < REQUEST_RETRY_INTERVAL)
            return reply("blocked");
          previous = previous.previous ?? void 0;
        }
        if (previous?.state === "pending" || previous && now - previous.at < DUPLICATE_INTERVAL) {
          return reply("blocked");
        }
        const legacyApplied = isDamageApplied(message, token, request.rollIndex);
        const confirmation = previous?.id ?? (legacyApplied ? "legacy" : void 0);
        if (confirmation && (!user.isGM || !request.allowRepeat))
          return reply("blocked");
        if (confirmation && request.confirmation !== confirmation)
          return reply("confirm", confirmation);
        const claim = {
          id: request.id,
          at: now,
          userId,
          state: "reserved",
          footprint,
          wasApplied: legacyApplied,
          previous: previous ?? null
        };
        await message.setFlag(MODULE_ID, flag, claim);
        return reply("granted", claim.id);
      }
      if (!previous || previous.id !== request.claimId || previous.userId !== userId)
        return reply("blocked");
      if (request.operation === "start") {
        if (previous.state === "pending")
          return reply("granted", previous.id);
        if (previous.state !== "reserved")
          return reply("blocked");
        if (!previous.wasApplied && isDamageApplied(message, token, request.rollIndex)) {
          return reply("blocked");
        }
        const claim = { id: previous.id, at: now, userId, state: "pending", previous: null, footprint };
        await message.setFlag(MODULE_ID, flag, claim);
        return reply("granted", claim.id);
      }
      if (request.operation === "complete" && previous.state === "applied")
        return reply("applied", previous.id);
      if (request.operation === "failed" && previous.state === "failed")
        return reply("failed", previous.id);
      if (previous.state !== "pending")
        return reply("error");
      const state = request.operation === "complete" ? "applied" : "failed";
      const updates = { [`flags.${MODULE_ID}.${flag}`]: { ...previous, at: now, state } };
      if (state === "applied") {
        await this.tool.markDamageApplied(message, token.id, request.rollIndex, updates);
      } else {
        await message.update(updates);
      }
      return reply(state, previous.id);
    } catch (error) {
      console.error("PF2e Pending Damage | Damage claim failed", error);
      return reply("error");
    }
  }
}
export {
  DamageApplicationGuard
};
