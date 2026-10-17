/** Terminal cells: one code point, a foreground and a background RGB color each */
export class CellGrid {
  readonly columns: number;
  readonly rows: number;
  readonly chars: Uint32Array;
  readonly foreground: Uint8Array;
  readonly background: Uint8Array;

  constructor(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
    this.chars = new Uint32Array(columns * rows);
    this.foreground = new Uint8Array(columns * rows * 3);
    this.background = new Uint8Array(columns * rows * 3);
  }
}

// Octant patterns that older blocks already cover; Unicode 16 encodes no octant for them
const existingBlocks = new Map([
  [0, 0x20],
  [1, 0x1cea8],
  [2, 0x1ceab],
  [3, 0x1fb82],
  [5, 0x2598],
  [10, 0x259d],
  [15, 0x2580],
  [20, 0x1fbe6],
  [40, 0x1fbe7],
  [63, 0x1fb85],
  [64, 0x1cea3],
  [80, 0x2596],
  [85, 0x258c],
  [90, 0x259e],
  [95, 0x259b],
  [128, 0x1cea0],
  [160, 0x2597],
  [165, 0x259a],
  [170, 0x2590],
  [175, 0x259c],
  [192, 0x2582],
  [240, 0x2584],
  [245, 0x2599],
  [250, 0x259f],
  [252, 0x2586],
  [255, 0x2588],
]);

// Bit `row * 2 + column` set means the foreground covers that eighth; `BLOCK OCTANT-n` is bit n-1.
// U+1CD00 to U+1CDE5 encode the other patterns in ascending order.
const octantChars = (() => {
  const chars = new Uint32Array(256);
  let next = 0x1cd00;
  for (let pattern = 0; pattern < 256; pattern++) {
    const existing = existingBlocks.get(pattern);
    chars[pattern] = existing ?? next++;
  }
  return chars;
})();

const cellPixels = new Uint8Array(8 * 3);

/**
 * Encodes RGBA pixels as octant cells, 2 by 4 pixels per cell, with the two colors that fit each
 * cell best. The image should be `grid.columns * 2` by `grid.rows * 4` pixels.
 */
export const encodeOctants = (rgba: Uint8Array, width: number, height: number, grid: CellGrid) => {
  const fore = grid.foreground;
  const back = grid.background;
  for (let row = 0; row < grid.rows; row++) {
    for (let column = 0; column < grid.columns; column++) {
      for (let i = 0; i < 8; i++) {
        const x = Math.min(width - 1, column * 2 + (i & 1));
        const y = Math.min(height - 1, row * 4 + (i >> 1));
        const o = (y * width + x) * 4;
        cellPixels[i * 3] = rgba[o] ?? 0;
        cellPixels[i * 3 + 1] = rgba[o + 1] ?? 0;
        cellPixels[i * 3 + 2] = rgba[o + 2] ?? 0;
      }

      // The two most different pixels seed the two colors
      let seedA = 0;
      let seedB = 0;
      let widest = -1;
      for (let a = 0; a < 8; a++) {
        for (let b = a + 1; b < 8; b++) {
          const distance = distanceBetween(a, b);
          if (distance > widest) {
            widest = distance;
            seedA = a;
            seedB = b;
          }
        }
      }

      const cell = row * grid.columns + column;
      if (widest < 300) {
        const r = meanOf(255, 0);
        const g = meanOf(255, 1);
        const b = meanOf(255, 2);
        grid.chars[cell] = 0x20;
        fore[cell * 3] = back[cell * 3] = r;
        fore[cell * 3 + 1] = back[cell * 3 + 1] = g;
        fore[cell * 3 + 2] = back[cell * 3 + 2] = b;
        continue;
      }

      let seeded = 0;
      for (let i = 0; i < 8; i++) {
        if (distanceBetween(i, seedA) < distanceBetween(i, seedB)) seeded |= 1 << i;
      }
      // One k-means step: assign each pixel to the nearer group mean
      const fr = meanOf(seeded, 0);
      const fg = meanOf(seeded, 1);
      const fb = meanOf(seeded, 2);
      const br = meanOf(~seeded & 255, 0);
      const bg = meanOf(~seeded & 255, 1);
      const bb = meanOf(~seeded & 255, 2);
      let pattern = 0;
      for (let i = 0; i < 8; i++) {
        if (distanceTo(i, fr, fg, fb) < distanceTo(i, br, bg, bb)) pattern |= 1 << i;
      }
      grid.chars[cell] = octantChars[pattern] ?? 0x20;
      fore[cell * 3] = meanOf(pattern, 0);
      fore[cell * 3 + 1] = meanOf(pattern, 1);
      fore[cell * 3 + 2] = meanOf(pattern, 2);
      back[cell * 3] = meanOf(~pattern & 255, 0);
      back[cell * 3 + 1] = meanOf(~pattern & 255, 1);
      back[cell * 3 + 2] = meanOf(~pattern & 255, 2);
    }
  }
  return grid;
};

const distanceTo = (i: number, r: number, g: number, b: number) => {
  const dr = (cellPixels[i * 3] ?? 0) - r;
  const dg = (cellPixels[i * 3 + 1] ?? 0) - g;
  const db = (cellPixels[i * 3 + 2] ?? 0) - b;
  // Green weighs most for the eye
  return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
};

const distanceBetween = (a: number, b: number) =>
  distanceTo(b, cellPixels[a * 3] ?? 0, cellPixels[a * 3 + 1] ?? 0, cellPixels[a * 3 + 2] ?? 0);

// Mean of one channel over the pixels whose bits are set in `mask`
const meanOf = (mask: number, channel: number) => {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < 8; i++) {
    if ((mask & (1 << i)) === 0) continue;
    sum += cellPixels[i * 3 + channel] ?? 0;
    count++;
  }
  return count === 0 ? 0 : Math.round(sum / count);
};

/** Encodes RGBA pixels as `▀` cells: the foreground is the top pixel, the background the bottom one */
export const encodeHalfBlocks = (
  rgba: Uint8Array,
  width: number,
  height: number,
  grid: CellGrid,
) => {
  for (let row = 0; row < grid.rows; row++) {
    for (let column = 0; column < grid.columns; column++) {
      const cell = row * grid.columns + column;
      const x = Math.min(width - 1, column);
      const top = (Math.min(height - 1, row * 2) * width + x) * 4;
      const bottom = (Math.min(height - 1, row * 2 + 1) * width + x) * 4;
      grid.chars[cell] = 0x2580;
      grid.foreground[cell * 3] = rgba[top] ?? 0;
      grid.foreground[cell * 3 + 1] = rgba[top + 1] ?? 0;
      grid.foreground[cell * 3 + 2] = rgba[top + 2] ?? 0;
      grid.background[cell * 3] = rgba[bottom] ?? 0;
      grid.background[cell * 3 + 1] = rgba[bottom + 1] ?? 0;
      grid.background[cell * 3 + 2] = rgba[bottom + 2] ?? 0;
    }
  }
  return grid;
};
