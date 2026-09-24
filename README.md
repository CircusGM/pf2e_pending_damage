# PF2e Pending Damage

A standalone Foundry VTT module by CircusGM that adds a pending damage window
and coordinated damage/healing application to PF2e Toolbelt's Target Helper.

## Requirements

- Foundry VTT **14** (14.361 or later).
- Pathfinder Second Edition **8.4.0+**, within version 8.
- The original **PF2e Toolbelt 3.56.3+**, within version 3.
- **libWrapper 1.13.5.1+**.
- An active GM and this module enabled for every participating client.

Enable Toolbelt's **Target Helper** and **Add Targets to Messages**. Do not use
this module alongside the old Toolbelt development fork with pending damage
built in. PF2e Toolbelt remains a separate dependency; its source is not bundled.

## Usage

New targeted damage and healing appear in a floating window. The GM sees all
eligible targets; players see tokens they own, including hidden owned tokens.
Private roll visibility is respected. Existing chat history is not imported.

Apply damage or healing using the normal PF2e buttons, Toolbelt's target buttons,
the chat context menu, or the pending window. They share the same duplicate
protection. The underlying PF2e system handles shields, immunities, weaknesses,
resistances, HP changes and its normal damage side effects.

- **Shift-click** opens the damage/healing adjustment dialog; canceling leaves
  the row pending.
- The window's **Shield** control requests PF2e Shield Block for that row.
- **×** dismisses one row; **Clear All** dismisses your current list without
  applying damage or clearing another user's list.
- **Ctrl+Shift+D** reopens the window; this keybinding is configurable.
- Turning off **Show Pending Damage Window** keeps duplicate protection in chat.

Applying a roll removes it from every relevant user's window. Rapid repeated
clicks are blocked with a small shake. After two seconds, only a GM using chat
can deliberately repeat an application, after confirming. Players and pending
window clicks never receive that override.

The window reuses Toolbelt's rendered save recommendations. When upstream omits
an owned hidden token's row, native PF2e controls provide a fallback; those rows
have no feat-specific recommendation highlighting. All multipliers still work.

## Installation and releases

For local testing, run `npm run package`, then extract `dist/module.zip` into
`Data/modules/pf2e-pending-damage` in your Foundry user-data directory. The
manifest must be immediately inside that directory. Reload all clients after
changing the installed version.

Publishing a GitHub release tagged `v0.1.0` (or `0.1.0`) runs validation and attaches
`module.json` and `module.zip`. Install/update through that repository's
`releases/latest/download/module.json` URL. The release workflow derives URLs
from the actual GitHub repository; the checked-in manifest contains placeholders.

```sh
npm ci
npm test
npm run check
npm run test:package
npm run package
```

Runtime code is plain JavaScript and needs no bundler. npm dependencies are only
for development tests. The packager includes an explicit list of runtime assets,
documentation and licenses, excluding local files, credentials and dependencies.

## Maintenance and validation

The coordination protocol preserves the original feature's one-second request
retries, 15-second request timeout and two-second repeat guard. HP application
itself is never retried automatically. A started but interrupted application
remains protected; check HP and the message's
`flags.pf2e-pending-damage.damageApplications` before manual recovery.

Automated tests exercise independent GM/player socket contexts and DOM event
routing. PF2e context preparation is checked against the **pf2e-8.4.0** source;
Toolbelt integration targets **3.56.3**. Full live-world gameplay testing remains
necessary; see [TESTING.md](docs/TESTING.md). No Foundry verified version is
claimed until that testing is recorded. New Foundry generations or substantial
Toolbelt/PF2e changes may require updating the integration.

See [the implementation notes](docs/INTEGRATION-ANALYSIS.md) for the narrow
integration boundaries. Direct HP edits and unrelated macros are outside the
chat-button workflow.

## License

[LICENSE](LICENSE) is copied verbatim from `pf2e_alledge_vision` (CC BY-NC-SA 4.0).
The small adapter derived directly from PF2e retains its Apache-2.0 license;
see [NOTICE](NOTICE) and [LICENSE-PF2E](LICENSE-PF2E).
