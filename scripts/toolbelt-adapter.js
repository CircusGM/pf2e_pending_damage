// Toolbelt's persistent flag and rendered row contracts are isolated here.
// Baseline: reonZ/pf2e-toolbelt 3.56.3 (665d856). Never access its debug/private tools.
import { MODULE_ID, TOOLBELT_ID, ownsDamageTarget } from "./constants.js";

export function getMessageData(message) {
    const data = message.getFlag(TOOLBELT_ID, "targetHelper");
    if (data?.type !== "damage" || !Array.isArray(data.targets ?? []) ||
        !Array.isArray(data.splashTargets ?? [])) return null;
    const resolve = (values) => {
        const seen = new Set();
        return (values ?? []).flatMap(uuid => {
            if (typeof uuid !== "string") return [];
            const token = fromUuidSync(uuid, { strict: false });
            if (token?.documentName !== "Token" || !token.actor) return [];
            const key = token.flags?.pf2e?.troop?.id ?? token.actor.uuid ?? token.uuid;
            if (seen.has(key)) return [];
            seen.add(key);
            return [token];
        });
    };
    return { ...data, targets: resolve(data.targets), splashTargets: resolve(data.splashTargets),
        applied: data.applied ?? {}, splashIndex: Number.isInteger(data.splashIndex) ? data.splashIndex : -1 };
}

export function isTargeted(data, token, rollIndex) {
    return !!data && (data.targets.some(t => t.uuid === token.uuid) ||
        (data.splashIndex === rollIndex && data.splashTargets.some(t => t.uuid === token.uuid)));
}

export function appliedUpdates(message, tokenId, rollIndex) {
    const data = getMessageData(message);
    const applied = { [tokenId]: { [rollIndex]: true } };
    // Match Toolbelt: selecting splash consumes that target's main roll; selecting
    // main consumes its splash and the other main targets' main roll.
    if (data && message.rolls.length === 2 && [0, 1].includes(data.splashIndex)) {
        const regular = 1 - data.splashIndex;
        applied[tokenId][rollIndex === data.splashIndex ? regular : data.splashIndex] = true;
        if (rollIndex !== data.splashIndex) {
            for (const target of data.targets) (applied[target.id] ??= {})[regular] = true;
        }
    }
    return applied;
}

export async function markDamageApplied(message, tokenId, rollIndex, updates) {
    if (getMessageData(message)) {
        for (const [id, rolls] of Object.entries(appliedUpdates(message, tokenId, rollIndex))) {
            for (const index of Object.keys(rolls)) {
                updates[`flags.${TOOLBELT_ID}.targetHelper.applied.${id}.${index}`] = true;
            }
        }
    }
    await message.update(updates);
}

export function applicationFootprint(message, token, rollIndex) {
    return Object.entries(appliedUpdates(message, token.id, rollIndex))
        .flatMap(([id, rolls]) => Object.keys(rolls).map(index => `${token.parent?.id ?? "scene"}.${id}.${index}`));
}

export function isDamageApplied(message, token, index) {
    if (getMessageData(message)?.applied[token.id]?.[index]) return true;
    const key = `${token.parent?.id ?? "scene"}.${token.id}.${index}`;
    // Toolbelt may rewrite its own flag while saves/targets are being updated.
    // Our separately scoped completion records remain authoritative for the panel.
    return Object.values(message.getFlag(MODULE_ID, "damageApplications") ?? {})
        .some(claim => claim.state === "applied" && claim.footprint?.includes(key));
}

export function targetRows(html) {
    return [...html.querySelectorAll(".damage-application[data-target-uuid][data-target-roll-index]")];
}

export function pendingRows(message, html, data) {
    const rows = targetRows(html);
    const existing = new Set(rows.map(row => `${row.dataset.targetUuid}:${row.dataset.targetRollIndex}`));
    const native = [...html.querySelectorAll(".damage-application")].filter(row => !row.dataset.targetUuid);
    // Upstream omits hidden tokens even for their owning players. Reuse PF2e's
    // native controls for owned targets absent from the Toolbelt-rendered rows.
    for (const token of [...data.targets, ...data.splashTargets].filter(ownsDamageTarget)) {
        for (let index = 0; index < message.rolls.length; index++) {
            const key = `${token.uuid}:${index}`;
            if (existing.has(key) || !isTargeted(data, token, index) || !native[index]) continue;
            const row = native[index].cloneNode(true);
            row.dataset.targetUuid = token.uuid;
            row.dataset.targetRollIndex = String(index);
            for (const button of row.querySelectorAll("[data-action]")) button.dataset.action = `target-${button.dataset.action}`;
            const variant = data.saveVariants?.null;
            const save = variant?.saves?.[token.id];
            const showResults = game.user.isGM || game.pf2e.settings.metagame.results ||
                !message.actor || message.actor.isOwner || message.actor.hasPlayerOwner;
            if (variant?.basic && showResults && save?.success === "criticalSuccess") row.classList.add("applied");
            // Do not reproduce Toolbelt's feat-specific recommendation logic.
            // The controls still permit every native damage/healing multiplier.
            rows.push(row);
            existing.add(key);
        }
    }
    return rows;
}

export function recommendedMultiplier(row, message) {
    if (row.classList.contains("success")) return "0.5";
    if (row.classList.contains("failure")) return "1";
    if (row.classList.contains("criticalFailure")) return "2";
    return ["success", "criticalSuccess"].includes(message.flags.pf2e?.context?.outcome) ? "1" : null;
}

export function targetHelperEnabled() {
    return game.settings.get(TOOLBELT_ID, "targetHelper.enabled") === true;
}
