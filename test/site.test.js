import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { caption, editionsOf, mapsUrl, pickVariant, relativeTime, shareFileName, sortCheckins } from "../src/lib/view.js";
import { run, spring } from "../src/lib/spring.js";

const NOW = Date.parse("2026-10-12T10:00:00Z");
const v = (theme) => ({ theme, text: "t", differences: [], day: `/media/${theme}/day.png`, night: `/media/${theme}/night.png` });
const ck = (over = {}) => ({
  id: "ck-1", text: "at the cafe", place: { name: "Cafe", address: null, lat: null, lng: null },
  capturedAt: null, capturedAtSource: null, companions: [], publishedAt: "2026-10-09T10:00:00.000Z", variants: [v("normal")], ...over,
});
const sentence = (parts) => parts.map((p) => p.value).join("");

// ---- view logic

test("caption: unknown capture time says 'Added' and marks the time as publication time", () => {
  const parts = caption(ck(), NOW, "en");
  assert.equal(sentence(parts), "Added Cafe · 3 days ago.");
  const time = parts.find((p) => p.kind === "time");
  assert.equal(time.datetime, "2026-10-09T10:00:00.000Z");
  assert.match(time.title, /Capture time unknown/);
});

test("caption: known capture time says 'Spotted at' and uses the capture time", () => {
  const parts = caption(ck({ capturedAt: "2026-10-11T10:00:00Z", capturedAtSource: "exif" }), NOW, "en");
  assert.equal(sentence(parts), "Spotted at Cafe · yesterday.");
  assert.equal(parts.find((p) => p.kind === "time").title, null);
});

test("caption: companions, missing place and Chinese", () => {
  assert.equal(sentence(caption(ck({ companions: ["Ada", "Bo", "Cy"] }), NOW, "en")), "Added Cafe with Ada, Bo and Cy · 3 days ago.");
  assert.equal(sentence(caption(ck({ place: { name: null } }), NOW, "en")), "Added a place · 3 days ago.");
  const zh = sentence(caption(ck({ companions: ["Ada", "Bo"] }), NOW, "zh"));
  assert.match(zh, /^收藏了 Cafe 和 Ada、Bo · 3天前。$/);
  assert.ok(!caption(ck({ place: { name: null } }), NOW).some((p) => p.kind === "place"));
});

test("relative time", () => {
  assert.equal(relativeTime("2026-10-12T09:59:40Z", NOW), "just now");
  assert.equal(relativeTime("2026-10-12T07:00:00Z", NOW), "3 hours ago");
  assert.equal(relativeTime("2026-09-07T10:00:00Z", NOW), "last month");
  assert.equal(relativeTime("2026-10-12T09:59:40Z", NOW, "zh"), "刚刚");
  assert.equal(relativeTime("garbage", NOW), "");
  assert.equal(relativeTime("2026-10-13T10:00:00Z", NOW), "just now", "clock skew never shows the future");
});

test("edition choice never invents a variant and reports unavailability", () => {
  const both = ck({ variants: [v("normal"), v("halloween")] });
  assert.equal(pickVariant(both, "halloween").variant.theme, "halloween");
  assert.deepEqual(editionsOf(both), ["normal", "halloween"]);
  const normalOnly = pickVariant(ck(), "halloween");
  assert.equal(normalOnly.available, false);
  assert.equal(normalOnly.variant.theme, "normal");
  const halloweenOnly = pickVariant(ck({ variants: [v("halloween")] }), "normal");
  assert.equal(halloweenOnly.variant.theme, "halloween");
  assert.equal(halloweenOnly.available, false);
});

test("sorting is newest first, using the capture time when known", () => {
  const a = ck({ id: "a", publishedAt: "2026-10-10T00:00:00Z" });
  const b = ck({ id: "b", publishedAt: "2026-10-11T00:00:00Z" });
  const c = ck({ id: "c", publishedAt: "2026-10-12T00:00:00Z", capturedAt: "2026-09-01T00:00:00Z" });
  assert.deepEqual(sortCheckins([a, b, c]).map((x) => x.id), ["b", "a", "c"]);
});

test("map links use only stated facts; file names are sanitised", () => {
  assert.equal(mapsUrl({ name: null }), null);
  assert.match(mapsUrl({ name: "Cafe", address: "1 Road" }), /query=Cafe%2C%201%20Road$/);
  assert.match(mapsUrl({ name: "Cafe", lat: 3.1, lng: 101.7 }), /query=3\.1%2C101\.7$/);
  assert.equal(shareFileName({ id: "ck-1/../x" }, "halloween", "night"), "halloween-checkin-ck-1x-halloween-night.png");
});

// ---- spring

test("spring settles on its target without drifting", () => {
  const s = spring({ from: 0, to: 100, stiffness: 170, damping: 26 });
  for (let i = 0; i < 240; i++) s.step(1 / 60);
  assert.ok(Math.abs(s.value - 100) < 0.01);
  assert.equal(s.settled(), true);
});

test("an underdamped spring overshoots, a critically damped one does not", () => {
  const bouncy = spring({ from: 0, to: 1, stiffness: 200, damping: 8 });
  const firm = spring({ from: 0, to: 1, stiffness: 100, damping: 20 });
  let maxB = 0, maxF = 0;
  for (let i = 0; i < 300; i++) { maxB = Math.max(maxB, bouncy.step(1 / 60)); maxF = Math.max(maxF, firm.step(1 / 60)); }
  assert.ok(maxB > 1.1);
  assert.ok(maxF <= 1.0005);
});

test("precision decides when a spring counts as settled", () => {
  const px = spring({ from: 60, to: 0, stiffness: 200, damping: 20, precision: 0.3 });
  const tight = spring({ from: 60, to: 0, stiffness: 200, damping: 20 });
  let a = 0, b = 0;
  while (!px.settled() && a < 1000) { px.step(1 / 60); a++; }
  while (!tight.settled() && b < 1000) { tight.step(1 / 60); b++; }
  assert.ok(a < b, `coarse precision settles sooner (${a} vs ${b} frames)`);
  assert.ok(a < 60, "a half-pixel spring settles within a second");
});

test("spring stepping is frame-rate independent", () => {
  const a = spring({ from: 0, to: 1 });
  const b = spring({ from: 0, to: 1 });
  for (let i = 0; i < 30; i++) a.step(1 / 60);
  for (let i = 0; i < 15; i++) b.step(1 / 30);
  assert.ok(Math.abs(a.value - b.value) < 0.002);
});

test("run() drives springs to completion with an injected clock", async () => {
  let clock = 0;
  const queue = [];
  const raf = (fn) => queue.push(fn);
  const s = spring({ from: 0, to: 1 });
  const frames = [];
  const { done } = run([s], ([x]) => frames.push(x), { raf, now: () => clock });
  while (queue.length) { clock += 16; queue.shift()(); }
  assert.equal(await done, true);
  assert.equal(frames.at(-1), 1);
  assert.ok(frames.length > 10);
});

// ---- static contracts of the page scripts

const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

test("only data.js talks to the network, and only with GET", () => {
  const data = read("scripts/data.js");
  assert.equal((data.match(/\bfetch\(/g) ?? []).length, 2);
  assert.ok(!/method\s*:/i.test(data));
  for (const file of ["scripts/app.js", "scripts/mood.js", "lib/view.js", "lib/spring.js"]) {
    assert.ok(!/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket/.test(read(file)), `${file} must not use the network`);
  }
});

test("the mood module touches no data and record text is never parsed as HTML", () => {
  const mood = read("scripts/mood.js");
  assert.ok(!/import/.test(mood), "mood is self-contained");
  const app = read("scripts/app.js");
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(app));
  // The only innerHTML use in mood.js is the static bat SVG and the static fog markup.
  assert.equal((mood.match(/innerHTML/g) ?? []).length, 2);
});

test("edition and scheme changes re-render from memory; only boot loads the list", () => {
  const app = read("scripts/app.js");
  assert.equal((app.match(/loadCheckins\(/g) ?? []).length, 1);
  const boot = app.slice(app.indexOf("async function boot"));
  assert.match(boot, /loadCheckins\(/);
  assert.equal((app.match(/loadImageBlob\(/g) ?? []).length, 1);
  assert.match(app.slice(app.indexOf("async function share"), app.indexOf("// ------", app.indexOf("async function share"))), /loadImageBlob\(/);
});
