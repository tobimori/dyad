/**
 * Motion of the feedback image for one frame, like Milkdrop per-frame variables. Values are per
 * 1/30 s; `Canvas.warp` scales them to the real frame time.
 */
export class Motion {
  /** Above 1 moves the image out from the center */
  zoom = 1;
  /** Radians */
  rot = 0;
  /** Extra rotation that is strongest at the center and 0 at radius 1 */
  swirl = 0;
  cx = 0;
  cy = 0;
  dx = 0;
  dy = 0;
  /** Horizontal and vertical stretch */
  sx = 1;
  sy = 1;
  /** Strength of the organic Milkdrop warp */
  warp = 0;
  warpSpeed = 1;
  warpScale = 1;
  /** Brightness that is kept per 1/30 s */
  decay = 0.95;

  reset() {
    this.zoom = 1;
    this.rot = 0;
    this.swirl = 0;
    this.cx = 0;
    this.cy = 0;
    this.dx = 0;
    this.dy = 0;
    this.sx = 1;
    this.sy = 1;
    this.warp = 0;
    this.warpSpeed = 1;
    this.warpScale = 1;
    this.decay = 0.95;
    return this;
  }

  copy(from: Motion) {
    this.zoom = from.zoom;
    this.rot = from.rot;
    this.swirl = from.swirl;
    this.cx = from.cx;
    this.cy = from.cy;
    this.dx = from.dx;
    this.dy = from.dy;
    this.sx = from.sx;
    this.sy = from.sy;
    this.warp = from.warp;
    this.warpSpeed = from.warpSpeed;
    this.warpScale = from.warpScale;
    this.decay = from.decay;
  }
}

const glowSteps = 256;
// Gaussian falloff of a glow sprite, indexed by squared distance / radius² over 0 to 4
const glowCurve = Float32Array.from({ length: glowSteps + 1 }, (_, i) => {
  const t = (i / glowSteps) * 4;
  return Math.max(0, Math.exp(-t * 2.2) - Math.exp(-8.8));
});

/**
 * A float RGB image with a feedback buffer. Coordinates are normalized: `y` is -1 at the top and 1
 * at the bottom, `x` is -`aspect` at the left and `aspect` at the right.
 */
export class Canvas {
  readonly width: number;
  readonly height: number;
  readonly aspect: number;
  /** Pixels per normalized unit */
  readonly scale: number;
  /** Height / 360. Thin lines and points scale their light by it, so all sizes look the same. */
  readonly detail: number;
  /** The image of this frame, 3 floats per pixel */
  pixels: Float32Array;
  private previous: Float32Array;
  private readonly gridWidth: number;
  private readonly gridHeight: number;
  private readonly meshX: Float32Array;
  private readonly meshY: Float32Array;
  private readonly rowX: Float32Array;
  private readonly rowY: Float32Array;
  private readonly vertex = new Motion();
  readonly bloomWidth: number;
  readonly bloomHeight: number;
  /** Blurred bright parts at a quarter of the size */
  readonly bloom: Float32Array;
  private readonly bloomTemp: Float32Array;
  /**
   * Makes the canvas a palette image: the red channel from 0 to 1 selects one of 256 sRGB colors.
   * The visualizer shows them as they are, without tone map and bloom.
   */
  ramp: Float32Array | undefined;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.aspect = width / height;
    this.scale = height / 2;
    this.detail = height / 360;
    this.pixels = new Float32Array(width * height * 3);
    this.previous = new Float32Array(width * height * 3);
    this.gridWidth = Math.max(4, Math.min(48, Math.round(width / 8)));
    this.gridHeight = Math.max(4, Math.round(this.gridWidth / this.aspect));
    const vertices = (this.gridWidth + 1) * (this.gridHeight + 1);
    this.meshX = new Float32Array(vertices);
    this.meshY = new Float32Array(vertices);
    this.rowX = new Float32Array(this.gridWidth + 1);
    this.rowY = new Float32Array(this.gridWidth + 1);
    this.bloomWidth = Math.max(1, Math.ceil(width / 4));
    this.bloomHeight = Math.max(1, Math.ceil(height / 4));
    this.bloom = new Float32Array(this.bloomWidth * this.bloomHeight * 3);
    this.bloomTemp = new Float32Array(this.bloomWidth * this.bloomHeight * 3);
  }

  px(x: number) {
    return x * this.scale + this.width / 2;
  }

  py(y: number) {
    return y * this.scale + this.height / 2;
  }

  clear() {
    this.pixels.fill(0);
    this.previous.fill(0);
  }

  /**
   * Starts a frame: moves the last image by `motion` into `pixels` with bilinear sampling and decay.
   * `perVertex` can change the motion at each point of a coarse mesh, like Milkdrop per-vertex code.
   */
  warp(
    motion: Motion,
    time: number,
    dt: number,
    perVertex?: (motion: Motion, x: number, y: number, radius: number, angle: number) => void,
  ) {
    const swap = this.previous;
    this.previous = this.pixels;
    this.pixels = swap;

    const steps = Math.min(4, dt * 30);
    const gw = this.gridWidth;
    const gh = this.gridHeight;
    const w = this.width;
    const h = this.height;
    const halfW = (w - 1) / 2;
    const halfH = (h - 1) / 2;
    const scale = this.scale;
    const f0 = 11.68 + 4 * Math.cos(time * 1.413 + 10);
    const f1 = 8.77 + 3 * Math.cos(time * 1.113 + 7);
    const f2 = 10.54 + 3 * Math.cos(time * 1.233 + 3);
    const f3 = 11.49 + 4 * Math.cos(time * 0.933 + 5);
    const vertex = this.vertex;

    for (let j = 0; j <= gh; j++) {
      for (let i = 0; i <= gw; i++) {
        const pxX = (i / gw) * (w - 1);
        const pxY = (j / gh) * (h - 1);
        const x = (pxX - halfW) / scale;
        const y = (pxY - halfH) / scale;
        vertex.copy(motion);
        const radius = Math.sqrt(x * x + y * y);
        if (perVertex !== undefined) perVertex(vertex, x, y, radius, Math.atan2(y, x));

        const ux = (x - vertex.cx) / (vertex.zoom * vertex.sx);
        const uy = (y - vertex.cy) / (vertex.zoom * vertex.sy);
        const angle = vertex.rot + vertex.swirl * Math.max(0, 1 - radius);
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        let sx = vertex.cx + ux * c - uy * s - vertex.dx;
        let sy = vertex.cy + ux * s + uy * c - vertex.dy;
        if (vertex.warp !== 0) {
          const t = time * vertex.warpSpeed;
          const k = 1 / vertex.warpScale;
          const a = vertex.warp * 0.007;
          sx += a * Math.sin(t * 0.333 + k * (x * f0 - y * f3));
          sy += a * Math.cos(t * 0.375 - k * (x * f2 + y * f1));
          sx += a * Math.cos(t * 0.753 - k * (x * f1 - y * f2));
          sy += a * Math.sin(t * 0.825 + k * (x * f0 + y * f3));
        }
        const index = j * (gw + 1) + i;
        this.meshX[index] = pxX + (sx - x) * scale * steps;
        this.meshY[index] = pxY + (sy - y) * scale * steps;
      }
    }

    const decay = Math.pow(Math.min(1, Math.max(0, motion.decay)), steps);
    // A small subtraction clears faint residue to exact 0: it keeps black black, compresses
    // better and avoids slow subnormal floats
    const floor = 0.0015 * steps;
    const source = this.previous;
    const target = this.pixels;
    const rowX = this.rowX;
    const rowY = this.rowY;
    const maxX = w - 1.001;
    const maxY = h - 1.001;
    const stride = w * 3;
    const cellWidth = (w - 1) / gw;

    for (let py = 0; py < h; py++) {
      const gy = h > 1 ? (py / (h - 1)) * gh : 0;
      const j = Math.min(gh - 1, Math.floor(gy));
      const fy = gy - j;
      for (let i = 0; i <= gw; i++) {
        const top = j * (gw + 1) + i;
        const bottom = top + gw + 1;
        rowX[i] = (this.meshX[top] ?? 0) * (1 - fy) + (this.meshX[bottom] ?? 0) * fy;
        rowY[i] = (this.meshY[top] ?? 0) * (1 - fy) + (this.meshY[bottom] ?? 0) * fy;
      }
      let o = py * stride;
      for (let i = 0; i < gw; i++) {
        const from = i === 0 ? 0 : Math.floor(i * cellWidth) + 1;
        const to = i === gw - 1 ? w - 1 : Math.floor((i + 1) * cellWidth);
        const x0 = rowX[i] ?? 0;
        const y0 = rowY[i] ?? 0;
        const stepX = ((rowX[i + 1] ?? 0) - x0) / cellWidth;
        const stepY = ((rowY[i + 1] ?? 0) - y0) / cellWidth;
        let sx = x0 + (from - i * cellWidth) * stepX;
        let sy = y0 + (from - i * cellWidth) * stepY;
        for (let px = from; px <= to; px++) {
          if (sx < -1 || sy < -1 || sx > w || sy > h) {
            target[o] = 0;
            target[o + 1] = 0;
            target[o + 2] = 0;
          } else {
            const cx = Math.min(maxX, Math.max(0, sx));
            const cy = Math.min(maxY, Math.max(0, sy));
            const ix = cx | 0;
            const iy = cy | 0;
            const fx = cx - ix;
            const fy2 = cy - iy;
            const w11 = fx * fy2 * decay;
            const w01 = (1 - fx) * fy2 * decay;
            const w10 = fx * (1 - fy2) * decay;
            const w00 = (1 - fx) * (1 - fy2) * decay;
            const a = (iy * w + ix) * 3;
            const b = a + stride;
            target[o] = Math.max(
              0,
              (source[a] ?? 0) * w00 +
                (source[a + 3] ?? 0) * w10 +
                (source[b] ?? 0) * w01 +
                (source[b + 3] ?? 0) * w11 -
                floor,
            );
            target[o + 1] = Math.max(
              0,
              (source[a + 1] ?? 0) * w00 +
                (source[a + 4] ?? 0) * w10 +
                (source[b + 1] ?? 0) * w01 +
                (source[b + 4] ?? 0) * w11 -
                floor,
            );
            target[o + 2] = Math.max(
              0,
              (source[a + 2] ?? 0) * w00 +
                (source[a + 5] ?? 0) * w10 +
                (source[b + 2] ?? 0) * w01 +
                (source[b + 5] ?? 0) * w11 -
                floor,
            );
          }
          o += 3;
          sx += stepX;
          sy += stepY;
        }
      }
    }
  }

  /** Adds a sub-pixel point. The color is for a 360-line image and scales with the pixel area. */
  point(x: number, y: number, r: number, g: number, b: number) {
    const area = this.detail * this.detail;
    this.splat(
      x * this.scale + this.width / 2 - 0.5,
      y * this.scale + this.height / 2 - 0.5,
      r * area,
      g * area,
      b * area,
    );
  }

  // Adds light to the 4 pixels around a point in pixel coordinates
  private splat(fx: number, fy: number, r: number, g: number, b: number) {
    if (fx < 0 || fy < 0 || fx >= this.width - 1 || fy >= this.height - 1) return;
    const ix = fx | 0;
    const iy = fy | 0;
    const ax = fx - ix;
    const ay = fy - iy;
    const pixels = this.pixels;
    const a = (iy * this.width + ix) * 3;
    const c = a + this.width * 3;
    const w00 = (1 - ax) * (1 - ay);
    const w10 = ax * (1 - ay);
    const w01 = (1 - ax) * ay;
    const w11 = ax * ay;
    pixels[a] = (pixels[a] ?? 0) + r * w00;
    pixels[a + 1] = (pixels[a + 1] ?? 0) + g * w00;
    pixels[a + 2] = (pixels[a + 2] ?? 0) + b * w00;
    pixels[a + 3] = (pixels[a + 3] ?? 0) + r * w10;
    pixels[a + 4] = (pixels[a + 4] ?? 0) + g * w10;
    pixels[a + 5] = (pixels[a + 5] ?? 0) + b * w10;
    pixels[c] = (pixels[c] ?? 0) + r * w01;
    pixels[c + 1] = (pixels[c + 1] ?? 0) + g * w01;
    pixels[c + 2] = (pixels[c + 2] ?? 0) + b * w01;
    pixels[c + 3] = (pixels[c + 3] ?? 0) + r * w11;
    pixels[c + 4] = (pixels[c + 4] ?? 0) + g * w11;
    pixels[c + 5] = (pixels[c + 5] ?? 0) + b * w11;
  }

  /** Adds a soft round light; the color is its center brightness */
  glow(x: number, y: number, radius: number, r: number, g: number, b: number) {
    const rad = radius * this.scale;
    if (rad < 0.7) {
      const area = Math.max(rad * rad * 2, 0.15);
      this.splat(
        x * this.scale + this.width / 2 - 0.5,
        y * this.scale + this.height / 2 - 0.5,
        r * area,
        g * area,
        b * area,
      );
      return;
    }
    const cx = x * this.scale + this.width / 2 - 0.5;
    const cy = y * this.scale + this.height / 2 - 0.5;
    const reach = rad * 2;
    const x0 = Math.max(0, Math.ceil(cx - reach));
    const x1 = Math.min(this.width - 1, Math.floor(cx + reach));
    const y0 = Math.max(0, Math.ceil(cy - reach));
    const y1 = Math.min(this.height - 1, Math.floor(cy + reach));
    const toIndex = glowSteps / (4 * rad * rad);
    const pixels = this.pixels;
    for (let py = y0; py <= y1; py++) {
      const dy = py - cy;
      let o = (py * this.width + x0) * 3;
      for (let px = x0; px <= x1; px++) {
        const dx = px - cx;
        const index = (dx * dx + dy * dy) * toIndex;
        if (index < glowSteps) {
          const weight = glowCurve[index | 0] ?? 0;
          pixels[o] = (pixels[o] ?? 0) + r * weight;
          pixels[o + 1] = (pixels[o + 1] ?? 0) + g * weight;
          pixels[o + 2] = (pixels[o + 2] ?? 0) + b * weight;
        }
        o += 3;
      }
    }
  }

  /**
   * Adds an anti-aliased line about one pixel wide with even brightness along its length. The
   * color is for a 360-line image and scales with the line width on the screen.
   */
  line(x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number) {
    const ax = x0 * this.scale + this.width / 2 - 0.5;
    const ay = y0 * this.scale + this.height / 2 - 0.5;
    const bx = x1 * this.scale + this.width / 2 - 0.5;
    const by = y1 * this.scale + this.height / 2 - 0.5;
    const dx = bx - ax;
    const dy = by - ay;
    const steep = Math.abs(dy) > Math.abs(dx);
    const length = Math.max(Math.abs(dx), Math.abs(dy));
    if (length < 0.5) return this.splat(ax, ay, r * this.detail, g * this.detail, b * this.detail);
    // Steps along the major axis; each step covers the two nearest pixels across the line
    const count = Math.ceil(length);
    const sx = dx / count;
    const sy = dy / count;
    const gain = (Math.sqrt(dx * dx + dy * dy) / count) * this.detail;
    const cr = r * gain;
    const cg = g * gain;
    const cb = b * gain;
    const w = this.width;
    const h = this.height;
    const pixels = this.pixels;
    let x = ax;
    let y = ay;
    for (let step = 0; step <= count; step++) {
      const edge = step === 0 || step === count ? 0.5 : 1;
      if (steep) {
        const iy = Math.round(y);
        const ix = Math.floor(x);
        const f = x - ix;
        if (iy >= 0 && iy < h && ix >= -1 && ix < w) {
          const o = (iy * w + ix) * 3;
          if (ix >= 0) {
            const k = (1 - f) * edge;
            pixels[o] = (pixels[o] ?? 0) + cr * k;
            pixels[o + 1] = (pixels[o + 1] ?? 0) + cg * k;
            pixels[o + 2] = (pixels[o + 2] ?? 0) + cb * k;
          }
          if (ix + 1 < w) {
            const k = f * edge;
            pixels[o + 3] = (pixels[o + 3] ?? 0) + cr * k;
            pixels[o + 4] = (pixels[o + 4] ?? 0) + cg * k;
            pixels[o + 5] = (pixels[o + 5] ?? 0) + cb * k;
          }
        }
      } else {
        const ix = Math.round(x);
        const iy = Math.floor(y);
        const f = y - iy;
        if (ix >= 0 && ix < w && iy >= -1 && iy < h) {
          const o = (iy * w + ix) * 3;
          if (iy >= 0) {
            const k = (1 - f) * edge;
            pixels[o] = (pixels[o] ?? 0) + cr * k;
            pixels[o + 1] = (pixels[o + 1] ?? 0) + cg * k;
            pixels[o + 2] = (pixels[o + 2] ?? 0) + cb * k;
          }
          if (iy + 1 < h) {
            const o2 = o + w * 3;
            const k = f * edge;
            pixels[o2] = (pixels[o2] ?? 0) + cr * k;
            pixels[o2 + 1] = (pixels[o2 + 1] ?? 0) + cg * k;
            pixels[o2 + 2] = (pixels[o2 + 2] ?? 0) + cb * k;
          }
        }
      }
      x += sx;
      y += sy;
    }
  }

  /** Adds a vertical gradient between two colors over the whole image */
  gradient(top: Color, bottom: Color, amount: number) {
    const pixels = this.pixels;
    const w = this.width;
    for (let py = 0; py < this.height; py++) {
      const t = this.height > 1 ? py / (this.height - 1) : 0;
      const r = (top.r + (bottom.r - top.r) * t) * amount;
      const g = (top.g + (bottom.g - top.g) * t) * amount;
      const b = (top.b + (bottom.b - top.b) * t) * amount;
      let o = py * w * 3;
      for (let px = 0; px < w; px++) {
        pixels[o] = (pixels[o] ?? 0) + r;
        pixels[o + 1] = (pixels[o + 1] ?? 0) + g;
        pixels[o + 2] = (pixels[o + 2] ?? 0) + b;
        o += 3;
      }
    }
  }

  /** Builds `bloom` from the parts of `pixels` above `threshold` */
  updateBloom(threshold: number) {
    const bw = this.bloomWidth;
    const bh = this.bloomHeight;
    const w = this.width;
    const h = this.height;
    const pixels = this.pixels;
    const bloom = this.bloom;
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let y = by * 4; y < Math.min(h, by * 4 + 4); y++) {
          let o = (y * w + bx * 4) * 3;
          for (let x = bx * 4; x < Math.min(w, bx * 4 + 4); x++) {
            r += pixels[o] ?? 0;
            g += pixels[o + 1] ?? 0;
            b += pixels[o + 2] ?? 0;
            n++;
            o += 3;
          }
        }
        const o = (by * bw + bx) * 3;
        bloom[o] = Math.max(0, r / n - threshold);
        bloom[o + 1] = Math.max(0, g / n - threshold);
        bloom[o + 2] = Math.max(0, b / n - threshold);
      }
    }
    for (let pass = 0; pass < 2; pass++) {
      blur(bloom, this.bloomTemp, bw, bh, 3, bw * 3);
      blur(this.bloomTemp, bloom, bh, bw, bw * 3, 3);
    }
  }
}

/** A mutable linear RGB color, usually 0 to 1 per channel */
export class Color {
  r = 0;
  g = 0;
  b = 0;

  set(r: number, g: number, b: number) {
    this.r = r;
    this.g = g;
    this.b = b;
    return this;
  }
}

// 9-tap Gaussian along lines of RGB floats; `step` and `lineStep` are float offsets
const kernel = [0.0162, 0.054, 0.1216, 0.1945, 0.227, 0.1945, 0.1216, 0.054, 0.0162] as const;
const blur = (
  source: Float32Array,
  target: Float32Array,
  length: number,
  lines: number,
  step: number,
  lineStep: number,
) => {
  for (let line = 0; line < lines; line++) {
    const base = line * lineStep;
    for (let i = 0; i < length; i++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = -4; k <= 4; k++) {
        const j = Math.min(length - 1, Math.max(0, i + k));
        const weight = kernel[k + 4] ?? 0;
        const o = base + j * step;
        r += (source[o] ?? 0) * weight;
        g += (source[o + 1] ?? 0) * weight;
        b += (source[o + 2] ?? 0) * weight;
      }
      const o = base + i * step;
      target[o] = r;
      target[o + 1] = g;
      target[o + 2] = b;
    }
  }
};
