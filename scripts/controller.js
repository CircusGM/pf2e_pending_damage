import { MODULE_ID, TOOLBELT_ID, localize, ownsDamageTarget } from "./constants.js";
import { getMessageData, isTargeted, isDamageApplied, appliedFootprints, markDamageApplied, pendingRows, recommendedMultiplier, targetHelperEnabled } from "./toolbelt-adapter.js";
import { DamageApplicationGuard } from "./damage-guard.js";
import { applyDamage, promptAdjustment } from "./damage.js";
import { PendingStore } from "./pending-store.js";
import { PendingDamageWindow } from "./window.js";

const APPLY = new Set(["applyDamage", "apply-damage", "target-applyDamage", "target-apply-damage"]);
const SHIELD = new Set(["target-shieldBlock", "target-shield-block"]);
const MAX_REFRESH_PASSES = 8;
const CONTEXT_MULTIPLIERS = new Map([
    ["PF2E.DamageButton.FullContext", 1], ["PF2E.DamageButton.HalfContext", 0.5],
    ["PF2E.DamageButton.DoubleContext", 2], ["PF2E.DamageButton.TripleContext", 3],
    ["PF2E.DamageButton.HealingContext", -1],
]);

function rollSignature(roll) {
    return roll ? JSON.stringify(roll.toJSON?.() ?? { total: roll.total, formula: roll.formula }) : null;
}

export class PendingDamageController {
    store = new PendingStore();
    pendingDamage = new PendingDamageWindow(this);
    guard = new DamageApplicationGuard(this);
    localize = localize;
    getMessageData = getMessageData;
    markDamageApplied = markDamageApplied;
    bound = new WeakSet();
    refreshes = new Map();
    busy = new Set();
    epoch = 0;
    get enabled() { return game.settings.get(MODULE_ID, "enabled") && targetHelperEnabled(); }
    get panelEnabled() {
        return this.enabled && game.settings.get(MODULE_ID, "showWindow") &&
            game.settings.get(TOOLBELT_ID, "targetHelper.targets");
    }
    start() {
        this.guard.activate();
        const controller = this;
        libWrapper.register(MODULE_ID, "ChatMessage.prototype.renderHTML", async function(wrapped, ...args) {
            const html = await wrapped(...args);
            controller.bindChat(this, html);
            return html;
        }, "WRAPPER");
        Hooks.on("getChatMessageContextOptions", (_app, options) => this.bindContextMenu(options));
        Hooks.on("createChatMessage", message => {
            if (!this.panelEnabled || !message.isDamageRoll) return;
            this.store.mark(message.id);
            this.refresh(message);
        });
        Hooks.on("updateChatMessage", message => this.refresh(message));
        Hooks.on("deleteChatMessage", message => {
            this.store.deleteMessage(message.id);
            this.renderSoon();
        });
        // Bind any existing chat elements without adding history to the pending list.
        for (const html of document.querySelectorAll(".chat-message[data-message-id]")) {
            const message = game.messages.get(html.dataset.messageId);
            if (message) this.bindChat(message, html);
        }
        for (const hook of ["updateActor", "updateToken", "deleteToken"]) {
            Hooks.on(hook, document => this.refreshAffected(document));
        }
        Hooks.on("canvasReady", () => this.refreshAffected());
        const onSetting = (setting) => {
            if ((!setting.user || setting.user === game.user.id) &&
                [`${TOOLBELT_ID}.targetHelper.targets`, `${TOOLBELT_ID}.targetHelper.enabled`].includes(setting.key)) {
                this.reset();
            }
        };
        Hooks.on("updateSetting", onSetting);
        Hooks.on("createSetting", onSetting);
    }
    reset() {
        this.epoch++;
        this.store.reset();
        void this.pendingDamage.close();
    }
    refreshAffected(document) {
        if (!this.panelEnabled) return;
        for (const id of this.store.eligible) {
            const message = game.messages.get(id);
            if (!message) { this.store.deleteMessage(id); continue; }
            if (document) {
                const flags = message.getFlag(TOOLBELT_ID, "targetHelper");
                const targets = [...(flags?.targets ?? []), ...(flags?.splashTargets ?? [])];
                const affected = message.actor?.uuid === document.uuid || message.token?.uuid === document.uuid ||
                    targets.some(uuid => uuid === document.uuid ||
                        fromUuidSync(uuid, { strict: false })?.actor?.uuid === document.uuid);
                if (!affected) continue;
            }
            this.refresh(message);
        }
    }
    hasPendingTargets(message, data) {
        const completed = appliedFootprints(message);
        return !!data && [...data.targets, ...data.splashTargets].some(token => ownsDamageTarget(token) &&
            message.rolls.some((_roll, index) => isTargeted(data, token, index) &&
                !this.store.dismissed.has(PendingStore.key(message.id, token.uuid, index)) &&
                !isDamageApplied(message, token, index, data, completed)));
    }
    refresh(message) {
        if (!this.panelEnabled || !this.store.eligible.has(message.id)) return;
        // Coalesce concurrent updates, and discard a completed render if it became
        // stale while Toolbelt was rendering saves/targets asynchronously.
        const existing = this.refreshes.get(message.id);
        if (existing) { existing.dirty = true; return existing.promise; }
        const state = { dirty: true };
        const epoch = this.epoch;
        this.refreshes.set(message.id, state);
        state.promise = (async () => {
            let passes = 0;
            while (state.dirty && epoch === this.epoch && this.store.eligible.has(message.id)) {
                // A renderer that updates the message on every pass must not
                // create an endless render/update cycle on each connected client.
                if (++passes > MAX_REFRESH_PASSES) throw new Error("Chat rendering continuously invalidated the pending damage refresh");
                state.dirty = false;
                if (!this.panelEnabled || message.isContentVisible === false ||
                    !this.hasPendingTargets(message, getMessageData(message))) {
                    this.store.replace(message.id, []);
                    break;
                }
                const html = await message.renderHTML();
                if (state.dirty || epoch !== this.epoch) continue;
                this.collect(message, html);
            }
        })().catch(error => {
            console.error("PF2e Pending Damage | Could not refresh target controls", error);
            this.store.replace(message.id, []);
        }).finally(() => {
            this.refreshes.delete(message.id);
            this.renderSoon();
        });
        return state.promise;
    }
    collect(message, html) {
        const data = getMessageData(message);
        const completed = appliedFootprints(message);
        const entries = [];
        if (message.isContentVisible !== false && data) for (const row of pendingRows(message, html, data)) {
            const token = fromUuidSync(row.dataset.targetUuid, { strict: false });
            const index = Number(row.dataset.targetRollIndex);
            if (!ownsDamageTarget(token) || !Number.isInteger(index) || index < 0 || !message.rolls[index] ||
                !isTargeted(data, token, index) || row.classList.contains("applied") ||
                isDamageApplied(message, token, index, data, completed)) continue;
            const clone = row.cloneNode(true);
            const recommended = recommendedMultiplier(row, message);
            for (const button of clone.querySelectorAll("button[data-multiplier]")) {
                button.classList.toggle("pending-recommended", button.dataset.multiplier === recommended);
            }
            const total = message.rolls[index].total;
            const key = PendingStore.key(message.id, token.uuid, index);
            entries.push({ key, messageId: message.id, targetUuid: token.uuid, targetName: token.name,
                rollIndex: index, row: clone, sourceLabel: message.item?.name ||
                    html.querySelector("h4.action")?.textContent || localize("damage"),
                total: Number.isFinite(total) ? total : null, applying: false,
                shield: this.store.entries.get(key)?.shield ?? false });
        }
        this.store.replace(message.id, entries);
    }
    bindChat(message, html) {
        if (!message.isDamageRoll || this.bound.has(html)) return;
        this.bound.add(html);
        // Capture on the message root beats target/bubble listeners installed by
        // Toolbelt and PF2e, including controls appended after this wrapper returns.
        html.addEventListener("click", event => {
            const button = event.target?.closest?.(".damage-application button[data-action]");
            if (!button || !this.enabled || !APPLY.has(button.dataset.action)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (event.button !== 0 || button.disabled || message.isContentVisible === false) return;
            const row = button.closest(".damage-application");
            const uuid = row.dataset.targetUuid;
            const regularRows = [...html.querySelectorAll(".damage-application")].filter(r => !r.dataset.targetUuid);
            const rollIndex = Number(row.dataset.targetRollIndex ?? button.closest("[data-roll-index]")?.dataset.rollIndex ?? regularRows.indexOf(row));
            const tokens = uuid ? [fromUuidSync(uuid, { strict: false })] :
                html.dataset.actorIsTarget && message.token ? [message.token] : game.user.getActiveTokens();
            void this.applyToTokens(message, tokens, { rollIndex, multiplier: Number(button.dataset.multiplier),
                shift: event.shiftKey }).catch(error => this.report(error));
        }, { capture: true });
    }
    bindContextMenu(options) {
        for (const option of options) {
            const multiplier = CONTEXT_MULTIPLIERS.get(option.label);
            if (multiplier === undefined) continue;
            const original = option.onClick;
            option.onClick = (event, element) => {
                if (!this.enabled) return original.call(option, event, element);
                const message = game.messages.get(element.dataset.messageId);
                if (!message || message.isContentVisible === false) return;
                const tokens = element.dataset.actorIsTarget && message.token ? [message.token] : game.user.getActiveTokens();
                return this.applyToTokens(message, tokens, { rollIndex: 0, multiplier, shift: false })
                    .catch(error => this.report(error));
            };
        }
    }
    async applyToTokens(message, tokens, { rollIndex, multiplier, shift }) {
        if (!tokens.length) { ui.notifications.error("PF2E.ErrorMessage.NoTokenSelected", { localize: true }); return; }
        const shield = CONFIG.PF2E.chatDamageButtonShieldToggle;
        const distinct = new Map(tokens.filter(ownsDamageTarget).map(t => [t.flags?.pf2e?.troop?.id ?? t.actor.uuid ?? t.uuid, t]));
        for (const token of distinct.values()) {
            await this.apply({ message, token, rollIndex, multiplier, shift, shield, allowRepeat: true });
        }
    }
    onPanelClick(event, key) {
        const button = event.target?.closest?.("button[data-action]");
        if (!button || event.button !== 0) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const entry = this.store.entries.get(key);
        if (!entry || entry.applying) { this.pendingDamage.shake(); return; }
        if (SHIELD.has(button.dataset.action)) {
            entry.shield = !entry.shield;
            this.renderSoon();
            return;
        }
        if (!APPLY.has(button.dataset.action)) return;
        const message = game.messages.get(entry.messageId);
        const token = fromUuidSync(entry.targetUuid, { strict: false });
        if (!message || !ownsDamageTarget(token) || !isTargeted(getMessageData(message), token, entry.rollIndex)) {
            this.dismiss(key); return;
        }
        void this.apply({ message, token, rollIndex: entry.rollIndex, multiplier: Number(button.dataset.multiplier),
            shift: event.shiftKey, shield: entry.shield, allowRepeat: false, entry }).catch(error => this.report(error));
    }
    async apply({ message, token, rollIndex, multiplier, shift, shield, allowRepeat, entry }) {
        const key = PendingStore.key(message.id, token.uuid, rollIndex);
        const signature = rollSignature(message.rolls[rollIndex]);
        if (this.busy.has(key)) { this.pendingDamage.shake(); return false; }
        if (!this.enabled || !ownsDamageTarget(token) || !Number.isInteger(rollIndex) || rollIndex < 0 ||
            !message.rolls[rollIndex] || !Number.isFinite(multiplier) || message.isContentVisible === false) return false;
        this.busy.add(key);
        if (entry) entry.applying = true;
        this.renderSoon();
        try {
            const addend = shift ? await promptAdjustment(multiplier) : 0;
            if (addend === null || addend === undefined) return false;
            // Recheck after a dialog: targets/ownership/rolls can change while open.
            if (!this.enabled || !game.messages.has(message.id) || !ownsDamageTarget(token) ||
                (entry && (!this.store.entries.has(key) || !isTargeted(getMessageData(message), token, rollIndex)))) return false;
            const applied = await this.guard.run(message, token, rollIndex, async () => {
                if (!this.enabled || !game.messages.has(message.id) || message.isContentVisible === false ||
                    rollSignature(message.rolls[rollIndex]) !== signature || !ownsDamageTarget(token) ||
                    (entry && !isTargeted(getMessageData(message), token, rollIndex))) {
                    throw new Error("Damage source or target changed before application");
                }
                await applyDamage({ message, token, rollIndex, multiplier, addend, shieldBlockRequest: shield });
            }, allowRepeat);
            if (applied && entry) this.dismiss(key);
            return applied;
        } finally {
            this.busy.delete(key);
            if (entry) { entry.applying = false; entry.shield = false; }
            CONFIG.PF2E.chatDamageButtonShieldToggle = false;
            for (const button of document.querySelectorAll(".damage-application .shield-activated")) {
                button.classList.remove("shield-activated");
            }
            this.renderSoon();
        }
    }
    dismiss(key) { this.store.dismiss(key); this.renderSoon(); }
    clear() { this.store.clear(); this.renderSoon(); }
    report(error) {
        console.error("PF2e Pending Damage", error);
        ui.notifications.error(localize("repeat.unavailable"));
    }
    renderSoon = foundry.utils.debounce(() => {
        if (!this.panelEnabled) return;
        if (this.store.entries.size) void this.pendingDamage.render({ force: true });
        else if (this.pendingDamage.rendered) void this.pendingDamage.render();
    }, 25);
}
