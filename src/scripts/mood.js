// Night atmosphere (Halloween): a moon, bats crossing it, little ghosts in the
// spirit of Kiro's ghost mascot (drawn for this project, not the official logo),
// one ghost peeking out from behind the building, a spider on a thread, a cobweb,
// drifting fog and rising embers. Pure decoration: no data, no network, the
// pictures are untouched. Everything is created on enable and removed on disable.
// All markup below is static; nothing from records is ever inserted.

const BAT = `<svg viewBox="0 0 64 32"><g fill="currentColor">
  <path class="wing l" d="M32 14c-4-6-10-9-18-8 3 2 4 4 3 6-3-1-7 0-10 3 4 0 6 1 7 4 3-3 7-4 11-3 2-1 5-1 7-2z"/>
  <path class="wing r" d="M32 14c4-6 10-9 18-8-3 2-4 4-3 6 3-1 7 0 10 3-4 0-6 1-7 4-3-3-7-4-11-3-2-1-5-1-7-2z"/>
  <ellipse cx="32" cy="15" rx="3.4" ry="5.2"/><path d="M29.4 10.6l1-3.2 1.6 2.6 1.6-2.6 1 3.2z"/></g>
  <circle cx="30.8" cy="13.6" r=".9" fill="#ffb35c"/><circle cx="33.2" cy="13.6" r=".9" fill="#ffb35c"/></svg>`;

// A rounded ghost with a wavy hem and big oval eyes. The pupils move (see eyes()).
const GHOST = `<svg viewBox="0 0 64 72">
  <path class="body" d="M32 3C16.5 3 7 15 7 30v33.5c0 2.2 2.5 3.3 4.1 1.8l4.4-4c1.2-1.1 3-1.1 4.2 0l4.8 4.3c1.2 1.1 3 1.1 4.2 0l4.2-3.8c1.2-1.1 3-1.1 4.2 0l4.2 3.8c1.2 1.1 3 1.1 4.2 0l4.8-4.3c1.2-1.1 3-1.1 4.2 0l4.4 4c1.6 1.5 4.1.4 4.1-1.8V30C57 15 47.5 3 32 3z"/>
  <g class="eyes"><ellipse cx="23.5" cy="31" rx="5.2" ry="7.4" fill="#2a1450"/><ellipse cx="40.5" cy="31" rx="5.2" ry="7.4" fill="#2a1450"/>
  <g class="pupils" fill="#fff"><circle cx="25" cy="28.5" r="1.9"/><circle cx="42" cy="28.5" r="1.9"/></g></g>
  <ellipse cx="17" cy="41" rx="3.4" ry="2" fill="#ff8fc7" opacity=".55"/><ellipse cx="47" cy="41" rx="3.4" ry="2" fill="#ff8fc7" opacity=".55"/></svg>`;

const SPIDER = `<svg viewBox="0 0 40 40"><g stroke="#1b1426" stroke-width="2.2" stroke-linecap="round" fill="none">
  <path d="M14 18 5 12M14 21 3 21M14 24 5 31M26 18l9-6M26 21h11M26 24l9 7"/></g>
  <ellipse cx="20" cy="22" rx="7.5" ry="8.5" fill="#1b1426"/><circle cx="20" cy="12.5" r="5" fill="#1b1426"/>
  <circle cx="18.2" cy="12" r="1.3" fill="#ff7a1a"/><circle cx="21.8" cy="12" r="1.3" fill="#ff7a1a"/></svg>`;

const WEB = `<svg viewBox="0 0 160 160"><g fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round">
  <path d="M0 0 160 16M0 0 132 72M0 0 92 116M0 0 46 150M0 0 12 160"/>
  <path d="M34 3.4c-4 5.6-6 9.6-8.3 15.6 6.6-1.9 11.6-3.6 17.4-6.6"/>
  <path d="M70 7c-8 10-12 19-16.3 31 12.4-3.2 21.8-6.6 34.2-13.6"/>
  <path d="M107 10.7c-11 16-17.6 29-23.6 47 18-4.4 33-10 52-20.6"/>
  <path d="M146 14.6c-15 22-24 40-31.5 64"/>
  <path d="M26 19c-7 5.6-12 11-16.6 18.6M53.7 38c-14 10.6-24 21-33 34.4M83.4 57.7c-20 15.4-34.5 31.2-47.4 50.3"/>
  <path d="M9.4 37.6 5 51M20.7 72.4 13 92M36 108 25 130"/></g></svg>`;

const MOON = `<svg viewBox="0 0 120 120"><defs><radialGradient id="mg" cx="40%" cy="38%" r="70%">
  <stop offset="0" stop-color="#fff8e1"/><stop offset=".7" stop-color="#fde7a8"/><stop offset="1" stop-color="#f4c56a"/></radialGradient></defs>
  <circle cx="60" cy="60" r="52" fill="url(#mg)"/>
  <g fill="#e9b85c" opacity=".45"><circle cx="44" cy="46" r="9"/><circle cx="74" cy="72" r="12"/><circle cx="70" cy="38" r="5"/><circle cx="40" cy="78" r="6"/></g></svg>`;

const rand = (a, b) => a + Math.random() * (b - a);

// A wandering path across the viewport; some routes pass in front of the moon.
function flightKeyframes(acrossMoon) {
  const fromLeft = Math.random() < 0.5;
  const y0 = acrossMoon ? rand(9, 18) : rand(8, 60);
  const y1 = y0 + rand(-14, 14);
  const amp = rand(2, 6);
  const waves = rand(3, 5);
  const frames = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const x = fromLeft ? -12 + t * 124 : 112 - t * 124;
    const y = y0 + (y1 - y0) * t + Math.sin(t * Math.PI * waves) * amp;
    const tilt = Math.cos(t * Math.PI * 4) * 9;
    frames.push({ transform: `translate(${x}vw, ${y}vh) rotate(${tilt}deg) scaleX(${fromLeft ? 1 : -1})`, offset: t });
  }
  return frames;
}

// A slow, looping drift for a ghost, with a gentle bob and sway.
function hauntKeyframes(side) {
  const frames = [];
  const x0 = side < 0 ? rand(2, 12) : rand(76, 86);
  const y0 = rand(14, 62);
  const rx = rand(6, 14);
  const ry = rand(4, 9);
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const a = t * Math.PI * 2;
    frames.push({
      transform: `translate(${x0 + Math.cos(a) * rx}vw, ${y0 + Math.sin(a * 2) * ry}vh) rotate(${Math.sin(a) * 7}deg)`,
      opacity: 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(a * 3)),
      offset: t,
    });
  }
  return frames;
}

export function createMood(root) {
  let layer = null;
  let peeker = null;
  let animations = [];
  let timers = [];
  let onPointer = null;

  // Pupils of every ghost look toward the pointer.
  function watch() {
    onPointer = (e) => {
      for (const ghost of document.querySelectorAll(".ghost")) {
        const r = ghost.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height * 0.4);
        const d = Math.hypot(dx, dy) || 1;
        const pupils = ghost.querySelector(".pupils");
        if (pupils) pupils.style.transform = `translate(${((dx / d) * 2.2).toFixed(2)}px, ${((dy / d) * 2.6).toFixed(2)}px)`;
      }
    };
    addEventListener("pointermove", onPointer, { passive: true });
  }

  function ghost(className) {
    const g = document.createElement("div");
    g.className = `ghost ${className}`;
    g.innerHTML = GHOST;
    return g;
  }

  // One ghost rises from behind the building now and then, looks around, sinks back.
  function addPeeker(anchor, reducedMotion) {
    if (!anchor) return;
    peeker = ghost("peeker");
    peeker.setAttribute("aria-hidden", "true");
    anchor.prepend(peeker);
    if (reducedMotion) return;
    const peek = () => {
      if (!peeker) return;
      const side = Math.random() < 0.5 ? -1 : 1;
      peeker.style.setProperty("--side", side);
      const a = peeker.animate(
        [
          { transform: `translate(${side * 28}%, 40%) rotate(${side * 4}deg)`, opacity: 0 },
          { transform: `translate(${side * 34}%, -18%) rotate(${side * -8}deg)`, opacity: 1, offset: 0.25 },
          { transform: `translate(${side * 34}%, -22%) rotate(${side * 6}deg)`, opacity: 1, offset: 0.7 },
          { transform: `translate(${side * 28}%, 40%) rotate(${side * 4}deg)`, opacity: 0 },
        ],
        { duration: 3600, easing: "cubic-bezier(.45,0,.25,1)" },
      );
      animations.push(a);
      timers.push(setTimeout(peek, rand(6500, 11000)));
    };
    timers.push(setTimeout(peek, 1400));
  }

  function enable({ reducedMotion = false, anchor = null } = {}) {
    if (layer) return;
    layer = document.createElement("div");
    layer.className = "mood-layer";
    layer.setAttribute("aria-hidden", "true");
    layer.innerHTML =
      `<div class="moon">${MOON}</div><div class="web">${WEB}</div>` +
      '<div class="fog a"></div><div class="fog b"></div><div class="vignette"></div>';

    const spider = document.createElement("div");
    spider.className = "spider";
    spider.innerHTML = `<span class="thread"></span>${SPIDER}`;
    layer.append(spider);

    for (let i = 0; i < 3; i++) {
      const g = ghost("drifter");
      g.style.setProperty("--size", `${rand(38, 64).toFixed(0)}px`);
      layer.append(g);
      if (!reducedMotion) {
        animations.push(g.animate(hauntKeyframes(i % 2 ? 1 : -1), { duration: rand(18000, 28000), iterations: Infinity, delay: -rand(0, 20000) }));
      } else {
        g.style.transform = `translate(${i % 2 ? rand(76, 86) : rand(2, 12)}vw, ${rand(14, 60)}vh)`;
      }
    }

    if (!reducedMotion) {
      for (let i = 0; i < 9; i++) {
        const bat = document.createElement("div");
        bat.className = "bat";
        bat.innerHTML = BAT;
        const near = i % 3 === 0; // a few large ones fly close
        bat.style.setProperty("--size", `${(near ? rand(56, 78) : rand(30, 48)).toFixed(0)}px`);
        bat.style.setProperty("--flap", `${rand(0.16, 0.28).toFixed(2)}s`);
        layer.append(bat);
        animations.push(
          bat.animate(flightKeyframes(i % 2 === 0), {
            duration: near ? rand(7000, 10000) : rand(10000, 17000),
            delay: rand(0, 7000),
            iterations: Infinity,
            easing: "linear",
            fill: "backwards",
          }),
        );
      }
      for (let i = 0; i < 18; i++) {
        const ember = document.createElement("span");
        ember.className = "ember";
        ember.style.left = `${rand(5, 95).toFixed(1)}%`;
        ember.style.setProperty("--drift", `${rand(-40, 40).toFixed(0)}px`);
        ember.style.animationDuration = `${rand(6, 12).toFixed(1)}s`;
        ember.style.animationDelay = `${(-rand(0, 12)).toFixed(1)}s`;
        layer.append(ember);
      }
    }
    root.append(layer);
    addPeeker(anchor, reducedMotion);
    watch();
    requestAnimationFrame(() => layer?.classList.add("on"));
    document.documentElement.dataset.mood = "on";
  }

  function disable() {
    if (!layer) return;
    const old = layer;
    const oldPeeker = peeker;
    const anims = animations;
    layer = null;
    peeker = null;
    animations = [];
    timers.forEach(clearTimeout);
    timers = [];
    if (onPointer) removeEventListener("pointermove", onPointer);
    onPointer = null;
    delete document.documentElement.dataset.mood;
    old.classList.remove("on");
    oldPeeker?.classList.add("leaving");
    setTimeout(() => {
      anims.forEach((a) => a.cancel());
      old.remove();
      oldPeeker?.remove();
    }, 700);
  }

  return {
    get on() {
      return Boolean(layer);
    },
    set(on, options = {}) {
      if (on) enable(options);
      else disable();
      return Boolean(layer);
    },
  };
}
