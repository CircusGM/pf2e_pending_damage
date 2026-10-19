// PF2e damage context adapter; adapted portions are Apache-2.0 (see NOTICE).
import { localize, ownsDamageTarget } from "./constants.js";

async function ephemeralEffects(origin, target, item, options) {
    if (!origin) return [];
    const domain = "damage-received";
    const tests = [...options, ...origin.getRollOptions([domain]), ...target.getSelfRollOptions("target")];
    const resolvables = item ? { [item.isOfType("spell") ? "spell" : "weapon"]: item } : {};
    const sources = await Promise.all((origin.synthetics.ephemeralEffects[domain]?.target ?? [])
        .map(resolve => resolve({ test: tests, resolvables })));
    return sources.filter(Boolean).map(source => {
        const effect = foundry.utils.deepClone(source);
        if (effect.type === "effect") {
            effect.system.context = {
                origin: { actor: origin.uuid, item: null, rollOptions: [], spellcasting: null, token: null },
                target: { actor: target.uuid, token: null }, roll: null,
            };
            effect.system.duration = { value: -1, unit: "unlimited", expiry: null, sustained: false };
        }
        return effect;
    });
}

export async function applyDamage(options) {
    let prepared;
    try {
        prepared = await prepareDamage(options);
    } catch (error) {
        // Nothing has changed yet, so the claim can be withdrawn instead of recorded as attempted.
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { untouched: true });
    }
    await prepared.actor.applyDamage(prepared.data);
}

async function prepareDamage({ message, token, rollIndex, multiplier, addend = 0, shieldBlockRequest = false }) {
    const roll = message.rolls[rollIndex];
    if (!ownsDamageTarget(token) || typeof roll?.alter !== "function" || !Number.isFinite(roll.total) ||
        !Number.isFinite(multiplier) || !Number.isFinite(addend)) throw new Error("Invalid damage application");
    const context = message.flags.pf2e?.context;
    const options = [...(context?.options ?? [])];
    const originOptions = options.filter(o => o.startsWith("self:")).map(o => o.replace(/^self:/, "origin:"));
    const item = message.item;
    const effectOptions = item?.isOfType("affliction", "condition", "effect") ? item.getRollOptions("item") : [];
    if (token.actor.alliance && message.actor) {
        options.push(`origin:${token.actor.alliance === message.actor.alliance ? "ally" : "enemy"}`);
    }
    if (!options.some(o => o.startsWith("target:"))) options.push(...token.actor.getSelfRollOptions("target"));
    const effects = multiplier > 0 ? await ephemeralEffects(message.actor, token.actor, item, options) : [];
    const actor = token.actor.getContextualClone(originOptions, effects);
    const rollOptions = new Set([...options.filter(o => !/^(?:self|target)(?::|$)/.test(o)),
        ...effectOptions, ...originOptions, ...actor.getSelfRollOptions()]);
    return { actor, data: {
        damage: multiplier < 0 ? multiplier * roll.total + addend : roll.alter(multiplier, addend),
        token, item, skipIWR: multiplier <= 0, rollOptions, shieldBlockRequest, outcome: context?.outcome,
    } };
}

// Resolves to a number, or null if cancelled. DialogV2 substitutes the button's action
// when a callback returns null, so an empty field counts as 0, as it does in PF2e.
export async function promptAdjustment(multiplier) {
    const result = await foundry.applications.api.DialogV2.prompt({
        window: { title: localize(multiplier < 0 ? "adjustHealing" : "adjustDamage") },
        content: `<label>${localize("adjustment")} <input name="adjustment" type="number" value="0" autofocus></label>`,
        ok: { label: localize("apply"), callback: (_event, button) => {
            const value = button.form.elements.adjustment.valueAsNumber;
            return (Number.isFinite(value) ? Math.trunc(value) : 0) * Math.sign(multiplier);
        } },
        rejectClose: false,
    });
    return typeof result === "number" && Number.isFinite(result) ? result : null;
}
