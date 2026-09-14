/* Mutation test for the 2.1.0 additions.
 *
 * A passing suite proves nothing on its own - it may simply not be looking.
 * So each guarantee 2.1.0 adds is deliberately broken in the real source, the
 * suite is run against the broken copy, and the run is expected to FAIL. A
 * mutation that slips through is a hole in the tests, not a win.
 *
 * The original file is restored after every mutation, including on a crash.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const MUTATIONS = [
  // ---- background.js: per-tab scope ----
  { file: "background.js", suite: "test-background.js",
    what: "a tab-scoped change also writes the site level",
    from: `if (scope !== "tab" && host) {`,
    to:   `if (host) {` },

  { file: "background.js", suite: "test-background.js",
    what: "a keyboard command is treated as a site-scoped change",
    from: `      await applyLevel(tabId, next, "tab");`,
    to:   `      await applyLevel(tabId, next, "site");` },

  { file: "background.js", suite: "test-background.js",
    what: "closing a tab leaves its scope and mute memory behind",
    from: `  tabOverrides.delete(tabId);
  tabScopes.delete(tabId);
  lastAudible.delete(tabId);`,
    to:   `  tabOverrides.delete(tabId);` },

  { file: "background.js", suite: "test-background.js",
    what: "reset writes its 100% to the site instead of just the tab",
    from: `  tabOverrides.set(tabId, v);
  tabScopes.set(tabId, "tab");
  lastAudible.set(tabId, v);`,
    to:   `  tabOverrides.set(tabId, v);
  tabScopes.set(tabId, "site");
  lastAudible.set(tabId, v);
  if (host) { delete sites[host]; persist(); }` },

  { file: "background.js", suite: "test-background.js",
    what: "reset lands somewhere other than 100%",
    from: `  const host = await tabHost(tabId);
  const v = 1;`,
    to:   `  const host = await tabHost(tabId);
  const v = effective(tabId, host);` },

  // ---- background.js: the arithmetic behind the keyboard steps ----
  { file: "background.js", suite: "test-background.js",
    what: "levels are no longer rounded to whole percentage points",
    from: `  return Math.max(0, Math.min(6, Math.round(v * 100) / 100));`,
    to:   `  return Math.max(0, Math.min(6, v));` },

  { file: "background.js", suite: "test-background.js",
    what: "the ceiling is lifted above 600%",
    from: `  return Math.max(0, Math.min(6, Math.round(v * 100) / 100));`,
    to:   `  return Math.max(0, Math.round(v * 100) / 100);` },

  { file: "background.js", suite: "test-background.js",
    what: "the floor is lifted below 0%",
    from: `  return Math.max(0, Math.min(6, Math.round(v * 100) / 100));`,
    to:   `  return Math.min(6, Math.round(v * 100) / 100);` },

  { file: "background.js", suite: "test-background.js",
    what: "the step is 10 points rather than 5",
    from: `const STEP = 0.05;`,
    to:   `const STEP = 0.1;` },

  { file: "background.js", suite: "test-background.js",
    what: "unmuting forgets where it came from and returns to 100%",
    from: `          lastAudible.set(tabId, current);
          next = 0;`,
    to:   `          next = 0;` },

  { file: "background.js", suite: "test-background.js",
    what: "a keyboard step ignores the site's level and starts from 100%",
    from: `      const current = effective(tabId, hostOf(tab.url));`,
    to:   `      const current = effective(tabId, null);` },

  { file: "background.js", suite: "test-background.js",
    what: "a tab held apart from its site is not reported as such",
    from: `  tabScopes.set(tabId, scope === "tab" ? "tab" : "site");`,
    to:   `  tabScopes.set(tabId, "site");` },

  { file: "background.js", suite: "test-background.js",
    what: "a keyboard change never reaches the audio",
    from: `      await applyLevel(tabId, next, "tab");
      await fanOut(tabId, { type: "setVolume", value: next });`,
    to:   `      await applyLevel(tabId, next, "tab");` },

  { file: "background.js", suite: "test-background.js",
    what: "the toolbar stops following a change",
    from: `  if (v > 0) lastAudible.set(tabId, v);
  indicate(tabId, v);`,
    to:   `  if (v > 0) lastAudible.set(tabId, v);` },

  { file: "background.js", suite: "test-background.js",
    what: "0 is recorded as the level to unmute back to",
    from: `  if (v > 0) lastAudible.set(tabId, v);`,
    to:   `  lastAudible.set(tabId, v);` },

  { file: "background.js", suite: "test-background.js",
    what: "navigating to another site keeps the old tab override",
    from: `    if (tabHosts.has(tabId) && newHost !== oldHost) forgetTab(tabId);`,
    to:   `    if (tabHosts.has(tabId) && newHost !== oldHost) tabHosts.set(tabId, newHost);` },

  { file: "background.js", suite: "test-background.js",
    what: "leaving a page with no host keeps the level set there",
    from: `    if (tabHosts.has(tabId) && newHost !== oldHost) forgetTab(tabId);`,
    to:   `    if (oldHost && newHost !== oldHost) forgetTab(tabId);` },

  { file: "background.js", suite: "test-background.js",
    what: "a level set on a hostless page records no host to leave",
    from: `  // or a file:// page must not follow the tab to the first real site either.
  tabHosts.set(tabId, host);`,
    to:   `  // or a file:// page must not follow the tab to the first real site either.
  if (host) tabHosts.set(tabId, host);` },

  { file: "background.js", suite: "test-background.js",
    what: "a content script can reset another tab",
    from: `      (msg.type === "storeVolume" || msg.type === "forgetSite" || msg.type === "fanOut" ||
       msg.type === "resetTab")) {`,
    to:   `      (msg.type === "storeVolume" || msg.type === "forgetSite" || msg.type === "fanOut")) {` },

  { file: "background.js", suite: "test-background.js",
    what: "Forget leaves the tab holding the level it just erased",
    from: `      forgetTab(msg.tabId);`,
    to:   `      ;` },

  // ---- popup.js: the scope control ----
  { file: "popup.js", suite: "test-popup.js",
    what: "the panel always writes site-scoped, whatever the control says",
    from: `      type: "storeVolume", tabId, value: value / 100, scope: site.scope`,
    to:   `      type: "storeVolume", tabId, value: value / 100, scope: "site"` },

  { file: "popup.js", suite: "test-popup.js",
    what: "clicking the other scope does not actually change scope",
    from: `  site.scope = next;
  push(currentPct, null, true);`,
    to:   `  push(currentPct, null, true);` },

  { file: "popup.js", suite: "test-popup.js",
    what: "the panel opens in site scope even for a tab held apart",
    from: `    scope: info.scope === "tab" ? "tab" : "site",`,
    to:   `    scope: "site",` },

  { file: "popup.js", suite: "test-popup.js",
    what: "a tab-scoped panel stops showing what the site itself keeps",
    from: `    label.append(node("span", "lvl",
      site.siteValue === null ? "unsaved" : "keeps " + asPct(site.siteValue)));`,
    to:   `    label.append(node("span", "lvl", ""));` },

  { file: "popup.js", suite: "test-popup.js",
    what: "the level is folded back into the hostname's own text node",
    from: `    label.append(node("b", null, site.host));
    label.append(node("span", "lvl",
      site.siteValue === null ? "unsaved" : "keeps " + asPct(site.siteValue)));`,
    to:   `    label.append(node("b", null, site.host +
      (site.siteValue === null ? " unsaved" : " keeps " + asPct(site.siteValue))));` },

  { file: "popup.js", suite: "test-popup.js",
    what: "Forget lets a queued save land afterwards and undo it",
    from: `      cancelPending();
      try { await NS.runtime.sendMessage({ type: "forgetSite", tabId }); }`,
    to:   `      try { await NS.runtime.sendMessage({ type: "forgetSite", tabId }); }` },

  // ---- audio-hook.js: inert at 100% ----
  { file: "audio-hook.js", suite: "test-audio-hook.js",
    what: "at 100% an element we never wrote to is touched anyway",
    from: `  function releaseToPage(el) {
    if (!ourWrite.has(el)) return;`,
    to:   `  function releaseToPage(el) {` },
  { file: "audio-hook.js", suite: "test-audio-hook.js",
    what: "returning to 100% pins the element at 1 instead of handing it back",
    from: `        releaseToPage(el);
        return;
      }

      if (current < 1) {`,
    to:   `        setElementVolume(el, 1);
        return;
      }

      if (current < 1) {` },

  { file: "audio-hook.js", suite: "test-audio-hook.js",
    what: "ownership is claimed after the write, so volumechange re-enters as a takeover",
    from: `    ourWrite.set(el, target);
    if (Math.abs(el.volume - target) > 0.01) el.volume = target;`,
    to:   `    if (Math.abs(el.volume - target) > 0.01) el.volume = target;` },
  { file: "audio-hook.js", suite: "test-audio-hook.js",
    what: "the level replaces the page's own instead of multiplying it",
    from: `    const target = Math.max(0, Math.min(1, pageBase(el) * factor));`,
    to:   `    const target = factor;` },

  { file: "audio-hook.js", suite: "test-audio-hook.js",
    what: "a move of the site's own volume control is stamped back over",
    from: `    if (Math.abs(el.volume - ourWrite.get(el)) > 0.01) originalVolume.set(el, el.volume);`,
    to:   `    ;` },
];

/* This script deliberately writes broken code into the real source and relies on
 * putting it back. A `finally` is not enough: kill the process between the write
 * and the restore and a mutation survives in the working tree, where the next
 * build will happily package it. That has happened. So the original is also
 * parked on disk, restored on any exit path, and checked for on the way in. */
const BAK = (f) => path.join(__dirname, "." + path.basename(f) + ".mutbak");

function restoreAll(why) {
  for (const m of MUTATIONS) {
    const file = path.join(__dirname, m.file);
    const bak = BAK(file);
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, file);
      fs.unlinkSync(bak);
      console.log(`  restored ${m.file} from backup (${why})`);
    }
  }
}

// A leftover backup means a previous run died mid-mutation. Put it back before
// doing anything else, and say so - the tree may have been built from it.
restoreAll("a previous run did not finish");

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { restoreAll(sig); process.exit(130); });
}
process.on("uncaughtException", (e) => {
  restoreAll("crash");
  console.error(e);
  process.exit(1);
});

let caught = 0, missed = 0;

for (const m of MUTATIONS) {
  const file = path.join(__dirname, m.file);
  const original = fs.readFileSync(file, "utf8");
  fs.writeFileSync(BAK(file), original);

  const hits = original.split(m.from).length - 1;
  if (hits !== 1) {
    console.log(`  SKIP  ${m.what}\n        anchor matched ${hits} times in ${m.file} - the mutation is invalid`);
    try { fs.unlinkSync(BAK(file)); } catch (e) { /* fine */ }
    missed++;
    continue;
  }

  fs.writeFileSync(file, original.replace(m.from, m.to));
  let failed = false, out = "";
  try {
    out = execFileSync("node", [path.join(__dirname, m.suite)], { encoding: "utf8" });
  } catch (e) {
    failed = true;
    out = (e.stdout || "") + (e.stderr || "");
  } finally {
    fs.writeFileSync(file, original);
    try { fs.unlinkSync(BAK(file)); } catch (e) { /* already gone */ }
  }

  const line = (out.match(/\d+ passed, \d+ failed/) || ["crashed"])[0];
  if (failed) { caught++; console.log(`  caught  ${m.what}\n          (${line})`); }
  else { missed++; console.log(`  MISSED  ${m.what}\n          the suite passed against broken code: ${line}`); }
}

console.log(`\n${caught} caught, ${missed} missed\n`);
process.exit(missed ? 1 : 0);
