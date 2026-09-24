import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { reset, hooks, wrappers } from "./helpers/dom-harness.js";

reset();
const { compatibilityError } = await import("../scripts/main.js");
const startup = new Map(hooks);

beforeEach(() => {
    reset();
    game.release = { generation: 14 };
    game.system = { id: "pf2e" };
    game.modules = new Map([
        ["pf2e-toolbelt", { active: true, version: "3.56.3" }],
        ["lib-wrapper", { active: true }], ["pf2e-pending-damage", {}],
    ]);
    game.settings.settings = new Map();
    game.toolbelt = { api: { targetHelper: { getMessageTargets() {} } } };
    globalThis.ChatMessage = class { renderHTML() {} };
    foundry.utils.isNewerVersion = (left, right) => {
        const a = left.split(".").map(Number), b = right.split(".").map(Number);
        const index = a.findIndex((value, i) => value !== b[i]);
        return index !== -1 && a[index] > b[index];
    };
});

test("current dependency contract starts at setup, before chat builds context menus", () => {
    assert.equal(compatibilityError(), null);
    startup.get("setup")[0]();
    assert.ok(wrappers.has("ChatMessage.prototype.renderHTML"));
    assert.ok(hooks.has("getChatMessageContextOptions"));
    assert.equal(typeof game.modules.get("pf2e-pending-damage").api.open, "function");
});

test("wrong Foundry generation, missing dependencies and the old fork are rejected", () => {
    game.release.generation = 13; assert.equal(compatibilityError(), "unsupported");
    game.release.generation = 15; assert.equal(compatibilityError(), "unsupported");
    game.release.generation = 14;
    const dependency = game.modules.get("pf2e-toolbelt");
    dependency.version = "3.56.2"; assert.equal(compatibilityError(), "toolbeltRequired");
    dependency.version = "4.0.0"; assert.equal(compatibilityError(), "toolbeltRequired");
    dependency.version = "3.56.3";
    game.modules.get("lib-wrapper").active = false; assert.equal(compatibilityError(), "wrapperRequired");
    game.modules.get("lib-wrapper").active = true;
    game.settings.settings.set("pf2e-toolbelt.targetHelper.pendingDamage", {});
    assert.equal(compatibilityError(), "forkConflict");
    assert.equal(wrappers.size, 0);
});
