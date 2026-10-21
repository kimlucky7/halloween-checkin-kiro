// Site behaviour and motion.
//
// Two modes only: Day shows each place's normal picture; Night shows the
// Halloween night picture when a place has one (otherwise its normal night
// picture, or its day picture if that is all it has) together with the Halloween
// atmosphere. Reads data only through ./data.js and
// decides what to show only through ../lib/view.js. Record text is always
// inserted with textContent, never parsed as HTML.
import {
  caption, depthFor, loopShift, nearestTo, pickImage,
  shareFileName, shortDate, sortCheckins, STRINGS,
} from "../lib/view.js";
import { run, spring } from "../lib/spring.js";
import { loadCheckins, loadImageBlob } from "./data.js";
import { createMood } from "./mood.js";

const root = document.documentElement;
root.dataset.app = "6"; // bump when a cached broken bundle must be bypassed
const $ = (sel) => document.querySelector(sel);
const els = {
  stage: $("[data-stage]"),
  heroWrap: $("[data-hero-wrap]"),
  pager: $("[data-pager]"),
  track: $("[data-pager-track]"),
  caption: $("[data-caption]"),
  share: $("[data-share]"),
  expand: $("[data-expand]"),
  expandCount: $("[data-expand-count]"),
  shelf: $("[data-shelf]"),
  grid: $("[data-grid]"),
  scheme: $("[data-scheme-toggle]"),
  lang: $("[data-lang-toggle]"),
  status: $("[data-status]"),
  foot: $("[data-foot]"),
};

// The strip repeats the list so there is always a picture on both sides:
// five copies, the middle one is "home". Index 0 is the newest place.
const COPIES = 3;
const HOME = 1;

const state = {
  checkins: [],
  index: 0,
  lang: (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en",
  view: "hero", // "hero" | "strip" | "grid"
  returnTo: "hero",
  busy: false,
  pending: null,
  pendingDir: 1,
  heading: null,
};

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = () => matchMedia("(hover: hover) and (pointer: fine)").matches;
const isNight = () => root.dataset.scheme === "dark";
const t = () => STRINGS[state.lang];
const current = () => state.checkins[state.index];
const el = (tag, attrs = {}, text) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
};

// The picture a place shows in a mode: Night → Halloween edition if it exists.
const imageFor = (checkin, night) => pickImage(checkin, night);
const urlFor = (checkin, night) => imageFor(checkin, night)?.url ?? "";
const urlsForMode = (night) => state.checkins.map((c) => urlFor(c, night));
const heroUrls = (checkin) => [urlFor(checkin, false), urlFor(checkin, true)];
// The pictures around one place (wrapping), which is what a strip shows first.
function nearbyUrls(index, night, radius = 2) {
  const n = state.checkins.length;
  const out = [];
  for (let d = -radius; d <= radius; d++) out.push(urlFor(state.checkins[(index + d + n * 4) % n], night));
  return out;
}
// Fade elements out while the next view gets ready; returns a function that resets them.
function fadeOut(nodes, duration = 150) {
  if (reduced() || !nodes.length) return { done: Promise.resolve(), reset() {} };
  const anims = nodes.map((n) => n.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing: "ease-in", fill: "forwards" }));
  return { done: Promise.all(anims.map((a) => a.finished.catch(() => {}))), reset: () => anims.forEach((a) => a.cancel()) };
}

// ------------------------------------------------------------ input modality
// Focus rings are for keyboard users: after a pointer interaction, do not move focus.
let keyboardMode = false;
addEventListener("keydown", (e) => { if (!e.metaKey && !e.ctrlKey && !e.altKey) keyboardMode = true; }, true);
addEventListener("pointerdown", () => (keyboardMode = false), true);
const focusIfKeyboard = (node) => { if (keyboardMode) node?.focus({ preventScroll: true }); };

// While an animation runs, the latest requested action waits and runs right after.
let queued = null;
function later(action) {
  if (!state.busy) return false;
  queued = action;
  return true;
}
function settle() {
  state.busy = false;
  const next = queued;
  queued = null;
  next?.();
}

// ------------------------------------------------------------ pictures ready before they show
// A view is only swapped once the pictures it needs are decoded, so a swap never
// paints an empty frame or lets thumbnails pop in late.
const decoded = new Map();
function ensureLoaded(urls, timeout = 800) {
  const jobs = urls.filter(Boolean).map((url) => {
    let job = decoded.get(url);
    if (!job) {
      const img = new Image();
      img.decoding = "async";
      img.src = url;
      job = img.decode().then(() => img, () => img); // a failed picture must never block the page
      decoded.set(url, job);
    }
    return job;
  });
  return Promise.race([Promise.all(jobs), new Promise((resolve) => setTimeout(resolve, timeout))]);
}

// ------------------------------------------------------------ rendering

function renderChrome() {
  const s = t();
  root.lang = state.lang === "zh" ? "zh-Hans" : "en";
  const label = s.schemeLabel(isNight());
  els.scheme.setAttribute("aria-label", label);
  els.scheme.title = label;
  els.lang.textContent = s.lang;
  els.lang.setAttribute("aria-label", s.langLabel);
  els.share.textContent = s.share;
  els.foot.textContent = s.footnote;
  els.expand.setAttribute("aria-label", s.all(state.checkins.length));
  els.expand.title = s.all(state.checkins.length);
  els.expandCount.textContent = String(state.checkins.length);
  els.expand.hidden = state.checkins.length < 2;
}

// ------------------------------------------------------------ the big picture: a native pager
// Every place is a slide in a real horizontal scroller with scroll snapping, so a
// swipe is the browser's own scrolling (finger-tracked, with native momentum) rather
// than a scripted imitation. Like the strip it holds three copies so it wraps.
const homeSlide = (i) => els.track.querySelector(`[data-slide="${i}"][data-copy="${HOME}"]`);
let heroLi = null; // the slide in the middle right now
function heroParts(li = heroLi ?? homeSlide(state.index)) {
  if (!li) return null;
  return {
    li,
    button: li.querySelector(".hero"),
    tilt: li.querySelector(".tilt"),
    flip: li.querySelector(".flip"),
    day: li.querySelector(".pic.day"),
    night: li.querySelector(".pic.night"),
    sheen: li.querySelector(".sheen"),
  };
}

let pagerKey = "";
function buildPager() {
  const n = state.checkins.length;
  const key = state.checkins.map((c) => c.id).join();
  if (key === pagerKey) return;
  pagerKey = key;
  els.track.replaceChildren();
  for (let c = 0; c < COPIES; c++) {
    for (let p = 0; p < n; p++) {
      const i = n - 1 - p; // oldest on the left, newest on the right
      const checkin = state.checkins[i];
      const home = c === HOME;
      const li = el("li", { class: "slide", "data-slide": String(i), "data-copy": String(c), "aria-hidden": home ? null : "true" });
      const button = el("button", { type: "button", class: "hero", "aria-controls": "shelf", tabindex: home ? "0" : "-1" });
      const tilt = el("span", { class: "tilt" });
      const flip = el("span", { class: "flip" });
      const near = home && (i <= 1 || i >= n - 2);
      const lazy = near ? "eager" : "lazy";
      flip.append(
        el("img", { class: "pic day", src: urlFor(checkin, false), width: "720", height: "720", alt: "", decoding: "async", loading: lazy, draggable: "false" }),
        el("img", { class: "pic night", src: urlFor(checkin, true), width: "720", height: "720", alt: "", decoding: "async", loading: lazy, draggable: "false" }),
        el("span", { class: "sheen", "aria-hidden": "true" }),
      );
      tilt.append(flip);
      button.append(tilt, el("span", { class: "ground", "aria-hidden": "true" }));
      li.append(button);
      els.track.append(li);
    }
  }
}

// Alt text belongs to whichever picture the current mode shows.
function setPictures() {
  const s = t();
  const night = isNight();
  for (const li of els.track.children) {
    const checkin = state.checkins[Number(li.dataset.slide)];
    const home = li.dataset.copy === String(HOME);
    const day = li.querySelector(".pic.day");
    const nightImg = li.querySelector(".pic.night");
    const shownDay = imageFor(checkin, false);
    const shownNight = imageFor(checkin, true);
    // Alt text names the picture's real edition and lighting, not the mode.
    day.alt = home && !night && shownDay ? s.alt(shownDay.theme, shownDay.lighting, checkin.place?.name) : "";
    nightImg.alt = home && night && shownNight ? s.alt(shownNight.theme, shownNight.lighting, checkin.place?.name) : "";
  }
  const parts = heroParts();
  if (parts) parts.sheen.style.setProperty("--mask", `url("${night ? parts.night.src : parts.day.src}")`);
}

const slideCenter = (li) => li.offsetLeft + li.offsetWidth / 2;
function nearestSlide() {
  const slides = [...els.track.children];
  return slides[nearestTo(slides.map(slideCenter), els.pager.scrollLeft + els.pager.clientWidth / 2)] ?? null;
}
function centerSlide(li, behavior = "instant") {
  if (!li) return;
  els.pager.scrollTo({ left: slideCenter(li) - els.pager.clientWidth / 2, behavior: reduced() ? "instant" : behavior });
}

// Runs on every scroll frame: neighbours shrink and fade, the caption fades with
// distance from the middle and changes while it is invisible.
function pagerFrame() {
  if (state.view !== "hero" || !els.track.children.length) return;
  const width = els.pager.clientWidth || 1;
  const mid = els.pager.scrollLeft + width / 2;
  const plain = reduced();
  let best = null;
  let bestOff = Infinity;
  for (const li of els.track.children) {
    const off = (slideCenter(li) - mid) / width;
    if (Math.abs(off) < Math.abs(bestOff)) {
      bestOff = off;
      best = li;
    }
    if (Math.abs(off) > 1.6) continue;
    const d = Math.min(1, Math.abs(off));
    li.style.setProperty("--depth", plain ? "1" : (1 - d * 0.14).toFixed(3));
    li.style.setProperty("--fade", plain ? "1" : (1 - d * 0.65).toFixed(3));
  }
  if (best && best !== heroLi) {
    const old = heroParts();
    if (old) old.tilt.style.transform = "";
    heroLi = best;
    const i = Number(best.dataset.slide);
    if (i !== state.index) {
      state.index = i;
      renderCaption(current());
    }
    setPictures();
  }
  const fade = Math.max(0, 1 - Math.abs(bestOff) * 2.4);
  els.caption.style.opacity = plain ? "" : fade.toFixed(3);
  els.caption.style.transform = plain ? "" : `translate3d(${(-bestOff * 28).toFixed(1)}px, 0, 0)`;
}

// Jump between identical copies while at rest (invisible), or at once near an end.
function normalizePager() {
  if (state.view !== "hero" || pagerDrag.active) return;
  const li = nearestSlide();
  if (!li) return;
  const copy = Number(li.dataset.copy);
  if (copy === HOME) return;
  const period = els.track.querySelector(`[data-copy="${HOME + 1}"]`).offsetLeft - els.track.querySelector(`[data-copy="${HOME}"]`).offsetLeft;
  els.pager.style.scrollSnapType = "none";
  els.pager.scrollLeft += loopShift(copy, HOME, period);
  requestAnimationFrame(() => (els.pager.style.scrollSnapType = ""));
  pagerFrame();
}

// The home-copy twin of a slide, and its neighbours, decoded ahead of the loop jump:
// a picture that is decoded only after the jump shows as an empty frame (a flash),
// mostly in Safari, which drops decoded images of slides that were off screen.
const twinOf = (li) => homeSlide(Number(li.dataset.slide));
function decodeAround(li) {
  const slides = [li?.previousElementSibling, li, li?.nextElementSibling].filter(Boolean);
  return Promise.all(slides.flatMap((s) => [...s.querySelectorAll("img.pic")]).map((img) => {
    img.loading = "eager";
    return img.decode?.().catch(() => {});
  }));
}
const centred = (li) => Math.abs(slideCenter(li) - (els.pager.scrollLeft + els.pager.clientWidth / 2)) <= 1;
// Jump to the home copy only once the twin is decoded and the scroller is at rest
// on the same slide; otherwise a later idle tick tries again.
async function settleLoop() {
  const li = nearestSlide();
  if (!li || li.dataset.copy === String(HOME)) return;
  await Promise.race([decodeAround(twinOf(li)), new Promise((r) => setTimeout(r, 400))]);
  if (pagerDrag.active || nearestSlide() !== li || !centred(li)) return;
  normalizePager();
}

let pagerFrameId = 0;
let pagerIdle = 0;
let pagerTarget = null;
let warmedFor = null;
function onPagerScroll() {
  if (!pagerFrameId) pagerFrameId = requestAnimationFrame(() => {
    pagerFrameId = 0;
    pagerFrame();
  });
  const li = nearestSlide();
  const copy = li ? Number(li.dataset.copy) : HOME;
  if (li && copy !== HOME && warmedFor !== li) {
    warmedFor = li;
    decodeAround(twinOf(li));
  }
  if (copy === 0 || copy === COPIES - 1) {
    // only when the edge copy is actually reached
    const edge = els.pager.scrollLeft < els.pager.clientWidth || els.pager.scrollLeft > els.pager.scrollWidth - 2 * els.pager.clientWidth;
    if (edge) normalizePager();
  }
  clearTimeout(pagerIdle);
  pagerIdle = setTimeout(() => {
    pagerTarget = null;
    // Safety net: if a browser left the scroller between two slides, finish the snap;
    // the loop jump waits for the next rest after that.
    const li = nearestSlide();
    if (li && !pagerDrag.active && !centred(li)) centerSlide(li, "smooth");
    else settleLoop();
  }, 160);
}

// Arrow keys: one slide at a time, adding up when pressed quickly.
function pagerStep(dir) {
  const base = pagerTarget ?? nearestSlide();
  const next = dir > 0 ? base?.nextElementSibling : base?.previousElementSibling;
  if (!next) return;
  pagerTarget = next;
  centerSlide(next, "smooth");
}

// Mouse: drag the pager like a touch screen; let go and it settles on a slide
// (a quick flick moves one slide). Touch uses native scrolling untouched.
const pagerDrag = { active: false, moved: false, x0: 0, left0: 0, from: null, samples: [] };
function setupPager() {
  els.pager.addEventListener("scroll", onPagerScroll, { passive: true });
  addEventListener("resize", () => {
    if (state.view === "hero" && heroLi) {
      centerSlide(heroLi);
      pagerFrame();
    }
  });
  els.pager.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // trackpads scroll sideways natively
  }, { passive: true });
  els.pager.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse" || e.button !== 0 || state.view !== "hero") return;
    Object.assign(pagerDrag, { active: true, moved: false, x0: e.clientX, left0: els.pager.scrollLeft, from: nearestSlide(), samples: [[e.timeStamp, e.clientX]] });
  });
  addEventListener("pointermove", (e) => {
    if (!pagerDrag.active) return;
    const dx = e.clientX - pagerDrag.x0;
    if (!pagerDrag.moved && Math.abs(dx) > 5) {
      pagerDrag.moved = true;
      els.pager.style.scrollSnapType = "none";
      els.pager.classList.add("dragging");
    }
    if (!pagerDrag.moved) return;
    els.pager.scrollLeft = pagerDrag.left0 - dx;
    pagerDrag.samples.push([e.timeStamp, e.clientX]);
    if (pagerDrag.samples.length > 6) pagerDrag.samples.shift();
  });
  addEventListener("pointerup", () => {
    if (!pagerDrag.active) return;
    pagerDrag.active = false;
    if (!pagerDrag.moved) return;
    const [t0, x0] = pagerDrag.samples[0];
    const [t1, x1] = pagerDrag.samples.at(-1);
    const v = t1 > t0 ? (x1 - x0) / (t1 - t0) : 0; // px per ms
    let target = nearestSlide();
    if (target === pagerDrag.from && Math.abs(v) > 0.35) target = v < 0 ? target.nextElementSibling ?? target : target.previousElementSibling ?? target;
    els.pager.classList.remove("dragging");
    centerSlide(target, "smooth");
    // Native snapping returns once the smooth scroll has landed.
    const restore = () => (els.pager.style.scrollSnapType = "");
    if ("onscrollend" in window) els.pager.addEventListener("scrollend", restore, { once: true });
    else setTimeout(restore, 450);
    setTimeout(() => (pagerDrag.moved = false), 0);
  });
  // Clicking the middle slide opens the strip; clicking a neighbour brings it to the middle.
  els.track.addEventListener("click", (e) => {
    if (pagerDrag.moved || !(e.target instanceof Element)) return;
    const li = e.target.closest(".slide");
    if (!li) return;
    if (li === heroLi) openShelf("strip");
    else centerSlide(li, "smooth");
  });
}

function renderCaption(checkin) {
  els.caption.replaceChildren();
  for (const part of caption(checkin, Date.now(), state.lang)) {
    if (part.kind === "text") els.caption.append(el("span", { class: "part" }, part.value));
    else if (part.kind === "place" && part.href) {
      els.caption.append(el("a", { class: "soft part place", href: part.href, target: "_blank", rel: "noopener noreferrer" }, part.value));
    } else if (part.kind === "time") {
      // Like a timeline: the time opens the row of all places.
      const b = el("button", { type: "button", class: "soft part time-button", "aria-label": t().all(state.checkins.length), "data-open-strip": "" });
      b.append(el("time", { datetime: part.datetime, title: part.title }, part.value));
      b.addEventListener("click", () => openShelf("strip"));
      els.caption.append(b);
    } else els.caption.append(el("span", { class: `soft part${part.kind === "place" ? " place" : ""}` }, part.value));
  }
}

function renderHero() {
  const checkin = current();
  if (!checkin) return;
  setPictures();
  renderCaption(checkin);
  els.expand.setAttribute("aria-expanded", "false");
}

// Two ways to see every place:
//  - "strip": one row you swipe sideways, oldest on the left and the newest on the
//    right, repeated so it never runs out; the picture in the middle is largest;
//  - "grid": everything at once, newest first.
// The list is built ahead of time and reused: building dozens of pictures in the
// frame that opens the strip is what made that frame stall.
let shelfKey = "";
function renderShelf(mode = state.view) {
  const n = state.checkins.length;
  const copies = mode === "strip" ? COPIES : 1;
  els.shelf.dataset.mode = mode;
  els.expand.setAttribute("aria-expanded", String(mode === "grid"));
  const key = [mode, isNight(), state.lang, n, state.checkins.map((c) => c.id).join()].join("|");
  if (key === shelfKey) return false;
  shelfKey = key;
  els.grid.replaceChildren();
  for (let c = 0; c < copies; c++) {
    const home = mode === "grid" || c === HOME;
    for (let p = 0; p < n; p++) {
      const i = mode === "strip" ? n - 1 - p : p;
      const checkin = state.checkins[i];
      const name = checkin.place?.name ?? checkin.text;
      const li = el("li", { class: "cell", "data-cell": String(i), "data-copy": String(c), "aria-hidden": home ? null : "true" });
      const button = el("button", { type: "button", class: "thumb", "aria-label": t().view(name), tabindex: home ? "0" : "-1" });
      const img = el("img", { src: urlFor(checkin, isNight()), alt: "", width: "360", height: "360", decoding: "async", loading: home ? "eager" : "lazy" });
      button.append(img);
      button.addEventListener("click", () => {
        if (drag.moved) return;
        closeShelf(i, img);
      });
      li.append(
        el("p", { class: "when" }, shortDate(checkin.capturedAt ?? checkin.publishedAt, state.lang)),
        button,
        el("p", { class: "name" }, name),
      );
      els.grid.append(li);
    }
  }
  return true;
}

// Build the strip while the big picture is showing, in an idle moment.
function prepareStrip() {
  if (state.view !== "hero" || !state.checkins.length) return;
  const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 200));
  idle(() => {
    if (state.view !== "hero") return;
    const fresh = renderShelf("strip");
    if (!fresh || warmed.has(shelfKey)) return;
    // Paint the strip once, invisibly, so its pictures are decoded and uploaded
    // before the first real open (otherwise that first frame stalls).
    const key = shelfKey;
    Promise.all([...els.grid.querySelectorAll(`[data-copy="${HOME}"] img`)].map((img) => img.decode?.().catch(() => {}))).then(() => {
      if (state.view !== "hero" || key !== shelfKey) return;
      els.shelf.classList.add("warming");
      els.shelf.hidden = false;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        els.shelf.classList.remove("warming");
        if (state.view === "hero") els.shelf.hidden = true;
        warmed.add(key);
      }));
    });
  });
}
const warmed = new Set();

// Re-render without losing the strip's position (rebuilding the list resets its scroll).
function rerender() {
  const keep = state.view === "strip" ? nearestCell()?.dataset.cell : undefined;
  render();
  if (keep !== undefined) {
    centerCell(homeCell(Number(keep)));
    applyDepth();
  }
}

function render() {
  renderChrome();
  if (state.view === "hero") {
    renderHero();
    prepareStrip();
  } else {
    renderShelf();
    if (state.view === "strip") applyDepth();
  }
}

// ------------------------------------------------------------ strip geometry
const cellCenter = (li) => li.offsetLeft + li.offsetWidth / 2;
const homeCell = (index) => els.grid.querySelector(`[data-cell="${index}"][data-copy="${HOME}"]`) ?? els.grid.querySelector(`[data-cell="${index}"]`);

function nearestCell() {
  const cells = [...els.grid.children];
  const at = nearestTo(cells.map(cellCenter), els.grid.scrollLeft + els.grid.clientWidth / 2);
  return cells[at] ?? null;
}

function centerCell(li, behavior = "instant") {
  if (state.view !== "strip" || !li) return;
  const left = cellCenter(li) - els.grid.clientWidth / 2;
  els.grid.scrollTo({ left, behavior: reduced() ? "instant" : behavior });
}

// Pictures nearer the middle are larger and brighter, and turn toward the middle.
// Positions come from layout offsets, not from transformed rectangles.
function applyDepth() {
  if (state.view !== "strip") return;
  const mid = els.grid.scrollLeft + els.grid.clientWidth / 2;
  const plain = reduced();
  for (const cell of els.grid.children) {
    if (plain) {
      cell.style.removeProperty("--depth");
      cell.style.removeProperty("--fade");
      cell.style.removeProperty("--tilt");
      cell.style.removeProperty("--shift");
      continue;
    }
    const offset = (cellCenter(cell) - mid) / cell.offsetWidth;
    if (Math.abs(offset) > 3.2) continue; // far outside the screen
    const { scale, opacity, tilt, shift } = depthFor(offset);
    cell.style.setProperty("--depth", scale.toFixed(3));
    cell.style.setProperty("--fade", opacity.toFixed(3));
    cell.style.setProperty("--tilt", `${tilt.toFixed(2)}deg`);
    cell.style.setProperty("--shift", `${shift.toFixed(1)}px`);
  }
}
let depthFrame = 0;
function scheduleDepth() {
  if (depthFrame) return;
  depthFrame = requestAnimationFrame(() => {
    depthFrame = 0;
    applyDepth();
  });
}

// The copies are identical, so jumping by exactly one period is invisible. Done when
// the strip is at rest, or at once if the centre is about to reach either end.
function loopPeriod() {
  const first = (c) => els.grid.querySelector(`[data-copy="${c}"]`);
  return first(HOME + 1).offsetLeft - first(HOME).offsetLeft;
}
function normalizeLoop() {
  if (state.view !== "strip" || drag.active) return;
  const cell = nearestCell();
  if (!cell) return;
  const copy = Number(cell.dataset.copy);
  if (copy === HOME) return;
  const active = document.activeElement;
  els.grid.style.scrollSnapType = "none";
  els.grid.scrollLeft += loopShift(copy, HOME, loopPeriod());
  requestAnimationFrame(() => (els.grid.style.scrollSnapType = ""));
  if (active instanceof HTMLElement && els.grid.contains(active)) {
    const owner = active.closest(".cell");
    const moved = Number(owner.dataset.copy) + (HOME - copy);
    els.grid.querySelector(`[data-cell="${owner.dataset.cell}"][data-copy="${moved}"] button`)?.focus({ preventScroll: true });
  }
}

let idleTimer = 0;
let stepTarget = null;
function onGridScroll() {
  scheduleDepth();
  const cell = nearestCell();
  const copy = cell ? Number(cell.dataset.copy) : HOME;
  if (copy === 0 || copy === COPIES - 1) normalizeLoop();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    stepTarget = null;
    normalizeLoop();
  }, 140);
}

function stripStep(dir) {
  const base = stepTarget ?? nearestCell();
  const next = dir > 0 ? base?.nextElementSibling : base?.previousElementSibling;
  if (!next) return;
  stepTarget = next;
  centerCell(next, "smooth");
  focusIfKeyboard(next.querySelector("button"));
}

// ------------------------------------------------------------ motion helpers

// Shared-element flight between the big picture and the strip/grid.
// Driven by a spring, so it lands with a small overshoot; travels on an arc and
// leans a little. `onLand` runs in the same frame in which the clone is removed.
function flyClone(img, from, to, { onLand, arc = -36, lean = 4, stiffness = 190, damping = 21 } = {}) {
  const clone = img.cloneNode();
  clone.removeAttribute("loading");
  clone.style.cssText = "";
  Object.assign(clone.style, {
    position: "fixed",
    left: `${to.left}px`,
    top: `${to.top}px`,
    width: `${to.width}px`,
    height: `${to.height}px`,
    margin: "0",
    zIndex: "40",
    pointerEvents: "none",
    transformOrigin: "0 0",
  });
  document.body.append(clone);
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const sx = from.width / to.width;
  const sy = from.height / to.height;
  const side = Math.sign(dx) || 1;
  const p = spring({ from: 0, to: 1, stiffness, damping, precision: 0.002 });
  const frame = ([k]) => {
    const rest = 1 - k;
    const air = Math.sin(Math.min(1, Math.max(0, k)) * Math.PI); // 0 → 1 → 0
    const swell = 1 + air * 0.05;
    clone.style.transform =
      `translate(${dx * rest}px, ${dy * rest + arc * air}px) rotate(${(-side * lean * air).toFixed(2)}deg) scale(${(sx + (1 - sx) * k) * swell}, ${(sy + (1 - sy) * k) * swell})`;
  };
  frame([0]);
  return run([p], frame).done.then(() => {
    onLand?.();
    clone.remove();
  });
}

const visibleHeroImage = () => {
  const p = heroParts();
  return isNight() ? p.night : p.day;
};

async function entrance() {
  if (reduced()) return;
  riseCaption(140);
  const y = spring({ from: 36, to: 0, stiffness: 140, damping: 16, precision: 0.3 });
  const sc = spring({ from: 0.9, to: 1, stiffness: 160, damping: 18, precision: 0.002 });
  const op = spring({ from: 0, to: 1, stiffness: 120, damping: 20, precision: 0.01 });
  const flip = heroParts().flip;
  await run([y, sc, op], ([dy, s, o]) => {
    flip.style.transform = `translateY(${dy}px) scale(${s})`;
    flip.style.opacity = String(Math.min(1, Math.max(0, o)));
  }).done;
  flip.style.transform = "";
  flip.style.opacity = "";
}

// The caption's parts come in one after another (transform and opacity only, so
// it stays on the compositor). `from` is the side they slide in from.
function riseCaption(delay = 60, { skip = null, from = "below" } = {}) {
  if (reduced()) return;
  const start = from === "below" ? "translate3d(0, 10px, 0)" : `translate3d(${from * 18}px, 0, 0)`;
  [...els.caption.children].forEach((node, i) => {
    if (node === skip) return;
    node.animate([{ opacity: 0, transform: start }, { opacity: 1, transform: "translate3d(0, 0, 0)" }], {
      duration: 520,
      delay: delay + i * 38,
      easing: "cubic-bezier(.22,1,.36,1)",
      fill: "backwards",
    });
  });
}

const placePart = () => els.caption.querySelector(".place");
const fontPx = (node) => parseFloat(getComputedStyle(node).fontSize) || 16;
const centre = (r) => [r.left + r.width / 2, r.top + r.height / 2];

// Shared text: the place name travels between the strip label and the caption,
// scaling between the two font sizes on the same spring as the picture.
function morphText(node, fromRect, fromFont, { stiffness = 190, damping = 21 } = {}) {
  if (!node || !fromRect || reduced()) return Promise.resolve();
  const toRect = node.getBoundingClientRect();
  const [fx, fy] = centre(fromRect);
  const [tx, ty] = centre(toRect);
  const s0 = fromFont / fontPx(node);
  node.style.willChange = "transform";
  const p = spring({ from: 0, to: 1, stiffness, damping, precision: 0.002 });
  const frame = ([k]) => {
    const rest = 1 - k;
    node.style.transform = `translate3d(${(fx - tx) * rest}px, ${(fy - ty) * rest}px, 0) scale(${s0 + (1 - s0) * k})`;
  };
  frame([0]);
  return run([p], frame).done.then(() => {
    node.style.transform = "";
    node.style.willChange = "";
  });
}

// A floating copy of a text element, used when its view is about to disappear.
function textClone(node) {
  const r = node.getBoundingClientRect();
  const cs = getComputedStyle(node);
  const copy = el("span", { class: "text-flight", "aria-hidden": "true" }, node.textContent);
  Object.assign(copy.style, {
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
    font: cs.font,
    lineHeight: `${r.height}px`,
    color: cs.color,
    letterSpacing: cs.letterSpacing,
  });
  document.body.append(copy);
  return { copy, rect: r, font: fontPx(node) };
}

function flyText(clone, toNode, { stiffness = 190, damping = 21 } = {}) {
  const toRect = toNode.getBoundingClientRect();
  const [fx, fy] = centre(clone.rect);
  const [tx, ty] = centre(toRect);
  const s1 = fontPx(toNode) / clone.font;
  const toColor = getComputedStyle(toNode).color;
  const fromColor = clone.copy.style.color;
  const p = spring({ from: 0, to: 1, stiffness, damping, precision: 0.002 });
  const colour = clone.copy.animate([{ color: fromColor }, { color: toColor }], { duration: 420, easing: "ease-out", fill: "forwards" });
  return run([p], ([k]) => {
    clone.copy.style.transform = `translate3d(${(tx - fx) * k}px, ${(ty - fy) * k}px, 0) scale(${1 + (s1 - 1) * k})`;
  }).done.then(() => {
    colour.cancel();
    clone.copy.remove();
  });
}

// Tilt toward the pointer with a sheen that follows it, sprung so it eases back.
function setupTilt() {
  const rx = spring({ stiffness: 120, damping: 14, precision: 0.02 });
  const ry = spring({ stiffness: 120, damping: 14, precision: 0.02 });
  rx.target = 0;
  ry.target = 0;
  let loop = null;
  const apply = ([x, y]) => {
    const p = heroParts();
    if (!p) return;
    p.tilt.style.transform = `rotateX(${x.toFixed(2)}deg) rotateY(${y.toFixed(2)}deg)`;
    p.sheen.style.setProperty("--mx", `${50 + y * 5}%`);
    p.sheen.style.setProperty("--my", `${50 - x * 5}%`);
    p.sheen.style.opacity = String(Math.min(1, (Math.abs(x) + Math.abs(y)) / 6));
  };
  const kick = () => {
    if (!loop) loop = run([rx, ry], apply);
    loop.done.then(() => (loop = null));
  };
  els.pager.addEventListener("pointermove", (e) => {
    if (!finePointer() || reduced() || state.busy || pagerDrag.moved) return;
    const r = heroParts()?.button.getBoundingClientRect();
    if (!r) return;
    rx.target = -((e.clientY - r.top) / r.height - 0.5) * 12;
    ry.target = ((e.clientX - r.left) / r.width - 0.5) * 14;
    kick();
  });
  els.pager.addEventListener("pointerleave", () => {
    rx.target = 0;
    ry.target = 0;
    kick();
  });
}

// A handful of tiny pumpkins and sparks pop out of the building and fall.
const PUMPKIN = '<svg viewBox="0 0 24 24"><path d="M12 6c-1-2 0-4 2-4" fill="none" stroke="#3b5a1f" stroke-width="2" stroke-linecap="round"/><path d="M12 6.5c-2.2-1.2-5-.9-6.8.8C3.4 9 3 12.3 4 15.2c1.1 3.4 4.4 5.3 8 5.3s6.9-1.9 8-5.3c1-2.9.6-6.2-1.2-7.9-1.8-1.7-4.6-2-6.8-.8z" fill="#ec7a1c"/></svg>';
function burst() {
  if (reduced() || state.view !== "hero") return;
  const r = heroParts().button.getBoundingClientRect();
  const ox = r.left + r.width / 2;
  const oy = r.top + r.height * 0.72;
  for (let i = 0; i < 16; i++) {
    const bit = document.createElement("span");
    const pumpkin = i % 3 === 0;
    bit.className = pumpkin ? "bit pumpkin-bit" : "bit spark";
    if (pumpkin) bit.innerHTML = PUMPKIN; // static markup, no data
    bit.style.left = `${ox}px`;
    bit.style.top = `${oy}px`;
    document.body.append(bit);
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
    const speed = 160 + Math.random() * 220;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;
    const g = 900;
    const T = 0.9 + Math.random() * 0.5;
    const frames = [];
    for (let k = 0; k <= 10; k++) {
      const s = (k / 10) * T;
      frames.push({
        transform: `translate(${vx * s}px, ${vy * s + 0.5 * g * s * s}px) rotate(${(vx / 4) * s}deg) scale(${1 - (k / 10) * 0.4})`,
        opacity: k < 7 ? 1 : 1 - (k - 6) / 4,
      });
    }
    bit.animate(frames, { duration: T * 1000, easing: "linear" }).finished.then(() => bit.remove());
  }
}

// ------------------------------------------------------------ navigation

async function openShelf(mode = "strip") {
  if (later(() => openShelf(mode))) return;
  if (!state.checkins.length) return;
  if (state.view !== "hero") return switchShelf(mode);
  state.busy = true;
  // The words and buttons leave while the pictures the strip shows first are decoded,
  // so the picture is never the only thing that changes in one frame.
  const place = placePart();
  const leaving = fadeOut([...els.caption.children].filter((n) => n !== place).concat([...els.stage.querySelectorAll(".row")]));
  await Promise.all([ensureLoaded(nearbyUrls(state.index, isNight()), 500), leaving.done]);
  const flyingName = !reduced() && place ? textClone(place) : null;

  // ---- one synchronous swap: no frame is painted between these lines ----
  els.shelf.classList.remove("warming");
  const from = visibleHeroImage().getBoundingClientRect();
  state.view = mode;
  state.returnTo = "hero";
  els.stage.hidden = true;
  els.shelf.hidden = false;
  render();
  leaving.reset();
  const landing = mode === "strip" ? homeCell(state.index) : els.grid.querySelector(`[data-cell="${state.index}"]`);
  centerCell(landing);
  applyDepth();
  const target = landing?.querySelector("img");
  const landingName = landing?.querySelector(".name");
  if (flyingName && landingName) {
    landingName.style.opacity = "0";
    flyText(flyingName, landingName).then(() => (landingName.style.opacity = ""));
  } else flyingName?.copy.remove();
  if (!reduced() && target) {
    const to = target.getBoundingClientRect();
    target.style.visibility = "hidden";
    const cells = [...els.grid.children];
    const at = cells.indexOf(landing);
    cells.forEach((cell, k) => {
      const gap = Math.abs(k - at);
      if (mode === "strip" && gap > 5) return; // off screen
      const side = Math.sign(k - at);
      if (cell === landing) {
        cell.querySelector(".when")?.animate([{ opacity: 0, transform: "translate3d(0, 6px, 0)" }, { opacity: 1, transform: "none" }], { duration: 420, delay: 160, easing: "cubic-bezier(.22,1,.36,1)", fill: "backwards" });
        return;
      }
      const frames =
        cell === landing
          ? [{ opacity: 0 }, { opacity: 1 }]
          : mode === "strip"
            ? [{ opacity: 0, translate: `${side * 60}px 0` }, { opacity: 1, translate: "0 0" }]
            : [{ opacity: 0, transform: "translateY(18px) scale(.96)" }, { opacity: 1, transform: "none" }];
      cell.animate(frames, { duration: 520, delay: 60 + gap * 45, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" });
    });
    await flyClone(target, from, to, { onLand: () => (target.style.visibility = "") });
  }
  focusIfKeyboard(landing?.querySelector("button"));
  settle();
}

// Strip ↔ grid without going back to the big picture.
async function switchShelf(mode) {
  if (later(() => switchShelf(mode))) return;
  if (mode === state.view) return;
  state.busy = true;
  if (state.view === "strip") {
    const c = nearestCell();
    if (c) state.index = Number(c.dataset.cell);
  }
  if (!reduced()) await els.grid.animate([{ opacity: 1 }, { opacity: 0, transform: "scale(.98)" }], { duration: 160, easing: "ease-in" }).finished;
  state.view = mode;
  render();
  const landing = mode === "strip" ? homeCell(state.index) : els.grid.querySelector(`[data-cell="${state.index}"]`);
  centerCell(landing);
  applyDepth();
  if (!reduced()) {
    [...els.grid.children].forEach((cell, k) =>
      cell.animate([{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }], { duration: 380, delay: Math.min(k, 12) * 30, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" }),
    );
  }
  focusIfKeyboard(landing?.querySelector("button"));
  settle();
}

// Close the strip/grid. A tapped picture is passed in; with nothing passed (empty
// space, Esc) the strip returns to the picture in its middle, the grid to the one
// you came from.
async function closeShelf(index, fromImg) {
  if (later(() => closeShelf(index, fromImg))) return;
  if (state.view === "hero") return;
  state.busy = true;
  let pick = index;
  let source = fromImg;
  if (pick === undefined) {
    if (state.view === "strip") {
      const c = nearestCell();
      pick = Number(c.dataset.cell);
      source = c.querySelector("img");
    } else {
      pick = state.index;
      source = els.grid.querySelector(`[data-cell="${pick}"] img`);
    }
  }
  // The other pictures step back while the big ones are decoded.
  const others = [...els.grid.children].filter((c) => c !== source?.closest(".cell"));
  const leaving = fadeOut(others, 170);
  await Promise.all([ensureLoaded(heroUrls(state.checkins[pick]), 600), leaving.done]);

  const nameNode = source?.closest(".cell")?.querySelector(".name");
  const nameRect = nameNode?.getBoundingClientRect();
  const nameFont = nameNode ? fontPx(nameNode) : 16;
  // ---- one synchronous swap ----
  const from = source?.getBoundingClientRect();
  state.index = pick;
  state.view = "hero";
  els.shelf.hidden = true;
  els.stage.hidden = false;
  heroLi = null;
  centerSlide(homeSlide(pick));
  render();
  pagerFrame();
  leaving.reset();
  els.caption.style.opacity = "";
  els.caption.style.transform = "";
  const img = visibleHeroImage();
  const heroFlip = heroParts().flip;
  if (!reduced() && from) {
    heroFlip.style.visibility = "hidden";
    const place = placePart();
    morphText(place, nameRect, nameFont);
    riseCaption(160, { skip: place });
    els.stage.querySelector(".row")?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, delay: 360, easing: "ease-out", fill: "backwards" });
    await flyClone(img, from, img.getBoundingClientRect(), { onLand: () => (heroFlip.style.visibility = "") });
  }
  focusIfKeyboard(heroParts().button);
  settle();
}

// ------------------------------------------------------------ mouse drag and momentum in the strip
const drag = { active: false, moved: false, startX: 0, startLeft: 0, samples: [] };
function glide(velocity) {
  // Coast with friction, then settle on the nearest picture.
  let v = velocity;
  let last = performance.now();
  const tick = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    v *= Math.pow(0.04, dt); // keeps ~4% of its speed per second
    const before = els.grid.scrollLeft;
    els.grid.scrollLeft -= v * dt;
    const stuck = els.grid.scrollLeft === before;
    if (Math.abs(v) > 40 && !stuck && !drag.active && state.view === "strip") return requestAnimationFrame(tick);
    els.grid.classList.remove("dragging");
    centerCell(nearestCell(), "smooth");
  };
  requestAnimationFrame(tick);
}
function setupShelfScrolling() {
  els.grid.addEventListener("scroll", onGridScroll, { passive: true });
  addEventListener("resize", () => {
    if (state.view === "strip") {
      centerCell(nearestCell());
      applyDepth();
    }
  });
  els.grid.addEventListener("wheel", (e) => {
    if (state.view !== "strip" || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    els.grid.scrollLeft += e.deltaY;
  }, { passive: false });
  els.grid.addEventListener("pointerdown", (e) => {
    if (state.view !== "strip" || e.pointerType !== "mouse" || e.button !== 0) return;
    Object.assign(drag, { active: true, moved: false, startX: e.clientX, startLeft: els.grid.scrollLeft, samples: [[e.timeStamp, e.clientX]] });
  });
  addEventListener("pointermove", (e) => {
    if (!drag.active) return;
    const dx = e.clientX - drag.startX;
    if (Math.abs(dx) > 4 && !drag.moved) {
      drag.moved = true;
      els.grid.classList.add("dragging");
    }
    if (!drag.moved) return;
    els.grid.scrollLeft = drag.startLeft - dx;
    drag.samples.push([e.timeStamp, e.clientX]);
    if (drag.samples.length > 6) drag.samples.shift();
  });
  addEventListener("pointerup", () => {
    if (!drag.active) return;
    drag.active = false;
    if (drag.moved) {
      const [t0, x0] = drag.samples[0];
      const [t1, x1] = drag.samples.at(-1);
      const v = t1 > t0 ? ((x1 - x0) / (t1 - t0)) * 1000 : 0; // px per second
      if (reduced()) {
        els.grid.classList.remove("dragging");
        centerCell(nearestCell());
      } else glide(v);
    }
    // The click that ends a drag must not open a picture.
    setTimeout(() => (drag.moved = false), 0);
  });
}

// ------------------------------------------------------------ the two modes

async function setMode(night, event) {
  const x0 = event?.clientX || els.scheme.getBoundingClientRect().left + els.scheme.offsetWidth / 2;
  const y0 = event?.clientY || els.scheme.getBoundingClientRect().top + els.scheme.offsetHeight / 2;
  // Pictures of the new mode are decoded first, so the switch never shows a gap.
  await ensureLoaded(urlsForMode(night), 900);
  // The night decorations are added after the reveal, so the reveal itself stays light
  // (building them inside the transition made that frame stall); they fade in.
  const decorate = () => mood.set(night, { reducedMotion: reduced(), anchor: els.heroWrap });
  const apply = () => {
    root.dataset.scheme = night ? "dark" : "light";
    if (!night) decorate();
    rerender();
  };
  if (reduced() || !document.startViewTransition) {
    apply();
    return decorate();
  }
  const radius = Math.hypot(Math.max(x0, innerWidth - x0), Math.max(y0, innerHeight - y0));
  const transition = document.startViewTransition(apply);
  transition.finished.finally(() => {
    if (isNight() === night) setTimeout(decorate, 60);
  });
  transition.ready.then(() => {
    root.animate(
      { clipPath: [`circle(0px at ${x0}px ${y0}px)`, `circle(${radius}px at ${x0}px ${y0}px)`] },
      { duration: 700, easing: "cubic-bezier(.2,.7,.1,1)", pseudoElement: "::view-transition-new(root)" },
    );
  }).catch(() => {});
  if (night) setTimeout(burst, 480);
}

async function share() {
  const checkin = current();
  if (!checkin) return;
  const shown = imageFor(checkin, isNight());
  if (!shown) return;
  const name = shareFileName(checkin, shown.theme, shown.lighting);
  try {
    const blob = await loadImageBlob(shown.url);
    const file = new File([blob], name, { type: "image/png" });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: checkin.place?.name ?? checkin.text });
      return;
    }
    const a = el("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    els.share.textContent = t().shared;
    setTimeout(() => (els.share.textContent = t().share), 1600);
  } catch (error) {
    if (error?.name !== "AbortError") console.info("share failed:", error?.message);
  }
}

// ------------------------------------------------------------ boot

const mood = createMood(document.body);


// Top right: show everything at once; press again to go back to where you were.
els.expand.addEventListener("click", () => {
  if (state.view === "grid") return state.returnTo === "strip" ? switchShelf("strip") : closeShelf();
  if (state.view === "strip") {
    state.returnTo = "strip";
    return switchShelf("grid");
  }
  openShelf("grid");
});
// No back button: tap a picture, tap any empty space, or press Esc.
document.addEventListener("click", (e) => {
  if (state.view === "hero" || drag.moved || !(e.target instanceof Element)) return;
  if (e.target.closest(".cell, button, a, .mood-layer")) return;
  closeShelf();
});
els.scheme.addEventListener("click", (e) => {
  const night = !isNight();
  sessionStorage.setItem("hc-scheme", night ? "dark" : "light");
  setMode(night, e);
});
els.share.addEventListener("click", share);
els.lang.addEventListener("click", () => {
  state.lang = state.lang === "en" ? "zh" : "en";
  rerender();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.view !== "hero") closeShelf();
  if (e.target instanceof HTMLElement && e.target.closest("input, textarea")) return;
  const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
  if (!dir) return;
  if (state.view === "hero") {
    e.preventDefault();
    pagerStep(dir);
  }
  else if (state.view === "strip") {
    e.preventDefault();
    stripStep(dir);
  }
});
// The default is Halloween night; the OS colour scheme does not override it.

setupPager();
setupTilt();
setupShelfScrolling();
renderChrome();

// Warm the other pictures quietly, one at a time, after the first screen is up.
function warmUp() {
  const urls = [...urlsForMode(isNight()), ...urlsForMode(!isNight())];
  let i = 0;
  const next = () => {
    if (i >= urls.length) return;
    ensureLoaded([urls[i++]], 4000).then(() => setTimeout(next, 120));
  };
  setTimeout(next, 600);
}

async function boot() {
  els.status.hidden = false;
  els.status.replaceChildren(el("span", { class: "dot-loader", "aria-label": "Loading" }));
  try {
    state.checkins = sortCheckins(await loadCheckins());
  } catch {
    els.status.replaceChildren(document.createTextNode(t().error + " "));
    const retry = el("button", { type: "button", class: "chip" }, t().retry);
    retry.addEventListener("click", boot);
    els.status.append(retry);
    return;
  }
  if (!state.checkins.length) {
    els.status.textContent = t().empty;
    return;
  }
  els.status.hidden = true;
  els.stage.hidden = false;
  buildPager();
  centerSlide(homeSlide(state.index));
  pagerFrame();
  render();
  const first = heroParts();
  await Promise.all([first.day.decode?.(), first.night.decode?.()].map((p) => p?.catch(() => {})));
  if (!reduced()) first.flip.style.opacity = "0";
  root.dataset.ready = "true";
  if (isNight()) mood.set(true, { reducedMotion: reduced(), anchor: els.heroWrap }); // night is the Halloween look
  entrance();
  warmUp();
}
boot();
