# Gainshift — source

_Distributed as `gainshift.xpi` / `gainshift-source.zip`._

Per-tab volume control for Firefox, 0–600%, covering Web Audio as well as media
elements. Levels are remembered per site, can be held for a single tab instead,
and can be nudged from the keyboard without opening the panel.

**Nothing here is compiled.** No bundler, no minifier, no transpiler, no
dependencies, no package manager. The packaged `.xpi` is these files zipped,
byte for byte — what you read here is what runs.

Build it with `./build.sh`. It takes about a second and needs only `zip`. Full
requirements and a step-by-step description are under **Build environment** and
**Building** below.

---

## Build environment

| | |
|---|---|
| **Operating system** | Any Unix-like system: Linux, macOS, or Windows via WSL / Git Bash. Nothing in the build is OS-specific. Verified on Debian 12 (Linux 6.x) and macOS 14. |
| **Shell** | POSIX `sh`. Not bash-specific. |
| **Required** | `zip` — Info-ZIP 3.0 or newer. Also `mktemp`, `touch`, `cp`, `date` (POSIX coreutils, present on every system above). |
| **Optional** | `unzip` 6.0+ (used to print and verify the archive contents), `sha256sum` or `shasum`, and `node` 18 or newer (only for `--test`; the tests are not part of producing the `.xpi`). |
| **Not used** | No node_modules, no `package.json`, no npm, no bundler, no transpiler, no minifier, no task runner, no code generator. There is nothing to install with a package manager. |

Installing the requirements, if a machine somehow lacks them:

```
# Debian / Ubuntu
sudo apt-get install zip unzip
sudo apt-get install nodejs          # optional, for ./build.sh --test

# Fedora / RHEL
sudo dnf install zip unzip nodejs

# macOS — zip and unzip ship with the system; nothing to install.
brew install node                    # optional, for ./build.sh --test

# Windows
# Use WSL (wsl --install) or Git Bash, then follow the Debian line above.
```

Version check, if you want to record what was used:

```
zip -v | head -2
unzip -v | head -1
node --version
```

Any Info-ZIP 3.x produces identical output here; the build pins the compression
level and the timestamps itself, so the zip version is not a variable.

---

## Building

**One step:**

```
./build.sh
```

That is the entire build. It writes `../gainshift.xpi` and prints its SHA-256
and the fifteen files it contains. (If your unzip tool dropped the executable
bit, use `sh build.sh` or `chmod +x build.sh` first.)

Step by step, this is what the script does — you can run these by hand instead
and get the same file:

1. `cd` into this directory (the one holding `manifest.json`).
2. Check that `zip` is available and that all fifteen packaged files are present.
3. Copy those fifteen files into an empty staging directory.
4. Set every staged file's modification time to `SOURCE_DATE_EPOCH`
   (default `1262304000` = 2010-01-01T00:00:00Z) with `TZ=UTC`.
5. From the staging directory, run
   `zip -X -D -9 ../gainshift.xpi` over the file list, in the fixed order given
   in `build.sh`.
6. Delete the staging directory.

Steps 4 and 5 are the only part that needs explaining. A zip archive stores each
entry's modification time, and Info-ZIP writes it in **local** time, so the same
files packaged on two machines normally produce two different archives. Stamping
the staged copies and pinning `TZ` removes both variables. `-X` drops the
platform extra fields (uid, gid, extended timestamps), `-D` omits directory
entries, and `-9` fixes the compression level so it is not left to the tool's
default.

The result is **byte-for-byte identical on any machine**, which makes the
SHA-256 a real check rather than a formality:

```
$ ./build.sh
== built ==
/path/to/gainshift.xpi
19f53223e1eb00552b904bdafb256ff1c4365355667ffbc70e6d7e630ed90558  gainshift.xpi
```

**To confirm the built file matches the one submitted to AMO:**

```
./build.sh --verify /path/to/the-submitted-gainshift.xpi
```

This compares the bytes; if they differ, it falls back to extracting both and
diffing the contents, so a mere container difference is reported as such rather
than as a code difference.

**To run the test suites as part of the build:**

```
./build.sh --test
```

The `.xpi` is a plain zip — `unzip -o gainshift.xpi -d somewhere` and diffing
that directory against this one works too, and is the comparison that actually
matters. `build.sh`, `README.md`, `test-*.js` and the `.svg` icon sources are
deliberately **not** packaged; the fifteen files that are packaged are listed in
`build.sh` and nowhere else.

### On "no build step"

Nothing in this source tree is transpiled, concatenated, minified or otherwise
machine-generated. No tool transformed these files into what ships: each `.js`
file was written directly in the form you see, and the code Firefox runs is the
code in this directory, character for character. `build.sh` is packaging, not
compilation — it copies fifteen files into a zip.

The point of the policy is that a reviewer must be able to read what actually
runs, rather than the output of a pipeline whose input they cannot see. There is
no such input here. No file in this tree has an earlier, different or more
readable version that is being withheld; these *are* the originals.

The one generation step anywhere in the project produces **images, not code**:
the shipped PNG icons are rasterised from `icon.svg` / `icon-small.svg`. Both
vector sources are included here. That step is deliberately outside `build.sh`,
because different rasteriser versions emit different bytes, and the icons are
shipped as fixed assets rather than rebuilt per build. See **Icons** below to
regenerate them.

---

## Files

| File | Runs in | What it does |
|---|---|---|
| `manifest.json` | — | Manifest V2. Two content scripts, one background page. |
| `audio-hook.js` | **page world**, `document_start`, all frames | All audio work. Patches `AudioContext`, `Audio`, `HTMLMediaElement.prototype.play`, and observes `createMediaElementSource` / `MediaElementAudioSourceNode`. |
| `content.js` | isolated world, `document_idle`, all frames | Relay only. Carries the level to `audio-hook.js` via a data attribute on `<html>` and reports back what it found. |
| `background.js` | background page | Per-site volume memory in `storage.local`, the per-tab override that sits on top of it, and the keyboard commands. Fans messages out to every frame via `webNavigation.getAllFrames`. |
| `popup.html` / `popup.js` | popup | UI. Slider, typed entry, presets, the Tab/Site scope control, per-frame readout. |
| `icon.svg`, `icon-small.svg` | — | Vector sources for the normal icons (see below). |
| `icon-muted.svg`, `icon-muted-small.svg` | — | Vector sources for the muted icons. |
| `build.sh` | — | The build. Zips the fifteen packaged files reproducibly. Not itself packaged. |
| `test-audio-hook.js`, `test-background.js`, `test-popup.js`, `test-content.js` | Node | Test suites, 321 assertions. Not packaged. |
| `mutate-2.1.0.js` | Node | Breaks each 2.1.0 guarantee in the real source in turn and requires the suites to notice. A development check, not part of the build. Not packaged. |

### Why a main-world content script

`AudioContext`, `Audio` and `HTMLMediaElement.prototype` are page-realm objects.
A content script in the isolated world holds its own separate copies, so patching
there has no effect on the page's audio. Firefox exposes no WebExtension API for
per-tab volume, so being in the page's realm is the only mechanism available.

The main-world script has no access to `browser.*` at all — which is why the
isolated `content.js` relay exists. The two communicate through data attributes on
`<html>`, visible to both worlds. That avoids `eval`, injected `<script>` tags,
`cloneInto` / `exportFunction`, and any interaction with page CSP.

### The five patch points

1. **`AudioContext` / `webkitAudioContext`** — each new context gets a master
   `GainNode` inserted before its destination, and `ctx.destination` is shadowed
   to return it. Preserves `.prototype`, the static chain, and `.name`, so
   `instanceof` and feature detection behave normally. `maxChannelCount` is
   mirrored onto the gain node. The whole body is in a `try/catch` that returns an
   unmodified context on any failure — a page can never lose audio because of the
   wrapper.
2. **`HTMLMediaElement.prototype.play`** — records which element played, then
   delegates with `.apply(this, args)` and returns the original promise unchanged.
3. **`Audio`** — records elements created but never inserted into the DOM. Howler.js
   and most game engines pool detached `Audio` objects, which `querySelectorAll`
   cannot see.
4. **`AudioContext.prototype.createMediaElementSource`** — *observation only*.
   When a page routes an element into its own graph, that element is already scaled
   by the master gain from (1); setting `element.volume` as well would apply the
   factor twice. Marks the element only after the underlying call succeeds, since
   that call throws when an element is already routed. Returns the real node.
5. **`MediaElementAudioSourceNode`** — the constructor form of (4), which never
   passes through it. Same observation, returns the real node.

(4) and (5) do not alter audio. They exist so the extension knows which elements it
must **not** touch.

A `window.__gainshiftHooked` guard prevents double-patching. Registries of gain
nodes and media elements are held as `WeakRef`s and pruned on every pass, so the
extension is never the reason a page object stays alive.

---

## Permissions

| Permission | Why |
|---|---|
| `<all_urls>` | Audio can be on any site, and in frames loaded from other domains. The extension reads no page content: it writes one numeric attribute and reads two numeric counters it wrote itself. |
| `webNavigation` | `getAllFrames()` only, to reach audio in deeply nested cross-origin iframes. No navigation events are observed; no history is read or stored. |
| `tabs` | `tabs.get()` for the active tab's hostname, `sendMessage` with a `frameId`, and `onUpdated` / `onRemoved` for lifecycle. |
| `storage` | Per-site volume levels, stored locally. |

The keyboard shortcuts added in 2.1.0 need **no new permission**. `commands` is a
manifest key rather than a permission, and the listener only calls the same
internal functions the popup already calls.

## Keyboard shortcuts

Declared in `manifest.json` under `commands`, all re-bindable by the user in
Firefox's *Manage Extension Shortcuts*:

| Default | Command | Effect |
|---|---|---|
| `Alt+Shift+W` | `volume-up` | +5 percentage points |
| `Alt+Shift+X` | `volume-down` | −5 percentage points |
| `Alt+Shift+N` | `volume-reset` | Set this tab to 100% |
| `Alt+Shift+Q` | `volume-mute` | Mute / unmute this tab |
| `Alt+Shift+G` | `_execute_browser_action` | Open the panel |

Two properties of that listener are deliberate and are pinned by tests:

- **A keystroke never writes to storage.** It sets a *tab* override only, so
  boosting one video does not silently redefine the level for the whole site.
- **Reset sets 100% on the tab, not on the site.** The override is set and
  `sites` is untouched, so a level the user deliberately saved survives; the tab
  returns to it when it navigates away or closes.

`Ctrl+Alt` was avoided because it is AltGr on German and other European layouts,
and `Ctrl+Shift` because Firefox itself already uses nearly every letter there.

The letters matter more than the modifier. On Windows, `Alt+Shift+<letter>`
still fires the menu bar's access keys, so a letter that is a menu mnemonic is
unusable — `F E V S B T H` on an English build, `D B A C L E H` on a German one,
and `D` is the address bar everywhere. The first set of defaults used `S`, `D`
and `V` and three of the five shortcuts simply opened menus. `W X N Q G` avoid
both localisations.

Even that is not sufficient. `R` was the second choice for reset, is not a menu
key, and was bound correctly according to Firefox's own shortcut page — and it
still never fired on one machine, because an application outside the browser
held it as a global hotkey. An extension cannot see that, so every shortcut here
is documented as a default to be re-bound rather than as something guaranteed to
work.

## Data

Nothing is collected or transmitted. The extension makes **no network requests of
any kind**. `storage.local` holds only hostnames the user deliberately set a level
for, plus the number — configuration the user created, not a record of browsing.
Declared in the manifest as:

```json
"data_collection_permissions": { "required": ["none"] }
```

---

## Icons

`icon.svg` and `icon-small.svg` are the vector sources. The shipped PNGs are
rendered from them — this is the only generation step anywhere in the project, and
it produces images, not code.

- `icon-48/64/96/128.png` ← `icon.svg`
- `icon-16/32.png` ← `icon-small.svg` (a simplified cut; at 16px the three arcs of
  the full mark blur together)
- `icon-muted-48.png` ← `icon-muted.svg`
- `icon-muted-16/32.png` ← `icon-muted-small.svg`

The muted pair is the same speaker with the sound waves replaced by an X, on a
grey ground instead of blue. It is set on the toolbar button, per tab, whenever
that tab is at 0%. Only 16/32/48 exist for it: those are the sizes a toolbar
button asks for at 1x, 2x and 3x, and nothing else ever displays it.

Any SVG rasteriser reproduces them, e.g.:

```
python3 -c "import cairosvg; cairosvg.svg2png(url='icon.svg', write_to='icon-128.png', output_width=128, output_height=128)"
```

---

## Tests

Four harnesses, no dependencies beyond Node itself:

```
node test-audio-hook.js     # 124 assertions
node test-background.js     # 118 assertions
node test-popup.js          #  53 assertions
node test-content.js        #  26 assertions
```

or `./build.sh --test`, which runs all four and then builds. Node 18 or newer;
no `npm install`, because there is nothing to install.

They run the real source in a fresh VM context against a mock Web Audio API and a
mock browser API, so the gain arithmetic is checked rather than argued about.
Coverage includes: the master gain insertion; boost producing exactly the
requested factor and not its square; the boost stage resetting when coming back
below 100%; page-routed elements not being scaled twice via either routing API; a
failed routing attempt being recorded as a failure rather than a success; a
suspended boost context being resumed instead of silently swallowing the audio; a
closed context being rebuilt; failures classified by `DOMException` name; contexts
that could not be decorated being counted rather than hidden; detached `Audio`
objects; `volumechange` enforcement for attached and detached media alike; the
5-second safety-net ticker; `WeakRef` pruning; legacy and modern constructor names
each getting exactly one wrapper; and the per-site storage and tab-override logic.

The toolbar and panel are covered too: 0% selecting the muted icon and clearing
the badge number; every route back out of 0% — raising the level, Forget, and
navigating to another site — restoring the normal icon; a toolbar call that
rejects because the tab has closed not escaping as an unhandled rejection; and a
site stored at 0% opening the panel at 0 rather than at 100.

`test-content.js` covers the one place page-controlled data crosses out of the
page: the `data-gainshift-*` attributes live in the page's own DOM, so a hostile
page can write them, and everything the relay hands to the popup is therefore
untrusted input. `test-popup.js` runs `popup.js` against a small mock DOM. It asserts the class
`popup.js` puts on the value box, which is the contract the stylesheet keys off;
the stylesheet itself needs a layout engine to assert against and is checked by
eye, in both colour schemes and with hostnames long enough to overflow the row.
That check is not ceremonial: it is what caught the site's own level being
ellipsised away behind a long hostname, which the DOM assertions could not see
because the text was present and merely invisible.

Gain assertions measure the product along the chain to the destination, not the
value on a single node — two chained gains of 0.5 each read as 0.5 individually
while actually delivering 0.25.

The 2.1.0 additions are covered on both sides of the message boundary: a
keyboard step landing on whole percentage points and clamping at 0 and 600; two
tabs on one site held at different levels; a tab-scoped change leaving the stored
site level untouched; scope, override and mute history all dropped together when
a tab closes, navigates to another site, or the site is forgotten; unmute
returning to the level it came from, including when that level came from the
site; and the panel's Tab/Site control sending the scope it is showing.

Each fix is pinned by a test that fails if the fix is reverted — verified by
mutation, not assumed. `node mutate-2.1.0.js` automates that for 2.1.0: it
rewrites the real source thirty-one times, each time breaking one guarantee, and
requires the suites to fail every time. Two holes found that way are why
`lastPushed()` exists in `test-background.js` — the maps agreeing is not the same
as the audio being told.

---

## The level is a multiplier

Gainshift's level multiplies whatever the page is already doing; it does not
replace it. A page whose own player sits at 20% and a Gainshift level of 50%
gives 10%, and 100% gives the page's 20% back untouched. This holds on both
paths — the master gain scales the page's Web Audio graph, and
`setElementVolume()` writes `pageBase(el) * factor` into `el.volume`, where
`pageBase` is the page's own value, re-read whenever the page moves it.

That last part is what makes a site's own volume control keep working while a
level is set: a `volumechange` carrying a value we did not write is the viewer
using the page's own slider, so it becomes the new base rather than something to
overwrite.

---

## Known limitation

Above 100%, amplification routes media elements through Web Audio. On media served
cross-origin without CORS headers, that routing silences the element — a browser
security boundary, not something an extension can work around. The popup warns at
the moment the user crosses 100%, and returning to 100% and reloading recovers it.
Below 100% that path is never used; the element's own `volume` is set directly.
