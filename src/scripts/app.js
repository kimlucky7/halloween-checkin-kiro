// Site behaviour and motion. Reads data only through ./data.js; decides what to
// show only through ../lib/view.js. Record text is always inserted with
// textContent, never parsed as HTML.
import { caption, depthFor, editionsOf, pickVariant, shareFileName, shortDate, sortCheckins, STRINGS } from "../lib/view.js";
import { run, spring } from "../lib/spring.js";
import { loadCheckins, loadImageBlob } from "./data.js";
import { createMood } from "./mood.js";

const root = document.documentElement;
root.dataset.app = "2"; // bump when a cached broken bundle must be bypassed
const $ = (sel) => document.querySelector(sel);
const els = {
  stage: $("[data-stage]"),
  heroButton: $("[data-hero]"),
  tilt: $("[data-tilt]"),
  flip: $("[data-flip]"),
  day: $("[data-img='day']"),
  night: $("[data-img='night']"),
  sheen: $("[data-sheen]"),
  caption: $("[data-caption]"),
  note: $("[data-note]"),
  editions: $("[data-editions]"),
  share: $("[data-share]"),
  expand: $("[data-expand]"),
  expandCount: $("[data-expand-count]"),
  shelf: $("[data-shelf]"),
  grid: $("[data-grid]"),
  back: $("[data-back]"),
  scheme: $("[data-scheme-toggle]"),
  mood: $("[data-mood-toggle]"),
  lang: $("[data-lang-toggle]"),
  status: $("[data-status]"),
  foot: $("[data-foot]"),
};

const state = {
  checkins: [],
  index: 0,
  edition: "normal",
  lang: (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en",
  view: "hero",
  busy: false,
  pending: null,
  returnTo: "hero",
  heading: null,
};

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = () => matchMedia("(hover: hover) and (pointer: fine)").matches;
const lighting = () => (root.dataset.scheme === "dark" ? "night" : "day");
const t = () => STRINGS[state.lang];
const current = () => state.checkins[state.index];
const el = (tag, attrs = {}, text) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
};

// ---------------------------------------------------------------- rendering

function renderChrome() {
  const s = t();
  root.lang = state.lang === "zh" ? "zh-Hans" : "en";
  const night = lighting() === "night";
  els.scheme.textContent = night ? s.toLight : s.toDark;
  els.scheme.setAttribute("aria-label", s.schemeLabel(night));
  els.mood.querySelector("span").textContent = s.mood;
  els.mood.setAttribute("aria-label", s.moodLabel);
  els.lang.textContent = s.lang;
  els.lang.setAttribute("aria-label", s.langLabel);
  els.back.textContent = s.back;
  els.share.textContent = s.share;
  els.foot.textContent = s.footnote;
  els.expand.setAttribute("aria-label", s.all(state.checkins.length));
  els.expand.title = s.all(state.checkins.length);
  els.expandCount.textContent = String(state.checkins.length);
  els.expand.hidden = state.checkins.length < 2;
}

function setPictures(variant, checkin) {
  const s = t();
  els.day.src = variant.day;
  els.night.src = variant.night;
  els.day.alt = lighting() === "day" ? s.alt(variant.theme, "day", checkin.place?.name) : "";
  els.night.alt = lighting() === "night" ? s.alt(variant.theme, "night", checkin.place?.name) : "";
  els.sheen.style.setProperty("--mask", `url("${variant.day}")`);
}

function renderCaption(checkin) {
  els.caption.replaceChildren();
  for (const part of caption(checkin, Date.now(), state.lang)) {
    if (part.kind === "text") els.caption.append(document.createTextNode(part.value));
    else if (part.kind === "place" && part.href) {
      els.caption.append(el("a", { class: "soft", href: part.href, target: "_blank", rel: "noopener noreferrer" }, part.value));
    } else if (part.kind === "time") {
      // Like a timeline: the time opens the row of all places.
      const b = el("button", { type: "button", class: "soft time-button", "aria-label": t().all(state.checkins.length), "data-open-strip": "" });
      b.append(el("time", { datetime: part.datetime, title: part.title }, part.value));
      b.addEventListener("click", () => openShelf("strip"));
      els.caption.append(b);
    } else els.caption.append(el("span", { class: "soft" }, part.value));
  }
}

function renderEditions(checkin) {
  const s = t();
  const have = editionsOf(checkin);
  els.editions.replaceChildren();
  for (const edition of ["normal", "halloween"]) {
    const b = el("button", {
      type: "button",
      class: `chip${have.includes(edition) ? "" : " missing"}`,
      "aria-pressed": String(state.edition === edition),
      "data-edition": edition,
    }, s[edition]);
    b.addEventListener("click", () => chooseEdition(edition));
    els.editions.append(b);
  }
}

function renderHero() {
  const checkin = current();
  if (!checkin) return;
  const { variant, available } = pickVariant(checkin, state.edition);
  setPictures(variant, checkin);
  renderCaption(checkin);
  renderEditions(checkin);
  els.note.textContent = available ? "" : t().noEdition(t()[state.edition]);
}

// Two ways to see every place:
//  - "strip": one row you swipe sideways, oldest on the left and the newest on the
//    right, the picture in the middle shown largest;
//  - "grid": everything at once, newest first.
function shelfOrder() {
  const order = state.checkins.map((_, i) => i);
  return state.view === "strip" ? order.reverse() : order;
}

function renderShelf() {
  els.shelf.dataset.mode = state.view;
  els.grid.replaceChildren();
  for (const i of shelfOrder()) {
    const checkin = state.checkins[i];
    const { variant } = pickVariant(checkin, state.edition);
    const name = checkin.place?.name ?? checkin.text;
    const li = el("li", { class: "cell", "data-cell": String(i) });
    const button = el("button", { type: "button", class: "thumb", "aria-label": t().view(name), "data-index": String(i) });
    button.append(el("img", { src: variant[lighting()], alt: "", width: "360", height: "360", loading: "lazy", decoding: "async" }));
    button.addEventListener("click", () => {
      if (drag.moved) return;
      closeShelf(i);
    });
    li.append(el("p", { class: "when" }, shortDate(checkin.capturedAt ?? checkin.publishedAt, state.lang)), button, el("p", { class: "name" }, name));
    els.grid.append(li);
  }
  els.expand.setAttribute("aria-expanded", String(state.view === "grid"));
}

function render() {
  renderChrome();
  if (state.view === "hero") {
    renderHero();
    els.expand.setAttribute("aria-expanded", "false");
  } else {
    renderShelf();
    updateDepth();
  }
}

// ---------------------------------------------------------------- motion helpers

function flyClone(img, from, to, { duration = 560 } = {}) {
  const clone = img.cloneNode();
  clone.removeAttribute("loading");
  clone.style.cssText = ""; // the source may be hidden while it is being flown to
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
  const anim = clone.animate(
    [
      { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
      { transform: `translate(${dx * 0.35}px, ${dy * 0.35 - 18}px) scale(${(sx + 1) / 2 * 1.04}, ${(sy + 1) / 2 * 1.04})`, offset: 0.55 },
      { transform: "none" },
    ],
    { duration, easing: "cubic-bezier(.2,.8,.2,1)" },
  );
  return anim.finished.then(() => clone.remove(), () => clone.remove());
}

function visibleHeroImage() {
  return lighting() === "night" ? els.night : els.day;
}

async function entrance() {
  if (reduced()) return;
  const y = spring({ from: 36, to: 0, stiffness: 140, damping: 16, precision: 0.3 });
  const sc = spring({ from: 0.9, to: 1, stiffness: 160, damping: 18, precision: 0.002 });
  const op = spring({ from: 0, to: 1, stiffness: 120, damping: 20, precision: 0.01 });
  await run([y, sc, op], ([dy, s, o]) => {
    els.flip.style.transform = `translateY(${dy}px) scale(${s})`;
    els.flip.style.opacity = String(Math.min(1, Math.max(0, o)));
  }).done;
  els.flip.style.transform = "";
  els.flip.style.opacity = "";
  // Caption words rise in one after another.
  [...els.caption.childNodes].forEach((node, i) => {
    if (node.nodeType === 1) node.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 420, delay: 60 + i * 45, easing: "ease-out", fill: "backwards" });
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
    els.tilt.style.transform = `rotateX(${x.toFixed(2)}deg) rotateY(${y.toFixed(2)}deg)`;
    els.sheen.style.setProperty("--mx", `${50 + y * 5}%`);
    els.sheen.style.setProperty("--my", `${50 - x * 5}%`);
    els.sheen.style.opacity = String(Math.min(1, (Math.abs(x) + Math.abs(y)) / 6));
  };
  const kick = () => {
    if (!loop) loop = run([rx, ry], apply);
    loop.done.then(() => (loop = null));
  };
  els.heroButton.addEventListener("pointermove", (e) => {
    if (!finePointer() || reduced() || state.busy) return;
    const r = els.heroButton.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    rx.target = -py * 12;
    ry.target = px * 14;
    kick();
  });
  els.heroButton.addEventListener("pointerleave", () => {
    rx.target = 0;
    ry.target = 0;
    kick();
  });
}

// ---------------------------------------------------------------- interactions

async function chooseEdition(edition) {
  if (edition === state.edition || state.busy) return;
  state.edition = edition;
  if (reduced() || state.view !== "hero") return render();
  state.busy = true;
  // Turn the model like a cardboard cut-out: away, swap the pictures, spring back.
  await els.flip.animate([{ transform: "rotateY(0deg)" }, { transform: "rotateY(90deg)" }], { duration: 200, easing: "cubic-bezier(.5,0,.9,.5)" }).finished;
  render();
  await Promise.all([els.day.decode?.(), els.night.decode?.()].map((p) => p?.catch(() => {})));
  const r = spring({ from: -90, to: 0, stiffness: 180, damping: 15, precision: 0.1 });
  await run([r], ([deg]) => (els.flip.style.transform = `rotateY(${deg}deg)`)).done;
  els.flip.style.transform = "";
  state.busy = false;
}

function step(direction) {
  // Count from where we are heading, so quick repeated presses add up.
  const from = state.pending ?? state.heading ?? state.index;
  return goTo(Math.min(state.checkins.length - 1, Math.max(0, from + direction)));
}

async function goTo(next) {
  if (state.view !== "hero" || next < 0 || next >= state.checkins.length) return;
  if (state.busy) {
    // Remember the latest request and go there as soon as the current move ends.
    state.pending = next;
    return;
  }
  if (next === state.index) return;
  const direction = next > state.index ? 1 : -1;
  state.busy = true;
  state.heading = next;
  if (!reduced()) {
    await els.flip.animate([{ transform: "none", opacity: 1 }, { transform: `translateX(${-direction * 60}px) scale(.94)`, opacity: 0 }], { duration: 180, easing: "ease-in" }).finished;
  }
  state.index = next;
  render();
  if (!reduced()) {
    await Promise.all([els.day.decode?.(), els.night.decode?.()].map((p) => p?.catch(() => {})));
    const x = spring({ from: direction * 60, to: 0, stiffness: 200, damping: 20, precision: 0.3 });
    const o = spring({ from: 0, to: 1, stiffness: 200, damping: 26, precision: 0.01 });
    await run([x, o], ([dx, op]) => {
      els.flip.style.transform = `translateX(${dx}px)`;
      els.flip.style.opacity = String(Math.min(1, op));
    }).done;
    els.flip.style.transform = "";
    els.flip.style.opacity = "";
  }
  state.busy = false;
  state.heading = null;
  if (state.pending !== null && state.pending !== undefined) {
    const pending = state.pending;
    state.pending = null;
    goTo(pending);
  }
}

function centerCell(li, behavior = "instant") {
  if (state.view !== "strip" || !li) return;
  const left = li.offsetLeft + li.offsetWidth / 2 - els.grid.clientWidth / 2;
  els.grid.scrollTo({ left, behavior: reduced() ? "instant" : behavior });
}

// Strip depth: the picture nearest the middle is full size, neighbours shrink and fade.
let depthFrame = 0;
function updateDepth() {
  if (depthFrame) return;
  depthFrame = requestAnimationFrame(() => {
    depthFrame = 0;
    const cells = [...els.grid.children];
    if (state.view !== "strip" || reduced()) {
      cells.forEach((c) => c.style.removeProperty("--depth"));
      return;
    }
    const mid = els.grid.getBoundingClientRect().left + els.grid.clientWidth / 2;
    for (const cell of cells) {
      const r = cell.getBoundingClientRect();
      const { scale, opacity } = depthFor((r.left + r.width / 2 - mid) / r.width);
      cell.style.setProperty("--depth", scale.toFixed(3));
      cell.style.setProperty("--fade", opacity.toFixed(3));
    }
  });
}

async function openShelf(mode = "strip") {
  if (state.busy || !state.checkins.length) return;
  if (state.view !== "hero") return switchShelf(mode);
  state.busy = true;
  state.returnTo = "hero";
  const from = visibleHeroImage().getBoundingClientRect();
  state.view = mode;
  els.stage.hidden = true;
  els.shelf.hidden = false;
  render();
  const landing = els.grid.querySelector(`[data-cell="${state.index}"]`);
  centerCell(landing);
  const target = landing?.querySelector("img");
  if (!reduced() && target) {
    // Measure where the picture will land before anything starts moving.
    const to = target.getBoundingClientRect();
    target.style.visibility = "hidden";
    const order = [...els.grid.children];
    const at = order.indexOf(landing);
    order.forEach((cell, k) => {
      const side = Math.sign(k - at);
      const frames =
        cell === landing
          ? [{ opacity: 0 }, { opacity: 1 }]
          : mode === "strip"
            ? [{ opacity: 0, translate: `${side * 60}px 0` }, { opacity: 1, translate: "0 0" }]
            : [{ opacity: 0, transform: "translateY(18px) scale(.96)" }, { opacity: 1, transform: "none" }];
      cell.animate(frames, { duration: 520, delay: 60 + Math.abs(k - at) * 45, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" });
    });
    await flyClone(target, from, to);
    target.style.visibility = "";
  }
  landing?.querySelector("button")?.focus({ preventScroll: true });
  state.busy = false;
}

// Strip ↔ grid without going back to the big picture.
async function switchShelf(mode) {
  if (mode === state.view) return;
  state.busy = true;
  if (!reduced()) await els.grid.animate([{ opacity: 1 }, { opacity: 0, transform: "scale(.98)" }], { duration: 160, easing: "ease-in" }).finished;
  state.view = mode;
  render();
  const landing = els.grid.querySelector(`[data-cell="${state.index}"]`);
  centerCell(landing);
  if (!reduced()) {
    [...els.grid.children].forEach((cell, k) =>
      cell.animate([{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }], { duration: 380, delay: k * 30, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" }),
    );
  }
  landing?.querySelector("button")?.focus({ preventScroll: true });
  state.busy = false;
}

async function closeShelf(index = state.index) {
  if (state.busy || state.view === "hero") return;
  state.busy = true;
  const thumb = els.grid.querySelector(`[data-cell="${index}"] img`);
  const from = thumb?.getBoundingClientRect();
  state.index = index;
  state.view = "hero";
  els.shelf.hidden = true;
  els.stage.hidden = false;
  render();
  const img = visibleHeroImage();
  if (!reduced() && from) {
    els.flip.style.visibility = "hidden";
    await img.decode?.().catch(() => {});
    await flyClone(img, from, img.getBoundingClientRect(), { duration: 600 });
    els.flip.style.visibility = "";
  }
  els.heroButton.focus({ preventScroll: true });
  state.busy = false;
}

// Sideways scrolling for mouse users: drag with the button held, or use the wheel.
const drag = { active: false, moved: false, startX: 0, startLeft: 0 };
function setupShelfScrolling() {
  els.grid.addEventListener("scroll", updateDepth, { passive: true });
  addEventListener("resize", updateDepth);
  els.grid.addEventListener("wheel", (e) => {
    if (state.view !== "strip" || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    els.grid.scrollLeft += e.deltaY;
  }, { passive: false });
  els.grid.addEventListener("pointerdown", (e) => {
    if (state.view !== "strip" || e.pointerType !== "mouse" || e.button !== 0) return;
    Object.assign(drag, { active: true, moved: false, startX: e.clientX, startLeft: els.grid.scrollLeft });
  });
  addEventListener("pointermove", (e) => {
    if (!drag.active) return;
    const dx = e.clientX - drag.startX;
    if (Math.abs(dx) > 4 && !drag.moved) {
      drag.moved = true;
      els.grid.classList.add("dragging");
    }
    if (drag.moved) els.grid.scrollLeft = drag.startLeft - dx;
  });
  addEventListener("pointerup", () => {
    if (!drag.active) return;
    drag.active = false;
    if (drag.moved) {
      els.grid.classList.remove("dragging");
      // Settle on the nearest picture.
      const mid = els.grid.scrollLeft + els.grid.clientWidth / 2;
      const nearest = [...els.grid.children].reduce((best, c) =>
        Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid) < Math.abs(best.offsetLeft + best.offsetWidth / 2 - mid) ? c : best);
      centerCell(nearest, "smooth");
    }
    // The click that ends a drag must not open a picture.
    setTimeout(() => (drag.moved = false), 0);
  });
}

function stripStep(direction) {
  const cells = [...els.grid.children];
  const mid = els.grid.scrollLeft + els.grid.clientWidth / 2;
  let at = 0;
  cells.forEach((c, k) => {
    if (Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid) < Math.abs(cells[at].offsetLeft + cells[at].offsetWidth / 2 - mid)) at = k;
  });
  const next = cells[Math.min(cells.length - 1, Math.max(0, at + direction))];
  centerCell(next, "smooth");
  next?.querySelector("button")?.focus({ preventScroll: true });
}

function toggleScheme(event) {
  const next = root.dataset.scheme === "dark" ? "light" : "dark";
  const apply = () => {
    root.dataset.scheme = next;
    render();
  };
  if (reduced() || !document.startViewTransition) return apply();
  const r = els.scheme.getBoundingClientRect();
  const x = event?.clientX || r.left + r.width / 2;
  const y = event?.clientY || r.top + r.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const transition = document.startViewTransition(apply);
  transition.ready.then(() => {
    root.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 700, easing: "cubic-bezier(.2,.7,.1,1)", pseudoElement: "::view-transition-new(root)" },
    );
  }).catch(() => {});
}

async function share() {
  const checkin = current();
  if (!checkin) return;
  const { variant } = pickVariant(checkin, state.edition);
  const url = variant[lighting()];
  const name = shareFileName(checkin, variant.theme, lighting());
  try {
    const blob = await loadImageBlob(url);
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

// ---------------------------------------------------------------- boot

const mood = createMood(document.body);

els.heroButton.addEventListener("click", () => openShelf("strip"));
// Top right: show everything at once; press again to go back to where you were.
els.expand.addEventListener("click", () => {
  if (state.view === "grid") return state.returnTo === "strip" ? switchShelf("strip") : closeShelf();
  state.returnTo = state.view;
  openShelf("grid");
});
els.back.addEventListener("click", () => closeShelf());
els.scheme.addEventListener("click", toggleScheme);
els.share.addEventListener("click", share);
els.lang.addEventListener("click", () => {
  state.lang = state.lang === "en" ? "zh" : "en";
  render();
});
els.mood.addEventListener("click", () => {
  const on = mood.toggle({ reducedMotion: reduced() });
  els.mood.setAttribute("aria-pressed", String(on));
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.view !== "hero") closeShelf();
  if (e.target instanceof HTMLElement && e.target.closest("input, textarea")) return;
  const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
  if (!dir) return;
  if (state.view === "hero") step(dir);
  else if (state.view === "strip") {
    e.preventDefault();
    stripStep(dir);
  }
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  if (!sessionStorage.getItem("scheme-chosen")) {
    root.dataset.scheme = e.matches ? "dark" : "light";
    render();
  }
});
els.scheme.addEventListener("click", () => sessionStorage.setItem("scheme-chosen", "1"));

// Swipe left/right on touch screens.
let touchX = null;
els.heroButton.addEventListener("touchstart", (e) => (touchX = e.touches[0].clientX), { passive: true });
els.heroButton.addEventListener("touchend", (e) => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
});

setupTilt();
setupShelfScrolling();
renderChrome();

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
  render();
  await Promise.all([els.day.decode?.(), els.night.decode?.()].map((p) => p?.catch(() => {})));
  if (!reduced()) els.flip.style.opacity = "0";
  root.dataset.ready = "true";
  entrance();
}
boot();
