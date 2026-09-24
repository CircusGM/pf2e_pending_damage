# PF2e Pending Damage

A Foundry VTT module by CircusGM that adds a pending damage window and duplicate
application protection to PF2e Toolbelt's Target Helper.

## Requirements

- Foundry VTT **14.361–15**. Version 15 support is provisional.
- Pathfinder Second Edition **8.4.0+**, within version 8.
- **PF2e Toolbelt 3.56.3+**, within version 3.
- **libWrapper 1.13.5.1+**.
- An active GM and this module enabled for every participating client.

Enable Toolbelt's **Target Helper** and **Add Targets to Messages**.

## Usage

New targeted damage and healing appear in a floating window. The GM sees all
eligible targets; players see tokens they own, including hidden owned tokens.
Private roll visibility is respected. Existing chat history is not imported.

Apply damage or healing using the normal PF2e buttons, Toolbelt's target buttons,
the chat context menu, or the pending window. They share the same duplicate
protection. PF2e handles shields, immunities, weaknesses, resistances, HP changes
and its normal damage side effects.

- **Shift-click** opens the damage/healing adjustment dialog; canceling leaves
  the row pending.
- The window's **Shield** control requests PF2e Shield Block for that row.
- **×** dismisses one row; **Clear All** dismisses your current list without
  applying damage or clearing another user's list.
- **Ctrl+Shift+D** reopens the window; this keybinding is configurable.
- Turning off **Show Pending Damage Window** keeps duplicate protection in chat.

Applying a roll removes it from every relevant user's window. Rapid repeated
clicks are blocked with a small shake. After two seconds, a GM using chat can
repeat an application after confirming. Players and pending window clicks
cannot override duplicate protection. Undoing damage does not clear that
protection; use the GM's chat controls to apply it again.

The window displays Toolbelt's save recommendations where available. Owned
hidden targets use native damage controls when Toolbelt does not render a row;
these controls support all multipliers but have no feat-specific recommendation
highlighting. Direct HP edits and unrelated macros are outside this module's
duplicate protection.

## Installation

Use the `module.json` asset from a [published release](https://github.com/CircusGM/pf2e_pending_damage/releases)
as the manifest URL in Foundry's **Install Module** dialog. Enable the module
and its dependencies in your world, then reload all clients.

For a local build, run `npm run package` and extract `dist/module.zip` into
`Data/modules/pf2e-pending-damage` in your Foundry user-data directory. The
`module.json` file must be directly inside that folder.

## Development

See [DEVELOPMENT.md](docs/DEVELOPMENT.md) for the integration architecture,
packaging and release process, and [TESTING.md](docs/TESTING.md) for validation
coverage and the gameplay checklist. Live gameplay validation is pending.

## License

[CC BY-NC-SA 4.0](LICENSE). Third-party licensing details are in [NOTICE](NOTICE).
