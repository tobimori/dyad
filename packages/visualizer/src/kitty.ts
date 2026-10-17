import { deflateSync } from "node:zlib";

import { Rgb } from "./palette.ts";

// The row and column diacritics of Kitty Unicode placeholders, in number order, from
// https://sw.kovidgoyal.net/kitty/_downloads/f0a0de9ec8d9ff4456206db8e0814937/rowcolumn-diacritics.txt
const diacritics = [
  0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346, 0x034a, 0x034b, 0x034c,
  0x0350, 0x0351, 0x0352, 0x0357, 0x035b, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369,
  0x036a, 0x036b, 0x036c, 0x036d, 0x036e, 0x036f, 0x0483, 0x0484, 0x0485, 0x0486, 0x0487, 0x0592,
  0x0593, 0x0594, 0x0595, 0x0597, 0x0598, 0x0599, 0x059c, 0x059d, 0x059e, 0x059f, 0x05a0, 0x05a1,
  0x05a8, 0x05a9, 0x05ab, 0x05ac, 0x05af, 0x05c4, 0x0610, 0x0611, 0x0612, 0x0613, 0x0614, 0x0615,
  0x0616, 0x0617, 0x0657, 0x0658, 0x0659, 0x065a, 0x065b, 0x065d, 0x065e, 0x06d6, 0x06d7, 0x06d8,
  0x06d9, 0x06da, 0x06db, 0x06dc, 0x06df, 0x06e0, 0x06e1, 0x06e2, 0x06e4, 0x06e7, 0x06e8, 0x06eb,
  0x06ec, 0x0730, 0x0732, 0x0733, 0x0735, 0x0736, 0x073a, 0x073d, 0x073f, 0x0740, 0x0741, 0x0743,
  0x0745, 0x0747, 0x0749, 0x074a, 0x07eb, 0x07ec, 0x07ed, 0x07ee, 0x07ef, 0x07f0, 0x07f1, 0x07f3,
  0x0816, 0x0817, 0x0818, 0x0819, 0x081b, 0x081c, 0x081d, 0x081e, 0x081f, 0x0820, 0x0821, 0x0822,
  0x0823, 0x0825, 0x0826, 0x0827, 0x0829, 0x082a, 0x082b, 0x082c, 0x082d, 0x0951, 0x0953, 0x0954,
  0x0f82, 0x0f83, 0x0f86, 0x0f87, 0x135d, 0x135e, 0x135f, 0x17dd, 0x193a, 0x1a17, 0x1a75, 0x1a76,
  0x1a77, 0x1a78, 0x1a79, 0x1a7a, 0x1a7b, 0x1a7c, 0x1b6b, 0x1b6d, 0x1b6e, 0x1b6f, 0x1b70, 0x1b71,
  0x1b72, 0x1b73, 0x1cd0, 0x1cd1, 0x1cd2, 0x1cda, 0x1cdb, 0x1ce0, 0x1dc0, 0x1dc1, 0x1dc3, 0x1dc4,
  0x1dc5, 0x1dc6, 0x1dc7, 0x1dc8, 0x1dc9, 0x1dcb, 0x1dcc, 0x1dd1, 0x1dd2, 0x1dd3, 0x1dd4, 0x1dd5,
  0x1dd6, 0x1dd7, 0x1dd8, 0x1dd9, 0x1dda, 0x1ddb, 0x1ddc, 0x1ddd, 0x1dde, 0x1ddf, 0x1de0, 0x1de1,
  0x1de2, 0x1de3, 0x1de4, 0x1de5, 0x1de6, 0x1dfe, 0x20d0, 0x20d1, 0x20d4, 0x20d5, 0x20d6, 0x20d7,
  0x20db, 0x20dc, 0x20e1, 0x20e7, 0x20e9, 0x20f0, 0x2cef, 0x2cf0, 0x2cf1, 0x2de0, 0x2de1, 0x2de2,
  0x2de3, 0x2de4, 0x2de5, 0x2de6, 0x2de7, 0x2de8, 0x2de9, 0x2dea, 0x2deb, 0x2dec, 0x2ded, 0x2dee,
  0x2def, 0x2df0, 0x2df1, 0x2df2, 0x2df3, 0x2df4, 0x2df5, 0x2df6, 0x2df7, 0x2df8, 0x2df9, 0x2dfa,
  0x2dfb, 0x2dfc, 0x2dfd, 0x2dfe, 0x2dff, 0xa66f, 0xa67c, 0xa67d, 0xa6f0, 0xa6f1, 0xa8e0, 0xa8e1,
  0xa8e2, 0xa8e3, 0xa8e4, 0xa8e5, 0xa8e6, 0xa8e7, 0xa8e8, 0xa8e9, 0xa8ea, 0xa8eb, 0xa8ec, 0xa8ed,
  0xa8ee, 0xa8ef, 0xa8f0, 0xa8f1, 0xaab0, 0xaab2, 0xaab3, 0xaab7, 0xaab8, 0xaabe, 0xaabf, 0xaac1,
  0xfe20, 0xfe21, 0xfe22, 0xfe23, 0xfe24, 0xfe25, 0xfe26, 0x10a0f, 0x10a38, 0x1d185, 0x1d186,
  0x1d187, 0x1d188, 0x1d189, 0x1d1aa, 0x1d1ab, 0x1d1ac, 0x1d1ad, 0x1d242, 0x1d243, 0x1d244,
];

const placeholder = String.fromCodePoint(0x10eeee);
const base64 = new TextEncoder().encode(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
);
const ascii = new TextEncoder();
const terminator = ascii.encode("\x1b\\");
const nextChunk = ascii.encode("\x1b_Gq=2,");
const more = ascii.encode("m=1;");
const last = ascii.encode("m=0;");
// 4096 base64 characters per chunk, the protocol maximum
const chunkBytes = 3072;

/**
 * One Kitty graphics image that shows through Unicode placeholders. Each `encode` replaces the
 * image and its virtual placement with one command, so the placeholders show the new frame without
 * a blank frame between.
 */
export class KittyImage {
  readonly id: number;
  readonly columns: number;
  readonly rows: number;
  /** Placeholder text for each cell row; draw it with the `foreground` color */
  readonly placeholderRows: ReadonlyArray<string>;
  /** The 24-bit foreground color that holds the image ID */
  readonly foreground: Rgb;
  private rgb = new Uint8Array(0);
  private output = new Uint8Array(0);
  private header = new Uint8Array(0);

  /** `id` is 1 to 0xffffff; `columns` and `rows` are at most 297 */
  constructor(id: number, columns: number, rows: number) {
    this.id = id;
    this.columns = Math.min(columns, diacritics.length);
    this.rows = Math.min(rows, diacritics.length);
    this.foreground = new Rgb({ r: (id >> 16) & 255, g: (id >> 8) & 255, b: id & 255 });
    this.placeholderRows = Array.from({ length: this.rows }, (_, row) => {
      const rowMark = String.fromCodePoint(diacritics[row] ?? 0x0305);
      let text = "";
      for (let column = 0; column < this.columns; column++) {
        text += placeholder + rowMark + String.fromCodePoint(diacritics[column] ?? 0x0305);
      }
      return text;
    });
  }

  /**
   * The escape that transmits `rgba` as compressed RGB in chunks and creates the virtual placement.
   * The result is a view of an internal buffer that the next call overwrites.
   */
  encode(rgba: Uint8Array, width: number, height: number) {
    const pixels = width * height;
    if (this.rgb.length !== pixels * 3) {
      this.rgb = new Uint8Array(pixels * 3);
      this.header = ascii.encode(
        `\x1b_Ga=T,U=1,q=2,C=1,i=${this.id},f=24,s=${width},v=${height},c=${this.columns},r=${this.rows},o=z,`,
      );
    }
    const rgb = this.rgb;
    for (let p = 0; p < pixels; p++) {
      rgb[p * 3] = rgba[p * 4] ?? 0;
      rgb[p * 3 + 1] = rgba[p * 4 + 1] ?? 0;
      rgb[p * 3 + 2] = rgba[p * 4 + 2] ?? 0;
    }
    const data = deflateSync(rgb, { level: 1 });

    const chunks = Math.max(1, Math.ceil(data.length / chunkBytes));
    const size = this.header.length + chunks * (nextChunk.length + 4 + 4096 + terminator.length);
    if (this.output.length < size) this.output = new Uint8Array(size);
    const out = this.output;

    let o = 0;
    for (let chunk = 0; chunk < chunks; chunk++) {
      const header = chunk === 0 ? this.header : nextChunk;
      const flag = chunk + 1 < chunks ? more : last;
      out.set(header, o);
      o += header.length;
      out.set(flag, o);
      o += flag.length;
      const end = Math.min(data.length, (chunk + 1) * chunkBytes);
      for (let i = chunk * chunkBytes; i < end; i += 3) {
        const a = data[i] ?? 0;
        const b = data[i + 1] ?? 0;
        const c = data[i + 2] ?? 0;
        out[o++] = base64[a >> 2] ?? 0;
        out[o++] = base64[((a & 3) << 4) | (b >> 4)] ?? 0;
        out[o++] = i + 1 < end ? (base64[((b & 15) << 2) | (c >> 6)] ?? 0) : 0x3d;
        out[o++] = i + 2 < end ? (base64[c & 63] ?? 0) : 0x3d;
      }
      out.set(terminator, o);
      o += terminator.length;
    }
    return out.subarray(0, o);
  }

  /** The escape that deletes the image and frees its data */
  delete() {
    return `\x1b_Ga=d,d=I,q=2,i=${this.id}\x1b\\`;
  }
}
