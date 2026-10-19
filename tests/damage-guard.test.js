import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { addMessage, advance, applied, claims, deferred, flush, join, makeClient, reset, state, until, user } from "./helpers/guard-harness.js";

beforeEach(reset);
const requests = (operation, kind = "request") => state.packets.filter(({ packet }) =>
    packet.kind === kind && (kind === "reply" || packet.operation === operation));
const outcomes = () => claims().map(claim => claim.outcome ?? "pending");

test("simultaneous GM and owner clicks change HP exactly once and tell the loser", async () => {
    const [gm, player] = await join("gm", "player");
    let hp = 100;
    const results = await Promise.all([gm.apply(async () => { hp -= 12; }), player.apply(async () => { hp -= 12; })]);
    assert.equal(hp, 88);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(gm.shakes + player.shakes, 1);
    assert.equal(gm.dialogs + player.dialogs, 0);
    const loser = results[0] ? player : gm;
    assert.ok(loser.noted("sync.busy") || loser.noted("sync.applied"));
    assert.deepEqual(outcomes(), ["applied"]);
    assert.deepEqual(applied(), { target: { 0: true } });
});

test("two owning players cannot apply the same healing twice", async () => {
    state.owners.add("other");
    const [, player, other] = await join("gm", "player", "other");
    let hp = 50;
    await Promise.all([player.apply(async () => { hp += 12; }), other.apply(async () => { hp += 12; })]);
    assert.equal(hp, 62);
    assert.equal(player.shakes + other.shakes, 1);
});

test("a rapid second click by the same client shakes without a second request", async () => {
    const [gm] = await join("gm");
    const finish = deferred(); let calls = 0;
    const pending = gm.apply(async () => { calls++; await finish.promise; });
    await flush();
    assert.equal(await gm.apply(async () => { calls++; }), false);
    finish.resolve(); await pending;
    assert.equal(calls, 1); assert.equal(gm.shakes, 1); assert.deepEqual(gm.notes, []);
});

test("Dice So Nice style roll annotations cannot fail an application", async () => {
    // The roll signature is the controller's concern; the guard never inspects rolls.
    const [gm] = await join("gm");
    state.message.rolls[0].dsnRoleManaged = true;
    assert.equal(await gm.apply(async () => {}), true);
    assert.deepEqual(gm.notes, []);
});

for (const operation of ["claim", "release"]) {
    for (const kind of ["request", "reply"]) {
        test(`a lost ${operation} ${kind} retries after one second without repeating HP changes`, async () => {
            const [, player] = await join("gm", "player");
            const operations = new Map();
            let dropped = false, calls = 0, settled = false;
            state.dropPacket = packet => {
                if (packet.kind === "request") operations.set(packet.id, packet.operation);
                if (!dropped && packet.kind === kind && operations.get(packet.id) === operation) return dropped = true;
                return false;
            };
            const pending = player.pendingApply(async () => { calls++; }).then(result => { settled = true; return result; });
            await flush();
            assert.equal(dropped, true);
            assert.equal(calls, operation === "release" ? 1 : 0);
            await advance(999);
            assert.equal(settled, false);
            await advance(1);
            assert.equal(await pending, true);
            assert.equal(calls, 1);
            assert.equal(new Set(requests(operation).map(({ packet }) => packet.id)).size, 1);
            assert.equal(requests(operation).length, 2);
            assert.deepEqual(outcomes(), ["applied"]);
            assert.deepEqual(player.errors, []);
            assert.equal(state.timers.size, 0);
        });
    }
}

test("an unanswered claim times out, is withdrawn, and never blocks a later application", async () => {
    const [gm, player] = await join("gm", "player");
    let replies = false, calls = 0;
    state.dropPacket = packet => packet.kind === "reply" && !replies;
    const pending = player.pendingApply(async () => { calls++; });
    await flush(); await advance(20_000);
    assert.equal(await pending, false);
    assert.ok(player.noted("sync.timeout"));
    assert.equal(calls, 0);
    // The coordinator granted it, but the client withdrew instead of applying late.
    assert.deepEqual(outcomes(), ["void"]);
    replies = true; await advance(1000);
    assert.equal(state.timers.size, 0);
    state.now += 2000;
    assert.equal(await gm.pendingApply(async () => { calls++; }), true);
    assert.equal(calls, 1); assert.equal(gm.dialogs, 0);
});

test("a claim withdrawn before the coordinator saw it is refused when it finally arrives", async () => {
    const [gm, player] = await join("gm", "player");
    const held = [];
    state.dropPacket = (packet, client) => {
        if (client === player && packet.operation === "claim") { held.push(packet); return true; }
        return false;
    };
    const pending = player.pendingApply(async () => assert.fail("timed out"));
    await flush(); await advance(20_000);
    assert.equal(await pending, false);
    await advance(1000);
    // A delayed copy of the claim is delivered after the withdrawal.
    for (const listener of gm.listeners.get("module.pf2e-pending-damage")) listener({ ...held[0], sentAt: state.now }, "player");
    await flush();
    assert.deepEqual(claims(), []);
    assert.equal(state.timers.size, 0);
});

test("no GM fails immediately with an accurate message and sends nothing", async () => {
    const [player] = await join("player");
    assert.equal(await player.pendingApply(async () => assert.fail("no GM")), false);
    assert.ok(player.noted("sync.noGM"));
    assert.equal(state.packets.filter(({ packet }) => packet.kind === "request").length, 0);
    assert.equal(state.timers.size, 0);
});

test("a GM that connects while a player waits still serves the request", async () => {
    const [player] = await join("player");
    const gm = makeClient("gm");
    const pending = player.pendingApply(async () => {});
    await advance(6000);
    assert.equal(await pending, true);
    assert.deepEqual(outcomes(), ["applied"]);
    assert.ok(gm.guard);
});

test("a client that vanishes after its grant blocks the target, then only a GM may reapply", async () => {
    state.owners.add("other");
    const [gm, player, other] = await join("gm", "player", "other");
    const stuck = player.pendingApply(() => new Promise(() => {}));
    await flush();
    player.close({ graceful: false });
    assert.equal(await other.pendingApply(async () => assert.fail("in progress")), false);
    assert.ok(other.noted("sync.busy"));
    gm.confirm = async () => false;
    assert.equal(await gm.apply(async () => assert.fail("in progress")), false);
    assert.equal(gm.dialogs, 0);
    await advance(30_000);
    assert.equal(await other.pendingApply(async () => assert.fail("uncertain")), false);
    assert.ok(other.noted("sync.interrupted"));
    assert.equal(await gm.apply(async () => assert.fail("declined")), false);
    assert.equal(gm.dialogs, 1);
    assert.match(gm.lastDialog.content, /repeat\.uncertain/);
    gm.confirm = async () => true;
    let calls = 0;
    assert.equal(await gm.apply(async () => calls++), true);
    assert.equal(calls, 1);
    void stuck;
});

test("a target held by a crashed client unlocks after five seconds", async () => {
    state.owners.add("other");
    const [gm, player, other] = await join("gm", "player", "other");
    void player.pendingApply(() => new Promise(() => {}));
    await flush();
    player.close({ graceful: false });
    await advance(4999);
    gm.confirm = async () => false;
    assert.equal(await gm.apply(async () => assert.fail("in progress")), false);
    assert.equal(gm.dialogs, 0);
    await advance(1);
    assert.equal(await gm.apply(async () => assert.fail("declined")), false);
    assert.equal(gm.dialogs, 1);
    assert.equal(await other.pendingApply(async () => assert.fail("interrupted")), false);
    assert.ok(other.noted("sync.interrupted"));
});

test("a grant that arrives late is withdrawn, and a fresh claim applies once", async () => {
    const [, player] = await join("gm", "player");
    let held = true, calls = 0;
    const replies = [];
    state.dropPacket = packet => {
        if (held && packet.kind === "reply" && packet.status === "granted") { replies.push(packet); return true; }
        return false;
    };
    const pending = player.pendingApply(async () => calls++);
    await advance(2000);
    // The first grant finally arrives, older than half the lease.
    held = false;
    await advance(600);
    for (const fn of player.listeners.get("module.pf2e-pending-damage")) fn(replies[0], "gm");
    await advance(3000);
    assert.equal(await pending, true);
    assert.equal(calls, 1);
    assert.deepEqual(outcomes().sort(), ["applied", "void"]);
    assert.deepEqual(player.notes, []);
});

test("a claim whose every grant is lost past its lease is withdrawn, then claimed afresh", async () => {
    const [, player] = await join("gm", "player");
    let drop = true, calls = 0;
    state.dropPacket = packet => drop && packet.kind === "reply" && packet.status === "granted";
    const pending = player.pendingApply(async () => calls++);
    await advance(5500);
    drop = false;
    await advance(3000);
    assert.equal(await pending, true);
    assert.equal(calls, 1);
    assert.deepEqual(outcomes().sort(), ["applied", "void"]);
});

test("a link too slow to use any grant in time fails safely", async () => {
    const [gm] = await join("gm");
    const player = makeClient("player", { latency: 2900 });
    await advance(6000);
    let calls = 0;
    const pending = player.pendingApply(async () => calls++);
    await advance(60_000);
    assert.equal(await pending, false);
    assert.equal(calls, 0);
    assert.ok(player.noted("sync.slow"));
    await advance(30_000);
    assert.ok(outcomes().every(outcome => outcome === "void"), JSON.stringify(outcomes()));
    state.now += 2000;
    assert.equal(await gm.pendingApply(async () => {}), true);
});

test("an application slower than its lease is still recorded when it completes", async () => {
    const [gm, player] = await join("gm", "player");
    const finish = deferred();
    const pending = player.pendingApply(() => finish.promise);
    await flush(); await advance(40_000);
    finish.resolve();
    assert.equal(await pending, true);
    assert.deepEqual(outcomes(), ["applied"]);
    state.now += 2000;
    gm.confirm = async () => false;
    assert.equal(await gm.apply(async () => assert.fail("declined")), false);
    assert.match(gm.lastDialog.content, /repeat\.applied/);
});

test("a running application stays locked beyond two seconds, for up to five", async () => {
    const [gm, player] = await join("gm", "player");
    const finish = deferred();
    const pending = gm.apply(() => finish.promise);
    await flush(); state.now += 4999;
    assert.equal(await player.apply(async () => assert.fail("duplicate")), false);
    finish.resolve(); await pending;
    assert.equal(player.shakes, 1);
});

test("a failed HP operation is recorded: players are told to ask the GM, who may retry", async () => {
    const [gm, player] = await join("gm", "player");
    assert.equal(await player.pendingApply(async () => { throw Error("actor update failed"); }), false);
    assert.ok(player.noted("sync.failed"));
    assert.deepEqual(outcomes(), ["failed"]);
    assert.deepEqual(applied(), {});
    assert.equal(await player.pendingApply(async () => assert.fail("rapid retry")), false);
    state.now += 2001;
    assert.equal(await player.apply(async () => assert.fail("player retry")), false);
    assert.ok(player.noted("sync.interrupted"));
    assert.equal(await gm.apply(async () => {}), true);
    assert.equal(gm.dialogs, 1);
    assert.match(gm.lastDialog.content, /repeat\.failed/);
});

test("an error before PF2e changes HP withdraws the claim instead of blocking players", async () => {
    const [, player] = await join("gm", "player");
    const invalid = async () => { throw Object.assign(new Error("Invalid damage application"), { untouched: true }); };
    assert.equal(await player.pendingApply(invalid), false);
    assert.ok(player.noted("sync.invalid"));
    assert.deepEqual(outcomes(), ["void"]);
    state.now += 2001;
    assert.equal(await player.pendingApply(async () => {}), true);
});

test("a source or target change before application withdraws the claim without history", async () => {
    const [gm] = await join("gm");
    assert.equal(await gm.apply(async () => assert.fail("changed"), { verify: () => "sync.changed" }), false);
    assert.ok(gm.noted("sync.changed"));
    assert.deepEqual(outcomes(), ["void"]);
    state.now += 2001;
    assert.equal(await gm.pendingApply(async () => {}), true);
    assert.equal(gm.dialogs, 0);
});

test("1999 ms is silent; 2000 ms requires confirmation; cancellation does nothing", async () => {
    const [gm, player] = await join("gm", "player");
    let calls = 0;
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
    assert.deepEqual(outcomes(), ["applied", "applied"]);
});

test("a GM's own double click within two seconds only shakes", async () => {
    const [gm] = await join("gm");
    await gm.apply(async () => {}); state.now += 500;
    assert.equal(await gm.apply(async () => assert.fail("double click")), false);
    assert.equal(gm.shakes, 1); assert.deepEqual(gm.notes, []);
});

test("a stale confirmation cannot bypass another GM's intervening application", async () => {
    const [gm, assistant] = await join("gm", "assistant");
    let calls = 0;
    await gm.apply(async () => { calls++; }); state.now += 2001;
    const confirmation = deferred(); assistant.confirm = () => confirmation.promise;
    const pending = assistant.apply(async () => { calls++; }); await flush();
    assert.equal(assistant.dialogs, 1);
    await gm.apply(async () => { calls++; });
    state.now += 2001;
    confirmation.resolve(true);
    assert.equal(await pending, false); assert.equal(calls, 2);
    assert.ok(assistant.noted("sync.superseded"));
});

test("a new coordinator uses the persisted history instead of forgetting an application", async () => {
    const [gm, assistant] = await join("gm", "assistant");
    await gm.apply(async () => {});
    gm.close();
    await advance(5000);
    assert.equal(await assistant.apply(async () => assert.fail("duplicate")), false);
    assistant.confirm = async () => false;
    assert.equal(await assistant.apply(async () => assert.fail("cancelled")), false);
    assert.equal(assistant.dialogs, 1);
});

test("an old Toolbelt applied flag without a record still requires confirmation", async () => {
    const [gm] = await join("gm");
    state.flags["pf2e-toolbelt"].targetHelper.applied.target = { 0: true };
    gm.docs.get("message")["pf2e-toolbelt"].targetHelper.applied.target = { 0: true };
    gm.confirm = async () => false;
    assert.equal(await gm.apply(async () => assert.fail("duplicate")), false);
    assert.equal(gm.dialogs, 1);
    assert.match(gm.lastDialog.content, /repeat\.content/);
});

test("version 1 records keep protecting the rolls they describe", async () => {
    const [gm, player] = await join("gm", "player");
    const legacy = { "pf2e-pending-damage": { damageApplications: {
        Scene_scene_Token_target_0: { id: "old", at: state.now - 60_000, userId: "player", state: "applied", footprint: ["scene.target.0"] },
        Scene_scene_Token_target_1: { id: "unstarted", at: state.now - 60_000, userId: "player", state: "reserved", previous: null },
    } } };
    for (const flags of [state.flags, ...state.clients.map(client => client.docs.get("message"))]) Object.assign(flags, structuredClone(legacy));
    assert.equal(await player.pendingApply(async () => assert.fail("applied in version 1")), false);
    assert.ok(player.noted("sync.applied"));
    assert.equal(await player.run(async () => {}, { allowRepeat: false }, { rollIndex: 1 }), true);
    void gm;
});

test("unowned tokens are denied with the reason", async () => {
    const [, other] = await join("gm", "other");
    assert.equal(await other.apply(async () => assert.fail("unowned")), false);
    assert.ok(other.noted("sync.notOwner"));
    assert.deepEqual(claims(), []);
});

test("blind or whispered damage cannot be claimed by a player outside its audience", async () => {
    const [, player] = await join("gm", "player");
    state.message.blind = true;
    assert.equal(await player.pendingApply(async () => assert.fail("blind roll")), false);
    state.message.blind = false; state.message.whisper = ["gm"];
    assert.equal(await player.pendingApply(async () => assert.fail("private roll")), false);
    assert.equal(player.notes.filter(([, key]) => key === "sync.hidden").length, 2);
});

test("a stale pending-panel click never offers an override, even to a GM after two seconds", async () => {
    const [gm] = await join("gm");
    await gm.pendingApply(async () => {}); state.now += 2001;
    assert.equal(await gm.pendingApply(async () => assert.fail("panel duplicate")), false);
    assert.equal(gm.dialogs, 0); assert.equal(gm.shakes, 1);
    assert.equal(await gm.apply(async () => {}), true);
    assert.equal(gm.dialogs, 1);
});

test("concurrent main and splash applications share their reservation", async () => {
    const [gm, player] = await join("gm", "player");
    state.flags["pf2e-toolbelt"].targetHelper.splashIndex = 1;
    for (const client of [gm, player]) client.docs.get("message")["pf2e-toolbelt"].targetHelper.splashIndex = 1;
    let calls = 0;
    const results = await Promise.all([
        gm.run(async () => calls++, {}, { rollIndex: 0 }),
        player.run(async () => calls++, {}, { rollIndex: 1 }),
    ]);
    assert.equal(calls, 1); assert.equal(results.filter(Boolean).length, 1);
    assert.equal(applied().target[0], true); assert.equal(applied().target[1], true);
});

test("completed receipts still block after another Toolbelt flag rewrite", async () => {
    const [gm, player] = await join("gm", "player");
    for (const flags of [state.flags, gm.docs.get("message"), player.docs.get("message")]) flags["pf2e-toolbelt"].targetHelper.splashIndex = 1;
    await gm.pendingApply(async () => {});
    for (const flags of [state.flags, gm.docs.get("message"), player.docs.get("message")]) flags["pf2e-toolbelt"].targetHelper.applied = {};
    state.now += 5000;
    assert.equal(await player.run(async () => assert.fail("splash already consumed"), { allowRepeat: false }, { rollIndex: 1 }), false);
});

test("a player application sends two requests, and replies go only to their recipient", async () => {
    const [, player, observer] = await join("gm", "player", "other");
    state.packets.length = 0;
    let observed = 0;
    const listener = observer.listeners.get("module.pf2e-pending-damage");
    observer.listeners.set("module.pf2e-pending-damage", listener.map(fn => (...args) => { observed++; fn(...args); }));
    assert.equal(await player.pendingApply(async () => {}), true);
    assert.equal(state.packets.length, 4);
    for (const { sender, packet, recipients } of state.packets) {
        assert.deepEqual([...recipients], [packet.kind === "request" ? "gm" : "player"]);
        assert.equal(sender, packet.kind === "request" ? "player" : "gm");
    }
    assert.equal(observed, 0);
    await advance(30_000);
    assert.equal(state.packets.length, 4);
    assert.equal(state.timers.size, 0);
});

test("retries during a slow GM write share one operation and produce one reply", async () => {
    const [, player] = await join("gm", "player");
    const gate = deferred();
    let writes = 0, calls = 0;
    state.beforeWrite = async () => { if (++writes === 1) await gate.promise; };
    const pending = player.pendingApply(async () => calls++);
    await flush(); await advance(2500);
    assert.equal(writes, 1);
    assert.equal(requests("claim").length, 3);
    gate.resolve();
    assert.equal(await pending, true);
    assert.equal(requests("claim", "reply").filter(({ packet }) => packet.id === requests("claim")[0].packet.id).length, 1);
    assert.equal(writes, 2); // Claim and release, regardless of the number of retries.
    assert.equal(calls, 1);
    assert.equal(state.timers.size, 0);
});

test("a stalled message does not block damage on another message", async () => {
    addMessage("other-message");
    const [gm] = await join("gm");
    const gate = deferred();
    state.beforeWrite = async (_client, _updates, id) => { if (id === "message") await gate.promise; };
    const stalled = gm.pendingApply(async () => {});
    await flush();
    let calls = 0;
    assert.equal(await gm.run(async () => calls++, {}, { message: gm.messages.get("other-message") }), true);
    assert.equal(calls, 1);
    gate.resolve();
    assert.equal(await stalled, true);
});

test("a coordinator whose own write stalls times out and never applies from its late result", async () => {
    const [gm] = await join("gm");
    const gate = deferred();
    let calls = 0, stall = true;
    state.beforeWrite = async () => { if (stall) await gate.promise; };
    const pending = gm.pendingApply(async () => calls++);
    await flush(); await advance(20_000);
    assert.equal(await pending, false);
    assert.ok(gm.noted("sync.timeout"));
    stall = false; gate.resolve(); await advance(2000);
    assert.equal(calls, 0);
    assert.deepEqual(outcomes(), ["void"]);
    assert.equal(await gm.pendingApply(async () => calls++), true);
    assert.equal(calls, 1);
    assert.equal(state.timers.size, 0);
});

test("a disconnected client does not buffer retries and can resume before timeout", async () => {
    const [, player] = await join("gm", "player");
    state.packets.length = 0;
    player.connected = false;
    const pending = player.pendingApply(async () => {});
    await flush(); await advance(5000);
    assert.equal(state.packets.length, 0);
    player.connected = true;
    await advance(1000);
    assert.equal(await pending, true);
    assert.equal(state.packets.length, 4);
    assert.equal(state.timers.size, 0);
});

test("a socket emit failure clears all request timers", async () => {
    const [, player] = await join("gm", "player");
    player.socket.emit = () => { throw Error("socket unavailable"); };
    assert.equal(await player.pendingApply(async () => assert.fail("no request sent")), false);
    assert.ok(player.noted("sync.error"));
    await advance(1000);
    assert.equal(state.timers.size, 0);
});

test("a synchronous reply cannot leave a retry timer running", async () => {
    const [, player] = await join("gm", "player");
    player.socket.emit = (_channel, packet) => {
        for (const fn of player.listeners.get("module.pf2e-pending-damage")) {
            fn({ ...packet, kind: "reply", to: packet.from, status: "blocked", reason: "busy", userId: "gm" }, "gm");
        }
    };
    assert.equal(await player.pendingApply(async () => assert.fail("blocked")), false);
    assert.equal(state.timers.size, 0);
});

test("a reply for another session of the same user is ignored", async () => {
    const [, player] = await join("gm", "player");
    const twin = makeClient("player", { label: "player-tab" });
    await flush();
    let calls = 0;
    const [first, second] = await Promise.all([player.pendingApply(async () => calls++), twin.pendingApply(async () => calls++)]);
    assert.equal(calls, 1);
    assert.equal(Number(first) + Number(second), 1);
});

// Multiple GM browser sessions.

test("two sessions of one GM account elect one coordinator; simultaneous clicks change HP once", async () => {
    const [laptop, player] = await join("gm", "player");
    const tv = makeClient("gm", { label: "tv" });
    await advance(5000);
    assert.equal(laptop.guard.coordinator.isCoordinator(), true);
    assert.equal(tv.guard.coordinator.isCoordinator(), false);
    let hp = 100;
    const results = await Promise.all([laptop, tv, player].map(client => client.apply(async () => { hp -= 7; })));
    assert.equal(hp, 93);
    assert.equal(results.filter(Boolean).length, 1);
    assert.deepEqual([...new Set(state.writes.map(write => write.session))], ["gm"]);
    assert.equal(claims().length, 1);
});

test("a newer GM session never takes over a working coordinator", async () => {
    const [first] = await join("gm");
    const second = makeClient("gm2");
    await advance(10_000);
    assert.equal(first.guard.coordinator.isCoordinator(), true);
    assert.equal(second.guard.coordinator.isCoordinator(), false);
    assert.equal(second.guard.coordinator.leader.sessionId, first.guard.coordinator.sessionId);
});

test("a GM session on a slow link never serves requests before it hears from the coordinator", async () => {
    state.owners.add("other");
    const [laptop, player, other] = await join("gm", "player", "other");
    const tv = makeClient("gm", { label: "tv", latency: 900 });
    let hp = 100;
    const pending = Promise.all([player, other].map(client => client.pendingApply(async () => { hp -= 4; })));
    await advance(25_000);
    assert.equal((await pending).filter(Boolean).length, 1);
    assert.equal(hp, 96);
    assert.ok(state.writes.every(write => write.session === "gm"));
    assert.equal(tv.guard.coordinator.isCoordinator(), false);
    void laptop;
});

test("a full GM outranks an assistant regardless of who joined first", async () => {
    const [assistant] = await join("assistant");
    const gm = makeClient("gm");
    await advance(6000);
    assert.equal(gm.guard.coordinator.isCoordinator(), true);
    assert.equal(assistant.guard.coordinator.isCoordinator(), false);
});

test("closing the coordinator's tab hands over to the remaining GM session", async () => {
    const [laptop, tv, player] = await join("gm", "gm", "player");
    laptop.close();
    const pending = player.pendingApply(async () => {});
    await advance(6000);
    assert.equal(await pending, true);
    assert.equal(tv.guard.coordinator.isCoordinator(), true);
    assert.equal(state.writes.at(-1).session, "gm");
    assert.ok(user("gm").active);
});

test("a coordinator that silently disappears is replaced before requests time out", async () => {
    const [laptop, tv, player] = await join("gm", "gm", "player");
    laptop.close({ graceful: false });
    let calls = 0;
    const pending = player.pendingApply(async () => calls++);
    await advance(15_000);
    assert.equal(await pending, true);
    assert.equal(calls, 1);
    assert.equal(tv.guard.coordinator.isCoordinator(), true);
});

test("a frozen coordinator that missed its ping steps down when it thaws", async () => {
    state.owners.add("other");
    const [laptop, tv, player, other] = await join("gm", "gm", "player", "other");
    let hp = 100;
    laptop.freeze();
    const first = player.pendingApply(async () => { hp -= 5; });
    await advance(12_000);
    assert.equal(await first, true);
    assert.equal(tv.guard.coordinator.isCoordinator(), true);
    // The old coordinator works through its backlog, then rejoins as the newest session.
    const second = other.pendingApply(async () => { hp -= 5; });
    await laptop.thaw();
    await advance(10_000);
    assert.equal(await second, false);
    assert.equal(hp, 95);
    assert.equal(laptop.guard.coordinator.isCoordinator(), false);
    assert.equal(tv.guard.coordinator.isCoordinator(), true);
    assert.deepEqual(outcomes(), ["applied"]);
});

for (const thawAt of [5500, 6500, 8000, 10_500, 14_000]) {
    test(`competing clicks queued behind a coordinator frozen for ${thawAt} ms apply once`, async () => {
        state.owners.add("other");
        const [laptop, , player, other] = await join("gm", "gm", "player", "other");
        let hp = 100;
        laptop.freeze();
        const first = player.pendingApply(async () => { hp -= 5; });
        await advance(500);
        const second = other.pendingApply(async () => { hp -= 5; });
        await advance(thawAt - 500);
        await laptop.thaw();
        await advance(25_000);
        const results = await Promise.all([first, second]);
        assert.equal(results.filter(Boolean).length, 1);
        assert.equal(hp, 95);
        assert.equal(claims().filter(claim => claim.outcome === "applied").length, 1);
    });
}

test("a coordinator ignores requests sent more than three seconds ago", async () => {
    const [gm, player] = await join("gm", "player");
    const request = { __type__: "damageGuard", v: 2, kind: "request", operation: "claim", from: player.guard.coordinator.sessionId,
        messageId: "message", tokenUuid: player.token.uuid, rollIndex: 0, allowRepeat: false };
    const deliver = packet => { for (const fn of gm.listeners.get("module.pf2e-pending-damage")) fn(packet, "player"); };
    deliver({ ...request, id: "stale", sentAt: state.now - 3001 });
    await flush();
    assert.deepEqual(claims(), []);
    deliver({ ...request, id: "fresh", sentAt: state.now - 2500 });
    await flush();
    assert.equal(claims().length, 1);
});

test("a takeover waits out the previous coordinator's last possible writes", async () => {
    const [laptop, , player] = await join("gm", "gm", "player");
    laptop.close({ graceful: false });
    const clicked = state.now;
    const pending = player.pendingApply(async () => {});
    await advance(15_000);
    assert.equal(await pending, true);
    // Three unanswered retries, a three-second ping, then five seconds of settling.
    assert.ok(claims()[0].at - clicked >= 10_000, `granted after ${claims()[0].at - clicked} ms`);
});

test("a reloading GM still records an application reported while it was away", async () => {
    const [gm, player] = await join("gm", "player");
    const finish = deferred();
    const pending = player.pendingApply(() => finish.promise);
    await flush();
    gm.close();
    finish.resolve();
    await advance(20_000);
    assert.equal(await pending, true);
    assert.ok(player.noted("sync.unrecorded"));
    makeClient("gm", { label: "gm-reloaded" });
    await advance(10_000);
    assert.deepEqual(outcomes(), ["applied"]);
    assert.deepEqual(applied(), { target: { 0: true } });
    assert.equal(state.timers.size, 0);
});

test("remote latency and jitter still apply each roll exactly once", async () => {
    state.owners.add("other");
    const [gm] = await join("gm");
    const player = makeClient("player", { latency: 180 }), other = makeClient("other", { latency: 450 });
    await advance(1000);
    let hp = 100;
    const pending = Promise.all([player, other, gm].map(client => client.apply(async () => { hp -= 3; })));
    await advance(20_000);
    assert.equal((await pending).filter(Boolean).length, 1);
    assert.equal(hp, 97);
    assert.equal(state.timers.size, 0);
});

test("a GM whose module socket is not relayed is told to relaunch the world", async () => {
    const [working] = await join("gm");
    await advance(10_000);
    assert.deepEqual(working.notes, []);
    state.dropPacket = (packet, client) => client.label === "broken";
    const broken = makeClient("gm2", { label: "broken" });
    await advance(10_000);
    assert.ok(broken.noted("socketUnavailable"));
});

test("a protocol mismatch is reported instead of timing out", async () => {
    const [gm, player] = await join("gm", "player");
    player.socket.emit = ((emit) => (channel, packet, options) => emit(channel, { ...packet, v: 3 }, options))(player.socket.emit);
    assert.equal(await player.pendingApply(async () => assert.fail("mismatch")), false);
    assert.ok(player.noted("sync.version"));
    void gm;
});

// Stale views, clocks and slow links: each was reproduced as a failure before its fix.

const setSplash = index => {
    for (const flags of [state.flags, ...state.clients.map(client => client.docs.get("message"))]) {
        flags["pf2e-toolbelt"].targetHelper.splashIndex = index;
    }
};

test("a GM that missed updates while offline decides from the server's copy, not its own", async () => {
    const [gm, assistant, player] = await join("gm", "assistant", "player");
    let hp = 100;
    gm.disconnect();
    await advance(5000);
    assert.equal(assistant.guard.coordinator.isCoordinator(), true);
    assert.equal(await player.pendingApply(async () => { hp -= 12; }), true);
    gm.reconnect();
    await advance(6000);
    assert.equal(gm.guard.coordinator.isCoordinator(), true);
    // Its own copy still shows nothing applied.
    assert.equal(gm.docs.get("message")["pf2e-pending-damage"], undefined);
    gm.confirm = async () => false;
    assert.equal(await until(gm.apply(async () => { hp -= 12; })), false);
    assert.equal(gm.dialogs, 1);
    state.now += 2001;
    assert.equal(await until(player.pendingApply(async () => { hp -= 12; })), false);
    assert.equal(hp, 88);
});

test("an outcome reported to a coordinator with a stale copy is still recorded", async () => {
    const [gm, , player] = await join("gm", "assistant", "player");
    gm.disconnect();
    await advance(5000);
    const finish = deferred();
    const pending = player.pendingApply(() => finish.promise);
    await advance(500);
    gm.reconnect();
    await advance(6000);
    finish.resolve();
    assert.equal(await until(pending), true);
    await advance(1000);
    assert.deepEqual(outcomes(), ["applied"]);
    assert.deepEqual(applied(), { target: { 0: true } });
});

for (const [label, setup] of [
    ["while disconnected from a GM and assistant", async () => {
        const [gm, assistant, player] = await join("gm", "assistant", "player");
        return { gm, other: assistant, player, cut: () => gm.disconnect(), restore: () => gm.reconnect(), wait: 5000 };
    }],
    ["while one of two tabs of a GM account is disconnected", async () => {
        const [laptop, tv, player] = await join("gm", "gm", "player");
        return { gm: laptop, other: tv, player, cut: () => laptop.disconnect(), restore: () => laptop.reconnect(), wait: 12_000 };
    }],
    ["while frozen", async () => {
        const [laptop, tv, player] = await join("gm", "gm", "player");
        return { gm: laptop, other: tv, player, cut: () => laptop.freeze(), restore: () => laptop.thaw(), wait: 12_000, queued: true };
    }],
]) {
    test(`a coordinator's own click made ${label} cannot apply a roll applied meanwhile`, async () => {
        const { gm, other, player, cut, restore, wait, queued } = await setup();
        let hp = 100, gmClick;
        gm.confirm = async () => false;
        cut();
        const click = () => { gmClick = gm.apply(async () => { hp -= 12; }); };
        if (queued) gm.later(click); else click();
        const playerClick = player.pendingApply(async () => { hp -= 12; });
        await advance(wait);
        assert.equal(other.guard.coordinator.isCoordinator(), true);
        assert.equal(await until(playerClick), true);
        await advance(2000);
        await restore();
        await advance(15_000);
        assert.equal(await until(gmClick), false);
        assert.equal(hp, 88);
        assert.deepEqual(outcomes().filter(outcome => outcome === "applied"), ["applied"]);
    });
}

test("a GM tab joining while the coordinator is frozen cannot double-grant with it", async () => {
    state.owners.add("other");
    const [laptop, player, other] = await join("gm", "player", "other");
    laptop.freeze();
    await advance(1000);
    makeClient("gm", { label: "tv" });
    let hp = 100;
    await advance(4700);
    const first = player.pendingApply(async () => { hp -= 12; });
    await advance(400);
    const second = other.pendingApply(async () => { hp -= 12; });
    await advance(100);
    await laptop.thaw();
    await advance(60_000);
    assert.equal([await first, await second].filter(Boolean).length, 1);
    assert.equal(hp, 88);
});

test("an interrupted main roll also blocks the splash roll it consumes", async () => {
    state.owners.add("other");
    const [gm, player, other] = await join("gm", "player", "other");
    setSplash(1);
    let hp = 100;
    void player.run(async () => { hp -= 12; await new Promise(() => {}); }, { allowRepeat: false }, { rollIndex: 0 });
    await flush();
    player.close({ graceful: false });
    await advance(6000);
    assert.equal(await until(other.run(async () => { hp -= 3; }, { allowRepeat: false }, { rollIndex: 1 })), false);
    assert.ok(other.noted("sync.interrupted"));
    gm.confirm = async () => false;
    assert.equal(await until(gm.run(async () => { hp -= 3; }, {}, { rollIndex: 1 })), false);
    assert.match(gm.lastDialog.content, /repeat\.uncertain/);
    assert.equal(hp, 88);
});

test("a retry that crosses a refusal gets the same refusal, leaving no orphan claim", async () => {
    state.owners.add("other");
    const [gm] = await join("gm");
    const player = makeClient("player", { latency: 600 });
    await advance(6000);
    setSplash(1);
    const fail = deferred();
    const gmRun = gm.run(() => fail.promise, {}, { rollIndex: 0 });
    await flush();
    const playerRun = player.run(async () => assert.fail("busy"), { allowRepeat: false }, { rollIndex: 1 });
    await advance(1000);
    fail.reject(new Error("update failed"));
    await advance(2000);
    assert.equal(await until(playerRun), false);
    assert.equal(await gmRun, false);
    await advance(10_000);
    assert.deepEqual(claims().filter(claim => claim.userId === "player"), []);
});

test("a grant that took seconds to write is withdrawn rather than used near its expiry", async () => {
    const [, player] = await join("gm", "player");
    const gate = deferred();
    let writes = 0, started = null;
    state.beforeWrite = async () => { if (++writes === 1) await gate.promise; };
    const clicked = state.now;
    const pending = player.pendingApply(async () => { started = state.now; });
    await advance(4500);
    gate.resolve();
    assert.equal(await until(pending), true);
    assert.ok(started >= clicked + 4500);
    // The grant decided before the slow write is the one withdrawn.
    assert.deepEqual(claims().sort((a, b) => a.at - b.at).map(claim => claim.outcome), ["void", "applied"]);
});

test("claims are timed by server time, so a coordinator with a wrong clock still frees a crashed target", async () => {
    state.owners.add("other");
    const [gm, assistant, player, other] = await join("gm", "assistant", "player", "other");
    assistant.clockSkew = -60_000;
    void player.pendingApply(() => new Promise(() => {}));
    await flush();
    player.close({ graceful: false });
    gm.close();
    await advance(6000);
    assert.equal(assistant.guard.coordinator.isCoordinator(), true);
    assert.equal(await until(other.pendingApply(async () => assert.fail("uncertain"))), false);
    assert.ok(other.noted("sync.interrupted"));
});

test("a backward wall-clock step does not stop the coordinator", async () => {
    const [laptop, , player] = await join("gm", "gm", "player");
    laptop.clockSkew = -60_000;
    let calls = 0;
    assert.equal(await until(player.pendingApply(async () => calls++)), true);
    assert.equal(calls, 1);
    assert.equal(laptop.guard.coordinator.isCoordinator(), true);
});

test("a GM tab on a slow link does not depose a healthy coordinator", async () => {
    const [laptop] = await join("gm");
    const tv = makeClient("gm", { label: "tv", latency: 1600 });
    const player = makeClient("player", { latency: 1100 });
    await advance(10_000);
    for (let i = 0; i < 4; i++) {
        addMessage(`m${i}`);
        const start = state.now;
        assert.equal(await until(player.run(async () => {}, { allowRepeat: false }, { message: player.messages.get(`m${i}`) })), true);
        assert.ok(state.now - start < 10_000, `took ${state.now - start} ms`);
        await advance(10_000);
    }
    assert.equal(state.packets.filter(({ packet }) => packet.kind === "gone").length, 0);
    assert.equal(laptop.guard.coordinator.isCoordinator(), true);
    void tv;
});

test("just after a failed application, others are told it was interrupted, not applied", async () => {
    state.owners.add("other");
    const [, player, other] = await join("gm", "player", "other");
    assert.equal(await player.pendingApply(async () => { throw new Error("actor update failed"); }), false);
    state.now += 500;
    assert.equal(await other.pendingApply(async () => assert.fail()), false);
    assert.ok(other.noted("sync.interrupted"));
});

test("a link over the stale limit is told it is too slow, and its withdrawals stop", async () => {
    const [gm] = await join("gm");
    const player = makeClient("player", { latency: 3100 });
    await advance(6000);
    assert.equal(await until(player.pendingApply(async () => assert.fail()), 60_000), false);
    assert.ok(player.noted("sync.slow"));
    assert.deepEqual(claims(), []);
    // The withdrawal is recorded on its first delivery instead of retrying for minutes.
    await advance(30_000);
    const releases = state.packets.filter(({ packet }) => packet.operation === "release").length;
    await advance(60_000);
    assert.equal(state.packets.filter(({ packet }) => packet.operation === "release").length, releases);
    void gm;
});

test("two sessions that both believe they coordinate cannot both grant", async () => {
    for (const latency of [0, 40, 250]) {
        reset();
        const [laptop, tv, player] = await join("gm", "gm", "player");
        for (const session of [laptop, tv]) {
            session.latency = latency;
            session.confirm = async () => false;
            session.guard.coordinator.isCoordinator = () => true; // Forced split brain.
        }
        let hp = 100;
        const results = await until(Promise.all([laptop, tv, player].map(client => client.apply(async () => { hp -= 5; }))));
        assert.ok(hp >= 95, `latency ${latency}: HP changed ${(100 - hp) / 5} times`);
        assert.ok(results.filter(Boolean).length <= 1);
    }
});
