# Development

## Architecture

All supported damage controls share one application guard. A capture listener
intercepts native PF2e and Toolbelt damage clicks before their application
handlers run. Context-menu callbacks use Foundry's
`getChatMessageContextOptions` hook. The guard authorizes each application,
then the damage adapter prepares context and calls PF2e's actor `applyDamage`
method. PF2e handles immunities, weaknesses, resistances, shields, HP and damage
side effects.

libWrapper wraps `ChatMessage.prototype.renderHTML` to attach the capture
listener. Background refresh waits for the complete render before collecting
Toolbelt target rows, so it does not depend on wrapper ordering.

## Integration boundaries

- `controller.js` handles lifecycle hooks, rendering, click routing and adjustment
  dialogs.
- `pending-store.js` and `window.js` manage the session's pending list and controls.
- `damage-guard.js` coordinates applications through the active GM, validates
  ownership and visibility, and persists application history in message flags.
- `toolbelt-adapter.js` reads Toolbelt target flags and rendered controls, updates
  its applied flags, and handles main/splash roll relationships.
- `damage.js` supplies roll options, contextual effects, multipliers and Shield
  Block requests to PF2e.

Toolbelt's damage handler is not exposed through its runtime API. The module
uses Toolbelt's target data and rendered recommendations, with PF2e's actor API
for damage application. Owned targets without a Toolbelt row receive native
controls without feat-specific recommendation highlighting.

The current integration targets PF2e 8.4.0 and Toolbelt 3.56.3. Foundry 14.367
was used for source review. Foundry 15 is provisionally allowed; changes to
rendering, target flags or actor APIs may require integration updates.

## Coordination

The manifest's `socket: true` enables the `module.pf2e-pending-damage` channel
on Foundry's existing connection. The requesting client sends claims to the
active GM and performs the PF2e operation once authorized.

Requests are addressed only to the active GM, and replies only to the requester.
A normal player application uses three request/reply exchanges: claim, start
and completion. Foundry separately synchronizes the three message-flag updates.
Repeated requests share one queued operation while it is in flight. Disconnected
clients do not emit buffered retries. The active GM's local requests use the same
15-second timeout as remote requests.

Operations are serialized per message, so a slow write does not block unrelated
messages. A timeout does not cancel an in-flight document write or unlock an
application that may have changed HP.

Requests repeat every second for up to 15 seconds using the same request ID.
An unstarted reservation can be reclaimed after a second; a start check rejects
superseded claims. Started claims do not expire automatically, and HP operations
are never retried automatically. Applied or failed operations require a GM's
repeat confirmation after two seconds. Players and pending-window clicks cannot
override them.

Locks identify a message, target and roll. Main/splash claims also lock rolls
that the application would consume. Separate rolls remain separate operations.
Module completion records preserve duplicate protection if Toolbelt rewrites
its own target flags.

Coordination assumes one browser session for the active GM account. Two sessions
using that account can both process claims; their local queues do not provide a
shared lock. Separate damage messages also have separate locks, even when they
target the same actor.

After an interrupted application, inspect the target's HP and the message's
`flags.pf2e-pending-damage.damageApplications` before manual recovery.

## Rendering and session state

Actor and token updates refresh only messages involving that document. Completed,
dismissed and unowned targets are filtered before background HTML rendering.
Applied-roll records and target data are resolved once per collection pass.
Concurrent updates share one render in flight per message and discard stale
results before updating the window.

A refresh stops after eight continuously invalidated render passes. This prevents
a renderer that changes its message on every pass from looping indefinitely.
The error is logged, stale rows are removed, and a later update can refresh the
message again. Normal rendering and window updates do not send module socket
messages or update shared documents.

Session eligibility and dismissal IDs remain until their message is deleted or
the session resets, allowing target and ownership changes to be reflected.
Document updates still scan these IDs; completed rows retain no rendered DOM.

## Checks and packaging

```sh
npm ci
npm test
npm run check
npm run test:package
npm run package
```

Runtime code is plain JavaScript; npm dependencies support development tests.
The packager includes an explicit list of runtime assets, documentation and
licenses. Local builds write `dist/module.json` and `dist/module.zip` without
published update URLs.

Publishing a GitHub release tagged `v0.1.0` or `0.1.0` runs validation and attaches
`module.json` and `module.zip`. The workflow derives release URLs from the GitHub
repository and substitutes the source manifest's placeholders. The stable
installation URL is:

```text
https://github.com/CircusGM/pf2e_pending_damage/releases/latest/download/module.json
```

See [TESTING.md](TESTING.md) for automated coverage and live validation steps.
