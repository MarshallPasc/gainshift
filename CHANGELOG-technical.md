# Gainshift — changelog (technical)

For reviewers and anyone reading the code: what changed, why, and how each claim
was checked. `CHANGELOG.md` is the other one - short, plain-language, and what
goes on the listing.

Every entry below was checked against the archived source of that version, not
written from memory. Where a claim is unusual — "2.0.0 changed no behaviour" —
the check that supports it is stated.

The add-on ID has been `tab-volume@pascal.local` since 1.7.2 and has never
changed. It looks wrong now that the name is Gainshift, but changing it would
make AMO treat this as a different add-on and break updates for existing users.

---

## 2.1.0

Two features and four fixes, no new permissions. `content.js` is
byte-identical to 2.0.3; `audio-hook.js` changes only in how element volume is
written, described under **Fixes** below. Everything else is in `background.js`,
`popup.js`, `popup.html` and `manifest.json`.

### Per-tab scope

`background.js` has held a per-tab override and a per-site store side by side
since 1.7.2, but the two were never distinguishable after the fact: a
site-scoped change leaves the override and the stored level equal, so comparing
them cannot tell you whether a tab is deliberately held apart. 2.1.0 records the
answer instead, in a `tabScopes` map, and funnels every write through one
function:

```js
async function applyLevel(tabId, value, scope) { … }
```

`scope === "tab"` sets the override and nothing else — `sites` is not touched and
`persist()` is not called. `scope === "site"` does both, as before. `lookupVolume`
and `storeVolume` now answer with `{ host, scope, remembered, siteValue }` so the
panel can show the site's own level while the tab is overriding it.

Scope is per-tab state, so it is dropped wherever the other per-tab state is
dropped. Those three call sites previously deleted only the override; they now
call one `forgetTab()` that clears the override, the scope and the mute history
together. Firefox reuses tab ids, so a half-cleared tab hands its leftovers to
whatever opens next.

### Keyboard commands

`commands` is a manifest key, not a permission — the install prompt is unchanged.
Defaults are `Alt+Shift+W/X/N/Q` plus `Alt+Shift+G` for
`_execute_browser_action`, all re-bindable. `Ctrl+Alt` was rejected because it is
AltGr on European layouts; `Ctrl+Shift` because Firefox already occupies nearly
every letter there.

The first pick — `W/S/D/Q` and `V` — was wrong, and testing on a real Windows
Firefox is what found it: `Alt+Shift+<letter>` still fires the menu bar's access
keys, so `S` opened History and `V` opened View, while `Alt+D` is the address
bar. Any letter that is a menu mnemonic is unusable: `F E V S B T H` on an
English build, `D B A C L E H` on a German one, plus `D` for the address bar
everywhere. `W X N Q G` are outside both sets. The lesson is that the reserved
list is a property of the *localised* browser, not of the WebExtensions API,
and no amount of reading the shortcut documentation would have shown it.

`R` was the second pick for reset and also had to go, for a different reason:
on the test machine *Firefox had it bound correctly* — Manage Extension
Shortcuts showed `Alt+Shift+R` against the command — and the key still never
arrived, because something outside the browser holds it as a global hotkey
(recorders and overlays commonly do). Nothing an extension can detect, and
nothing a reserved-key list would have predicted. It is the reason the
shortcuts are documented as re-bindable rather than as facts.

The listener is deliberately narrow:

- It always applies `"tab"` scope and therefore **never writes to storage**. A
  keystroke adjusts the tab in front of you; it does not redefine a site.
- `volume-reset` sets 100%, and does it **tab-scoped**. That is the part that
  matters: writing 100% to the *site* would silently destroy a level the user
  deliberately saved, so the override is set and `sites` is left alone. The tab
  returns to the site's level on its own when it navigates away or closes.
- `volume-mute` records the level it is leaving, including when that level came
  from the site rather than from a previous adjustment, so unmuting returns
  there rather than to 100%.
- Steps run through `clampLevel()`, which rounds to whole percentage points:
  `0.7 + 0.05` is `0.7500000000000001` in binary floating point, and that dust
  would otherwise reach both the badge and storage.

### Panel

A two-state `Tab`/`Site` control, with the inactive state always visible so the
answer is readable without clicking. Choosing a scope re-applies the level
already on screen, so the choice takes effect immediately rather than at the next
nudge of the slider.

The site line is now built from separate elements — hostname, and the level
beside it — because they shrink differently: on a narrow row the hostname
ellipsises and the level never does. Rendering the panel at 290px with a long
hostname showed `youtube.com keeps …`, with the one number worth reading cut
off. The row is now two lines: controls above, text below.

**The scale under the slider was lying, and had been since 1.7.2.** The four
labels were laid out with `justify-content: space-between`, which spaces them
evenly — but the track is linear from 0 to 600, so 100 belongs one sixth of the
way along, not a third. Measured in the 290px panel: `100` was drawn at 78.9px
when 100% sits at 48.8px, and `300` at 160.9px when 300% sits at 130.8px — both
30px too far right. At 179% the thumb's centre is 80.8px, which put the `100`
label 1.9px from the thumb: the slider looked broken, and that is how the bug
was reported. Each label is now positioned at its own value:

```css
left: calc(var(--thumb) / 2 + var(--at) * (100% - var(--thumb)));
```

The `--thumb` term is not decoration. A range thumb's centre travels from half a
thumb in to half a thumb short of the far end, so the span a value maps onto is
(track − thumb), not the track. 18px is Firefox's thumb width, measured off a
screenshot of the running add-on rather than assumed; getting it wrong would
only shift the end labels by a pixel or two, but the constant should be a
measurement.

Verified from pixels rather than from the formula that produced it: the slider
is rendered at 0, 100, 300 and 600, the thumb's centre is located by finding the
only tall object in the row, and it is compared against each label's centre as
the DOM reports it. Every label lands within 1.2px of its thumb, the residual
being Chromium's 16px thumb against Firefox's 18px — on Firefox it is closer.

### Fixes

- **At 100%, a player's own volume was overwritten.**
  `applyToElement()` set `el.volume = current` for every element at or below
  100%, including the first time an element was seen at exactly 100%. A player
  that restores a saved level before calling `play()` — a video site kept at
  30% — was forced to full volume with the extension installed and never
  touched. At 100% an element Gainshift has not yet written to is now left
  alone, and one we *have* written to gets its own level handed back rather
  than being pinned at 1 — `current === 1` now calls `releaseToPage(el)`, which
  already existed for the page-routing case and already declines when the page
  has moved the value since. Both halves matter: fixing only the untouched case
  left the same slider position behaving differently depending on whether it had
  ever been moved. Off 100%, the element is taken over exactly as before.

  Two details that are easy to get wrong and are pinned by tests. The recorded
  "original" is re-read on each *takeover* rather than once per element, because
  between spells at 100% the element belongs to the page and a player may move
  its own level while we are not holding it. And ownership is claimed *before*
  the write: assigning `el.volume` fires `volumechange` synchronously, which
  re-enters `setElementVolume`, and with the claim recorded afterwards that
  re-entrant call looked like a fresh takeover and filed our own new value as
  "what the page had" — after which every release handed back our value instead
  of the page's. That one is invisible until you return to 100%.
- **The level replaced the page's own instead of multiplying it.** Reported from
  real use, and the most consequential bug in this release. `setElementVolume()`
  wrote the factor straight into `el.volume`, so a video the viewer had already
  turned down to 20% in the site's own player became *louder* the moment
  Gainshift was set to 50% — `el.volume = 0.5`, above the 0.2 they had chosen,
  with the site's own control silently discarded.

  The Web Audio path never had this problem: our master gain multiplies whatever
  the page's graph produced, which is why the README and the store description
  have always described the level as "an exact multiplication". The
  media-element path was the odd one out, and the documentation was right while
  the code was wrong. It now writes `pageBase(el) * factor`, so 50% means half of
  whatever the page was doing.

  Three consequences fall out of that and are each pinned by a test:

  - **Boost multiplies too.** During boost the element is held at the page's own
    level rather than pinned at 1, and the amplification stays in the gain node,
    so the result is the page's level × the factor. (That element volume reaches
    the graph at all is not an assumption: it is the mechanism behind the 2.0.3
    page-routing bug, where a page's own level and our write multiplied to make
    sites twice as loud.)
  - **The site's own volume control works again.** `onVolumeChange` used to stamp
    our number straight back over any change, so dragging the site's slider while
    Gainshift was engaged did nothing. A change that is not the value we last
    wrote is now taken as the page's new base, and our factor is re-applied on
    top of it.
  - **Releasing at 100% gives ownership back**, not just the number. Holding the
    element at the page's level while keeping ownership looks identical until the
    page changes its own level while we are at 100%: with ownership retained that
    value is never re-read, and the next slider move multiplies against a stale
    base.

- **A level set on a page with no host followed the tab to the next site.** The
  cross-site cleanup in `tabs.onUpdated` fired only when the previous host was
  truthy, and the new-tab page, `file://` and `about:blank` all have a `null`
  host. `Alt+Shift+Q` on a new tab, then typing an address, opened that site
  muted. The check is now `tabHosts.has(tabId)`, and `applyLevel()` and
  `resetTab()` record the host even when it is `null`.
- **Forget could be undone by a save still in the debounce.** Dragging the
  slider and clicking Forget within 350ms let the queued `storeVolume` land
  after `forgetSite`, saving the dragged level straight back while the panel
  showed 100%. Forget now cancels anything pending before it sends.
- `resetTab` joins the message types a content script may not send. Nothing
  sends it today, from a frame or from the panel.

### Tests

321 assertions (was 201), and a mutation runner, `mutate-2.1.0.js`, that breaks
each of the thirty-one guarantees above in the real source and requires the
suites to fail. Two of them initially passed against broken code, which is the
point of running it, and both were the same blind spot:

- Removing the `fanOut` from the keyboard listener — so a keystroke changed the
  maps and the badge but never reached the audio — was invisible, because the
  suite only ever asked `lookupVolume` what the level *was*.
- Likewise a `volume-reset` whose pushed level disagreed with the maps: reset
  computes the level a second time for the frames and the toolbar, and only the
  maps were being checked.

Added `lastPushed()`, and every keyboard assertion now also checks what the
frames and the toolbar were actually told.

The runner writes broken code into the real source, so it now parks the original
on disk as well as in memory, restores it on `SIGINT`/`SIGTERM`/crash, and
refuses to start without first putting back anything a dead run left behind. An
interrupted run had left `STEP = 0.1` in the working tree — a 10% keyboard step,
contradicting the manifest and every document — where the next build would have
packaged it.

Two harness bugs were also fixed: the mock element kept `className` and
`classList` in separate places (so a class set one way was invisible to the
other), and setting `textContent` did not discard children the way a real element
does, which let a stale node answer a query after a redraw.

---

## 2.0.3

Four bugs and three performance fixes, all found by reviewing 2.0.2 rather than
by a report. Every one is pinned by a test that fails when the fix is reverted,
verified by reverting it.

### Bugs

- **A page-routed element had its volume overwritten.** `applyToElement` wrote
  `el.volume = 1` for any element the page had routed into its own Web Audio
  graph. A page that routes an element *and* sets a level on it for its own mix
  had that level destroyed — the signal entering the graph was up to twice what
  the page intended. It happened on every pass, including at 100%, where the
  extension is supposed to be inert. Element volume is now written only through
  one helper that records both the page's original value and our own last write,
  so a page-routed element is left alone, and taking an element over *undoes* our
  scaling rather than flattening the page's.
- **A level chosen during startup could be undone by startup.** `content.js`
  asks the background page for the tab's level at `document_idle`. That reply
  carries the level as of when the message was *received*, so a `setVolume`
  arriving in the meantime was silently overwritten with the older value a moment
  later. The startup reply is now ignored once an explicit level has arrived.
- **Patching `Audio` broke subclassing.** The wrapper called
  `new RealAudio(...args)`, discarding `new.target`, so
  `class Sound extends Audio {}` produced instances carrying `Audio.prototype`
  rather than `Sound.prototype`. Now `Reflect.construct(..., new.target)`. The
  same fix went into the `AudioContext` and `MediaElementAudioSourceNode`
  wrappers, which had it too. `Audio.name` also read `"PatchedAudio"`; the
  `AudioContext` wrapper had always preserved its name, so this was an
  oversight rather than a decision.
- **`content.js` computed a field nothing read.** Every message ran
  `querySelectorAll("video, audio")` a second time to populate `domMedia`, which
  no code anywhere consumed. Removed; the remaining query runs only when the
  page-world hook has not reported a count of its own.

### Performance

- **Status attributes are no longer rewritten when unchanged.** All five were
  written on every pass. Each is a DOM mutation that wakes any `MutationObserver`
  the page keeps on `<html>`, and frameworks commonly have one. Measured in
  Chromium: a page creating 300 pooled `Audio` objects went from **1,500
  attribute writes to 300**, and thirty slider steps from **180 to 30**.
- **A repeated level no longer re-runs the whole pass.** The content script
  restates the level on every message, including when it has not changed; each
  restatement walked both registries and rewrote five attributes for nothing.
- **`applyAll` walks each registry once.** It pruned both, then `announce()`
  walked both again. The counts are now handed over.

### Hardening

These close the findings from a security review of 2.0.2. No vulnerability was
exploitable — there is no code-execution or HTML-injection sink anywhere in the
extension, and a web page cannot message it at all — but two of the three were
reachable enough to be worth shutting.

- **`boostFailKind` is validated.** It is read from an attribute in the page's
  own DOM, so a page can write it, and it was rendered verbatim inside the
  extension's popup styled as the extension's own warning. Not script injection —
  the popup builds text nodes, confirmed by firing a payload at it — but a page
  could print a sentence of its choosing in trusted chrome, and an unbounded one
  wrecked the panel's layout (2 MB of text took 2.6 s to render and blew the
  layout to 15.6 million pixels wide). A `DOMException` name is always a bare
  identifier; anything else is now discarded.
- **The background page checks the sender** on `storeVolume`, `forgetSite` and
  `fanOut`. Those come from the popup, which has no `sender.tab`. Not reachable
  today — a page cannot execute in the isolated world — but the door is shut
  before a future change opens it. `requestVolume` is deliberately exempt: that
  one does come from a frame.
- **The per-site store has a null prototype.** `"__proto__"` is a legal hostname,
  and assigning a number to that key on an ordinary object is a silent no-op — so
  a level set on such a host simply vanished. Not a pollution vector (the value
  is a number), but it was a real if absurd correctness bug.

### Tests

102 → **201 assertions**, and a fourth suite: `content.js` had none, which is
why the startup race had gone unnoticed — the test written for something else
is what exposed it.

## 2.0.2

**Muting is shown as a symbol instead of a number.**

- The toolbar button now switches icon at 0%: the same speaker with the sound
  waves replaced by an X, on a grey ground instead of blue
  (`browserAction.setIcon`, per tab). Previously 0% was the text `0` on a dark
  red badge — a number you had to read to learn a yes/no fact.
- The badge number is cleared at 0%. A number next to a mute symbol reads as a
  level rather than as *off*. Levels from 1–99% and above 100% are unchanged.
- The tooltip now carries the state too — `Gainshift - muted`, or
  `Gainshift - 250%` — so the icon is not the only signal.
- In the panel, the `%` becomes the same mute mark at 0%. This is CSS keyed off
  the `muted` class `popup.js` already set, so there is no second piece of logic
  that could disagree about what counts as muted.

**Fixed: a site saved at 0% opened the panel at 100%.**

`popup.js` read the stored level as `stored.value || 1`. Zero is falsy, so a
muted site reported itself as 100% while the tab was genuinely silent — and the
first nudge of the slider "restored" a level the user had never chosen, unmuting
the site. Present since per-site memory was introduced. Found while testing the
icon change.

**Fixed: unhandled promise rejections in the background page.**

`browserAction.*` return promises in Firefox. A tab closing mid-update rejects
them, and the surrounding `try/catch` cannot catch that — it surfaces later as an
unhandled rejection. Now handled at the call site.

**Tests: 102 → 148 assertions.**

- New `test-popup.js` (25) — the panel had no suite, which is why the bug above
  was invisible.
- `test-background.js` 18 → 39: the icon swap, the badge and tooltip, every route
  back out of 0% (raising the level, Forget, navigating away), rejection
  handling, and a check that every icon path the code passes to `setIcon` exists
  on disk *and* appears in the packaged file list.
- Each fix was re-broken to confirm the suite catches it.

`build.sh` now packages 15 files (was 12) and runs all three suites under
`--test`.

---

## 2.0.1

**Build tooling only. No extension code changed.**

Verified: the only files differing from 2.0.0 are `manifest.json` (the version
string), `README.md`, and the new `build.sh`. No `.js`, `.html` or icon changed.

- Added `build.sh`, a reproducible build. File timestamps are pinned to
  `SOURCE_DATE_EPOCH`, `TZ` to UTC (Info-ZIP writes the MS-DOS time field in
  local time), and the compression level and file order are fixed. Building from
  the source archive therefore produces a `.xpi` with the same SHA-256 as the
  submitted one, not merely an equivalent file.
- README gained the build environment, OS requirements, tool versions and
  step-by-step instructions that AMO's source-code submission asks for.

---

## 2.0.0

**Rename only: Tab Volume → Gainshift.**

Verified rather than asserted: normalising the name in every 1.9.0 source file
and diffing against 2.0.0 leaves **zero** residual difference in
`audio-hook.js`, `background.js`, `content.js` and `popup.html`. No behaviour
changed in this version.

- Internal names followed the product name: the `data-tabvolume-*` attributes
  became `data-gainshift-*`, and the `__tabVolumeHooked` guard became
  `__gainshiftHooked`.

---

## 1.9.0

Changes since 1.7.2 — the round of fixes following external code review.

### `audio-hook.js`

- **A failed boost was recorded as a success.** When
  `createMediaElementSource` threw, the element was added to the `boosted` set,
  so the extension believed it was amplifying audio it had not touched. Failures
  now go to a separate set and are counted.
- **Failure causes are distinguished** by `DOMException` name. The popup used to
  blame missing CORS headers for every boost failure — but CORS *silences* the
  element rather than throwing, so that was the one cause it could never have
  been reporting. `InvalidStateError` (the page already routes that element) now
  says so.
- **A suspended boost context is resumed.** A context created outside a user
  gesture can start suspended, and an element routed into a suspended context is
  silent — worse than not boosting at all. Also re-checked on later changes,
  since autoplay policy can suspend it again.
- **A closed boost context is rebuilt** instead of being failed against forever.
  The failure set and its counters are replaced with the graph, so elements get a
  fresh attempt.
- **The double-wrapping guard was too broad.** It refused any constructor already
  seen, which left `webkitAudioContext` unpatched whenever it aliases
  `AudioContext`. It now refuses only constructors that resolve to one of our own
  wrappers — the case that would decorate a context twice and square the gain.
- **Contexts that could not be decorated are counted** and reported, so the
  status line cannot claim coverage that does not exist.
- **`volumechange` is handled per element.** A page resetting `element.volume` is
  now answered immediately rather than at the next poll. Bound per element and
  not on `document`, because `volumechange` does not bubble and a detached
  `Audio()` is not in the document tree at all — which is exactly the case that
  matters, since Howler.js and most game engines pool detached `Audio` objects.
- The 1-second re-assert loop became a 5-second safety net, now that
  `volumechange` does the real work. It still rescans the DOM for elements that
  appeared without firing `play`.

### `background.js`

- Frame fan-out runs concurrently (`Promise.all`) instead of one frame after
  another. `Promise.all` preserves order, so the popup's frame list still matches
  the frame tree.
- **A per-tab override could bleed into the next site.** The tab's host is now
  recorded when a level is set. Without it, a tab that was already open when the
  extension loaded had no stored host, so the cross-site cleanup found nothing to
  compare and kept the override after navigating elsewhere.

### `popup.js`

- **Requests are sequence-numbered.** Dragging the slider puts several in flight;
  a slow reply carrying an old value could land last and repaint the panel with
  state that was no longer true.
- `flush()` now takes the queued value before acting on it, so a pending timer
  cannot act on it a second time.

### `content.js`

- Reports the boost failure count, the failure kind and the undecorated-context
  count back to the popup.
- The level is written to the page-world hook even when it is 1, rather than
  assuming the hook's own default matches.

> There is no 1.8.0 archive. It was an intermediate build in which the
> `volumechange` listener was bound to `document` — which never sees the detached
> `Audio()` objects that matter most — and it was corrected before 1.9.0.

---

## 1.7.2

Baseline: the first version submitted to addons.mozilla.org, under the name
Tab Volume.
