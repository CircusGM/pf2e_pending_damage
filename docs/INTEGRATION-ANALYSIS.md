# Integration notes

## Chosen approach

This module implements CircusGM's pending-damage feature as a standalone addon,
using the existing feature's lock/retry behavior as the accepted reliability
boundary. It requires PF2e Toolbelt and does not modify or distribute Toolbelt.
No upstream API change is required.

Toolbelt's damage function is a bundle-local closure. Its public runtime API
exposes target helpers but no awaitable damage application. Replaying its DOM
buttons would lose completion/error/cancel information. Debug-object access or
bundle rewriting adds fragility without a useful completion boundary.

Instead, a capture listener stops supported damage clicks before PF2e or
Toolbelt's original listeners execute. Context-menu callbacks are replaced via
Foundry's `getChatMessageContextOptions` hook. Every route calls the same guard,
then the narrow PF2e context adapter. The adapter calls PF2e's contextual actor
`applyDamage`; PF2e computes IWR, shields, HP and normal side effects.

libWrapper is used for the reachable `ChatMessage.prototype.renderHTML` method,
so chat interception can coexist with Toolbelt's render wrapper. Background
refresh awaits the entire render before collecting target rows, independently
of wrapper ordering. No Toolbelt debug API or function-source rewriting is used.

## Files and contracts

- `controller.js`: lifecycle hooks, background refresh, native/Toolbelt/context
  menu routing, Shift prompts and click ownership.
- `pending-store.js` / `window.js`: session-local eligibility, dismissal and UI.
- `damage-guard.js`: original claim/start/complete protocol, authenticated sender
  checks, persisted history, duplicate interval and idempotent request retries.
- `toolbelt-adapter.js`: independently written interoperability with the existing
  flag structure and rendered controls. Main/splash consumption is mirrored by
  updates to Toolbelt's applied flags. Overlapping in-flight main/splash claims
  conflict, and our separate completed receipts survive Toolbelt flag rewrites.
- `damage.js`: small adapter derived directly from licensed PF2e 8.4.0 sources.
  It supplies roll options, contextual effects, multipliers and Shield Block to
  the system; it does not implement damage-rule calculations.

Toolbelt's normal target rows provide save and feat recommendation classes.
For owned tokens upstream omits (such as hidden tokens), the module reuses native
controls without reproducing Toolbelt's feat-specific highlighting logic.

## Baselines and source provenance

- Toolbelt 3.56.3: `665d856c7369cc6e261bcb341045968abd03573c`.
- CircusGM's original feature: `ec7f475` in the sibling `pf2e-owed-damage` repo.
- PF2e adapter: tag `pf2e-8.4.0`, `src/module/chat-message/helpers.ts` and
  `src/module/rules/helpers.ts`, Apache-2.0; see NOTICE.
- Foundry lifecycle/source review: 14.367.

Toolbelt and foundry-helpers implementation code must not be vendored. Runtime
use of their installed UI/data is the integration boundary. The copied module
LICENSE does not replace PF2e's license on its adapted code.

## Accepted behavior

The active GM coordinates claims; the requesting client performs the PF2e actor
operation. Requests repeat every second for up to 15 seconds with the same ID.
An unstarted reservation can be reclaimed after a second, and a start check
rejects superseded claims. Started claims do not expire automatically. Applied
or failed operations need a GM's explicit repeat confirmation after two seconds;
players and pending-window clicks cannot override them.

As in the original feature, lock identity is message/token/roll. Separate rolls
remain separate actions, and this is not a global actor-update transaction layer.
A highly unusual interruption after an actor update can require inspecting HP
and the persistent claim before manual recovery. Automatic HP retries would be
incorrect in that case and are deliberately absent.

Tests and release packaging are documented in TESTING.md. Compatibility metadata
is an installation boundary; it cannot establish compatibility with an untested
future upstream build.
