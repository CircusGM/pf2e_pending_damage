export const MODULE_ID = "pf2e-pending-damage";
export const TOOLBELT_ID = "pf2e-toolbelt";
export const SOCKET = `module.${MODULE_ID}`;
export const localize = (key, data) => data
    ? game.i18n.format(`${MODULE_ID}.${key}`, data)
    : game.i18n.localize(`${MODULE_ID}.${key}`);

export function ownsDamageTarget(token) {
    return !!token?.actor && (game.user.isGM || token.isOwner || token.actor.isOwner);
}

export function visibleTo(message, user) {
    if (user.isGM) return true;
    if (message.blind) return false;
    const recipients = message.whisper ?? [];
    return !recipients.length || recipients.includes(user.id) || message.author?.id === user.id;
}
