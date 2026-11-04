// Drive slew: jump the Drive knob mid-signal and measure the click it makes.
// node tools/slew.js
const { MackieChannel } = require('../mackie-channel-core.js');
const fs = 48000, N = fs, f = 110, amp = Math.pow(10, -50 / 20), jumpAt = 187 * 128;
function highpass(x, fc) {
  const w = 2 * Math.PI * fc / fs, al = Math.sin(w) / Math.SQRT2, c = Math.cos(w), a0 = 1 + al;
  const b0 = (1 + c) / 2 / a0, b1 = -(1 + c) / a0, a1 = -2 * c / a0, a2 = (1 - al) / a0;
  let y = Float64Array.from(x);
  for (let pass = 0; pass < 2; pass++) {
    const o = new Float64Array(y.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) { const v = b0 * y[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = y[i]; y2 = y1; y1 = v; o[i] = v; }
    y = o;
  }
  return y;
}
function run(slewMs, from, to, os = 1) {
  const m = new MackieChannel(fs, { drive: from, driveSlewMs: slewMs, oversample: os, outputDb: -20 });
  const x = new Float32Array(N), y = new Float32Array(N), B = 128;
  for (let i = 0; i < N; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / fs);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i += B) { if (i <= jumpAt && jumpAt < i + B) m.setParams({ drive: to }); m.process(x.subarray(i, i + B), y.subarray(i, i + B)); }
  const rt = Number(process.hrtime.bigint() - t0) / 1e9;
  // click: what a 4th-order 1 kHz high-pass finds in the 50 ms after the move
  // (the 110 Hz tone is ~80 dB down there), in dB under the output's peak
  const hp = highpass(y, 1000);
  let e = 0, p = 0;
  for (let i = jumpAt; i < jumpAt + fs / 20; i++) e = Math.max(e, Math.abs(hp[i]));
  for (let i = 0; i < N; i++) p = Math.max(p, Math.abs(y[i]));
  return { click: 20 * Math.log10(e / p), rt, done: m.driveNow === to };
}
for (const [a, b] of [[0.2, 0.7], [0.7, 0.2], [0, 0.7]]) for (const ms of [0, 3, 10, 30]) {
  const r = run(ms, a, b);
  console.log(`drive ${a} -> ${b}, slew ${String(ms).padStart(3)} ms: click ${r.click.toFixed(1).padStart(6)} dB re signal peak, ${r.rt.toFixed(2)}x RT, reached target ${r.done}`);
}
