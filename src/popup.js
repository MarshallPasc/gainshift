"use strict";

const NS = typeof browser !== "undefined" ? browser : chrome;

const slider   = document.getElementById("slider");
const entry    = document.getElementById("entry");
const statusEl = document.getElementById("status");
const framesEl = document.getElementById("frames");
const siteEl   = document.getElementById("site");
const buttons  = Array.from(document.querySelectorAll(".presets button"));

const MIN = 0;
const MAX = 600;

let tabId = null;
let currentPct = 100;
let siteHost = null;

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function clamp(n) {
  if (isNaN(n)) return currentPct;
  return Math.max(MIN, Math.min(MAX, Math.round(n)));
}

/** Update the controls without re-triggering their own handlers. */
function paint(pct, source) {
  currentPct = pct;
  if (source !== "slider") slider.value = String(pct);
  if (source !== "entry")  entry.value  = String(pct);

  entry.classList.toggle("boost", pct > 100);
  entry.classList.toggle("muted", pct === 0);
  buttons.forEach(b => b.classList.toggle("active", Number(b.dataset.v) === pct));
}

function renderSite(host, remembered) {
  siteEl.textContent = "";
  if (!host) return;

  const label = node("span", "name");
  label.append(remembered ? "Saved for " : "Applies to ");
  label.append(node("b", null, host));
  siteEl.append(label);

  if (remembered) {
    const btn = node("button", "forget", "Forget");
    btn.addEventListener("click", async () => {
      try { await NS.runtime.sendMessage({ type: "forgetSite", tabId }); }
      catch (e) { /* ignore */ }
      paint(100, null);
      renderSite(host, false);
      await refresh(100, false);
    });
    siteEl.append(btn);
  }
}

function hostOf(url) {
  if (!url) return "(none)";
  if (url === "about:blank") return "about:blank";
  try { return new URL(url).host || url.slice(0, 28); }
  catch (e) { return url.slice(0, 28); }
}

function report(pct, results) {
  statusEl.textContent = "";
  framesEl.textContent = "";

  if (!Array.isArray(results) || !results.length) {
    statusEl.append(node("span", "warn", "No frames responded. Reload the tab."));
    return;
  }

  let media = 0, contexts = 0, reached = 0, missing = 0;

  for (const r of results) {
    if (!r.ok || !r.state) { missing++; continue; }
    reached++;
    media    += r.state.mediaCount || 0;
    contexts += r.state.audioContexts || 0;
  }

  if (contexts > 0) {
    statusEl.append(node("b", null, String(contexts)));
    statusEl.append(" Web Audio context" + (contexts === 1 ? "" : "s") + " intercepted");
    if (media > 0) statusEl.append(" + " + media + " media");
    statusEl.append(".");
  } else if (media > 0) {
    statusEl.append(node("b", null, String(media)));
    statusEl.append(" media element" + (media === 1 ? "" : "s") + " controlled.");
    if (pct > 100) {
      const failed = results.reduce((a, r) => a + ((r.ok && r.state && r.state.boostUnavailable) || 0), 0);
      const kind = (results.find(r => r.ok && r.state && r.state.boostFailKind) || {}).state;
      statusEl.append(" ");
      let msg;
      if (!failed) {
        msg = "If boost silences the tab, the media is served without CORS headers — back to 100% and reload.";
      } else if (kind && kind.boostFailKind === "InvalidStateError") {
        msg = `Can't amplify ${failed} element${failed === 1 ? "" : "s"} — the site already routes that audio through its own mixer.`;
      } else {
        msg = `Can't amplify ${failed} element${failed === 1 ? "" : "s"}${kind && kind.boostFailKind ? ` (${kind.boostFailKind})` : ""}.`;
      }
      statusEl.append(node("span", "warn", msg));
    }
  } else {
    statusEl.append("No audio found yet in ");
    statusEl.append(node("b", null, String(reached)));
    statusEl.append(" frame" + (reached === 1 ? "" : "s") + ". Start the sound, then adjust.");
  }

  if (missing > 0) {
    statusEl.append(" ");
    statusEl.append(node("span", "warn",
      missing + " frame" + (missing === 1 ? "" : "s") + " unreachable."));
  }

  for (const r of results) {
    const row = node("div", "frame");
    const ok = r.ok && r.state;

    let mark = "×", cls = "bad";
    if (ok && (r.state.audioContexts > 0 || r.state.mediaCount > 0)) { mark = "♪"; cls = "good"; }
    else if (ok) { mark = "•"; cls = "idle"; }

    row.append(node("span", "mark " + cls, mark));
    row.append(node("span", "host", hostOf(r.url)));

    let note = "no script";
    if (ok) {
      if (r.state.audioContexts > 0)   note = r.state.audioContexts + " ctx";
      else if (r.state.mediaCount > 0) note = r.state.mediaCount + " media";
      else if (r.state.hookAlive)      note = "ready";
      else                             note = "no hook";
    }
    row.append(node("span", "note", note));
    framesEl.append(row);
  }
}

// Rapid slider movement puts several of these in flight at once. Without a
// sequence number a slow reply carrying an old value can land last and repaint
// the panel with state that is no longer true.
let reqSeq = 0;

async function refresh(pct, alsoSet) {
  const seq = ++reqSeq;
  const payload = alsoSet
    ? { type: "setVolume", value: pct / 100 }
    : { type: "getState" };
  try {
    const results = await NS.runtime.sendMessage({ type: "fanOut", tabId, payload });
    if (seq !== reqSeq) return;              // a newer request already answered
    report(pct, results);
  } catch (e) {
    if (seq !== reqSeq) return;
    statusEl.textContent = "Could not reach the tab: " + ((e && e.message) || e);
  }
}

/* Dragging the slider fires an input event per pixel. Applying the volume on
   every one of those is fine and wanted; writing to storage and re-querying every
   frame in the tab is not. So the apply is throttled and the persist debounced. */

let applyTimer = null;
let persistTimer = null;
let queued = null;

async function doApply(pct) {
  await refresh(pct, true);
}

async function doPersist(pct) {
  try {
    const r = await NS.runtime.sendMessage({ type: "storeVolume", tabId, value: pct / 100 });
    if (r && r.host) { siteHost = r.host; renderSite(r.host, r.remembered); }
  } catch (e) { /* ignore */ }
}

function flush() {
  if (applyTimer) { clearTimeout(applyTimer); applyTimer = null; }
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  if (queued === null) return;
  const value = queued;      // take it, so nothing can act on it twice
  queued = null;
  doApply(value);
  doPersist(value);
}

function push(pct, source, immediate) {
  paint(pct, source);
  queued = pct;

  if (immediate) { flush(); return; }

  if (!applyTimer) {
    applyTimer = setTimeout(() => {
      applyTimer = null;
      if (queued !== null) doApply(queued);
    }, 70);
  }
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    // Deliberately does NOT clear `queued`: a pending apply timer still reads it,
    // and doPersist is idempotent. Only flush() consumes the value.
    if (queued !== null) doPersist(queued);
  }, 350);
}

// The popup can be dismissed mid-debounce; don't lose the last value.
window.addEventListener("pagehide", flush);

/* ---------- controls ---------- */

slider.addEventListener("input", () => push(clamp(Number(slider.value)), "slider", false));

entry.addEventListener("input", () => {
  // Ignore an empty box while the user is mid-edit; commit happens on blur/Enter.
  if (entry.value.trim() === "") return;
  push(clamp(Number(entry.value)), "entry", false);
});

entry.addEventListener("change", () => {
  const pct = entry.value.trim() === "" ? currentPct : clamp(Number(entry.value));
  push(pct, null, true);
});

entry.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { entry.blur(); }
});

entry.addEventListener("focus", () => entry.select());

buttons.forEach(b => {
  b.addEventListener("click", () => push(Number(b.dataset.v), null, true));
});

/* ---------- init ---------- */

(async function init() {
  try {
    const tabs = await NS.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) { statusEl.textContent = "No active tab."; return; }
    tabId = tabs[0].id;

    const stored = await NS.runtime.sendMessage({ type: "lookupVolume", tabId });
    // `stored.value || 1` would be wrong here: a site muted at 0 stores 0, which
    // is falsy, so reopening the popup on a muted site claimed 100% while the
    // tab was in fact silent — and the first nudge of the slider unmuted it.
    const raw = stored && typeof stored.value === "number" ? stored.value : 1;
    const pct = clamp(Math.round(raw * 100));
    siteHost = (stored && stored.host) || null;
    paint(pct, null);
    renderSite(siteHost, !!(stored && stored.remembered));
    await refresh(pct, false);
  } catch (e) {
    statusEl.textContent = "Could not read the active tab.";
  }
})();
