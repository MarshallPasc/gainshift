# Gainshift — changelog (technical)

For reviewers and anyone reading the code. `CHANGELOG.md` is the plain-language
version for users.

Every entry below was checked against the archived source of that version, not
written from memory. Where a claim is unusual — "2.0.0 changed no behaviour" —
the check that supports it is stated.

The add-on ID has been `tab-volume@pascal.local` since 1.7.2 and has never
changed. It looks wrong now that the name is Gainshift, but changing it would
make AMO treat this as a different add-on and break updates for existing users.

---

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
