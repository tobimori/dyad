import { type Canvas, Color } from "../../canvas.ts";
import { type Frame, Preset } from "../../preset.ts";
import { History } from "./history.ts";

const tau = Math.PI * 2;

const spikes = (name: string, draw: (canvas: Canvas, frame: Frame, history: History) => void) =>
  new Preset({
    name,
    collection: "Spikes",
    bloom: 0,
    create: (canvas) => {
      const history = new History();
      return (frame: Frame) => {
        history.push(frame.audio.spectrum, 0.3 ** (frame.dt * 30));
        canvas.pixels.fill(0);
        draw(canvas, frame, history);
      };
    },
  });

const spikeColor = new Color().set(0.55, 0.6, 0.2);
export const spikesSpike = spikes("spike", (canvas, _frame, history) => {
  const count = 360;
  for (let i = 0; i < count; i++) {
    const t = i / count;
    const r = 0.25 + history.at(0, Math.abs(((t * 4) % 2) - 1) * 0.45) * 0.75;
    const a = t * tau - Math.PI / 2;
    canvas.line(0, 0, Math.cos(a) * r, Math.sin(a) * r, spikeColor.r, spikeColor.g, spikeColor.b);
  }
});

export const spikesAmoeba = spikes("amoeba", (canvas, frame) => {
  const samples = frame.audio.waveform;
  const count = 220;
  let smooth = 0;
  for (let i = 0; i < count; i++) {
    smooth += ((samples[Math.floor((i / count) * samples.length)] ?? 0) - smooth) * 0.1;
    const a = (i / count) * tau;
    const r = 0.6 + smooth * 0.4 * Math.sin((i / count) * Math.PI);
    canvas.point(Math.cos(a) * r, Math.sin(a) * r, 1.2, 1.2, 1.2);
  }
});
