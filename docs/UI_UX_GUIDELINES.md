# UI / UX Guidelines

## Principles
Calm, fast, precise. Content first; chrome recedes. Every control does something real — if a module isn't built, it is not in the navigation.

## Layout
- Left sidebar (240px, collapsible): organisation switcher, workspace list, primary nav, user menu.
- Main area: page header (title, key actions, view switcher) → content.
- Detail opens in a right-side drawer (task) so the list stays in context.
- Mobile < 768px: sidebar becomes an overlay; drawers become full-screen.

## Navigation (target order)
Home · Inbox · My Tasks · Projects · Documents · Calendar · Databases · AI · Automations · Search · Analytics · Settings.
Phase 1 shows only: **My Tasks, Projects (per workspace), Settings → Sessions**.

## Visual system
- Tokens as CSS variables (light + dark, follows OS, user override later): `--bg`, `--surface`, `--surface-2`, `--border`, `--text`, `--text-muted`, `--accent`, `--danger`, `--warning`, `--success`.
- Type: Inter (system fallback), 14px base, 1.5 line height; headings 600 weight.
- Spacing on a 4px grid; radius 8px controls / 12px cards; 1px borders over shadows.
- Status colours always paired with text/icon (never colour alone).

## Interaction
- Keyboard: `C` new task, `/` focus search (Phase 2), `⌘K` command palette (Phase 2), `Esc` closes drawer, `Enter` submits inline forms.
- Inline editing for titles; selects for status/priority/assignee.
- Save feedback: "Saving…" → "Saved" only after server response → error toast with retry; 409 shows "Someone else changed this — reload / keep mine".
- Empty states explain the next action with one button.
- Destructive actions need confirmation.

## Accessibility
WCAG 2.2 AA target: visible focus rings, labels on all inputs, semantic landmarks, 4.5:1 contrast, drag-and-drop always has a keyboard alternative (status select on board cards).

## Readiness panel
Each rule: pass/fail icon, title, plain-language reason, count, and a direct fix action where possible. The computed status badge always links to "Why?".
