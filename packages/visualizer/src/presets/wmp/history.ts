const columns = 128;
const historyRows = 64;

/**
 * Recent spectrum frames in linear columns from 0 Hz to Nyquist. As in WMP, the encoder cutoff at
 * about 16 kHz shows as a cliff.
 */
export class History {
  readonly levels = new Float32Array(historyRows * columns);
  head = 0;

  push(spectrum: Float32Array, smoothing: number) {
    const previous = this.head * columns;
    this.head = (this.head + historyRows - 1) % historyRows;
    const row = this.head * columns;
    const per = spectrum.length / columns;
    for (let c = 0; c < columns; c++) {
      let peak = 0;
      for (let b = Math.floor(c * per); b < Math.floor((c + 1) * per); b++) {
        peak = Math.max(peak, spectrum[b] ?? 0);
      }
      const level = Math.min(1, Math.max(0, (peak - 0.18) / 0.62));
      const last = this.levels[previous + c] ?? 0;
      this.levels[row + c] = level + (last - level) * smoothing;
    }
  }

  /** Level of the row `age` frames ago at `u` from 0 (bass) to 1 (Nyquist) */
  at(age: number, u: number) {
    const row = ((this.head + Math.min(historyRows - 1, age)) % historyRows) * columns;
    const x = Math.min(columns - 1.001, Math.max(0, u * (columns - 1)));
    const i = Math.floor(x);
    const a = this.levels[row + i] ?? 0;
    return a + ((this.levels[row + i + 1] ?? 0) - a) * (x - i);
  }
}
