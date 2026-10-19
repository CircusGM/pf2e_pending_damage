import { MODULE_ID } from "./constants.js";

// A granted claim blocks its footprint until the applying client reports back,
// for at most this long. After that its outcome is unknown, so only a GM can
// confirm another application.
export const LEASE = 5e3;

export function recordKey(tokenUuid, rollIndex) {
    return `${tokenUuid.replaceAll(".", "_")}_${rollIndex}`;
}

// Each target and roll has an append-only log keyed by claim ID. Concurrent or
// late writes add entries; they cannot overwrite another client's application.
// Grants and outcomes use separate fields, so a delayed grant cannot undo an outcome.
export function claimsOf(message) {
    const claims = [];
    for (const [key, entries] of Object.entries(message.getFlag(MODULE_ID, "applications") ?? {})) {
        for (const [id, claim] of Object.entries(entries ?? {})) {
            if (Number.isFinite(claim?.at)) claims.push({ ...claim, id, key, state: claim.outcome ?? "pending" });
        }
    }
    // Version 1 kept one record per target; an unstarted reservation never changed HP.
    for (const [key, stored] of Object.entries(message.getFlag(MODULE_ID, "damageApplications") ?? {})) {
        const record = stored?.state === "reserved" ? stored.previous : stored;
        if (record?.id && typeof record.state === "string") claims.push({ ...record, key, doneAt: record.at, legacy: true });
    }
    return claims;
}

// Times are game.time.serverTime, shared by all clients. A negative age means a
// version 1 record (wall-clock time) or one from before a server restart.
export function claimStatus(claim, now) {
    const age = now - claim.at;
    if (claim.state === "pending") return age >= 0 && age < LEASE ? "active" : "uncertain";
    return ["applied", "failed"].includes(claim.state) ? claim.state : null;
}
