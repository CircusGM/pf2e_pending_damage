# Development

## Architecture

Native PF2e buttons, Toolbelt target buttons, chat context menus and the pending
window share one damage guard. libWrapper attaches click interception during
chat rendering. PF2e's actor API handles damage calculations, shields and HP.

- `controller.js`: hooks, click routing and background refresh.
- `pending-store.js` / `window.js`: pending entries and window controls.
- `damage-guard.js`: claim protocol and duplicate protection.
- `coordinator.js`: election of the coordinating GM session.
- `records.js`: the per-message application log.
- `toolbelt-adapter.js`: Toolbelt targets, recommendations and applied flags.
- `damage.js`: roll context and PF2e damage application.

Toolbelt's damage handler is private, so integration uses its rendered controls
and message flags. Changes to those structures may require adapter updates.

## Coordination and rendering

An application is claim → apply → release. One GM browser session checks and
records each claim, serialized per message; the clicking client then changes HP
through PF2e, so PF2e's messages and warnings stay with the user who clicked, and
reports the outcome. Requests retry every second (claims for 20 seconds, outcome
reports for 10 minutes, across GM reloads), but HP operations never retry.

Foundry lets a GM account connect several times, and every such session is
`game.user.isActiveGM`. GM sessions therefore elect the coordinator: full GMs
before assistants, then the earliest-joined session, so a newcomer never
preempts it. A session coordinates only after holding the role for five seconds.
If requests go unanswered, other GM sessions ping the coordinator and replace it
when it misses a three-second deadline (longer on slow links); a replaced session
that was merely frozen rejoins as the newest. The coordinator answers claims sent
more than three seconds earlier with "slow" instead of acting on them.

The election only keeps one session busy; it is not what prevents duplicates. A
session can miss broadcasts while reconnecting, so the coordinator reads each
message from the server before deciding, writes its claim, and reads it again.
The server queues reads and writes for messages in order, so of two sessions
granting at once, at most one sees no rival claim written since its first read;
a session that sees one withdraws its own.

Claims live in an append-only log, `flags.pf2e-pending-damage.applications`,
keyed by target, roll and claim, and timed with `game.time.serverTime`, which every
client shares. Grant and outcome fields are separate, so late or duplicate writes
cannot erase another application. Retries of a refused claim get the same answer. A claim blocks its target,
and any main or splash roll it consumes, until its outcome arrives or five seconds
pass. A client withdraws a claim it gave up waiting for, or whose grant arrives
more than 2.5 seconds old, and retries with a fresh claim up to three times. After an
application, a failure or an expired claim, only a GM using chat can apply that
roll again, after a confirmation describing what happened. Version 1 records in
`flags.pf2e-pending-damage.damageApplications` remain authoritative history.

Foundry relays a module's socket only if the module was installed when the world
launched; a GM client warns when its own announcement is not echoed back. Turning
off the **Duplicate Protection** setting bypasses coordination entirely: chat
clicks reach PF2e's and Toolbelt's handlers, and the window applies directly.

Before changing HP, a client checks that the roll's formula and total are
unchanged. Nothing else is compared: Dice So Nice and other modules annotate
prepared `Roll` objects in memory, and every flag update rebuilds them.

Separate messages have separate queues, even when they target the same actor.
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
