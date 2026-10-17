/** Mono samples around the play position, indexed by absolute frame */
export class SampleRing {
  readonly samples: Float32Array;
  sampleRate = 44100;
  /** Absolute frame of the first sample that the ring holds */
  start = 0;
  /** Absolute frame after the last written sample */
  end = 0;

  constructor(capacity = 1 << 18) {
    this.samples = new Float32Array(capacity);
  }

  /** Drops all samples. The next written sample gets index `frame`, for example after a seek. */
  reset(frame: number, sampleRate: number) {
    this.start = frame;
    this.end = frame;
    this.sampleRate = sampleRate;
  }

  /** Mixes the channels to mono and appends them */
  write(channels: ReadonlyArray<Float32Array>, frames: number) {
    const capacity = this.samples.length;
    const samples = this.samples;
    const scale = 1 / Math.max(1, channels.length);
    for (const [c, channel] of channels.entries()) {
      for (let i = 0; i < frames; i++) {
        const index = (this.end + i) % capacity;
        samples[index] = (c === 0 ? 0 : (samples[index] ?? 0)) + (channel[i] ?? 0) * scale;
      }
    }
    this.end += frames;
    this.start = Math.max(this.start, this.end - capacity);
  }

  /** Copies the samples before `frame` into `out`; missing samples are 0 */
  read(frame: number, out: Float32Array) {
    const capacity = this.samples.length;
    const first = Math.floor(frame) - out.length;
    for (let i = 0; i < out.length; i++) {
      const index = first + i;
      out[i] = index >= this.start && index < this.end ? (this.samples[index % capacity] ?? 0) : 0;
    }
  }
}

// Bass, mid and treble in Hz
const ranges = [
  [30, 250],
  [250, 2500],
  [2500, 12000],
] as const;

/** Audio features of one video frame. `Analyzer` updates the same instance each frame. */
export class AudioFrame {
  /** Smoothed log-frequency levels, 0 to 1 */
  readonly bands: Float32Array;
  /** Held maximum of each band */
  readonly peaks: Float32Array;
  /** Latest samples, normalized to about -1 to 1 */
  readonly waveform: Float32Array;
  /** Bass, mid and treble energy relative to their long average, about 1 on average */
  bass = 1;
  mid = 1;
  treble = 1;
  /** `bass`, `mid` and `treble` with slower attack and release, like Milkdrop `bass_att` */
  bassAtt = 1;
  midAtt = 1;
  trebleAtt = 1;
  /** Mean of the three relative energies */
  volume = 1;
  /** True only in the frame of a detected beat */
  beat = false;
  /** 1 at a beat, then decays to 0 */
  beatPulse = 0;
  /** Number of beats so far */
  beats = 0;

  constructor(bandCount: number, waveformLength: number) {
    this.bands = new Float32Array(bandCount);
    this.peaks = new Float32Array(bandCount);
    this.waveform = new Float32Array(waveformLength);
  }
}

const blockSize = 256;

// Exponential smoothing factor for a time constant, independent of the frame rate
const follow = (dt: number, seconds: number) => 1 - Math.exp(-dt / seconds);

/** Turns the samples at the play position into `AudioFrame` features */
export class Analyzer {
  readonly frame: AudioFrame;
  readonly fftSize: number;
  private readonly window: Float32Array;
  private readonly hann: Float32Array;
  private readonly real: Float32Array;
  private readonly imag: Float32Array;
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private readonly reversed: Uint32Array;
  private readonly power: Float32Array;
  private readonly bandLow: Float32Array;
  private readonly bandHigh: Float32Array;
  private readonly bandTilt: Float32Array;
  private readonly peakAge: Float32Array;
  private readonly peakSpeed: Float32Array;
  private bandSampleRate = 0;
  private level = 1e-4;
  private waveGain = 1;
  private readonly imm = new Float32Array(3);
  private readonly att = new Float32Array(3);
  private readonly long = new Float32Array(3);
  private warm = 0;
  private kickMean = 0;
  private kickVariance = 0;
  private kickArmed = true;
  private lowA = 0;
  private lowB = 0;
  private envelope = 0;
  private lastFrame = 0;
  private blockPeak = 0;
  private blockFill = 0;
  private sinceBeat = 10;

  constructor(fftSize = 2048, bandCount = 64, waveformLength = 512) {
    this.fftSize = fftSize;
    this.frame = new AudioFrame(bandCount, waveformLength);
    this.window = new Float32Array(fftSize);
    this.hann = new Float32Array(fftSize);
    this.real = new Float32Array(fftSize);
    this.imag = new Float32Array(fftSize);
    this.cos = new Float32Array(fftSize / 2);
    this.sin = new Float32Array(fftSize / 2);
    this.reversed = new Uint32Array(fftSize);
    this.power = new Float32Array(fftSize / 2);
    this.bandLow = new Float32Array(bandCount);
    this.bandHigh = new Float32Array(bandCount);
    this.bandTilt = new Float32Array(bandCount);
    this.peakAge = new Float32Array(bandCount);
    this.peakSpeed = new Float32Array(bandCount);

    const bits = Math.log2(fftSize);
    for (let i = 0; i < fftSize; i++) {
      this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));
      let reversed = 0;
      for (let bit = 0; bit < bits; bit++) reversed |= ((i >> bit) & 1) << (bits - 1 - bit);
      this.reversed[i] = reversed;
    }
    for (let i = 0; i < fftSize / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / fftSize);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / fftSize);
    }
  }

  /** Analyzes the samples before `frame` in `ring`. `dt` is the time since the last call. */
  update(ring: SampleRing, frame: number, dt: number) {
    ring.read(frame, this.window);
    if (ring.sampleRate !== this.bandSampleRate) this.layoutBands(ring.sampleRate);
    this.transform();
    this.updateBands(dt);
    this.updateEnergy(this.detectBeat(ring, frame), dt);
    this.updateWaveform(dt);
    return this.frame;
  }

  // Log-spaced band edges in fractional FFT bins; narrow low bands interpolate between bins
  private layoutBands(sampleRate: number) {
    this.bandSampleRate = sampleRate;
    const count = this.bandLow.length;
    const binHz = sampleRate / this.fftSize;
    const low = 30;
    const high = Math.min(16000, sampleRate / 2);
    for (let b = 0; b < count; b++) {
      const from = low * (high / low) ** (b / count);
      const to = low * (high / low) ** ((b + 1) / count);
      this.bandLow[b] = from / binHz;
      this.bandHigh[b] = to / binHz;
      // Music loses about 3 dB per octave; the tilt shows a flat spectrum for pink noise
      this.bandTilt[b] = 3 * Math.log2(Math.sqrt(from * to) / 1000);
    }
  }

  private transform() {
    const n = this.fftSize;
    const real = this.real;
    const imag = this.imag;
    for (let i = 0; i < n; i++) {
      const j = this.reversed[i] ?? 0;
      real[j] = (this.window[i] ?? 0) * (this.hann[i] ?? 0);
      imag[j] = 0;
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step] ?? 0;
          const s = this.sin[k * step] ?? 0;
          const a = start + k;
          const b = a + half;
          const br = real[b] ?? 0;
          const bi = imag[b] ?? 0;
          const tr = br * c - bi * s;
          const ti = br * s + bi * c;
          const ar = real[a] ?? 0;
          const ai = imag[a] ?? 0;
          real[b] = ar - tr;
          imag[b] = ai - ti;
          real[a] = ar + tr;
          imag[a] = ai + ti;
        }
      }
    }
    const scale = 4 / (n * n);
    for (let i = 0; i < n / 2; i++) {
      const r = real[i] ?? 0;
      const m = imag[i] ?? 0;
      this.power[i] = (r * r + m * m) * scale;
    }
  }

  // Mean power between two fractional bins, with linear interpolation inside a bin
  private powerBetween(from: number, to: number) {
    const power = this.power;
    const last = power.length - 1;
    if (to - from < 1) {
      const center = Math.min(last - 1, (from + to) / 2);
      const index = Math.floor(center);
      const frac = center - index;
      return (power[index] ?? 0) * (1 - frac) + (power[index + 1] ?? 0) * frac;
    }
    let sum = 0;
    const first = Math.max(1, Math.round(from));
    const end = Math.min(last, Math.round(to));
    for (let i = first; i < end; i++) sum += power[i] ?? 0;
    return sum / Math.max(1, end - first);
  }

  private updateBands(dt: number) {
    const frame = this.frame;
    const count = frame.bands.length;
    let loudest = 0;
    for (let i = 0; i < this.power.length; i++) loudest = Math.max(loudest, this.power[i] ?? 0);
    // Automatic gain: the reference follows loud parts fast and quiet parts slowly
    const target = Math.max(loudest, 1e-7);
    this.level += (target - this.level) * follow(dt, target > this.level ? 0.3 : 6);
    const reference = 10 * Math.log10(this.level);
    const attack = follow(dt, 0.025);
    const release = follow(dt, 0.18);

    for (let b = 0; b < count; b++) {
      const db =
        10 * Math.log10(this.powerBetween(this.bandLow[b] ?? 0, this.bandHigh[b] ?? 0) + 1e-12);
      const value = Math.min(1, Math.max(0, (db + (this.bandTilt[b] ?? 0) - reference + 54) / 54));
      const current = frame.bands[b] ?? 0;
      const next = current + (value - current) * (value > current ? attack : release);
      frame.bands[b] = next;

      const peak = frame.peaks[b] ?? 0;
      if (next >= peak) {
        frame.peaks[b] = next;
        this.peakAge[b] = 0;
        this.peakSpeed[b] = 0;
      } else {
        const age = (this.peakAge[b] ?? 0) + dt;
        this.peakAge[b] = age;
        if (age > 0.35) {
          const speed = (this.peakSpeed[b] ?? 0) + 2.5 * dt;
          this.peakSpeed[b] = speed;
          frame.peaks[b] = Math.max(next, peak - speed * dt);
        }
      }
    }
  }

  private amplitudeIn(fromHz: number, toHz: number, sampleRate: number) {
    const binHz = sampleRate / this.fftSize;
    const first = Math.max(1, Math.round(fromHz / binHz));
    const end = Math.min(this.power.length, Math.round(toHz / binHz));
    let sum = 0;
    for (let i = first; i < end; i++) sum += Math.sqrt(this.power[i] ?? 0);
    return sum;
  }

  private relative(values: Float32Array, i: number) {
    const long = this.long[i] ?? 0;
    return long > 1e-6 ? Math.min(4, (values[i] ?? 0) / long) : 1;
  }

  // Reads every sample since the last frame and checks for a kick in blocks of 256 samples, so
  // the result does not depend on the frame rate. Returns true if a kick started.
  private detectBeat(ring: SampleRing, frame: number) {
    const rate = ring.sampleRate;
    const end = Math.floor(frame);
    const start = end < this.lastFrame || end - this.lastFrame > rate ? end - 1 : this.lastFrame;
    this.lastFrame = end;
    const smooth = 1 - Math.exp((-2 * Math.PI * 150) / rate);
    const release = Math.exp(-1 / (0.06 * rate));
    const blockDt = blockSize / rate;
    const meanRate = follow(blockDt, 1.2);
    const samples = ring.samples;
    let beat = false;
    for (let index = Math.max(start, ring.start); index < Math.min(end, ring.end); index++) {
      const sample = samples[index % samples.length] ?? 0;
      this.lowA += (sample - this.lowA) * smooth;
      this.lowB += (this.lowA - this.lowB) * smooth;
      this.envelope = Math.max(Math.abs(this.lowB), this.envelope * release);
      this.blockPeak = Math.max(this.blockPeak, this.envelope);
      if (++this.blockFill < blockSize) continue;

      // A kick rises well above its recent mean, and only counts after the level fell back
      const kick = this.blockPeak;
      this.blockPeak = 0;
      this.blockFill = 0;
      const deviation = kick - this.kickMean;
      const std = Math.sqrt(this.kickVariance);
      this.sinceBeat += blockDt;
      if (
        this.kickArmed &&
        deviation > 1.4 * std &&
        kick > this.kickMean * 1.25 &&
        kick > 1e-3 &&
        this.sinceBeat > 0.26
      ) {
        beat = true;
        this.sinceBeat = 0;
        this.kickArmed = false;
      }
      if (deviation < 0.4 * std) this.kickArmed = true;
      this.kickMean += deviation * meanRate;
      this.kickVariance += (deviation * deviation - this.kickVariance) * meanRate;
    }
    return beat;
  }

  // Milkdrop-style relative energies
  private updateEnergy(beat: boolean, dt: number) {
    const sampleRate = this.bandSampleRate;
    const frame = this.frame;
    this.warm = Math.min(1, this.warm + dt / 2);
    const longRate = follow(dt, this.warm < 1 ? 0.5 : 4);
    for (let i = 0; i < 3; i++) {
      const range = ranges[i] ?? ranges[0];
      const value = this.amplitudeIn(range[0], range[1], sampleRate);
      const att = this.att[i] ?? 0;
      this.imm[i] = value;
      this.att[i] = att + (value - att) * follow(dt, value > att ? 0.04 : 0.2);
      const long = this.long[i] ?? 0;
      this.long[i] = long + (value - long) * longRate;
    }
    frame.bass = this.relative(this.imm, 0);
    frame.mid = this.relative(this.imm, 1);
    frame.treble = this.relative(this.imm, 2);
    frame.bassAtt = this.relative(this.att, 0);
    frame.midAtt = this.relative(this.att, 1);
    frame.trebleAtt = this.relative(this.att, 2);
    frame.volume = (frame.bass + frame.mid + frame.treble) / 3;

    frame.beat = beat;
    if (beat) {
      frame.beats++;
      frame.beatPulse = 1;
    } else {
      frame.beatPulse *= Math.exp(-dt / 0.22);
    }
  }

  private updateWaveform(dt: number) {
    const wave = this.frame.waveform;
    const source = this.window;
    const stride = Math.max(1, Math.floor(source.length / (wave.length * 2)));
    const offset = source.length - wave.length * stride;
    let peak = 0;
    for (let i = 0; i < wave.length; i++) {
      const index = offset + i * stride;
      const value = ((source[index] ?? 0) + (source[index + stride - 1] ?? 0)) / 2;
      peak = Math.max(peak, Math.abs(value));
    }
    this.waveGain +=
      (Math.max(peak, 0.02) - this.waveGain) * follow(dt, peak > this.waveGain ? 0.05 : 1.5);
    const gain = 0.9 / this.waveGain;
    for (let i = 0; i < wave.length; i++) {
      const index = offset + i * stride;
      wave[i] = (((source[index] ?? 0) + (source[index + stride - 1] ?? 0)) / 2) * gain;
    }
  }
}
