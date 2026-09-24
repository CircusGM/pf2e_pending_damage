# Development

## Architecture

Native PF2e buttons, Toolbelt target buttons, chat context menus and the pending
window share one damage guard. libWrapper attaches click interception during
chat rendering. PF2e's actor API handles damage calculations, shields and HP.

- `controller.js`: hooks, click routing and background refresh.
- `pending-store.js` / `window.js`: pending entries and window controls.
- `damage-guard.js`: GM coordination and duplicate protection.
- `toolbelt-adapter.js`: Toolbelt targets, recommendations and applied flags.
- `damage.js`: roll context and PF2e damage application.

Toolbelt's damage handler is private, so integration uses its rendered controls
and message flags. Changes to those structures may require adapter updates.

## Coordination and rendering

The active GM serializes claims per message; the requesting client applies the
HP change. Requests retry every second for up to 15 seconds, but HP operations
are never automatically retried. Started claims remain locked until completion
or failure. Only a GM using chat can confirm a repeat after two seconds.

Coordination assumes one browser session for the active GM account. Separate
messages have separate locks, even when they target the same actor. Application
records live in `flags.pf2e-pending-damage.damageApplications`.

Refreshes skip completed, dismissed and unowned targets, coalesce concurrent
updates, and stop after eight continuously invalidated renders to prevent loops.
Pending lists and dismissals are local to each user's session.

## Build and release

```sh
npm ci
npm run package
```

The build writes `dist/module.json` and `dist/module.zip`. Extract the zip into
`Data/modules/pf2e-pending-damage` for local testing. Runtime code needs no bundler.
See [TESTING.md](TESTING.md) for validation commands and coverage.

Publishing a GitHub release tagged `vX.Y.Z` or `X.Y.Z` runs validation and attaches
both assets with the release version and download URLs filled in.
