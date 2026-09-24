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

DOM tests use jsdom to exercise capture/target/bubble event order, verifying that
native and Toolbelt listeners do not run when our interception handles a click.
They cover native multipliers, target buttons, late-rendered controls, roll
indices, context menus, window controls, background refresh, owning users,
hidden-token fallbacks, cancellation and multiple panels observing completion.
The PF2e adapter tests verify contextual effects/options, healing and the exact
inputs passed to the system's actor method, including Shield Block. They do not
substitute a custom resistance/weakness calculation for PF2e.

Packaging tests build isolated releases, check matching inner/outer manifests,
dynamic repository URLs, version tags, dependencies, all runtime assets and
licenses, exclusion of private files, and rejection of symlinks.

## Live Foundry checklist

Live-world gameplay validation is pending. Automated tests and source review
target Foundry 14; Foundry 15 is provisionally allowed and has not been validated.
Record the exact Foundry, PF2e, Toolbelt and libWrapper versions when performing
the checks below.

1. Install a generated package in a disposable PF2e test world on Foundry 14.
   Use Toolbelt 3.56.3 or later within version 3, enable Target Helper and target rows,
   and connect a GM and two owning players with the same module version.
2. Roll new targeted damage. Check audience filtering, hidden owned tokens,
   whispered/blind rolls, recommendations, names, totals and multiple rolls.
   Open the window while chat is closed. Old history must not populate it.
3. Click simultaneously from a GM and owner. Check one HP application, one
   loser shake, and removal from all relevant windows. Repeat with two owners,
   healing, native controls, Toolbelt controls, chat popouts and context menus.
4. Test full/half/double/triple damage, all basic save degrees, IWR, conditional
   effects, healing at full HP, zero damage, Shield Block, shield-only damage,
   broken/unraised shields, persistent damage and main/splash targeting.
5. Shift-click and cancel: no HP or claim change. Confirm an adjustment: correct
   signed damage/healing adjustment and one application. Repeat while another
   client applies that same roll with the dialog open.
6. Dismiss individual rows, Clear All, close/reopen (Ctrl+Shift+D), and disable
   the window. Dismissed rows must stay dismissed during rerenders. With only
   the window disabled, chat must retain duplicate protection.
7. Remove targets, delete messages/tokens, change ownership and rerender chat.
   Check removal of stale rows without exposing other users' targets.
8. Repeat within two seconds: block silently. After two seconds, a GM must
   confirm in chat; owners and pending-window clicks cannot override. Open two
   GM confirmations and ensure one intervening application invalidates the other.
9. Check Foundry's normal damage undo. Deliberate reapplication remains a GM
   chat operation requiring confirmation; undo does not erase protection history.
10. Disable Target Helper and check the window closes. Restore it and check only
    subsequent new messages are collected. Verify other Toolbelt tools continue
    functioning and companion modules that wrap rendering still work.

The guard needs an active GM. A request timeout should leave an error rather
than replaying HP. After an interrupted started operation, inspect HP and
`flags.pf2e-pending-damage.damageApplications` before recovering manually.
