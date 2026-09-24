# Validation

## Automated checks

```sh
npm ci
npm test
npm run check
npm run test:package
npm run package
```

The Node suite runs the actual guard in independent GM/player contexts with a
simulated authenticated socket and persisted flags. It exercises simultaneous
clicks and healing, lost requests/replies, reservation expiry, delayed starts,
stale confirmations, ownership, visibility, GM handoff, failures, main/splash
conflicts and stale pending-window clicks.

Transport tests cover recipient routing, in-flight retry deduplication, slow
document writes on independent messages, local GM timeouts, disconnected sends,
socket exceptions and timer cleanup. The simulated transport does not establish
live network latency or multi-session coordinator safety.

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
