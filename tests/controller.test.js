import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { reset, token, message, chat, click, flush, settings, fire, wrappers, errors } from "./helpers/dom-harness.js";
import { PendingDamageController } from "../scripts/controller.js";
import { PendingStore } from "../scripts/pending-store.js";

let controller, target, msg;
beforeEach(() => { reset(); target = token(); msg = message(); controller = new PendingDamageController(); });

for (const targeted of [false, true]) for (const multiplier of [0.5, 1, 2, 3, -1]) {
    test(`${targeted ? "Toolbelt" : "native"} ${multiplier} click invokes one guarded call and no original listener`, async () => {
        const html = chat(msg);
        const row = html.querySelector(targeted ? "[data-target-uuid]" : ".damage-application");
        const button = row.querySelector(`[data-multiplier="${multiplier}"]`);
        let original = 0, calls = [];
        // Original listeners are attached before our interceptor, as in Foundry.
        button.addEventListener("click", () => original++);
        html.addEventListener("click", () => original++);
        controller.apply = async options => calls.push(options);
        controller.bindChat(msg, html);
        controller.bindChat(msg, html); // Rerender/rebinding must not duplicate handlers.
        assert.equal(click(button.querySelector("i")), false);
        await flush();
        assert.equal(original, 0); assert.equal(calls.length, 1);
        assert.equal(calls[0].multiplier, multiplier); assert.equal(calls[0].token, target);
        assert.equal(calls[0].allowRepeat, true);
    });
}

test("late-added Toolbelt controls and rolls in a popout are intercepted", async () => {
    const html = chat(msg, { includeTargets: false });
    controller.bindChat(msg, html);
    msg.rolls.push({ total: 3 });
    const late = chat(msg).querySelector('[data-target-roll-index="1"]');
    let calls = [], original = 0;
    late.querySelector("button").addEventListener("click", () => original++);
    html.append(late);
    controller.apply = async options => calls.push(options);
    click(late.querySelector("button")); await flush();
    assert.equal(original, 0); assert.equal(calls[0].rollIndex, 1);
});

test("context-menu damage/healing uses the guard; unrelated options remain intact", async () => {
    let original = 0, unrelated = 0, calls = [];
    const options = ["Full", "Half", "Double", "Triple", "Healing"].map(name => ({
        label: `PF2E.DamageButton.${name}Context`, onClick: () => original++,
    }));
    const other = { label: "other", onClick: () => unrelated++ };
    options.push(other);
    controller.apply = async options => calls.push(options);
    controller.bindContextMenu(options);
    for (const option of options) await option.onClick({}, chat(msg));
    assert.equal(original, 0); assert.equal(unrelated, 1);
    assert.deepEqual(calls.map(call => call.multiplier), [1, 0.5, 2, 3, -1]);
    settings.set("pf2e-pending-damage.enabled", false);
    await options[0].onClick({}, chat(msg)); assert.equal(original, 1);
});

test("deprecated context-menu spellings are intercepted; entries without a handler are left alone", async () => {
    let original = 0, calls = [];
    const legacy = { name: "PF2E.DamageButton.HalfContext", callback: () => original++ };
    const broken = { label: "PF2E.DamageButton.FullContext" };
    controller.apply = async options => calls.push(options);
    controller.bindContextMenu([legacy, broken]);
    await legacy.callback({}, chat(msg));
    assert.equal(original, 0); assert.deepEqual(calls.map(call => call.multiplier), [0.5]);
    assert.equal(broken.onClick, undefined); assert.equal(broken.callback, undefined);
});

test("disabling only the panel leaves chat protection active", async () => {
    settings.set("pf2e-pending-damage.showWindow", false);
    let calls = 0; controller.apply = async () => calls++;
    const html = chat(msg); controller.bindChat(msg, html); click(html.querySelector("button")); await flush();
    assert.equal(calls, 1); assert.equal(controller.panelEnabled, false);
});

test("with duplicate protection off, chat uses the native handlers and the window applies directly", async () => {
    settings.set("pf2e-pending-damage.protection", false);
    const html = chat(msg);
    let original = 0;
    html.querySelector("[data-target-uuid] button").addEventListener("click", () => original++);
    controller.bindChat(msg, html);
    assert.equal(click(html.querySelector("[data-target-uuid] button")), true);
    assert.equal(original, 1);
    let menu = 0;
    const options = [{ label: "PF2E.DamageButton.FullContext", onClick: () => menu++ }];
    controller.bindContextMenu(options);
    await options[0].onClick({}, chat(msg));
    assert.equal(menu, 1);
    // No GM is needed and nothing is sent.
    game.users.filter = () => [];
    let emits = 0; game.socket.emit = () => emits++;
    let hp = 0; target.actor.applyDamage = async () => hp++;
    assert.equal(await controller.apply({ message: msg, token: target, rollIndex: 0, multiplier: 1, allowRepeat: false }), true);
    assert.equal(hp, 1); assert.equal(emits, 0);
});

test("only newly created messages populate, even when chat is closed", async () => {
    controller.start();
    controller.collect(msg, chat(msg)); assert.equal(controller.store.entries.size, 0);
    await fire("createChatMessage", msg); await controller.refresh(msg);
    assert.equal(controller.store.entries.size, 1);
    assert.ok(wrappers.has("ChatMessage.prototype.renderHTML"));
    controller.clear(); await controller.refresh(msg); assert.equal(controller.store.entries.size, 0);
});

test("GM sees all targets, owners see their targets, hidden rolls are excluded", async () => {
    const unowned = token("enemy", false); msg = message([target, unowned]);
    for (const isGM of [true, false]) {
        game.user.isGM = isGM;
        controller.store.reset(); controller.store.mark(msg.id); controller.collect(msg, chat(msg));
        assert.equal(controller.store.entries.size, isGM ? 2 : 1);
    }
    msg.isContentVisible = false; controller.collect(msg, chat(msg)); assert.equal(controller.store.entries.size, 0);
});

test("hidden owned tokens get native fallback controls without exposing unowned tokens", () => {
    game.user.isGM = false;
    target.hidden = true;
    const enemy = token("enemy", false); msg = message([target, enemy]);
    controller.store.mark(msg.id); controller.collect(msg, chat(msg, { includeTargets: false }));
    assert.equal(controller.store.entries.size, 1);
    const entry = [...controller.store.entries.values()][0];
    assert.equal(entry.targetUuid, target.uuid);
    assert.equal(entry.row.querySelector("button").dataset.action, "target-applyDamage");
});

test("applied flags, removed targets, deleted messages and changed ownership purge pending rows", async () => {
    controller.start(); controller.store.mark(msg.id); await controller.refresh(msg);
    const data = msg.flags["pf2e-toolbelt"].targetHelper;
    data.applied[target.id] = { 0: true }; await controller.refresh(msg); assert.equal(controller.store.entries.size, 0);
    data.applied = {}; await controller.refresh(msg); assert.equal(controller.store.entries.size, 1);
    game.user.isGM = false; target.actor.isOwner = false; await fire("updateActor", target.actor); await controller.refresh(msg);
    assert.equal(controller.store.entries.size, 0);
    target.actor.isOwner = true; await controller.refresh(msg);
    data.targets = []; await controller.refresh(msg); assert.equal(controller.store.entries.size, 0);
    data.targets = [target.uuid]; await controller.refresh(msg);
    await fire("deleteChatMessage", msg); assert.equal(controller.store.entries.size, 0);
    assert.equal(controller.store.eligible.has(msg.id), false);
});

test("an application removes the row from every client's independently maintained panel", async () => {
    const peers = [controller, new PendingDamageController(), new PendingDamageController()];
    for (const peer of peers) { peer.start(); peer.store.mark(msg.id); await peer.refresh(msg); }
    // A single-session GM coordinates its own clicks once the election settles.
    controller.guard.coordinator.isCoordinator = () => true;
    let hpCalls = 0; target.actor.applyDamage = async () => hpCalls++;
    assert.equal(await controller.apply({ message: msg, token: target, rollIndex: 0, multiplier: 1, allowRepeat: false }), true);
    for (const peer of peers) { await peer.refresh(msg); assert.equal(peer.store.entries.size, 0); }
    assert.equal(hpCalls, 1);
});

test("rapid clicks and rerender while applying retain a single in-flight operation", async () => {
    controller.store.mark(msg.id); controller.collect(msg, chat(msg));
    const entry = [...controller.store.entries.values()][0];
    let finish, calls = 0;
    controller.guard.run = async (_m, _t, _i, { apply }) => { calls++; await new Promise(resolve => { finish = resolve; }); await apply(); return true; };
    const options = { message: msg, token: target, rollIndex: 0, multiplier: 1, entry };
    const first = controller.apply(options);
    controller.collect(msg, chat(msg));
    assert.equal(controller.store.entries.get(entry.key), entry); assert.equal(entry.applying, true);
    assert.equal(await controller.apply(options), false); assert.equal(calls, 1);
    finish(); assert.equal(await first, true);
    controller.collect(msg, chat(msg)); assert.equal(controller.store.entries.size, 0);
});

test("Shift cancellation never reserves or applies damage; a confirmed modifier reaches PF2e", async () => {
    let guards = 0, damage;
    controller.guard.run = async (_m, _t, _i, { apply }) => { guards++; await apply(); return true; };
    foundry.applications.api.DialogV2.prompt = async () => null;
    const options = { message: msg, token: target, rollIndex: 0, multiplier: -1, shift: true };
    assert.equal(await controller.apply(options), false); assert.equal(guards, 0);
    foundry.applications.api.DialogV2.prompt = async () => -4;
    target.actor.applyDamage = async data => { damage = data.damage; };
    assert.equal(await controller.apply(options), true); assert.equal(guards, 1); assert.equal(damage, -16);
});

// The guard withdraws a claim whose verification fails, without calling apply.
const verifyingGuard = async (_m, _t, _i, { verify, apply }) => {
    if (verify()) return false;
    await apply();
    return true;
};

test("a deleted message, rerolled total or changed damage type never reaches PF2e", async () => {
    let hp = 0; target.actor.applyDamage = async () => hp++;
    msg.rolls[0].formula = "2d6[piercing]";
    const original = msg.rolls[0];
    for (const mutate of [() => game.messages.delete(msg.id), () => { msg.rolls[0] = { ...original, total: 90 }; },
        () => { msg.rolls[0] = { ...original, formula: "2d6[fire]" }; }]) {
        msg.rolls[0] = original;
        game.messages.set(msg.id, msg);
        controller.guard.run = async (...args) => { mutate(); assert.match(args[3].verify(), /sync\.changed/); return verifyingGuard(...args); };
        assert.equal(await controller.apply({ message: msg, token: target, rollIndex: 0, multiplier: 1 }), false);
    }
    assert.equal(hp, 0);
});

test("Dice So Nice annotations and rolls rebuilt by flag updates do not block an application", async () => {
    let hp = 0; target.actor.applyDamage = async () => hp++;
    msg.rolls[0].formula = "2d6[piercing]";
    // Dice So Nice annotates the prepared roll before the click.
    msg.rolls[0].terms = [{ options: { flavor: "piercing", dsnRoleManaged: true }, results: [{ result: 6, indexThrow: 0 }] }];
    controller.guard.run = async (...args) => {
        // The claim's flag write rebuilds the roll from stored data, without those notes.
        msg.rolls[0] = { ...msg.rolls[0], options: { showBreakdown: true }, terms: [{ options: { flavor: "piercing" }, results: [{ result: 6 }] }] };
        return verifyingGuard(...args);
    };
    assert.equal(await controller.apply({ message: msg, token: target, rollIndex: 0, multiplier: 1 }), true);
    assert.equal(hp, 1);
});

test("clear title button, safe labels, shield selection and pending click work together", async () => {
    msg.item.name = '<img src=x onerror="bad()">';
    controller.store.mark(msg.id); controller.collect(msg, chat(msg));
    const win = controller.pendingDamage;
    await win.render();
    assert.equal(win.element.querySelector(".source img"), null);
    assert.equal(win.element.querySelector(".pending-clear").disabled, false);
    click(win.element.querySelector('[data-action="target-shieldBlock"]'));
    assert.equal([...controller.store.entries.values()][0].shield, true);
    let options; controller.apply = async args => { options = args; };
    click(win.element.querySelector('[data-multiplier="1"]')); await flush();
    assert.equal(options.shield, true); assert.equal(options.allowRepeat, false);
    click(win.element.querySelector(".pending-clear")); await win.render();
    assert.equal(controller.store.entries.size, 0); assert.equal(win.element.querySelector(".pending-clear").disabled, true);
});

test("disable during background rendering cannot repopulate the cleared session", async () => {
    let finish;
    msg.renderHTML = () => new Promise(resolve => { finish = resolve; });
    controller.store.mark(msg.id); const pending = controller.refresh(msg);
    controller.reset(); finish(chat(msg)); await pending;
    assert.equal(controller.store.entries.size, 0); assert.equal(controller.store.eligible.size, 0);
});

test("a newer update supersedes an older async background render", async () => {
    let finish, count = 0;
    msg.renderHTML = async () => { if (++count === 1) await new Promise(resolve => { finish = resolve; }); return chat(msg); };
    controller.store.mark(msg.id); const pending = controller.refresh(msg);
    msg.flags["pf2e-toolbelt"].targetHelper.targets = [];
    controller.refresh(msg); finish(); await pending;
    assert.equal(count, 1); assert.equal(controller.store.entries.size, 0);
});

test("malformed/missing totals stay blank and critical success rows are absent", () => {
    controller.store.mark(msg.id); msg.rolls[0].total = NaN;
    controller.collect(msg, chat(msg)); assert.equal([...controller.store.entries.values()][0].total, null);
    const html = chat(msg); html.querySelector("[data-target-uuid]").classList.add("applied");
    controller.collect(msg, html); assert.equal(controller.store.entries.size, 0);
});

test("non-left click and missing selection do not apply", async () => {
    const html = chat(msg); let calls = 0; controller.apply = async () => calls++;
    controller.bindChat(msg, html);
    click(html.querySelector("button"), { button: 2 });
    game.user.getActiveTokens = () => [];
    click(html.querySelector("button")); await flush();
    assert.equal(calls, 0); assert.equal(errors.length, 1);
});

test("splash-only targets receive only the splash roll", () => {
    const data = msg.flags["pf2e-toolbelt"].targetHelper;
    data.targets = []; data.splashTargets = [target.uuid]; data.splashIndex = 1;
    msg.rolls.push({ total: 3 }); controller.store.mark(msg.id); controller.collect(msg, chat(msg));
    assert.deepEqual([...controller.store.entries.keys()], [PendingStore.key(msg.id, target.uuid, 1)]);
});

test("completed, dismissed and unowned rows do not render in the background", async () => {
    let renders = 0;
    msg.renderHTML = async () => { renders++; return chat(msg); };
    controller.store.mark(msg.id);
    await controller.refresh(msg);
    assert.equal(renders, 1);
    controller.clear();
    await controller.refresh(msg);
    assert.equal(renders, 1);
    controller.store.dismissed.clear();
    msg.flags["pf2e-toolbelt"].targetHelper.applied[target.id] = { 0: true };
    await controller.refresh(msg);
    assert.equal(renders, 1);
    msg.flags["pf2e-toolbelt"].targetHelper.applied = {};
    game.user.isGM = false; target.actor.isOwner = false;
    await controller.refresh(msg);
    assert.equal(renders, 1);
    target.actor.isOwner = true;
    await controller.refresh(msg);
    assert.equal(renders, 2);
    assert.equal(controller.store.entries.size, 1);
});

test("actor and token updates refresh only affected messages", async () => {
    controller.start();
    controller.store.mark(msg.id);
    const other = token("other"), otherMsg = message([other], "other-message");
    controller.store.mark(otherMsg.id);
    const refreshed = [];
    controller.refresh = message => refreshed.push(message.id);
    await fire("updateActor", target.actor);
    assert.deepEqual(refreshed.splice(0), [msg.id]);
    await fire("updateToken", other);
    assert.deepEqual(refreshed.splice(0), [otherMsg.id]);
    await fire("deleteToken", other);
    assert.deepEqual(refreshed.splice(0), [otherMsg.id]);
    await fire("updateActor", { uuid: "Actor.unrelated" });
    assert.deepEqual(refreshed, []);
    msg.actor = { uuid: "Actor.origin" };
    await fire("updateActor", msg.actor);
    assert.deepEqual(refreshed.splice(0), [msg.id]);
    await fire("canvasReady");
    assert.deepEqual(refreshed, [msg.id, otherMsg.id]);
});

test("a burst of relevant updates has at most one background render in flight", async () => {
    controller.start(); controller.store.mark(msg.id);
    let resolve, renders = 0, active = 0, maximum = 0;
    msg.renderHTML = async () => {
        maximum = Math.max(maximum, ++active);
        if (++renders === 1) await new Promise(done => { resolve = done; });
        active--;
        return chat(msg);
    };
    const pending = controller.refresh(msg);
    for (let i = 0; i < 100; i++) await fire("updateActor", target.actor);
    assert.equal(renders, 1);
    resolve(); await pending;
    assert.equal(renders, 2);
    assert.equal(maximum, 1);
    assert.equal(controller.store.entries.size, 1);
});

test("a renderer that continuously invalidates itself cannot loop indefinitely", async () => {
    controller.store.mark(msg.id);
    let renders = 0;
    const original = console.error, failures = [];
    console.error = (...args) => failures.push(args);
    try {
        msg.renderHTML = async () => {
            renders++;
            if (renders < 20) controller.refresh(msg);
            return chat(msg);
        };
        await controller.refresh(msg);
        assert.equal(renders, 8);
        assert.equal(failures.length, 1);
        assert.equal(controller.refreshes.size, 0);
        assert.equal(controller.store.entries.size, 0);
        msg.renderHTML = async () => chat(msg);
        await controller.refresh(msg);
        assert.equal(controller.store.entries.size, 1);
    } finally { console.error = original; }
});

test("a long session of completed rolls does not render its history on an actor update", async () => {
    controller.start(); controller.store.mark(msg.id);
    let renders = 0;
    msg.renderHTML = async () => { renders++; return chat(msg); };
    for (let i = 0; i < 200; i++) {
        const completed = message([target], `completed-${i}`);
        completed.flags["pf2e-toolbelt"].targetHelper.applied[target.id] = { 0: true };
        completed.renderHTML = async () => { renders++; return chat(completed); };
        controller.store.mark(completed.id);
    }
    await fire("updateActor", target.actor);
    await Promise.all([...controller.refreshes.values()].map(state => state.promise));
    assert.equal(renders, 1);
    assert.equal(controller.store.entries.size, 1);
});
