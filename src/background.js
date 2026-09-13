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

/** hostname -> volume (1 === 100%), persisted */
let sites = {};

/** tabId -> volume, this session only, overrides the site value */
const tabOverrides = new Map();

/** tabId -> hostname, to notice when a tab changes site */
const tabHosts = new Map();

const ready = (async () => {
  try {
    const o = await NS.storage.local.get(STORE_KEY);
    sites = (o && o[STORE_KEY]) || {};
  } catch (e) {
    sites = {};
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
      return {
        value: effective(msg.tabId, host),
        host: host,
        remembered: !!(host && typeof sites[host] === "number")
      };
    })();
  }

  // Popup setting a value: applies to this tab now, and becomes the site default.
  if (msg.type === "storeVolume") {
    return (async () => {
      await ready;
      const host = await tabHost(msg.tabId);

      tabOverrides.set(msg.tabId, msg.value);
      // Record the host alongside the override. Without this, a tab that was
      // already open when the extension loaded has no entry in tabHosts, so the
      // cross-site cleanup below finds no oldHost and lets the override bleed
      // into the next site.
      if (host) tabHosts.set(msg.tabId, host);

      if (host) {
        if (msg.value === 1) delete sites[host];
        else sites[host] = msg.value;
        persist();
      }

      indicate(msg.tabId, msg.value);
      return { ok: true, host, remembered: !!(host && typeof sites[host] === "number") };
    })();
  }

  // Popup clearing the saved level for this site.
  if (msg.type === "forgetSite") {
    return (async () => {
      await ready;
      const host = await tabHost(msg.tabId);
      if (host) { delete sites[host]; persist(); }
      tabOverrides.delete(msg.tabId);
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
  tabOverrides.delete(tabId);
  tabHosts.delete(tabId);
});

NS.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // A tab that moves to a different site loses its per-tab override, so the new
  // site's own remembered level applies instead.
  if (changeInfo.url) {
    const newHost = hostOf(changeInfo.url);
    const oldHost = tabHosts.get(tabId);
    if (oldHost && newHost !== oldHost) tabOverrides.delete(tabId);
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
