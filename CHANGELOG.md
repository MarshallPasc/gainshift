# Changelog

## 2.1.0

**Added**

- Keyboard shortcuts. `Alt+Shift+W` 5% louder, `Alt+Shift+X` 5% quieter,
  `Alt+Shift+N` set this tab to 100%, `Alt+Shift+Q` mute/unmute, `Alt+Shift+G`
  open the panel. All rebindable under Add-ons → Manage Extension Shortcuts.
- A **Tab / Site** switch in the panel. *Site* saves the level for every page on
  the site, as before. *Tab* holds it for one tab only and saves nothing, so two
  tabs on the same site can sit at different volumes.
- While a tab is held apart, the panel shows what the site itself is still set
  to.

**Fixed**

- The level now multiplies the site's own volume instead of replacing it. A
  video already turned down to 20% in the site's player became *louder* when
  Gainshift was set to 50%; it now means half of whatever the page is doing.
- The site's own volume control keeps working while a Gainshift level is set.
- At 100%, a site's own player level is left exactly as the site set it.
- Unmuting returns to the level you were at, not to 100%.
- A level set on the new-tab page or a local file no longer follows the tab to
  the next site.
- Forget could be undone by a save still in flight if you clicked it straight
  after moving the slider.
- The numbers under the slider now line up with the handle. They were spaced
  evenly, but the slider is linear, so "100" sat a third of the way along
  instead of a sixth.
- Sites that do their own audio mixing could play up to twice as loud as
  intended, even at 100%.
- A level chosen while a page was still loading could be undone a moment later.
- Pages that subclass `Audio` for their own sound objects now work.

**Changed**

- Around 80% fewer updates to the page, which matters most on game sites that
  load hundreds of sounds at once.

No new permissions.

## 2.0.2

**Changed**

- Renamed from Tab Volume to Gainshift. Saved sites carry over.
- Muting shows a mute icon on the toolbar button instead of a red "0".

**Fixed**

- Turning the volume down didn't always stick on sites that set their own
  volume — browser games and music players especially.
- A site saved at 0% reopened showing 100% while the tab was silent, and the
  first touch of the slider unmuted it.
- A level set on one site could follow you to the next site in that tab.
- Boosting above 100% is more reliable, and the panel now gives the real reason
  when it can't work.
- The number in the panel no longer flickers back to an old value while
  dragging.

## 1.7.2

First release.
