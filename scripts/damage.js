// Adapted PF2e chat damage context preparation (Apache-2.0; see NOTICE).
// Source: foundryvtt/pf2e tag pf2e-8.4.0, chat-message/helpers.ts and rules/helpers.ts.
// Toolbelt's onDamageBtnClick/applyDamageFromMessage are private bundle functions.
// Keep this bridge small: PF2e owns IWR, shield dialogs, HP, conditions and undo.
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

export async function applyDamage({ message, token, rollIndex, multiplier, addend = 0, shieldBlockRequest = false }) {
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
    await actor.applyDamage({
        damage: multiplier < 0 ? multiplier * roll.total + addend : roll.alter(multiplier, addend),
        token, item, skipIWR: multiplier <= 0, rollOptions, shieldBlockRequest, outcome: context?.outcome,
    });
}

export async function promptAdjustment(multiplier) {
    return foundry.applications.api.DialogV2.prompt({
        window: { title: localize(multiplier < 0 ? "adjustHealing" : "adjustDamage") },
        content: `<label>${localize("adjustment")} <input name="adjustment" type="number" value="0" autofocus></label>`,
        ok: { label: localize("apply"), callback: (_event, button) => {
            const input = button.form.elements.adjustment;
            return input.checkValidity() && Number.isFinite(input.valueAsNumber)
                ? input.valueAsNumber * Math.sign(multiplier) : null;
        } },
        rejectClose: false,
    });
}
