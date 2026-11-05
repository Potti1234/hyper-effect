# crease/ui changes from hyper-effect

Changes to crease/ui that came out of building a Linear clone on hyper-effect (`apps/linear-clone`, `EXPERIMENT.md` there). They are written against crease **`696a5bcd`** (`fix(docs): show component groups on guide pages`), and applied in hyper-effect's copies of the components, where they are tested.

- **Applied, with a patch:**
  - C1: an `attributes` prop on `input` and `textarea`;
  - C2: `activateOnHover` on `dropdownMenu`.
- **Recommended, not applied** (an API decision for crease):
  - C3: keyboard navigation that does not render items.
- **No crease change needed:** C4, command palette, combobox, listbox and menu keyboard selection on a server. That was a gap in hyper-effect, now fixed there.

## Applying the patch

All of C1 and C2 is in [`crease-changes.patch`](crease-changes.patch), a unified diff against the files in crease's `src/`:

```sh
cd crease
git apply --ignore-whitespace ../hyper-effect/docs/crease-changes.patch
```

`git apply --check` passes against `696a5bcd`. `--ignore-whitespace` covers line endings, because the diff was made with LF.

The `ui/` wrappers (`src/ui/input.ts`, `src/ui/textarea.ts`) need no change: they pass their props to `renderInput` and `renderTextarea` unchanged, so the new prop reaches the control.

Not in the patch, to add on crease's side: the props tables in the component docs pages for input, textarea and dropdown menu.

## C1. `attributes` on `input` and `textarea`

**Problem.**
- Linear edits an issue's title and description in place and saves when the field loses focus. crease's `input` and `textarea` accept a fixed set of props, and there is no way to put `h.OnBlur(...)` (or `h.OnKeyDown`, or a `data-*` attribute) on the control element itself.
- The only escape was to call the lower-level `renderTextarea` with its own visual attribute groups, re-supplying crease's classes. Or, for the title, to wrap the input in a form with `OnFocusLeave` (the Linear clone's friction-log entry F8).

**Change.** An optional `attributes` prop on `InputBehaviorProps` and `TextareaBehaviorProps`, spread last onto the control element:
- After crease's own attributes and after the visual group, so an app can add anything the props do not name.
- Typed like the element's own attributes: `Attribute<Msg>` for the input, `TextareaAttribute<Msg>` for the textarea.
- Optional, so existing callers are unchanged.

`src/lib/input.ts` (lines 36 and 108 at `696a5bcd`):

```diff
@@ -33,6 +33,10 @@
   isInvalid?: boolean
   isAutofocus?: boolean
   isRequired?: boolean
+  /** Extra attributes for the input element itself, after crease's own: an
+   *  event the props do not name (`h.OnBlur`, `h.OnKeyDown`), a data or ARIA
+   *  attribute. */
+  attributes?: ReadonlyArray<Attribute<Msg>>
 }>
@@ -105,6 +109,7 @@
             ? []
             : [h.AriaDescribedBy(describedBy)]),
           ...visual.input,
+          ...(props.attributes ?? []),
         ])
```

`src/lib/textarea.ts` (lines 31 and 94 at `696a5bcd`):

```diff
@@ -28,6 +28,10 @@
   isReadOnly?: boolean
   isInvalid?: boolean
   isAutofocus?: boolean
+  /** Extra attributes for the textarea element itself, after crease's own:
+   *  an event the props do not name (`h.OnBlur`, `h.OnKeyDown`), a data or
+   *  ARIA attribute. */
+  attributes?: ReadonlyArray<TextareaAttribute<Msg>>
 }>
@@ -91,6 +95,7 @@
             ? []
             : [h.AriaDescribedBy(describedBy)]),
           ...visual.textarea,
+          ...(props.attributes ?? []),
         ])
```

**Usage** (the Linear clone's description editor, `apps/linear-clone/src/app/issue/page.ts`):

```ts
textarea(
  {
    id: 'issue-description',
    value: model.descriptionDraft ?? issue.description,
    onInput: description => Message.ChangedDescription({ description }),
    attributes: [h.AriaLabel('Description'), h.OnBlur(Message.BlurredDescription())],
    class: '…',
  },
  h,
)
```

**Why last, not first:** an app that adds an attribute crease also sets (an ARIA label, a class) means it as an override. Foldkit merges `Class` attributes, so a class added here adds to crease's classes rather than replacing them.

**Verified:**
- In hyper-effect's template (`input`) and in the Linear clone (`input`, `textarea`);
- typecheck, 24 tests, and the clone's two-person browser check, which includes save-on-blur, 41/41 in development and production.

## C2. `activateOnHover` on `dropdownMenu`

**Problem.**
- `dropdownMenu` binds `OnMouseEnter` on every item, which sends `ActivatedItem({ index })`, so the active item follows the pointer.
- In a browser runtime that is a local update and free. When the menu's `update` runs on a server (hyper-effect renders Foldkit UI Submodels server-side), every item the pointer crosses is a request and a morph: dozens per second while moving through a menu, each a round trip.
- With 80 ms of network latency, the highlight trails the pointer visibly.

**Change.** An optional `activateOnHover` prop, default `true` (unchanged behaviour). With `false`:
- **Hover:** plain items bind no `OnMouseEnter`. Hover is styled in CSS (`hover:bg-accent hover:text-accent-foreground`, or `hover:bg-destructive/10` for destructive items), the same tokens the active state uses.
- **Keys** still move the active item (`data-active`), exactly as before.
- **Submenus:** items with a submenu keep `OnMouseEnter`, because a submenu has no click binding and opens on hover; that is one request per submenu, not per item.

`src/ui/dropdown-menu.ts`:

- line 171, the prop:

```diff
@@ -168,6 +168,12 @@
   /** When true, selecting a checkbox or radio item toggles it without
    * closing the menu, so several entries can be edited in one open. */
   keepOpenOnCheckableSelect?: boolean
+  /** Default true: moving the pointer over an item makes it the active
+   * item (a Message per item crossed). False: hover is styled in CSS and only
+   * keys move the active item; items with a submenu still open it on hover.
+   * For menus whose update runs away from the browser (a server), where
+   * every Message is a round trip. */
+  activateOnHover?: boolean
 }>
```

- line 352, the binding:

```diff
@@ -349,7 +355,8 @@
                 anchorName: `--${props.model.id}-sub-${String(index)}`,
               }),
             ]),
-        ...(config.isDisabled === true
+        ...(config.isDisabled === true ||
+        (props.activateOnHover === false && config.submenu === undefined)
           ? []
           : [
               h.OnMouseEnter(
```

- line 392, the hover styling:

```diff
@@ -390,6 +397,11 @@
             config.variant === 'destructive'
               ? 'text-destructive data-[active=true]:bg-destructive/10 data-[active=true]:text-destructive'
               : undefined,
+            props.activateOnHover === false
+              ? config.variant === 'destructive'
+                ? 'hover:bg-destructive/10'
+                : 'hover:bg-accent hover:text-accent-foreground'
+              : undefined,
           ),
```

**Trade-off, for the docs:** with `activateOnHover: false`, the keyboard-active item and the hovered item can differ for a moment (pointer on one item, arrow keys on another). Native menus behave the same way.

**Verified:** the Linear clone's ⋯ menu on the issue page (`activateOnHover: false`). Its browser check opens the menu, moves the pointer over the items (0 requests), and chooses an item with the pointer, in development and production mode (43/43).

## C3. Recommended: keyboard navigation should not render items

**Problem.**
- `dropdownMenu`'s key handler (`menuKey`, `src/ui/dropdown-menu.ts:252`) calls `Behavior.keyMessage`. That calls `enabledEntries` (`src/lib/dropdown-menu-behavior.ts:121`), which calls the app's `itemToConfig` for every item on every key press, to learn which items are disabled.
- `DropdownMenuItemConfig` carries rendered markup (`icon: Html`, `label: Html | string`), so each arrow key builds every item's icon.
- In a browser runtime this is only wasted work. On a server it failed outright: the key handler runs at event time, outside a render, where hyper-effect's builder refused to work. So arrow keys in a crease menu with icons did nothing on the server. dropdown-menu, context-menu, menubar, button-group and item were affected; the compatibility check's new keyboard pass found it.
- hyper-effect now evaluates handlers in a throwaway builder frame, so this works, but every key press still renders all icons.

**Recommendation.** Let keyboard navigation read only what it needs: label text for typeahead, `isDisabled`, `kind`, and the submenu's items. Two options:
1. **Separate the behaviour from the visuals:** an optional `itemToBehavior: (item) => { label: string; isDisabled?: boolean; kind?; submenu? }` prop. `menuKey` uses it when given, and falls back to deriving it from `itemToConfig` as today.
2. **Make `icon` (and other markup) lazy:** `icon?: Html | (() => Html)`, built only when an item renders.

Option 1 is the smaller change and keeps today's API intact. The same pattern applies to `contextMenu`, `menubar` and any component whose key handler resolves item configs.

## C4. Command palette, combobox, listbox, menu: Enter on a server (no crease change)

**What looked like a crease problem:**
- On a hyper-effect server, Enter in `command` (and in every component built on Foldkit UI's combobox, listbox or menu) selected nothing.
- Foldkit UI commits a keyboard-chosen item with a `ClickItem` Command (`Dom.clickElement('#<id>-item-<index>')`), which needs a browser.
- 14 crease components were affected, among them command, combobox, select, multi-selector, tokenizer, field, label, pagination and toolbar.

**Fixed in hyper-effect:**
- `ClickItem`, `ScrollIntoView`, `FocusInput`, `FocusButton` and `FocusItems` are now forwarded to the browser by Foldkit UI's id conventions (`packages/core/src/client-commands.ts`).
- The compatibility check now also presses keys (ArrowDown, ArrowDown, Enter, Escape) and reports what happens; it found both this and C3's problem.
- [`compatibility.md`](compatibility.md) is regenerated.

**Still open, on hyper-effect's side:**
- Dialogs (`ShowDialog`): `dialog`, `alert-dialog`, `sheet`, `drawer`, `command` in a dialog, `lightbox` and `mobile-nav` do not open as modals on a server.
- `ShowDialog`'s result Message drives the dialog's own update, so it cannot simply be forwarded. The design proposal ([design-latency.md](design-latency.md)) covers forwarded Commands that report back.
- No crease change is expected.
