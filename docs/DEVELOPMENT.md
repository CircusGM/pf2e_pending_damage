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

After an interrupted application, inspect the target's HP and the message's
`flags.pf2e-pending-damage.damageApplications` before manual recovery.

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
