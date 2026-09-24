import { MODULE_ID, TOOLBELT_ID, localize } from "./constants.js";
import { PendingDamageController } from "./controller.js";

let controller;

export function compatibilityError() {
    if (Number(game.release.generation) !== 14 || game.system.id !== "pf2e") return "unsupported";
    const toolbelt = game.modules.get(TOOLBELT_ID);
    if (!toolbelt?.active || foundry.utils.isNewerVersion("3.56.3", toolbelt.version) ||
        Number(toolbelt.version.split(".")[0]) !== 3) return "toolbeltRequired";
    if (!game.modules.get("lib-wrapper")?.active || typeof globalThis.libWrapper?.register !== "function") return "wrapperRequired";
    // The old development fork already has its own damage interceptor and guard.
    if (game.settings.settings.has(`${TOOLBELT_ID}.targetHelper.pendingDamage`)) return "forkConflict";
    if (typeof ChatMessage.prototype.renderHTML !== "function" ||
        typeof game.toolbelt?.api?.targetHelper?.getMessageTargets !== "function") return "unsupported";
    return null;
}

Hooks.once("init", () => {
    for (const [key, scope, requiresReload] of [["enabled", "world", true], ["showWindow", "user", false]]) {
        game.settings.register(MODULE_ID, key, { name: `${MODULE_ID}.settings.${key}.name`,
            hint: `${MODULE_ID}.settings.${key}.hint`, scope, config: true, type: Boolean,
            default: true, requiresReload, onChange: (_value, _options, userId) => {
                if (scope !== "user" || userId === game.user.id) controller?.reset();
            } });
    }
    game.keybindings.register(MODULE_ID, "open", { name: `${MODULE_ID}.open`,
        editable: [{ key: "KeyD", modifiers: ["Control", "Shift"] }],
        onDown: () => {
            if (!controller?.panelEnabled) return false;
            void controller.pendingDamage.render({ force: true });
            return true;
        } });
});

Hooks.once("setup", () => {
    const error = compatibilityError();
    if (error) { ui.notifications.error(localize(error), { permanent: true }); return; }
    controller = new PendingDamageController();
    try {
        controller.start();
        game.modules.get(MODULE_ID).api = Object.freeze({
            open: () => controller.panelEnabled && controller.pendingDamage.render({ force: true }),
            clear: () => controller.clear(),
        });
    } catch (error) {
        console.error("PF2e Pending Damage | Startup failed", error);
        ui.notifications.error(localize("unsupported"), { permanent: true });
    }
});

Hooks.once("ready", () => {
    if (controller && !game.settings.get(TOOLBELT_ID, "targetHelper.enabled")) {
        ui.notifications.warn(localize("enableTargetHelper"));
    }
});
