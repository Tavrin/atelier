# Atelier Design System

Atelier is a calm cockpit for supervising active work. Its interface should feel quiet until state changes demand attention. Color communicates state semantics rather than decoration: indigo carries the Atelier brand and primary action, green means success, and the dark appearance is graphite rather than black.

## Token architecture

The cascade is ordered as `tokens`, `base`, `components`, `utilities`, then `overrides`. Tokens have three tiers:

1. Primitive colors are the fixed palette. The families are `--c-gray-*`, `--c-indigo-*`, `--c-green-*`, `--c-red-*`, `--c-amber-*`, `--c-violet-*`, and `--c-blue-*`. Primitive values do not describe UI meaning and components never consume them directly.
2. Semantic colors describe purpose. The complete set is `--bg`, `--panel`, `--panel-raised`, `--line`, `--text`, `--muted`, `--accent`, `--accent-strong`, `--on-accent`, `--success`, `--danger`, `--warning`, `--verify`, `--info`, `--triage`, `--priority-0` through `--priority-4`, `--ready`, `--blocked`, `--progress`, `--closed`, `--page-glow`, `--brand-border`, `--brand-bg`, `--focus-ring`, `--status-ring`, `--pulse-ring`, `--pulse-clear`, `--modal-backdrop`, `--elevation-color-sm`, `--elevation-color-md`, `--elevation-color-lg`, and `--shadow-color`. Elevation geometry is named `--card-shadow`, `--card-shadow-hover`, `--panel-shadow`, and `--shadow`.
3. Component tokens are colocated with the selector that owns them. Controls use `--control-bg`, `--control-border`, `--control-focus-border`, `--control-focus-ring`, and `--control-text`; columns use `--column-border`, `--column-bg`, and `--column-header-bg`; chips use `--chip-bg`, `--chip-border`, and `--chip-text`; cards use `--card-bg`, `--card-border`, `--card-elevation`, `--card-elevation-hover`, and `--card-text`; timelines use `--timeline-accent`, `--timeline-bg`, `--timeline-border`, and `--timeline-text`; modals use `--modal-bg`, `--modal-border`, `--modal-overlay`, `--modal-shadow`, `--modal-text`, and `--modal-header-bg`; toasts use `--toast-bg`, `--toast-border`, `--toast-shadow`, and `--toast-text`.

There is one semantic token block, not duplicated light and dark blocks. Each semantic role uses `light-dark(light-value, dark-value)`, while `:root` advertises `color-scheme: light dark`. The theme control stores `auto`, `light`, or `dark` under `atelier-theme`; `applyTheme` writes it to `data-theme`. Auto leaves both schemes available so the browser follows the operating system. The light and dark selectors narrow `color-scheme`, which makes every `light-dark()` token choose the requested branch.

## How to add a theme

Add a semantic override in the `overrides` layer, leave every `--c-*` primitive untouched, and change only roles whose meaning needs a different expression. Add the theme name to `THEMES` in `ui/app.js` so the existing cycle control can select it. Check the resulting roles in `#/styleguide`; components should need no edits.

This example is exactly one theme block:

```css
:root[data-theme="graphite"] {
  color-scheme: dark;
  --bg: var(--c-gray-950);
  --panel: var(--c-gray-900);
  --panel-raised: var(--c-gray-850);
  --line: var(--c-gray-700);
  --text: var(--c-gray-100);
  --muted: var(--c-gray-400);
  --accent: var(--c-indigo-300);
}
```

## Type and spacing

`--fs-1` through `--fs-6` form the fluid type ramp. Each value uses `clamp()` so text scales within deliberate limits instead of jumping at breakpoints. Use the named step that matches the surrounding hierarchy; do not introduce a one-off font size when a step already fits.

`--space-1` through `--space-8` form the spacing scale, and `--radius-1` through `--radius-5` form the radius scale. Spacing is calculated through `var(--density, 1)`. The product has no persistent density setting: the styleguide alone maps `data-density="compact"` to `--density: 0.8` and removes the attribute when that view is left. A future product control must use the same attribute contract on `<html>`; persistence requires an explicit product decision rather than a component-local override.

Diffs, commands, and raw tool output use the system monospace stack with `pre-wrap` and anywhere overflow wrapping. Preserve source line breaks, allow long paths and tokens to wrap, and do not add syntax highlighting that competes with semantic state color.

Transcript hierarchy follows the work rhythm rather than repeating one generic card: agent narration stays flush with an accent rail; commands, file activity, results, and raw adapter lines step inward in that order. Commands use `--accent`, file activity uses `--info`, successful results use `--success`, failed results use `--danger`, and raw lines stay muted and borderless except for a neutral rail. Text labels and exit badges always accompany state color. The `Transcript activity` styleguide group is the visual-regression fixture for this grammar.

## Component states catalog

- Buttons: `.button` default, `.primary`, `.danger`, `.compact`, and `:disabled`; `.tab` and `.icon-button` share the base interaction states.
- Badges: `.badge` default, `.triage`, `.tracker-committed`, `.tracker-personal`, `.tracker-none`, `.archetype-full`, `.archetype-git-only`, `.archetype-tracker-only`, `.repo-chip`, `.verify-running`, `.verify-passed`, `.verify-failed`, `.verify-skipped`, `.review-pending`, `.review-pass`, `.review-fail`, `.review-error`, `.review-invalid`, `.review-audit`, `.merged`, `.filtered-view-badge`, and `.priority-chip.p0` through `.priority-chip.p4`.
- Dispatch states: `.state-chip` covers `queued`, `preparing`, `resuming`, `running`, `verifying`, `stopping`, `completed`, `completed_empty`, `needs_input`, `failed`, `stopped`, `prepare_failed`, and `rejected`. `needs_input` uses the warning colour (it is the one terminal state an operator must act on); `completed_empty` uses the informational colour.
- Issue cards: `.issue-card.priority-p0` through `.priority-p4`, with optional `.card-assignee`; priority changes the semantic left edge, not the card structure.
- Board columns: `.column[data-kind="ready"]`, `blocked`, `progress`, and `closed`, each with a sticky `.column-header`.
- Status timeline: `.timeline-step.reached`, `.timeline-step.current`, and the unmodified pending step.
- Toasts: `.toast` default and `.toast.error`.
- Banners: `.warning-banner`, `.error-banner`, and `.info-banner`.
- Form controls: `input` and `select` default, focused, and disabled; `.queue-toggle` off, `.enabled`, and disabled; `.checkbox-setting`; and the composed `.dispatch-filter-bar`.
- Reply composer: `.reply-composer` with `Send now`, `Reply & resume`, and disabled-with-reason states.
- Diff review: `.diff-file-list`, sticky `.diff-file-header`, collapsed/expanded `.diff-file-content`, and `.diff-comment`.
- Modal: `.modal-root`, sticky `.modal-header`, `.modal-body`, and wrapping `.modal-actions`; the styleguide renders the same frame statically.

## Responsive contract

Media queries control page chrome:

- At `880px`, the sidebar becomes a loopback-only drawer behind a fixed mobile top bar, page headers stack, the board becomes a horizontal snap track, and dispatch content constrains long output.
- At `720px`, forms collapse to one column, rollups stack, the dispatch table becomes a card list, and interactive controls receive a minimum `44px` touch target. Any new phone control must meet the same target.
- At `600px`, the project chrome becomes denser, timeline and tool layouts tighten, and `.modal-root` becomes a full-screen sheet with square edges.

The supporting `980px` query narrows the sidebar and composer grid, while the `1200px`–`1500px` band adjusts board column width. These queries are part of the same tested list. Container queries are reserved for component-internal reflow: components declare inline-size containment where local width matters, and the current `600px` modal container rule lets modal actions grow without coupling them to viewport width.

## Keyboard shortcuts

Atelier keeps global shortcuts small and navigation-focused: `g d` opens all dispatches, `g s` opens the styleguide, `1` through `9` jump to the matching sidebar project, `/` focuses the filter on an open board, `n` opens the current project's New dispatch composer, and `?` toggles the shortcuts overlay. `Escape` closes the overlay or any other modal through the native dialog behavior. The `g` sequence expires after 800ms. Global shortcuts pause while an input, textarea, select, or editable region has focus and ignore modified key presses, with the Shift required to type `?` as the sole exception.

## Motion

All reduced-motion behavior lives in the single `prefers-reduced-motion: reduce` block. Motion must communicate a state change, such as running work, verification, or the arrival of a toast. Never add animation merely as decoration, and extend the existing reduced-motion block whenever a new state animation is introduced.

## Pre-ship ritual

Before shipping any token or component change, open `#/styleguide`. Cycle auto, light, and dark, then toggle the compact-density preview. Eyeball token swatches, every scale, and every component state. This page is Atelier's manual visual-regression surface.

## Do and don't

- Do use semantic tokens; don't put visual literals in component rules.
- Do build app-state-free DOM with the primitives in `ui/components.mjs`; don't create parallel ad hoc helpers.
- Do use `createElement`, `textContent`, and text nodes; never use `innerHTML`.
- Do keep raw hex values inside the tokens layer; don't leak palette values into components or overrides.
- Do preserve every media query in the responsive contract; the query list is contract-tested, so never remove one without deliberately changing that contract and its tests.
- Do state a control's unmet preconditions in both its disabled-state title and a nearby inline hint; don't leave operators to infer why an action is unavailable.

The optional editor integration is the exception to the preconditions rule: hide "Open in editor" when `defaults.editorCommand` is unconfigured because setup is uncommon and there is no useful in-context action to offer. A configured dispatch action may also stay hidden until its server-resolved worktree exists.
