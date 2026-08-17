# Secure Lock

Secure Lock is a SillyTavern contextual interaction extension. It keeps normal roleplay in the main chat while opening small interactive components only when the current scene actually needs them.

## Current stage — v0.2.4

### ATM Card

- Extensions-tab card editor
- Front/back flip preview with Safari-safe face swapping; the back face no longer depends on rotating the entire 3D card container
- Gold chip, card number, card holder, expiry, CVV/CVC and network label
- Multiple visual card themes
- User-entered fields always win
- Blank card fields can receive stable AI-generated defaults when an ATM interaction is triggered
- Card viewer is card-only with no outer white modal shell
- The card can be dragged with mouse, pen or touch; a tap still flips it
- A **Secure Lock Card** shortcut is added to SillyTavern's Wand/Extensions Menu
- Opening the card from the Wand Menu dismisses the Wand Menu first

### Contextual ATM

- The ATM opens from the same normal SillyTavern generation through `secureLockGenInterceptor`; it does not make a second model request.
- Triggering is intentionally strict. Seeing, approaching, passing or standing near an ATM does not open the component.
- Immediate intent to operate the ATM can open it: inserting/reaching for a card, beginning a transaction, explicitly deciding to use it, or an NPC actively starting to use the ATM.
- The AI may supply scene-specific ATM bank, branch, terminal, location and currency context.
- Desktop and mobile presentations are responsive and the ATM window can be dragged with mouse, pen or touch.
- ATM flow currently includes card insertion, PIN, balance, withdrawal, transfer, deposit and card ejection.
- ATM backdrop filtering and descendant filters are disabled for readability on iOS.
- The ATM is positioned with direct integer pixel coordinates instead of a centering transform to avoid Safari whole-window raster blur.

### Pocket Phone bridge

When `pocket-phone-optimized` is installed, Secure Lock reads and writes the Pocket Phone wallet state directly:

- wallet balance
- wallet currency
- wallet account
- wallet name
- per-chat wallet routes
- wallet transaction history

Withdrawals, transfers and deposits therefore update the same financial state instead of maintaining a competing balance. If Pocket Phone is unavailable, Secure Lock uses a local fallback wallet so the ATM remains testable.

## Installation

Install as a third-party SillyTavern extension:

`https://github.com/DesZiDesu/secure-lock-extension`

The extension is displayed in SillyTavern as **Secure Lock**.
