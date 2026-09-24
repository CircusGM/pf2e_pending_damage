// A client-local session queue. Only newly created messages become eligible;
// dismissal never changes HP or another user's list.
export class PendingStore {
    eligible = new Set();
    dismissed = new Set();
    entries = new Map();
    static key(messageId, tokenUuid, rollIndex) { return `${messageId}:${tokenUuid}:${rollIndex}`; }
    mark(messageId) { this.eligible.add(messageId); }
    replace(messageId, entries) {
        if (!this.eligible.has(messageId)) return;
        const incoming = new Map(entries.map(entry => [entry.key, entry]));
        for (const [key, entry] of this.entries) {
            if (entry.messageId === messageId && !incoming.has(key)) this.entries.delete(key);
        }
        for (const [key, entry] of incoming) {
            if (this.dismissed.has(key)) continue;
            const existing = this.entries.get(key);
            this.entries.set(key, existing ? Object.assign(existing, entry, { applying: existing.applying }) : entry);
        }
    }
    dismiss(key) { this.dismissed.add(key); this.entries.delete(key); }
    clear() { for (const key of this.entries.keys()) this.dismiss(key); }
    deleteMessage(id) {
        this.eligible.delete(id);
        for (const [key, entry] of this.entries) if (entry.messageId === id) this.entries.delete(key);
        for (const key of this.dismissed) if (key.startsWith(`${id}:`)) this.dismissed.delete(key);
    }
    reset() { this.eligible.clear(); this.dismissed.clear(); this.entries.clear(); }
}
