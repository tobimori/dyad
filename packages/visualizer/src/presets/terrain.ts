import { Color } from "../canvas.ts";
import { type Frame, Preset } from "../preset.ts";

const rows = 36;
const columns = 48;

/**
 * The spectrum history as a mountain range under a striped sun. The newest spectrum is the front
 * ridge; older ones move to the horizon. Bass is at the sides and treble forms the valley.
 */
export const terrain = new Preset({
  name: "Terrain",
  bloom: 0.8,
  create: (canvas, random) => {
    const history = new Float32Array(rows * columns);
    const roughness = Float32Array.from({ length: rows * columns }, () => random.next());
    const horizon = new Float32Array(canvas.width);
    const screenX = new Float32Array(columns);
    const screenY = new Float32Array(columns);
    const nearerY = new Float32Array(columns);
    const heights = new Float32Array(columns);
    const ridge = new Color();
    const fill = new Color();
    const top = new Color();
    const bottom = new Color();
    const stars = Float32Array.from({ length: 120 }, () => random.next());
    let newest = 0;
    let scroll = 0;

    // Bass at the edges, treble in the middle
    const profile = (bands: Float32Array, target: Float32Array, offset: number) => {
      for (let c = 0; c < columns; c++) {
        const u = Math.abs((c / (columns - 1)) * 2 - 1);
        const position = (1 - u) * (bands.length - 1) * 0.9;
        const index = Math.floor(position);
        const t = position - index;
        const level = (bands[index] ?? 0) * (1 - t) + (bands[index + 1] ?? 0) * t;
        target[offset + c] = level ** 1.6 * (0.3 + 0.7 * u);
      }
    };

    return (frame: Frame) => {
      const { audio, dt, time, palette } = frame;
      const w = canvas.width;
      const h = canvas.height;
      const pixels = canvas.pixels;
      pixels.fill(0);

      scroll += dt * (9 + 3 * Math.min(2, audio.bassAtt));
      while (scroll >= 1) {
        scroll -= 1;
        newest = (newest + 1) % rows;
        profile(audio.bands, history, newest * columns);
      }

      const horizonY = -0.16;
      const sky = time * 0.01;
      palette.sample(sky + 0.5, top, 0.04);
      palette.sample(sky, bottom, 0.4);
      const horizonPx = Math.round(canvas.py(horizonY));
      for (let py = 0; py < Math.min(h, horizonPx); py++) {
        const t = (py / Math.max(1, horizonPx)) ** 2;
        const r = top.r + (bottom.r - top.r) * t;
        const g = top.g + (bottom.g - top.g) * t;
        const b = top.b + (bottom.b - top.b) * t;
        for (let px = 0; px < w; px++) {
          const o = (py * w + px) * 3;
          pixels[o] = r;
          pixels[o + 1] = g;
          pixels[o + 2] = b;
        }
      }
      for (let s = 0; s + 1 < stars.length; s += 2) {
        const sx = ((stars[s] ?? 0) * 2 - 1) * canvas.aspect;
        const sy = -1 + (stars[s + 1] ?? 0) * (horizonY + 0.6);
        const twinkle = 0.25 + 0.2 * Math.sin(time * 2 + s);
        canvas.point(sx, sy, twinkle, twinkle, twinkle);
      }

      // A striped sun; the gaps grow toward its bottom edge
      const sunY = horizonY - 0.3;
      const sunRadius = 0.32 + 0.02 * audio.bassAtt;
      palette.sample(sky + 0.15, top, 1.2);
      palette.sample(sky + 0.55, bottom, 1.1);
      canvas.glow(0, sunY, sunRadius * 1.6, bottom.r * 0.25, bottom.g * 0.25, bottom.b * 0.25);
      const sunTop = Math.max(0, Math.floor(canvas.py(sunY - sunRadius)));
      const sunBottom = Math.min(horizonPx, Math.ceil(canvas.py(sunY + sunRadius)));
      for (let py = sunTop; py < sunBottom; py++) {
        const y = (py + 0.5 - h / 2) / canvas.scale - sunY;
        const v = (y + sunRadius) / (2 * sunRadius);
        if (v > 0.5 && (v * 9 + time * 0.6) % 1 < (v - 0.5) * 1.4) continue;
        const half = Math.sqrt(Math.max(0, sunRadius * sunRadius - y * y)) * canvas.scale;
        const x0 = Math.max(0, Math.ceil(w / 2 - half));
        const x1 = Math.min(w - 1, Math.floor(w / 2 + half));
        const r = top.r + (bottom.r - top.r) * v;
        const g = top.g + (bottom.g - top.g) * v;
        const b = top.b + (bottom.b - top.b) * v;
        for (let px = x0; px <= x1; px++) {
          const o = (py * w + px) * 3;
          pixels[o] = r;
          pixels[o + 1] = g;
          pixels[o + 2] = b;
        }
      }

      // Front to back with a floating horizon, so near ridges hide the ones behind them
      horizon.fill(h);
      profile(audio.bands, heights, 0);
      const eye = 0.42;
      const near = 0.26;
      const spacing = 0.26;
      for (let k = 0; k < rows; k++) {
        const depth = near + (k + scroll) * spacing;
        const row = (newest - k + rows) % rows;
        const distance = (k + scroll) / rows;
        const fog = (1 - distance) ** 1.4 * Math.min(1, (rows - k - scroll) / 3);
        if (fog <= 0) continue;
        const halfWidth = (1.9 * canvas.aspect * 0.62) / depth ** 0.18;
        nearerY.set(screenY);
        for (let c = 0; c < columns; c++) {
          const level = k === 0 ? (heights[c] ?? 0) : (history[row * columns + c] ?? 0);
          const rough = 0.03 * (roughness[row * columns + c] ?? 0);
          const height = level * 0.7 + rough * (0.4 + level);
          screenX[c] = canvas.px(((c / (columns - 1)) * 2 - 1) * halfWidth);
          screenY[c] = canvas.py(horizonY + (eye - height) / depth);
        }
        const pulse = k < 6 ? 1 + 0.5 * audio.beatPulse * (1 - k / 6) : 1;
        palette.sample(sky + 0.1 + distance * 0.5, ridge, 1.8 * fog * pulse);
        palette.sample(sky + 0.6 + distance * 0.3, fill, fog * 0.12);
        let previous = Number.NaN;
        for (let c = 0; c + 1 < columns; c++) {
          const ax = screenX[c] ?? 0;
          const bx = screenX[c + 1] ?? 0;
          const ay = screenY[c] ?? 0;
          const by = screenY[c + 1] ?? 0;
          const from = Math.max(0, Math.ceil(ax));
          const to = Math.min(w - 1, Math.floor(bx));
          for (let px = from; px <= to; px++) {
            const t = (px - ax) / Math.max(1e-3, bx - ax);
            const y = ay + (by - ay) * t;
            const limit = horizon[px] ?? h;
            const rise = Number.isNaN(previous) ? y : previous;
            previous = y;
            if (y >= limit) continue;
            const iy = Math.max(0, Math.floor(y));
            const frac = y - Math.floor(y);
            // Grid lines run from each ridge point down to the nearer ridge
            const gridEnd = k > 0 && px === Math.round(ax) ? (nearerY[c] ?? 0) : 0;
            for (let py = iy + 1; py < Math.min(h, limit); py++) {
              const o = (py * w + px) * 3;
              const shade = 1 / (1 + (py - y) * 0.08);
              const grid = py < gridEnd ? 0.5 : 0;
              pixels[o] = fill.r * shade + ridge.r * grid;
              pixels[o + 1] = fill.g * shade + ridge.g * grid;
              pixels[o + 2] = fill.b * shade + ridge.b * grid;
            }
            if (iy < h && y >= 0) {
              const o = (iy * w + px) * 3;
              pixels[o] = (pixels[o] ?? 0) * frac + ridge.r * (1 - frac);
              pixels[o + 1] = (pixels[o + 1] ?? 0) * frac + ridge.g * (1 - frac);
              pixels[o + 2] = (pixels[o + 2] ?? 0) * frac + ridge.b * (1 - frac);
              if (iy + 1 < Math.min(h, limit)) {
                const below = o + w * 3;
                // About 1.5 pixels wide, so the ridge stays visible when scaled down
                const weight = 0.5 + frac * 0.5;
                pixels[below] = (pixels[below] ?? 0) + ridge.r * weight;
                pixels[below + 1] = (pixels[below + 1] ?? 0) + ridge.g * weight;
                pixels[below + 2] = (pixels[below + 2] ?? 0) + ridge.b * weight;
              }
            }
            // Steep slopes get a vertical ridge span, so the line has no gaps
            const spanEnd = Math.min(h, limit, Math.floor(Math.max(rise, y)));
            for (let py = Math.max(0, Math.ceil(Math.min(rise, y))); py < spanEnd; py++) {
              if (py === iy) continue;
              const o = (py * w + px) * 3;
              pixels[o] = ridge.r * 0.8;
              pixels[o + 1] = ridge.g * 0.8;
              pixels[o + 2] = ridge.b * 0.8;
            }
            horizon[px] = y;
          }
        }
      }
    };
  },
});
