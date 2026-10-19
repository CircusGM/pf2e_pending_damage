# PF2e Pending Damage

A Foundry VTT module by CircusGM that adds a pending damage window and duplicate
application protection to PF2e Toolbelt's Target Helper to help players and GMs track and apply damage better.

## Requirements

- Foundry VTT **14.361–15**.
- Pathfinder Second Edition **8.4.0+**.
- **PF2e Toolbelt 3.56.3+**.
- **libWrapper 1.13.5.1+**.

Enable Toolbelt's **Target Helper** and **Add Targets to Messages**.

## Usage

New damage and healing appear in a floating window. The GM sees all
eligible targets; players see tokens they own.

Apply damage or healing using the normal PF2e buttons, Toolbelt's target buttons,
the chat context menu, or the pending window. They share the same duplicate
protection so you or the GM don't both damage the same character.

- The window's **Shield** control requests PF2e Shield Block for that row.
- **×** dismisses one row; **Clear All** dismisses your current list without
  applying damage or clearing another user's list.
- **Ctrl+Shift+D** reopens the window; this keybinding is configurable.
- Turning off **Show Pending Damage Window** keeps duplicate protection in chat.
- **Duplicate Protection** is a last resort if applying damage fails: turned off,
  chat buttons work exactly as in PF2e and Toolbelt, and the window applies damage
  without protection.

Applying a roll removes it from every relevant user's window. Rapid repeated
clicks are blocked with a small shake. After two seconds, a GM using chat can
repeat an application after confirming in case you really did need damage twice or the first one got undone.

With duplicate protection on, a connected GM is required to apply damage. When an application is blocked or
fails, a notification says why: for example, who already applied it, or that the
GM's client didn't respond. The GM may be logged in on several browsers or devices.

The window displays Toolbelt's save recommendations where available.

## Installation

Use the `module.json` asset from a [published release](https://github.com/CircusGM/pf2e_pending_damage/releases)
as the manifest URL in Foundry's **Install Module** dialog. Enable the module
and its dependencies in your world, then reload all clients. If the world was
running when you installed the module, return to Setup and launch it again.

## License

[CC BY-NC-SA 4.0](LICENSE). Third-party licensing details are in [NOTICE](NOTICE).
