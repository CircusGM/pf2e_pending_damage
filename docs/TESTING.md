# Validation

## Automated checks

```sh
npm ci
npm test
npm run check
npm run test:package
npm run package
```

The Node suite runs the actual guard in independent browser sessions sharing a
simulated Foundry server: authoritative flags, serialized writes broadcast to
every session with per-client latency, and a socket relay that reaches every
session of a recipient user. It exercises simultaneous clicks and healing, lost
requests/replies, claim timeouts and withdrawal, expired claims, late outcome
reports, stale confirmations, ownership, visibility, failures, version 1
records, main/splash conflicts and stale pending-window clicks.

Coordinator tests run several sessions of one GM account and an assistant: the
election, newcomers on slow links, tab closes, silent crashes, GM reloads, a
frozen coordinator thawing with competing clicks in its backlog, sessions that
missed updates while offline, forced split brain, clock skew and clock steps. Transport tests
cover recipient routing, retry deduplication, slow writes on independent
messages, local GM timeouts, disconnected sends, socket exceptions, protocol
mismatches and timer cleanup. Each timing safeguard was checked by weakening it
and confirming that a test fails.

DOM tests use jsdom to exercise capture/target/bubble event order, verifying that
native and Toolbelt listeners do not run when our interception handles a click.
They cover native multipliers, target buttons, late-rendered controls, roll
indices, context menus, window controls, background refresh, owning users,
hidden-token fallbacks, cancellation and multiple panels observing completion.
Refresh tests also cover update bursts, irrelevant actor updates, completed-row
filtering and renderers that continuously invalidate their own output.
The PF2e adapter tests verify contextual effects/options, healing and the exact
inputs passed to the system's actor method, including Shield Block. They do not
substitute a custom resistance/weakness calculation for PF2e.

Packaging tests build isolated releases, check matching inner/outer manifests,
dynamic repository URLs, version tags, dependencies, all runtime assets and
licenses, exclusion of private files, and rejection of symlinks.
