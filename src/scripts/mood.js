// Halloween mood: bats, drifting fog, rising embers and a candle glow behind the
// building. Pure decoration — no data, no network, nothing about the pictures
// changes. Everything is created on enable and removed on disable.

const BAT = `<svg viewBox="0 0 64 32" aria-hidden="true"><g fill="currentColor">
  <path class="wing l" d="M32 14c-4-6-10-9-18-8 3 2 4 4 3 6-3-1-7 0-10 3 4 0 6 1 7 4 3-3 7-4 11-3 2-1 5-1 7-2z"/>
  <path class="wing r" d="M32 14c4-6 10-9 18-8-3 2-4 4-3 6 3-1 7 0 10 3-4 0-6 1-7 4-3-3-7-4-11-3-2-1-5-1-7-2z"/>
  <ellipse cx="32" cy="15" rx="3.2" ry="5"/><path d="M29.5 10.5l1-3 1.5 2.5 1.5-2.5 1 3z"/></g></svg>`;

const rand = (a, b) => a + Math.random() * (b - a);

function flightKeyframes() {
  // A wandering path across the viewport with a gentle sine bob.
  const fromLeft = Math.random() < 0.5;
  const y0 = rand(8, 55);
  const y1 = y0 + rand(-18, 18);
  const amp = rand(2, 6);
  const frames = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const x = fromLeft ? -12 + t * 124 : 112 - t * 124;
    const y = y0 + (y1 - y0) * t + Math.sin(t * Math.PI * rand(3, 5)) * amp;
    const tilt = Math.cos(t * Math.PI * 4) * 8;
    frames.push({ transform: `translate(${x}vw, ${y}vh) rotate(${tilt}deg) scaleX(${fromLeft ? 1 : -1})`, offset: t });
  }
  return frames;
}

export function createMood(root) {
  let layer = null;
  let animations = [];

  function enable({ reducedMotion }) {
    if (layer) return;
    layer = document.createElement("div");
    layer.className = "mood-layer";
    layer.setAttribute("aria-hidden", "true");
    layer.innerHTML = '<div class="fog a"></div><div class="fog b"></div><div class="vignette"></div>';
    if (!reducedMotion) {
      for (let i = 0; i < 6; i++) {
        const bat = document.createElement("div");
        bat.className = "bat";
        bat.innerHTML = BAT;
        bat.style.setProperty("--size", `${rand(22, 46).toFixed(0)}px`);
        bat.style.setProperty("--flap", `${rand(0.18, 0.32).toFixed(2)}s`);
        layer.append(bat);
        const flight = bat.animate(flightKeyframes(), {
          duration: rand(9000, 17000),
          delay: rand(0, 6000),
          iterations: Infinity,
          easing: "linear",
          fill: "backwards",
        });
        animations.push(flight);
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
    // Fade in on the next frame so the transition runs.
    requestAnimationFrame(() => layer?.classList.add("on"));
    document.documentElement.dataset.mood = "on";
  }

  function disable() {
    if (!layer) return;
    const old = layer;
    const anims = animations;
    layer = null;
    animations = [];
    delete document.documentElement.dataset.mood;
    old.classList.remove("on");
    setTimeout(() => {
      anims.forEach((a) => a.cancel());
      old.remove();
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
