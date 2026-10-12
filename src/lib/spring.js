// A small damped-spring integrator used for the site's motion (hero entrance,
// tilt, flip). Pure: the caller supplies time steps, so it is testable and
// frame-rate independent.

// `precision` is how close (in the value's own unit) counts as settled:
// about half a pixel for positions, a hundredth for opacity or scale.
export function spring({ stiffness = 170, damping = 26, mass = 1, from = 0, to = 1, velocity = 0, precision = 0.001 } = {}) {
  let x = from;
  let v = velocity;
  let target = to;
  return {
    get value() {
      return x;
    },
    get velocity() {
      return v;
    },
    set target(next) {
      target = next;
    },
    get target() {
      return target;
    },
    /** Advance by dt seconds using sub-steps for stability. */
    step(dt) {
      const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        const force = -stiffness * (x - target) - damping * v;
        v += (force / mass) * h;
        x += v * h;
      }
      return x;
    },
    settled(epsilon = precision) {
      return Math.abs(x - target) < epsilon && Math.abs(v) < epsilon * 10;
    },
    snap() {
      x = target;
      v = 0;
    },
  };
}

/**
 * Drive one or more springs on requestAnimationFrame until they settle.
 * `raf` is injectable for tests. Returns a promise and a cancel function.
 */
export function run(springs, onFrame, { raf = globalThis.requestAnimationFrame, now = () => performance.now() } = {}) {
  let last = now();
  let cancelled = false;
  let resolve;
  const done = new Promise((r) => (resolve = r));
  const tick = () => {
    if (cancelled) return resolve(false);
    const t = now();
    const dt = Math.min(0.05, Math.max(0, (t - last) / 1000));
    last = t;
    for (const s of springs) s.step(dt);
    onFrame(springs.map((s) => s.value));
    if (springs.every((s) => s.settled())) {
      springs.forEach((s) => s.snap());
      onFrame(springs.map((s) => s.value));
      return resolve(true);
    }
    raf(tick);
  };
  raf(tick);
  return { done, cancel: () => (cancelled = true) };
}
