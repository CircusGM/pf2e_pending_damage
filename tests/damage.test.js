import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { reset, token, message } from "./helpers/dom-harness.js";
import { applyDamage, promptAdjustment } from "../scripts/damage.js";

let target, msg, applications, contexts, probes;
beforeEach(() => {
    reset(); target = token(); msg = message(); applications = []; contexts = []; probes = [];
    target.actor.alliance = "party";
    target.actor.getSelfRollOptions = prefix => [`${prefix ?? "self"}:type:character`, `${prefix ?? "self"}:condition:off-guard`];
    target.actor.getContextualClone = (options, effects) => {
        contexts.push({ options, effects });
        return { getSelfRollOptions: () => ["self:contextual-clone"], applyDamage: async options => applications.push(options) };
    };
    msg.actor = { uuid: "Actor.attacker", alliance: "opposition", getRollOptions: () => ["domain:damage-received"],
        synthetics: { ephemeralEffects: { "damage-received": { target: [async params => {
            probes.push(params); return { type: "effect", system: {} };
        }] } } } };
    msg.flags.pf2e.context = { options: ["self:trait:undead", "item:trait:fire"], outcome: "criticalSuccess" };
});

test("PF2e receives the roll, shield request, outcome, origin options and contextual effects", async () => {
    await applyDamage({ message: msg, token: target, rollIndex: 0, multiplier: 0.5, addend: 2, shieldBlockRequest: true });
    assert.equal(applications.length, 1);
    const applied = applications[0];
    assert.deepEqual(applied.damage, { total: 8 });
    assert.equal(applied.token, target); assert.equal(applied.item, msg.item);
    assert.equal(applied.shieldBlockRequest, true); assert.equal(applied.skipIWR, false);
    assert.equal(applied.outcome, "criticalSuccess");
    assert.deepEqual([...applied.rollOptions].sort(), ["item:trait:fire", "origin:enemy", "origin:trait:undead", "self:contextual-clone"].sort());
    assert.deepEqual(contexts[0].options, ["origin:trait:undead"]);
    assert.equal(contexts[0].effects[0].system.context.origin.actor, "Actor.attacker");
    assert.equal(contexts[0].effects[0].system.duration.unit, "unlimited");
    assert.ok(probes[0].test.includes("target:condition:off-guard"));
    assert.ok(probes[0].test.includes("domain:damage-received"));
});

test("healing stays numeric, bypasses IWR and damage-only ephemeral effects", async () => {
    await applyDamage({ message: msg, token: target, rollIndex: 0, multiplier: -1, addend: -5 });
    assert.equal(applications[0].damage, -17); assert.equal(applications[0].skipIWR, true);
    assert.equal(probes.length, 0); assert.deepEqual(contexts[0].effects, []);
});

test("spell/effect context, alliance and existing target roll options are preserved", async () => {
    msg.item.isOfType = (...types) => types.includes("effect") || types.includes("spell");
    msg.item.getRollOptions = () => ["item:effect:blessing"];
    msg.actor.alliance = "party";
    msg.flags.pf2e.context.options.push("target:trait:fiend");
    await applyDamage({ message: msg, token: target, rollIndex: 0, multiplier: 2 });
    assert.equal(probes[0].resolvables.spell, msg.item);
    assert.ok(applications[0].rollOptions.has("origin:ally"));
    assert.ok(applications[0].rollOptions.has("item:effect:blessing"));
    assert.ok(probes[0].test.includes("target:trait:fiend"));
    assert.ok(!applications[0].rollOptions.has("target:trait:fiend"));
});

test("no origin actor is valid; invalid rolls and unauthorized targets never reach PF2e", async () => {
    msg.actor = null;
    await applyDamage({ message: msg, token: target, rollIndex: 0, multiplier: 1 });
    assert.equal(applications.length, 1); assert.deepEqual(contexts[0].effects, []);
    for (const options of [{ rollIndex: 9 }, { multiplier: NaN }, { addend: Infinity }]) {
        await assert.rejects(applyDamage({ message: msg, token: target, rollIndex: 0, multiplier: 1, ...options }));
    }
    game.user.isGM = false; target.actor.isOwner = false;
    await assert.rejects(applyDamage({ message: msg, token: target, rollIndex: 0, multiplier: 1 }));
    assert.equal(applications.length, 1);
});

test("adapter awaits the system's operation instead of finishing when a shield dialog opens", async () => {
    let resolve, finished = false;
    target.actor.getContextualClone = () => ({ getSelfRollOptions: () => [], applyDamage: () => new Promise(r => { resolve = r; }) });
    const applying = applyDamage({ message: msg, token: target, rollIndex: 0, multiplier: 1 }).then(() => { finished = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false); resolve(); await applying; assert.equal(finished, true);
});

test("Shift dialog keeps positive healing adjustments intuitive and cancellation distinguishable", async () => {
    let config;
    foundry.applications.api.DialogV2.prompt = async options => { config = options; return options.ok.callback(null,
        { form: { elements: { adjustment: { valueAsNumber: 4, checkValidity: () => true } } } }); };
    assert.equal(await promptAdjustment(-1), -4);
    assert.equal(config.rejectClose, false);
    assert.equal(await promptAdjustment(0.5), 4);
});
