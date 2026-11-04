# Crease journal: general components, the `linear` style, and a design system built on crease

Status: plan, 2026-10-27, written in hyper-effect because nothing is committed in crease from here. Base: crease `main` at `9240b562`. It replaces the earlier `crease-linear-plan.md` and builds on `docs/crease-changes.md` (C1, C2).

**Each journal entry is one crease commit:** a conventional-commit title, the files, what changes, why, and how it is checked. Entries are ordered so every commit builds and passes on its own.

**Part A** extends crease with general components and variants. **Part B** is the tutorial repository: the Linear app in plain Foldkit, one branch per chapter. **Part C** is the guide: how a team builds its own design system on crease, with the Linear system as the worked example.

**Sources:**
- the hyper-effect Linear clone (`apps/linear-clone`);
- crease's own plans: `docs/plan/design-system-guide-series-plan.md`, `design-system-policy-and-ai-plan.md`, `design-system-tutorial-spec.md`, `linear-task-manager-design-research.md`, `tutorial-architecture-enforcement-plan.md`;
- Matt Rothenberg's notes:
  - [className Considered Harmful](https://mattrothenberg.com/notes/classname-considered-harmful/) (2026-10-09);
  - [You Don't Have a Design System](https://mattrothenberg.com/notes/you-dont-have-a-design-system/) (2026-08-03);
  - [Speaking Design at Scale](https://mattrothenberg.com/notes/design-system-language/) (2026-08-21).

## Principles for every entry

1. **Defaults never change.** Every component change is an additive variant or prop whose default renders exactly what crease renders today (shadcn parity). Plain crease stays plain crease.
2. **General names.** Variants and components are named for what they do (`indent`, `inline`, `picker`, `board`), never for Linear.
3. **Linear lives in two places only:**
   - the `linear` style (geometry: control and row heights, row rhythm);
   - the `Linear` preset (tokens: colours, type, radius, motion).

   Selecting both gives the look. Removing them leaves no trace in components.
4. **New looks are named variants, not class overrides.** This is Rothenberg's className argument, and crease already enforces it (`crease/no-component-restyle`, the warning ratchet in `docs/design-system-lint.md`). Nothing in this journal adds a way to pass classes into a component.
5. **Product decisions live in patterns, not in crease.** `IssueRow`, the property pickers and the issue page layout belong to the tutorial app (part B), composed from crease, each with its rules written beside it. This is crease's own boundary from the guide-series plan, and it is how Rothenberg's notes keep decisions from drifting.
6. **Tailwind first.** Every change in this journal touches only `src/ui` and `src/lib` (Tailwind). Each new component or variant gets a `docs/component-roadmap.json` entry saying StyleX and Pleat are not ported yet, as `docs/component-authoring.md` requires. Porting to `src/stylex` and `src/pleat` is a later, separate set of commits, once the Tailwind version has been refined and accepted.
7. **Per the authoring contract, each new component ships:**
   - its source;
   - its `registry.json` entry;
   - a docs definition and real preview;
   - its roadmap status;
   - tests and a scene or e2e test for its behaviour.

   Run `npm run component:create -- <name>` for the shell, and `npm run check:full` before review. `npm run parity:check` should report the new entries as known gaps, not failures.

## Part A: crease foundation

### A0. Problems found while building the tutorial

Building the tutorial against crease `9240b562` turned up nineteen problems in crease itself. Each is small, and each should become its own `fix` commit before the A1+ entries. The tutorial works around each one in its own copy, and the essays say so where it matters.

**Status 2026-10-30:** A0.1 to A0.19 are fixed in crease `main` (pull request #46, merge commit `d0bf498a`, verified with `npm run check` on Windows). Tutorial chapter 15 takes them in and removes the workarounds. A0.20 was found while doing that and is open.

| # | Problem | Where | Fix |
|---|---|---|---|
| A0.1 | `npm run preset:build` fails for every preset code: the script passes the whole `Option` to `presetRegistryJson`, which then encodes `NaN` | `scripts/materialize-create-preset.ts`, `presetRegistryJson(config)` | `presetRegistryJson(config.value)` |
| A0.2 | The CSS the preset compiler generates breaks crease's own CSS policy: 22 violations from `creaseui-lint css` (global `data-slot` rules, `h1,h2,h3,h4`, `:root svg`, `*` motion durations, `font-family` in the token rule) | `src/demo/create-preset.ts` (CSS output) | Emit two files: tokens (`:root`, `.dark`, custom properties only) and geometry (the `:where([data-slot=…])` rules, registered as theme CSS). Leave out the base rules or express them as tokens. The tutorial does this split by hand in chapter 4 (`design-system/theme.md`) |
| A0.3 | A stylesheet registered as an extension (`role: 'theme'`) ends up in ESLint's file list and fails with a TypeScript parser error | `packages/lint/creaseui.js`: `files: [...files, ...paths(() => true)]` | Filter registered paths to script extensions before handing them to ESLint |
| A0.4 | `creaseui-lint scope` reports a line-ending-only difference as an enforcement change (Windows, `core.autocrlf=true`) | `packages/lint/lib/strict/scope.js` | Normalize line endings before comparing |
| A0.5 | The height diagnostic always says "use its `size` option", also for components without one: crease's `input`, and any Button narrowed the way the guide's chapter 5 does (`intent` and `shape`, no `size`) | `packages/lint/lib/strict/component-calls.js` (named-size message) | Name the size prop only when the receipt or the component has one; otherwise say that the component owns its height |
| A0.6 | `sidebar({ collapsible: 'none' })` doesn't fill the page height: `h-full` inside `sidebarProvider`'s `min-h-svh` | `src/ui/sidebar.ts`, the `collapsible === 'none'` branch | `h-svh` (or `min-h-svh` with `self-stretch`) for that branch |
| A0.7 | `sidebarInset` has no `min-w-0`, so content that must not wrap makes the whole page scroll sideways | `src/ui/sidebar.ts`, `sidebarInset` | Add `min-w-0` to its base class |
| A0.8 | `sidebarTrigger` calls `buttonVariants({ variant: 'ghost', size: 'icon' })`, so an app that narrows Button must also edit the sidebar | `src/ui/sidebar.ts:270` | Information, not a bug: the guide's chapter 5 uses it as the example of a system-wide change. A comment at that call would help |
| A0.9 | `creaseui-lint doctor` does not compare a receipt's `variants` with the component's variants. Add `danger` to Button's source only, and TypeScript accepts `intent: 'danger'`, the lint rejects it, and `doctor` reports `coverage complete` | `packages/lint/bin/creaseui-lint.js` (`doctor`), `lib/strict/ownership.js` | `doctor` reads each export's variant union (cva config or prop type) and reports values missing on either side, with the repair (update the receipt, or remove the value) |
| A0.10 | There is no approved way to hide a component at a breakpoint: `hidden md:flex` is rejected on every component (measured on 6 components), and `stack` has no visibility option | `lib/strict/component-calls.js` (class categories), `src/ui/stack.ts` | Count `hidden` and responsive `display` utilities as placement, or give `stack` a `hideBelow` / `showFrom` prop |
| A0.11 | Button's only route for extra attributes, `buttonAttributes`, is reported as an appearance override even when it carries behaviour (`h.AriaExpanded(true)` for a disclosure button) | `lib/strict/component-calls.js`, `src/ui/button.ts` / `src/lib/button.ts` | Give Button named behaviour props (`ariaExpanded`, `ariaControls`, `ariaHasPopup`), as the guide's chapter 7 does in the app; keep rejecting classes inside `buttonAttributes` |
| A0.12 | `dropdownMenu` returns focus to its trigger only on an explicit close. A pointer selection closes the menu and leaves focus on the page body | `src/ui/dropdown-menu.ts`, `updateTyped`: `FocusTrigger` only when `message._tag === 'Closed'` | Also emit `FocusTrigger` when a selection closes an open menu (the guide's app does: `Option.isSome(result.selection) && model.isOpen && !result.model.isOpen`) |
| A0.13 | The base theme names a font it does not load: `--font-sans: 'Inter', 'Inter Fallback', …` with no `@import`, `@font-face` or font dependency, so a fresh install renders in the system font (the guide's chapter 2 screenshots show it) | `registry/theme/crease-theme.css` line 115, `registry/theme/registry.json` | Add `@fontsource-variable/inter` as a dependency of the theme item and import it, naming the family `Inter Variable`; or name no font the theme does not ship |
| A0.14 | crease's strict configuration (`creaseui()`) has no declarative product policy: it accepts `preset`, `policy`, `manifest` and `extensions`, but no forbidden props and no per-component placement allowances, although crease's own plan (`docs/plan/design-system-policy-and-ai-plan.md`, "Common restrictions through configuration") describes them. The non-strict `tailwind()` helper has `contracts` allow lists; strict mode does not | `packages/lint/lib/strict/context.js`, `creaseui.js` | Add a validated `policy` option (forbidden props, placement per contract, contexts), or document receipt `variants` plus plain ESLint rules as the supported route (the guide's chapter 10 uses that route) |
| A0.15 | Receipt `variants` are only checked for string values. A number (`heading({ level: 2 })` with `variants: { level: [4] }`, `stack`'s `gap`) passes without a finding | `packages/lint/lib/strict/component-calls.js`, `analysis.resolveString(value)` in the variants branch | Resolve numeric and boolean literals too, and compare against the receipt's values as written |
| A0.16 | The preset's sidebar tokens are incomplete. Light: `--sidebar-accent` equals `--sidebar`, so the active and hovered sidebar link have no visible background. Dark: the `.dark` block has no `--sidebar`, `--sidebar-foreground`, `--sidebar-accent`, `--sidebar-border` or `--sidebar-ring`, and the product's light `:root` values load after the base theme, so the sidebar stays light in dark mode | `src/demo/create-preset.ts` (token output) | Derive the sidebar accent from the foreground like `--accent`, and emit the full sidebar set in `.dark`. The tutorial adds both by hand at the end of `tokens.css` (chapter 4) |
| A0.17 | `sidebarMenuSubButton` renders an `<a>`. Without an `href` (an app that navigates by Message) it cannot take keyboard focus, and it has no slot for a count like `sidebarMenuBadge` | `src/ui/sidebar.ts`, `sidebarMenuSubButton` | Render a `<button>` when there is no `href`, and support `sidebarMenuBadge` next to sub-items. The tutorial uses an `indent` option on `sidebarMenuButton` instead (chapter 7) |
| A0.18 | `avatarFallback` fills with `bg-muted`. In themes where the sidebar surface equals `--muted` (the Linear preset), initials on the sidebar have no visible circle | `src/ui/avatar.ts`, `avatarFallback` | A `tone` option, or a fill that differs from the sidebar surface. The tutorial adds `tone: 'accent'` (chapter 7) |
| A0.20 | The preset compiler still loads Inter from Google Fonts (`@import url('https://fonts.googleapis.com/…')`) and sets `--font-sans: "Inter", …`, while the base theme since A0.13 loads the self-hosted `@fontsource-variable/inter`, whose family is `"Inter Variable"`. A preset loaded after the base theme therefore names a family that is not loaded unless the Google import stays. Found in tutorial chapter 15 (crease `d0bf498a`) | `src/demo/create-preset.ts`, the font import (around line 1351) and `fontFamily` | For `inter`, emit no import (the theme item ships the font) and name `"Inter Variable"` first. The tutorial deletes the import and renames the family by hand (`design-system/theme.md`) |
| A0.19 | 24 files in `src/ui` (49 in the repository), among them `command.ts` and `tooltip.ts`, start with a UTF-8 byte-order mark, so a fresh install differs from the registry source by one invisible character; the wiring example at the end of `command.ts` contains a broken line (`const commandOp__ = //   AppCommand.update(...)`) | `src/ui/command.ts`, `src/ui/tooltip.ts` | Strip the BOM; repair the example |

### A1. `fix(input,textarea): accept behaviour attributes`

**Files:** `src/ui/input.ts`, `src/ui/textarea.ts`, `src/lib/input.ts`, `src/lib/textarea.ts`, `packages/lint/rules/no-component-restyle.js` and its tests, and the input and textarea docs definitions.

**What:**
- An `attributes` prop, appended after the component's own attributes. The diff is `hyper-effect/docs/crease-changes.patch`, C1; it still applies to `9240b562`.
- **Added here:** `attributes` is for behaviour only (events, `aria-*`, `data-*`, `name`, `autocomplete`). The lint rule reports `h.Class`, `h.Style` and `h.Attribute('class' | 'style', …)` inside `attributes`. `STYLE_ESCAPE_MEMBERS` in `packages/lint/lib/strict/inventory.js` already names them.

**Why:**
- Saving on blur (inline title and description editing) needs `OnBlur` on the control.
- Without the lint extension, `attributes` would become the className escape hatch that principle 4 rules out.

**Check:**
- typecheck;
- a test that the attributes render;
- one valid fixture (`h.OnBlur`) and one invalid fixture (`h.Class('h-6')`) for the rule.

### A2. `feat(dropdown-menu): activateOnHover option`

**Files:** `src/ui/dropdown-menu.ts`, the docs definition, and a scene test.

**What:**
- `activateOnHover?: boolean`, default `true`, so behaviour is unchanged.
- With `false`, items get no mouse-enter or mouse-leave Messages, and a hover highlight in CSS (`hover:bg-accent`). Keyboard highlight still goes through the Model.
- The diff is C2 in `crease-changes.patch`.

**Why:** a menu whose highlight is in the Model sends one Message per item hovered. In a browser app that's cheap; on a server or in large menus it isn't. A CSS hover is also what shadcn's menus do.

**Check:** a scene test that hover sends no Message with `false` and still does with the default.

### A3. `fix(sidebar): mark the active link with aria-current`

**Files:** `src/ui/sidebar.ts` (`sidebarMenuButton`, about line 558; `sidebarMenuSubButton`, about line 750).

**What:** when `isActive` is true and `href` is set, add `h.AriaCurrent('page')` next to `data-active`.

**Why:** screen readers announce the current page from `aria-current`, not from `data-active`. The clone's hand-built sidebar has it; crease's doesn't.

**Check:** a unit test on the rendered attribute; the sidebar blocks' visual audit is unchanged.

### A4. `feat(sidebar): indent variant for sub-menus`

**Files:** `src/ui/sidebar.ts` (`sidebarMenuSub`, about line 699) and the sidebar docs.

**What:** `variant?: 'line' | 'indent'`, default `'line'` (today's guide line, `border-l`). `'indent'` indents the items under their parent's label without the line.

**Why:** many apps (Linear, Notion, GitHub's repository sidebar) indent nested navigation without a rule. Today that requires a class override, which the lint forbids.

**Check:** a preview for both variants; the existing sidebar blocks render unchanged.

### A5. `feat(sidebar): badges on sub-menu items`

**Files:** `src/ui/sidebar.ts` (`sidebarMenuBadge` positioning, `sidebarMenuSubButton`) and docs.

**What:** `sidebarMenuBadge` positions itself against `menu-sub-button` as well as `menu-button`, using the same `peer-data-[size=…]` selectors.

**Why:** counts on nested entries, such as open issues per team or unread messages per channel.

**Check:** a preview and a visual check at both sizes.

### A6. `feat(item): group header`

**Files:** `src/ui/item.ts`, docs, tests and a scene test.

**What:**
```ts
itemGroupHeader({
  icon?: Html,
  label: string,
  count?: number,
  isCollapsed?: boolean,
  onToggle?: Msg,          // renders a disclosure button with aria-expanded
  actions?: ReadonlyArray<Html>,
  sticky?: boolean,        // sticks to the top of its scroll container
}, h)
```
It carries `data-slot="item-group-header"`, so styles and presets can size it.

**Why:** grouped lists (issues by status, mail by date, files by type) all need a header with a count, a collapse toggle and an action. crease has `itemGroup` and `itemHeader`, but no collapsible, sticky group header.

**Check:** a scene test of the toggle and `aria-expanded`; a preview with a long list.

### A7. `feat(item): inline layout`

**Files:** `src/ui/item.ts`, docs and tests.

**What:** `layout?: 'wrap' | 'inline'`, default `'wrap'` (today's `flex-wrap`). `'inline'` keeps a row on one line:
- media fixed at the start;
- `itemContent` takes the remaining width;
- `itemTitle` truncates;
- `itemActions` stays at the end.

**Why:** dense rows (issue lists, file lists, inbox rows) must never wrap; a wrapped row breaks the column rhythm of the whole list.

**Check:** a preview with a very long title at 390 px and 1440 px.

### A8. `feat(create): linear style`

**Files:** `src/demo/create-preset.ts`, `docs/create-presets.md`, `test/create-preset.test.ts`, and `e2e/sites/preset-geometry.spec.ts` / `preset-matrix.spec.ts` if they enumerate styles.

**What:**
- Append `'linear'` to the end of `STYLES`. Never insert it: preset codes store the index, and the current code format has 4 bits, room for 16 styles.
- Its rule in `STYLE_RULES`:
  - `mira`'s compact control geometry;
  - 28 px rows for `ROW_SLOTS` (`item`, `sidebar-menu-button`), and the same height for `item-group-header`;
  - hairline row separators.

**Why:**
- `mira` follows shadcn's Mira exactly. Changing it to add row heights would break that parity, so a separate style is the honest place for a different geometry.
- Named `linear` as agreed. It is a geometry, so other products can use it too.

**Check:**
- `preset-geometry` covers the new heights;
- old preset codes decode unchanged (a test with a few existing codes);
- the `/create` board renders with the new style.

### A9. `feat(create): Linear preset`

**Files:** `src/demo/create-preset.ts` (`presets`) and `docs/create-presets.md`.

**What:**
```ts
{
  name: 'Linear',
  description: 'Cool zinc greys, a calm indigo and compact rows, after Linear',
  config: {
    ...DEFAULT_CONFIG,
    style: 'linear',
    base: 'zinc', surfaceSaturation: 0.004,
    hue: 277, chroma: 0.16, lightness: 55,
    surfaceLightness: 100, surfaceLightnessDark: 19,
    radius: 0.8, shadow: 30, relief: 'flat', outlines: 'soft', hover: 'neutral',
    font: 'inter', textScale: 0.925, headingWeight: 600, tracking: -0.01,
    motion: 0.8, chartColor: 'indigo',
    overrides: { 'dark:border': 'oklch(1 0 0 / 8%)', 'dark:input': 'oklch(1 0 0 / 12%)' },
  },
},
```
The values come from the clone's `apps/linear-clone/src/styles.css`, e.g. primary `oklch(0.55 0.16 277)` and greys at hue 285–286. There is no `scheme`, because both themes are intended.

**Why:** the look of the clone, available to every crease app through `/create` and `npm run preset:build`.

**Check:**
- `npm run preset:build -- --preset <code>`;
- the generated CSS replaces the clone's own `:root` and `.dark` blocks, and the clone's screenshots look the same in light and dark;
- the contrast checks from the theme plan pass.

### A10. `feat(picker): filterable selection menu anchored to its trigger`

**Files:** a new `src/ui/picker.ts` (on `ComboboxPrimitive`, as `command.ts` is), `registry.json`, docs, roadmap, tests and a scene test.

**What:**
```ts
picker({
  model, toParentMessage,
  trigger: { label: 'Status', children: [...] },   // the anchor button
  items: [{ value, label, icon?, shortcut?, keywords? }],
  selected: ReadonlyArray<string>,
  multiple?: boolean,
  placeholder?: string,
}, h)
// OutMessage: Selected { value } | Toggled { value } | Closed
```

**It must handle:**
- a CSS-anchored popover;
- focus to the filter input on open;
- an active option with `aria-activedescendant`;
- a check mark on selected values;
- shortcut hints and number keys when `shortcut` is set;
- Escape closing it and returning focus to the trigger;
- modified keys (Ctrl/Cmd+Enter) passing through to the app, a lesson from the Crease Tasks slice.

**Why:** GitHub's label menu, Notion's property menus and Linear's pickers all have this shape. Today each app builds it: the clone in `view/picker.ts` (271 lines), the Crease Tasks slice in `src/design/pickers.ts`.

**Check:** a scene test for single and multi select, filter, keys and focus return; an e2e test in the preview.

### A11. `feat(board): columns of cards with drop targets`

**Files:** a new `src/ui/board.ts` (a view helper: the app owns drag state), registry, docs, roadmap and an e2e test.

**What:**
```ts
board({ columns: [{ id, header: Html, cards: ReadonlyArray<Html>,
                    isDropTarget: boolean, onDragEnter: Msg, onDrop: Msg }] }, h)
```

**Why:** kanban boards are a common app layout, and crease has none. As a view helper it works the same in a browser app and on a server (hyper-effect).

**Check:** an e2e drag between columns; keyboard alternative documented (move through the card's menu).

### A12. `feat(timeline): activity feed`

**Files:** a new `src/ui/timeline.ts`, registry, docs and roadmap.

**What:**
```ts
timeline({ entries: [{ media: Html, content: Html, time: Html, variant: 'event' | 'comment' }] }, h)
```
- `event` is a compact one-line entry.
- `comment` is a block with a border.

**Why:** issue activity, audit logs and order histories. `message` (chat) and `log-stream` (terminal) don't fit.

**Check:** a preview with mixed entries and long content.

### A13. `feat(lint): override report`

**Files:** `packages/lint/bin/creaseui-lint.js` (a new `overrides` command), `packages/lint/README.md` and `docs/design-system-lint.md`.

**What:** `creaseui-lint overrides --json` lists every class, style and suppression passed to a crease component, grouped by component and by class, with counts.

**Why:** this is Rothenberg's "trust, but verify". The warning ratchet says *how many* overrides exist; the report says *which*, so a class that keeps recurring shows up as a missing variant. A diff of the report against `main` on a pull request is a cheap CI signal.

**Check:** fixture tests; run it on crease's own docs (the 386 ratchet warnings) to see the first real report.

**Order and size:** A1–A5 are small and independent. A6–A7 come before A8, whose rule sizes their slots, and A9 follows A8. A10–A12 are medium-sized and independent. A13 can come at any time.

## Part B: the tutorial repository, a branch per chapter

The Linear example is rebuilt as a plain browser Foldkit app, with a local seed and no hyper-effect. It doesn't live in crease. It lives in its own repository, where every tutorial chapter is a branch.

### B1. Repository

**Where:** `C:/Users/lpottner/Documents/MaasProjects/creaseui-demo`, the repository the guide-series plan names. Remote: `https://github.com/Potti1234/creaseui-demo` (`origin`), which already holds an initial commit (MIT licence) and eight `experiment/*` branches from 2026-10-19. On 2026-10-30 `main` was joined to that initial commit with a merge (`b8c1c2e`), ready to push.

**What is there now:**
- the branch `archive/tutorial-attempt-01` (commit `f723c38`), the first attempt with its architecture findings;
- no remote, and a clean working tree.

The archive branch stays. The new work starts from an empty root commit, so the tutorial history doesn't contain the attempt.

**How the app gets crease:**
- through crease's registry, pinned to an exact crease commit in `crease.lock.json`, with Tailwind only;
- a clean clone must run without the crease checkout, links or a parent `node_modules` (the tutorial spec's rule).

### B2. One branch, a tag per chapter

Decided 2026-10-27: `main` is the only branch. Each chapter is one commit on it, tagged `chapter-NN`.
- `git diff chapter-04 chapter-05` is exactly the code of chapter 5.
- `git switch --detach chapter-05` gives the app as chapter 5 leaves it.

**Before the guide is published,** a fix to an earlier chapter amends that chapter's commit, replays the later ones and moves their tags. This happened once already: chapter 5's inline rows still let the Search row wrap its identifier, found by the essay's figure, so `chapter-05` was amended.

**After publishing,** tags don't move. A fix becomes a new commit on `main`, and an essay that must show it links a new tag (`chapter-05-v2`).

**State on 2026-10-27:**

| Tag | Commit | Content |
|---|---|---|
| `chapter-02` | `e30ecac` | Foldkit app, crease components from the registry (crease `9240b562`), strict lint with receipt, the first slice (3 views, 13 lint warnings in migration mode) |
| `chapter-03` | `e12cfc9` | `design-system/product-brief.md`, `principles.md` (decisions D1 to D10, each naming its enforcement) |
| `chapter-04` | `4950efd` | The theme from crease's preset compiler (mira, zinc, indigo 277, surface contrast 6), split into tokens and registered geometry; a light/dark switch in the sidebar footer through `src/theme/mode.ts`, a registered setup file; the sidebar tokens the preset leaves out (A0.16), added by hand |
| `chapter-05` | `2b48ea2` | `item` `layout: 'inline'`, Button narrowed to `intent` and `shape`, allowed values in `crease.lock.json`, callers migrated (including the theme switch), ratchet 13 to 1 |
| `chapter-06` | `094bcd2` | Migration mode only for the one file with a finding, `npm run check` and `npm run scope`, `design-system/boundaries.md`, `AGENTS.md` |
| `chapter-07` | `b6bca48` | `IssueRow`, `IssueGroup`, `IssueCollection`, `PropertyPicker` and `AppSidebar` in `src/design`; the clone's navigation (teams Engineering and Design with Issues pages and counts, saved views Urgent & high and Unassigned, the person with the theme switch); local options `indent` on `sidebarMenuButton` (A0.17) and `tone: 'accent'` on `avatarFallback` (A0.18); crease `dropdown-menu`; a product import rule; ratchet 0 |
| `chapter-08` | `2a7b840` | `IssueComposer` (draft in the page Model, validation, Ctrl/Cmd+Enter), saving through Effect's `KeyValueStore` with the theme choice, `SaveNotice`; `IssueDetail` (a page per issue, title and description edited in place, row title as a link); `CommandMenu` on Ctrl+K with crease `command`, `C` for a new issue |
| `chapter-09` | `13aeb3d` | Story tests, lint fixtures, the browser check (22 steps at chapter 14, including the title ellipsis) with a component check page, `design-system/verification.md` |
| `chapter-10` | `0a00f12` | `policy/product-policy.js` (item, dropdown-menu, dialog, command), receipt narrowing for `badge` and `text`, the label look replacing crease's outline badge, `design-system/policy.md` |
| `chapter-11` | `324b254` | A product lint rule, `crease-tasks/one-primary-action` (D4), with RuleTester tests and a fixture |
| `chapter-12` | `121a140` | The drift test, re-run: three agents add an Active bugs view with identical screens and the same filter; they differ in the view's id and the place of the tests (D11); agent B's version adopted; the `AGENTS.md` stop rule; `design-system/drift-tests.md` |
| `chapter-13` | `d19ccfd` | A board per team as a reviewed system change: `IssueBoard`, `IssueCard`, D12, the Board link and the Layout button through one helper, six browser steps, change record `008-issue-board.md` |
| `chapter-14` | `9f53a79` | `IssueCollection`'s `controls` replaced by `display` and `actions` in three commits (add and deprecate, migrate, remove); D13; change record `009-display-options.md` |
| `chapter-15` | `7c21dda` | crease updated from `9240b562` to `d0bf498a` (A0.1 to A0.19 fixed upstream): components merged with `git merge-file`, theme regenerated, lint package repacked; workarounds removed (hand-split theme and sidebar tokens, ESLint CSS ignore, local `ariaExpanded`, `indent`, avatar `tone`, dropdown focus patch); team pages on crease's sub-menu; one edit left in `tokens.css` (A0.20); change record `010-crease-update.md` |

**The essays** live in a separate folder, `MaasProjects/creaseui-guide`: a Foldkit app whose figures render the tagged code. `npm run snapshot` copies `src/` of each tag into `src/snapshots/<tag>` (it only rewrites `@/` imports and exports the three row functions) and writes the chapter diffs into `src/generated`. Essays exist for chapters 1 to 15 (`chapter-01.html` to `chapter-15.html`, index at `http://127.0.0.1:5198` with `npm run dev`). Text and figures share one 800px column.

### B3. What the app gains per chapter

This is the original plan. On 2026-10-28 chapters 4 to 14 were rebuilt so the app matches the hyper-effect clone: the dark mode in 4, the clone's sidebar in 7, the issue page and the command menu in 8, a board per team in 13 (the timeline is not built). Chapter 12 is a drift test with a saved view, and 14 migrates `IssueCollection`'s bar API. The first build is kept as the tags `v1/chapter-NN`. B2 lists what each tag contains.

Chapters follow `docs/plan/design-system-guide-series-plan.md`. G01 has no branch: it shows the finished app (`main`) and the choices.

| Chapter | The Linear app gains | Needs crease |
|---|---|---|
| `02-install-and-run` | A Foldkit app, crease theme and button, the lint add-on, one working interaction | registry as-is |
| `03-principles` | `design-system/principles.md` and decision records: dense rows, edits in place, the composer as the only way to create an issue, keyboard first | — |
| `04-theme-and-tokens` | The `Linear` preset and `linear` style; a token preview page; light and dark | A8, A9 |
| `05-customize-a-component` | Button narrowed to two intents and one height; the `inline` item variant added from a recurring override | A7, A13 |
| `06-contracts-and-boundaries` | Local contracts; feature code can't import the broader implementations | — |
| `07-compose-product-patterns` | Sidebar shell, `IssueRow`, `IssueGroup`, `PropertyPicker`, `IssueCollection`, each with its rules; `design-system/patterns.md`; the issue list works | A3–A6, A10 |
| `08-state-and-workflows` | Composer dialog, inline title and description edits, browser persistence, drafts | A1 |
| `09-verify-your-system` | Story and scene tests, browser checks, visual baselines, the first drift test | — |
| `10-configure-product-policy` | `eslint.config.js` with the product policy | — |
| `11-custom-lint-rule` | A product rule, e.g. issue properties are only changed through `PropertyPicker` | — |
| `12-ai-feature-work` | The board view, built by an agent inside the system | A11 |
| `13-ai-system-change` | The activity timeline, added deliberately as a system change | A12 |
| `14-evolve-apis` | A renamed variant and migrated callers; the override report going down | A13 |
| `15-upstream` | A crease update merged without losing local changes: crease `d0bf498a`, which fixes A0.1 to A0.19 | A0.1–A0.19 (done) |

**What has to exist first:**
- Chapter 4 needs A8–A9 committed in crease.
- Chapter 7 needs A3–A6 and A10.

Writing branches 02–03 can start right away.

**Pilot:** the guide plan asks for one pilot essay before the rest. I recommend chapter 5, "Customize a component": it carries the series' central argument (an override becomes a named variant), and it needs only the issue row.

### B4. Afterwards, in hyper-effect

The clone drops its hand-built sidebar, picker, rows and theme. It copies the crease components and the tutorial's patterns and keeps only what is server-specific. Its 43-step browser check is the acceptance test. That is hyper-effect work.

## Part C: the guide, building your own design system on crease

### C1. The idea

**crease is a base, not the design system.**
- A team installs crease's components, tokens and lint.
- It then adds the variants its product needs and removes the ones it doesn't.
- It builds named patterns on top that carry its product decisions.

The lint keeps feature code inside that vocabulary.

**Rothenberg's three notes give the reasons:**
- A component library supplies parts, not decisions. Two teams with the same parts still build different settings pages, until someone makes the decision once, names it, and puts it where the next builder will find it.
- Passing classes into components turns every internal class into public API and lets looks drift. The fix is named variants plus a lint, with an inventory of the overrides that remain.
- Named patterns, with their rules written beside the code, are a vocabulary people and agents can build from. A request names the pattern, and the agent reads its code and rules.

**This guide is not a new series.** It is the Linear system as the worked example running through the existing plan, `docs/plan/design-system-guide-series-plan.md` (G01–G15), with two additions (C5).

### C2. The layers of the Linear system

Each layer resolves one more question and is checked by its own mechanism:

| Layer | Linear system | Owner | Enforced by | Chapter |
|---|---|---|---|---|
| Tokens | `Linear` preset (A9) | crease preset, copied into the app | theme checks, contrast audit | G04 |
| Geometry | `linear` style (A8) | crease style | `preset-geometry` e2e | G04 |
| Components (atoms) | crease components, with variants added (`item` inline, sidebar sub-menu `indent`) and removed (the app's Button keeps two intents and one height) | the app's copy of crease source | `no-component-restyle`, local contracts, types | G05, G06 |
| Behaviours (molecules) | `PropertyPicker` (picker plus the issue vocabulary), `InlineField` (saves on blur or Enter, reverts on Escape) | app patterns | scene tests | G07, G08 |
| Arrangements (organisms) | `IssueRow` (fixed order: priority, identifier, status, title, labels, date, assignee), `IssueGroup`, `PropertiesPanel` | app patterns | pattern contract, review | G07 |
| Templates | `IssueCollection` (header, filter bar, grouped list), `IssueDetail` (content left, properties right, timeline below) | app patterns | structured API, browser check | G07 |
| Policy | which components and variants feature code may use, and where | `eslint.config.js` with crease's config factory | lint | G10, G11 |

**Adding and removing variants is the core operation (G05).** Following crease's own table in `design-system-policy-and-ai-plan.md` ("Normal customization operations"), both directions change several places together:
- **Adding** a variant updates the type, the implementation, the contract and its guidance.
- **Removing** one updates the type, the runtime branch, the contract and every caller. A negative fixture proves the removed value fails.

The Linear example does both:
- it **adds** `inline` rows;
- it **removes** Button sizes;
- it **narrows** `badge` to the two tones the product uses.

### C3. Rules beside the pattern

Every template and organism opens with its rules in a doc comment. This follows Rothenberg's settings example: the ticket decides which settings exist, and the pattern decides how they appear. For `IssueCollection` the comment would be:

```ts
/**
 * Rules for every issue collection (team issues, my issues, saved views):
 *
 * - One header: the view name and its count. Actions sit in the header's
 *   action slot, never in the list.
 * - Filters and display options live in the bar under the header, separately:
 *   a filter changes which issues show, a display option changes how.
 * - Issues are grouped by status in workflow order; empty groups are hidden,
 *   collapsed groups keep their header and count.
 * - Every row is an IssueRow. Properties change in place through a
 *   PropertyPicker; the row keeps its position and focus until it regroups.
 * - Creating an issue opens the composer; nothing is created from the list.
 * - Keyboard: j/k move, s/p/a open the pickers, c creates. Every key has a
 *   pointer route.
 *
 * The view decides which issues show. These rules decide how they appear.
 */
export const issueCollection = ...
```

**The same rules go into `design-system/patterns.md`, with three entries per pattern:**
- its purpose;
- when to use it;
- when not to.

**`AGENTS.md`** points agents to that file first. A request such as "a project page listing its issues" then resolves to `IssueCollection` with a filter, instead of a new page shape.

### C4. Enforcement

- **Lint:**
  - `crease/no-component-restyle` allows only `layout` on components;
  - local contracts declare the app's variants (`docs/design-system-lint.md`, "Adding or changing a contract");
  - A1's rule closes the `attributes` route.
- **Override report (A13):** run on every pull request. A recurring class is the signal for a missing variant, which is decided in the design layer instead of patched in a feature.
- **Exceptions:** only with an owner and reason, per the existing exception policy.

### C5. Two additions to the existing chapter plan

1. **G05 "Adapt a component and reduce its API" gains a section "Add a variant from a recurring override".** Start from the A13 report on the Linear app, where three features pass the same class to `item`. Turn it into the `inline` variant, migrate the callers, and lower the ratchet. This teaches the full loop: override → report → variant → migration.
2. **G09 "Verify the whole system" and G12 "Use AI for feature work" gain the drift test.** Give the same ordinary ticket (for example "add a page for a project's issues") to three fresh agents that see only the system:
   - **Before** the patterns and rules exist, compare their screens: what differs is the decision the system hasn't made yet.
   - **After** them, the screens should agree.

   This is Rothenberg's experiment, and it is the most direct test that a design system carries its decisions.

### C6. How the essays look: visual explanations and comparisons

The guide plan already names the editorial references (Rothenberg's notes and [Logging Sucks](https://loggingsucks.com/) by Boris Tane) and the rule to write original prose. These are the devices taken from them, made concrete for this series.

**From the references:**

| Device | In the references | In this series |
|---|---|---|
| **Open on the failure, shown** | Logging Sucks opens on a wall of scrolling log lines; Rothenberg opens on a grid of one library's six components as shipped and as used, each override labelled | Each essay opens with the problem visible, e.g. the same issue row as shipped and as six features use it, every override labelled with its class |
| **A named playground per idea** | Logging Sucks has eight, each named ("The Log Chaos Simulator", "Query Playground") | One to three per essay, named, built from real crease components and the chapter's own code |
| **Flip between versions** | Rothenberg's tabs flip between three agents' settings pages; whatever moves is the drift | Before/after and A/B/C tabs on the same screen, so the difference is the only thing that moves |
| **Realistic artifacts** | A bot comment on a pull request, a terminal `rg` run, a chat message before and after, a file tree linking names to code | The override report as a pull-request comment, real lint and test output, a ticket before and after the vocabulary exists, the app's `design-system/` tree |
| **Misconceptions** | Logging Sucks answers five common objections, each as its own heading | A short "But…" section per essay ("Tokens already make it consistent", "We can just pass a class") |
| **Take it with you** | A closing list of practices | A closing checklist the reader applies to their own system |

**The playgrounds, per chapter.** The names are working titles.

| Chapter | Playground | The reader… |
|---|---|---|
| 03 Principles | **One Ticket, Three Pages** | flips between three agent-built issue pages from the same ticket, before the rules exist and after |
| 04 Theme | **Token Tuner** | moves the preset's knobs and watches the real issue list and its contrast readout change |
| 05 Component | **The Override Wall** | sees one `IssueRow` as shipped and as used by six features, every override labelled |
| 05 Component | **Variant or Override?** | sorts recurring classes into "variant", "parent layout" and "bug nobody reported" |
| 06 Boundaries | **Who May Import This?** | picks a file and sees which imports the lint allows, and why |
| 07 Patterns | **Anatomy of a Row** | hovers over the parts of a live `IssueRow` and sees the rule that places each one |
| 07 Patterns | **Say It in the System's Words** | turns a plain request into the pattern tree it resolves to, with links to code and rules |
| 08 Workflows | **One Status Change, Step by Step** | changes a status and steps through Message, update, Model diff, view, and where focus goes |
| 09 Verify | **Break It** | switches on deliberate regressions and sees which check catches each: types, lint, scene or browser |
| 10–11 Policy | **Policy Playground** | edits a lint configuration and sees the result on a sample feature file |
| 14 Evolve | **Rename and Migrate** | sees the variant rename as a diff, the callers migrating, and the ratchet number falling |
| 15 Upstream | **Three-Way Merge** | sees crease's change, the local change and the merged result side by side |

**Rules for every visual:**
- It shows a decision the reader can observe. Decoration doesn't count; this is the guide plan's rule.
- It uses real crease components and the chapter's tagged source, never a re-drawn imitation. The site is a crease app, so the explanations are crease code too.
- It works with the keyboard and with reduced motion. A static fallback carries the same point for readers who don't interact.
- Each playground is a Foldkit Submodel in the docs site, written once and reused by later chapters.

## Decisions

**Decided 2026-10-27:**
- **Tailwind first** (principle 6). StyleX and Pleat follow once the Tailwind version is reviewed and liked.
- **The tutorial app lives in `creaseui-demo`**, on one branch with a tag per chapter (B2), not as a crease block.
- **The essays use visual explanations and comparisons** in the style of Rothenberg's notes and Logging Sucks (C6).

- **Chapter 5 is the pilot essay.** It is written and running (B2).
- **`creaseui-demo` started fresh.** The first attempt is kept on `archive/tutorial-attempt-01`, and its ignored local files were moved to `MaasProjects/creaseui-demo-attempt-01-local`.
