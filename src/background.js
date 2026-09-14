/* Gainshift - background page.
 *
 * Volume is remembered per SITE (hostname, www- stripped), persisted in storage.local,
 * so any page on rainbet.com comes up at the level you last chose there. A per-tab
 * override sits on top for the tab you're currently adjusting, and is dropped when
 * that tab navigates to a different host.
 *
 * Messages are fanned out to every frame explicitly via webNavigation.getAllFrames -
 * deeply nested cross-origin game frames are the case that matters.
 */

"use strict";

const NS = typeof browser !== "undefined" ? browser : chrome;

const STORE_KEY = "siteVolumes";

/** hostname -> volume (1 === 100%), persisted.
 *  Null-prototype: the keys are hostnames, and a hostname is allowed to be the
 *  string "__proto__". Assigning a number to that on a normal object is a silent
 *  no-op rather than a write, so the level would vanish; on a null-prototype
 *  object it is an ordinary key. */
let sites = Object.create(null);

/** tabId -> volume, this session only, overrides the site value */
const tabOverrides = new Map();

/** tabId -> hostname, to notice when a tab changes site */
const tabHosts = new Map();

/** tabId -> "tab" | "site": which scope last set this tab's level.
 *  It has to be recorded rather than inferred: after a site-scoped change the
 *  override and the stored site level are equal, so comparing them cannot tell
 *  you whether the tab is deliberately held apart from its site. */
const tabScopes = new Map();

/** tabId -> the level this tab had before it was muted, for the mute toggle. */
const lastAudible = new Map();

/** One keyboard step, as a fraction: 5 percentage points. */
const STEP = 0.05;

/** Levels are floats, and 0.7 + 0.05 is 0.7500000000000001. Rounding to whole
 *  percentage points keeps the badge honest and the stored values tidy. */
function clampLevel(v) {
  if (typeof v !== "number" || isNaN(v)) return 1;
  return Math.max(0, Math.min(6, Math.round(v * 100) / 100));
}

/** Everything this tab knows, dropped together. Firefox reuses tab ids, so a
 *  half-cleared tab hands its leftovers to whatever opens next. */
function forgetTab(tabId) {
  tabOverrides.delete(tabId);
  tabScopes.delete(tabId);
  lastAudible.delete(tabId);
}

const ready = (async () => {
  try {
    const o = await NS.storage.local.get(STORE_KEY);
    sites = Object.assign(Object.create(null), (o && o[STORE_KEY]) || {});
  } catch (e) {
    sites = Object.create(null);
  }
})();

function hostOf(url) {
  try {
    const h = new URL(url).hostname;
    if (!h) return null;
    return h.replace(/^www\./i, "");
  } catch (e) {
    return null;
  }
}

let persistTimer = null;

/* Coalesce writes. The popup already debounces, but a fast drag or several
   rapid changes shouldn't each hit storage. */
function persist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try { NS.storage.local.set({ [STORE_KEY]: sites }); }
    catch (e) { /* ignore */ }
  }, 250);
}

async function tabHost(tabId) {
  try {
    const tab = await NS.tabs.get(tabId);
    return hostOf(tab && tab.url);
  } catch (e) {
    return null;
  }
}

/** Effective volume for a tab: tab override, else site value, else 1. */
function effective(tabId, host) {
  if (tabOverrides.has(tabId)) return tabOverrides.get(tabId);
  if (host && typeof sites[host] === "number") return sites[host];
  return 1;
}

/* Toolbar button state.
 *
 * Two signals, each answering a different question:
 *   the icon  - is this tab making sound at all?
 *   the badge - how loud, when it is?
 *
 * Muted used to be a "0" on a red badge, which is a number you have to read.
 * It is now a distinct icon - speaker with an X, on a grey ground instead of
 * blue - so the state is legible at a glance and at 16px.
 */
const ICON_ON = {
  16: "icon-16.png",
  32: "icon-32.png",
  48: "icon-48.png"
};
const ICON_MUTED = {
  16: "icon-muted-16.png",
  32: "icon-muted-32.png",
  48: "icon-muted-48.png"
};

/* browserAction.* return promises in Firefox. A tab closing mid-update rejects
   them, and a bare try/catch does not catch that - it arrives later, as an
   unhandled rejection in the background page. Swallow it at the source. */
function quiet(p) {
  if (p && typeof p.then === "function") p.then(undefined, () => {});
  return p;
}

function indicate(tabId, value) {
  const pct = Math.round(value * 100);
  const muted = pct === 0;

  try {
    quiet(NS.browserAction.setIcon({ tabId, path: muted ? ICON_MUTED : ICON_ON }));
  } catch (e) { /* tab may be gone */ }

  // No badge when muted: the icon already says it, and a number beside a mute
  // symbol reads as a level rather than as "off".
  const text = (muted || pct === 100) ? "" : (pct >= 1000 ? "999" : String(pct));
  try {
    quiet(NS.browserAction.setBadgeText({ tabId, text }));
    quiet(NS.browserAction.setBadgeBackgroundColor({
      tabId,
      color: pct > 100 ? "#b45309" : "#1d4ed8"
    }));
    // The icon is the only visual cue at 0%, so the tooltip carries it too,
    // for screen readers and for anyone who can't tell the two icons apart.
    quiet(NS.browserAction.setTitle({
      tabId,
      title: muted ? "Gainshift - muted" : (pct === 100 ? "Gainshift" : `Gainshift - ${pct}%`)
    }));
  } catch (e) { /* tab may be gone */ }
}

/* ---------- applying a level ----------
 *
 * Every path that sets a level goes through here - the popup and the keyboard
 * both - so the scope rule, the badge, the icon and the mute memory cannot
 * drift apart from each other later.
 */
async function applyLevel(tabId, value, scope) {
  await ready;
  const host = await tabHost(tabId);
  const v = clampLevel(value);

  tabOverrides.set(tabId, v);
  // Record the host alongside the override. Without this, a tab that was
  // already open when the extension loaded has no entry in tabHosts, so the
  // cross-site cleanup finds no oldHost and lets the override bleed into the
  // next site. Recorded even when it is null: a level set on the new-tab page
  // or a file:// page must not follow the tab to the first real site either.
  tabHosts.set(tabId, host);
  tabScopes.set(tabId, scope === "tab" ? "tab" : "site");

  // Only a site-scoped change is allowed to touch storage. This is the whole
  // of the per-tab feature, and the reason the keyboard is safe.
  if (scope !== "tab" && host) {
    if (v === 1) delete sites[host];
    else sites[host] = v;
    persist();
  }

  if (v > 0) lastAudible.set(tabId, v);
  indicate(tabId, v);
  return { host, value: v };
}

/** Reset: put this tab at 100%, whatever the site is saved at.
 *
 *  It is a TAB-scoped write, which is the part that matters: the site's stored
 *  level is left exactly as it was, so a site you deliberately keep at 45% is
 *  still at 45% in every other tab and in this one again once it navigates away
 *  or closes. Nothing is written to or deleted from storage. */
async function resetTab(tabId) {
  await ready;
  const host = await tabHost(tabId);
  const v = 1;
  tabOverrides.set(tabId, v);
  tabScopes.set(tabId, "tab");
  lastAudible.set(tabId, v);
  tabHosts.set(tabId, host);
  indicate(tabId, v);
  await fanOut(tabId, { type: "setVolume", value: v });
  return { host, value: v };
}

async function listFrames(tabId) {
  try {
    const frames = await NS.webNavigation.getAllFrames({ tabId });
    return Array.isArray(frames) ? frames : [];
  } catch (e) {
    return [];
  }
}

async function fanOut(tabId, payload) {
  const frames = await listFrames(tabId);

  if (!frames.length) {
    try {
      const r = await NS.tabs.sendMessage(tabId, payload);
      return [{ frameId: 0, url: "(unknown)", ok: true, state: r }];
    } catch (e) {
      return [{ frameId: 0, url: "(unknown)", ok: false, error: String((e && e.message) || e) }];
    }
  }

  // Concurrently, not one after another: a page with many frames would otherwise
  // pay the round-trip for each in series. Promise.all preserves input order, so
  // the popup's frame list still matches the frame tree.
  return Promise.all(frames.map(async (f) => {
    try {
      const state = await NS.tabs.sendMessage(tabId, payload, { frameId: f.frameId });
      return { frameId: f.frameId, url: f.url, ok: true, state: state || null };
    } catch (e) {
      return {
        frameId: f.frameId,
        url: f.url,
        ok: false,
        error: String((e && e.message) || e)
      };
    }
  }));
}

/* ---------- messaging ---------- */

NS.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return;

  // Everything that changes stored state or reaches into another tab comes from
  // the popup, which has no sender.tab; a content script always has one. Nothing
  // in this extension sends these from a content script, so today this closes a
  // door that is already shut - but it closes it before some later change opens
  // it. requestVolume is deliberately not on the list: that one IS from a frame.
  if (sender && sender.tab &&
      (msg.type === "storeVolume" || msg.type === "forgetSite" || msg.type === "fanOut" ||
       msg.type === "resetTab")) {
    return;
  }

  // Content script (any frame) asking what to apply. sender.tab.url is the
  // top-level tab URL, so nested game frames inherit the parent site's setting.
  if (msg.type === "requestVolume") {
    return (async () => {
      await ready;
      const tabId = sender && sender.tab ? sender.tab.id : undefined;
      const host = hostOf(sender && sender.tab ? sender.tab.url : null);
      return { value: effective(tabId, host) };
    })();
  }

  // Popup opening.
  if (msg.type === "lookupVolume") {
    return (async () => {
      await ready;
      const host = await tabHost(msg.tabId);
      const stored = host && typeof sites[host] === "number" ? sites[host] : null;
      return {
        value: effective(msg.tabId, host),
        host: host,
        remembered: stored !== null,
        // The panel needs both: which scope it is in, and what the site would
        // fall back to, so it can say "youtube.com stays at 45%" while the tab
        // is held somewhere else.
        scope: tabScopes.get(msg.tabId) || "site",
        siteValue: stored
      };
    })();
  }

  // Popup setting a value. scope "site" (the default) also stores it against
  // the hostname; scope "tab" holds it on this tab alone.
  if (msg.type === "storeVolume") {
    return (async () => {
      const scope = msg.scope === "tab" ? "tab" : "site";
      const r = await applyLevel(msg.tabId, msg.value, scope);
      const stored = r.host && typeof sites[r.host] === "number" ? sites[r.host] : null;
      return {
        ok: true,
        host: r.host,
        scope,
        remembered: stored !== null,
        siteValue: stored
      };
    })();
  }

  // Put this tab at 100%, tab-scoped. Nothing in the panel sends this today;
  // the keyboard calls resetTab() directly.
  if (msg.type === "resetTab") {
    return (async () => {
      const r = await resetTab(msg.tabId);
      const stored = r.host && typeof sites[r.host] === "number" ? sites[r.host] : null;
      return { ok: true, host: r.host, value: r.value, remembered: stored !== null, siteValue: stored };
    })();
  }

  // Popup clearing the saved level for this site.
  if (msg.type === "forgetSite") {
    return (async () => {
      await ready;
      const host = await tabHost(msg.tabId);
      if (host) { delete sites[host]; persist(); }
      forgetTab(msg.tabId);
      indicate(msg.tabId, 1);
      await fanOut(msg.tabId, { type: "setVolume", value: 1 });
      return { ok: true, host };
    })();
  }

  if (msg.type === "fanOut") {
    return fanOut(msg.tabId, msg.payload);
  }
});

/* ---------- tab lifecycle ---------- */

NS.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId);
  tabHosts.delete(tabId);
});

NS.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // A tab that moves to a different site loses its per-tab override, so the new
  // site's own remembered level applies instead.
  if (changeInfo.url) {
    const newHost = hostOf(changeInfo.url);
    const oldHost = tabHosts.get(tabId);
    // has(), not a truthy oldHost: null is a real previous host (new-tab page,
    // file://, about:blank), and leaving one must drop what was set there.
    if (tabHosts.has(tabId) && newHost !== oldHost) forgetTab(tabId);
    tabHosts.set(tabId, newHost);
  }

  if (changeInfo.status !== "complete") return;

  await ready;
  const host = hostOf(tab && tab.url);
  tabHosts.set(tabId, host);

  const v = effective(tabId, host);
  indicate(tabId, v);
  if (v !== 1) fanOut(tabId, { type: "setVolume", value: v });
});

/* ---------- keyboard ----------
 *
 * Scope follows the gesture. A keystroke is a reaction to whatever is playing
 * right now - this video is quiet, that one is not - so it is ALWAYS tab-scoped
 * and never writes to storage. Deciding that a whole site should be quieter is
 * what the panel is for.
 *
 * Reset follows the same rule: it puts this tab at 100% as a tab-scoped level,
 * so a level saved for the site is never overwritten from the keyboard.
 */
NS.commands.onCommand.addListener((name) => {
  (async () => {
    try {
      const tabs = await NS.tabs.query({ active: true, currentWindow: true });
      if (!tabs.length) return;
      const tab = tabs[0];
      const tabId = tab.id;

      if (name === "volume-reset") {
        await resetTab(tabId);
        return;
      }

      await ready;
      const current = effective(tabId, hostOf(tab.url));
      let next;

      if (name === "volume-up") {
        next = clampLevel(current + STEP);
      } else if (name === "volume-down") {
        next = clampLevel(current - STEP);
      } else if (name === "volume-mute") {
        if (current > 0) {
          // Remember where we were even if this tab has never been adjusted -
          // the level may be coming from the site, and unmuting has to return
          // to it rather than to 100%.
          lastAudible.set(tabId, current);
          next = 0;
        } else {
          next = lastAudible.has(tabId) ? lastAudible.get(tabId) : 1;
        }
      } else {
        return;
      }

      if (next === current && name !== "volume-mute") return;   // already at the end of the range

      await applyLevel(tabId, next, "tab");
      await fanOut(tabId, { type: "setVolume", value: next });
    } catch (e) { /* the tab can go away mid-keystroke */ }
  })();
});
