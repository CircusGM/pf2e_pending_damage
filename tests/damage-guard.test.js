import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { makeClient, reset, flush, advance, deferred, state, tokenUuid } from "./helpers/guard-harness.js";
const records = { get: key => state.records.get(key), set: (key, value) => state.records.set(key, value) };
const users = state.users;
let applied, owners;
beforeEach(() => { reset(); applied = state.applied; owners = state.owners; });

test("simultaneous GM and owner clicks change HP exactly once and shake the loser", async () => {
    const gm = makeClient("gm"), player = makeClient("player");
    let hp = 100;
    const changeHP = async () => { hp -= 12; };
    const results = await Promise.all([gm.apply(changeHP), player.apply(changeHP)]);
    assert.equal(hp, 88);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(gm.shakes + player.shakes, 1);
    assert.equal(gm.dialogs + player.dialogs, 0);
});

test("two owning players cannot apply the same healing twice", async () => {
    makeClient("gm"); owners.add("other");
    const player = makeClient("player"), other = makeClient("other");
    let hp = 50;
    await Promise.all([player.apply(async () => { hp += 12; }), other.apply(async () => { hp += 12; })]);
    assert.equal(hp, 62);
    assert.equal(player.shakes + other.shakes, 1);
});

test("a rapid second click by the same client shakes without a second request", async () => {
    const gm = makeClient("gm"); const finish = deferred(); let calls = 0;
    const pending = gm.apply(async () => { calls++; await finish.promise; });
    await flush();
    assert.equal(await gm.apply(async () => { calls++; }), false);
    finish.resolve(); await pending;
    assert.equal(calls, 1); assert.equal(gm.shakes, 1);
});

for (const operation of ["claim", "start", "complete"]) {
    for (const kind of ["request", "reply"]) {
        test(`a lost ${operation} ${kind} retries after one second without repeating HP changes`, async () => {
            makeClient("gm"); const player = makeClient("player");
            const operations = new Map(), retriedIds = [];
            let dropped = false, calls = 0, settled = false;
            state.dropPacket = packet => {
                if (packet.kind === "request") {
                    operations.set(packet.id, packet.operation);
                    if (packet.operation === operation) retriedIds.push(packet.id);
                }
                if (!dropped && packet.kind === kind && operations.get(packet.id) === operation) {
                    dropped = true;
                    return true;
                }
                return false;
            };
            const pending = player.pendingApply(async () => { calls++; }).then(result => { settled = true; return result; });
            await flush();
            assert.equal(dropped, true);
            assert.equal(calls, operation === "complete" ? 1 : 0);
            await advance(999);
            assert.equal(settled, false);
            await advance(1);
            assert.equal(await pending, true);
            assert.equal(calls, 1);
            assert.equal(retriedIds.length, 2);
            assert.equal(new Set(retriedIds).size, 1);
            assert.deepEqual(player.errors, []);
            assert.equal(state.timers.size, 0);
        });
    }
}

test("an unstarted reservation expires at one second and its delayed start cannot apply again", async () => {
    const gm = makeClient("gm"), player = makeClient("player"); let calls = 0;
    state.dropPacket = packet => packet.operation === "start";
    const pending = player.pendingApply(async () => { calls++; });
    await flush();
    await advance(999);
    assert.equal(await gm.pendingApply(async () => { calls++; }), false);
    await advance(1);
    assert.equal(await gm.pendingApply(async () => { calls++; }), true);
    state.dropPacket = () => false;
    await advance(1000);
    assert.equal(await pending, false);
    assert.equal(calls, 1);
    assert.equal(player.shakes, 1);
    assert.equal(gm.dialogs + player.dialogs, 0);
    assert.equal(state.timers.size, 0);
});

test("the final start check catches an applied flag set while the reservation was waiting", async () => {
    makeClient("gm"); const player = makeClient("player");
    state.dropPacket = packet => packet.operation === "start";
    const pending = player.pendingApply(async () => assert.fail("already applied"));
    await flush();
    applied.target = { 0: true };
    state.dropPacket = () => false;
    await advance(1000);
    assert.equal(await pending, false);
    assert.equal(player.shakes, 1);
});

test("an abandoned repeat reservation retains the earlier failed application history", async () => {
    const gm = makeClient("gm");
    const previous = { id: "failed", at: state.now - 5000, userId: "gm", state: "failed" };
    records.set("damageApplications.Scene_scene_Token_target_0", {
        id: "abandoned", at: state.now - 1000, userId: "player", state: "reserved", previous,
    });
    gm.confirm = async () => false;
    assert.equal(await gm.apply(async () => assert.fail("unconfirmed retry")), false);
    assert.equal(gm.dialogs, 1);
});

test("a timed-out unstarted request can be reclaimed without changing HP on the disconnected client", async () => {
    const gm = makeClient("gm"), player = makeClient("player");
    state.dropPacket = packet => packet.kind === "reply";
    const pending = player.pendingApply(async () => assert.fail("no acknowledgement"));
    await flush(); await advance(15000);
    assert.equal(await pending, false);
    assert.ok(player.errors.length);
    assert.equal(state.timers.size, 0);
    assert.equal(await gm.pendingApply(async () => {}), true);
    assert.equal(gm.dialogs, 0);
});

test("a lost failure acknowledgement retries without running the failed HP operation again", async () => {
    makeClient("gm"); const player = makeClient("player"); let dropped = false, calls = 0;
    state.dropPacket = packet => {
        if (!dropped && packet.kind === "reply" && packet.status === "failed") {
            dropped = true;
            return true;
        }
        return false;
    };
    const pending = player.pendingApply(async () => { calls++; throw Error("interrupted HP update"); });
    await flush(); await advance(1000);
    assert.equal(await pending, false);
    assert.equal(calls, 1);
    assert.equal(records.get("damageApplications.Scene_scene_Token_target_0").state, "failed");
    assert.equal(state.timers.size, 0);
});

test("a slow player HP operation remains exclusive while the one-second retry clock advances", async () => {
    const gm = makeClient("gm"), player = makeClient("player"), finish = deferred(); let calls = 0;
    const pending = player.pendingApply(async () => { calls++; await finish.promise; });
    await flush(); await advance(5000);
    assert.equal(await gm.pendingApply(async () => { calls++; }), false);
    finish.resolve();
    assert.equal(await pending, true);
    assert.equal(calls, 1);
    assert.equal(state.timers.size, 0);
});

test("1999 ms is silent; 2000 ms requires confirmation; cancellation does nothing", async () => {
    const gm = makeClient("gm"), player = makeClient("player"); let calls = 0;
    await gm.apply(async () => { calls++; }); state.now += 1999;
    assert.equal(await player.apply(async () => { calls++; }), false);
    assert.equal(player.shakes, 1); assert.equal(player.dialogs, 0);
    state.now++;
    assert.equal(await player.apply(async () => { calls++; }), false);
    assert.equal(player.dialogs, 0); assert.equal(calls, 1);
    gm.confirm = async () => false;
    assert.equal(await gm.apply(async () => { calls++; }), false);
    assert.equal(gm.dialogs, 1); assert.equal(calls, 1);
    gm.confirm = async () => true;
    assert.equal(await gm.apply(async () => { calls++; }), true);
    assert.equal(calls, 2);
});

test("a stale confirmation cannot bypass another client's intervening application", async () => {
    const gm = makeClient("gm");
    const otherUser = users.find(user => user.id === "other"); otherUser.isGM = true;
    const player = makeClient("other"); let calls = 0;
    await gm.apply(async () => { calls++; }); state.now += 2001;
    const confirmation = deferred(); player.confirm = () => confirmation.promise;
    const pending = player.apply(async () => { calls++; }); await flush();
    assert.equal(player.dialogs, 1);
    await gm.apply(async () => { calls++; });
    confirmation.resolve(true);
    assert.equal(await pending, false); assert.equal(calls, 2); assert.equal(player.shakes, 1);
    otherUser.isGM = false;
});

test("a long-running application stays locked beyond two seconds", async () => {
    const gm = makeClient("gm"), player = makeClient("player"); const finish = deferred();
    const pending = gm.apply(async () => { await finish.promise; }); await flush(); state.now += 30_000;
    assert.equal(await player.apply(async () => assert.fail("duplicate")), false);
    finish.resolve(); await pending;
    assert.equal(player.shakes, 1);
});

test("a new GM uses the persisted history instead of forgetting a previous application", async () => {
    const gm = makeClient("gm"); const otherUser = users.find(user => user.id === "other"); otherUser.isGM = true;
    const other = makeClient("other");
    await gm.apply(async () => {}); state.activeGM = "other";
    assert.equal(await other.apply(async () => assert.fail("duplicate")), false);
    state.now += 2001; other.confirm = async () => false;
    assert.equal(await other.apply(async () => assert.fail("cancelled")), false);
    assert.equal(other.dialogs, 1); otherUser.isGM = false;
});

test("an old applied flag without a timestamp still requires confirmation", async () => {
    const gm = makeClient("gm"); applied.target = { 0: true }; gm.confirm = async () => false;
    assert.equal(await gm.apply(async () => assert.fail("duplicate")), false);
    assert.equal(gm.dialogs, 1);
});

test("unowned tokens and missing GMs fail closed before HP can change", async () => {
    makeClient("gm"); const other = makeClient("other");
    assert.equal(await other.apply(async () => assert.fail("unowned")), false);
    state.activeGM = null;
    const player = makeClient("player");
    assert.equal(await player.apply(async () => assert.fail("no GM")), false);
    assert.ok(other.errors.length); assert.ok(player.errors.length);
});

test("failed HP operations retain history and require a later explicit retry", async () => {
    const gm = makeClient("gm");
    assert.equal(await gm.apply(async () => { throw Error("actor update failed"); }), false);
    assert.equal(applied.target, undefined);
    assert.equal(await gm.apply(async () => assert.fail("rapid retry")), false);
    state.now += 2001;
    assert.equal(await gm.apply(async () => {}), true);
    assert.equal(gm.dialogs, 1);
    assert.equal(records.get("damageApplications.Scene_scene_Token_target_0").previous, null);
});

test("a stale pending-panel click never offers an override, even to a GM after two seconds", async () => {
    const gm = makeClient("gm");
    await gm.pendingApply(async () => {}); state.now += 2001;
    assert.equal(await gm.pendingApply(async () => assert.fail("panel duplicate")), false);
    assert.equal(gm.dialogs, 0); assert.equal(gm.shakes, 1);
    assert.equal(await gm.apply(async () => {}), true);
    assert.equal(gm.dialogs, 1);
});

test("concurrent main and splash applications share their reservation", async () => {
    const gm = makeClient("gm"), player = makeClient("player");
    gm.splashIndex = player.splashIndex = 1;
    let calls = 0;
    const results = await Promise.all([
        gm.guard.run(gm.message, gm.token, 0, async () => calls++),
        player.guard.run(player.message, player.token, 1, async () => calls++),
    ]);
    assert.equal(calls, 1); assert.equal(results.filter(Boolean).length, 1);
    assert.equal(applied.target[0], true); assert.equal(applied.target[1], true);
});

test("completed receipts still block after another Toolbelt flag rewrite", async () => {
    const gm = makeClient("gm"), player = makeClient("player");
    gm.splashIndex = player.splashIndex = 1;
    await gm.pendingApply(async () => {});
    state.applied = {}; state.now += 5000;
    assert.equal(await player.guard.run(player.message, player.token, 1, async () => assert.fail("splash already consumed")), false);
});

test("blind or whispered damage cannot be claimed by a player outside its audience", async () => {
    const gm = makeClient("gm"), player = makeClient("player");
    gm.message.blind = true;
    assert.equal(await player.pendingApply(async () => assert.fail("blind roll")), false);
    gm.message.blind = false; gm.message.whisper = ["gm"];
    assert.equal(await player.pendingApply(async () => assert.fail("private roll")), false);
});
