// Harmonics of a sine through each colour circuit: node tools/colour-thd.js [freq=110] [dBFS=-12]
const { ColourCircuit } = require('../colour-circuits-core.js');
const f = +(process.argv[2] || 110), lvl = Math.pow(10, +(process.argv[3] || -12) / 20), fs = 48000;
for (const model of ['ts808', 'fuzz', 'tweed']) for (const d of [0, 0.25, 0.5, 0.75, 1]) {
  const m = new ColourCircuit(fs, { model, drive: d, autoLevel: false, oversample: 2 });
  const N = fs, x = new Float32Array(2 * N); for (let i = 0; i < x.length; i++) x[i] = lvl * Math.sin(2 * Math.PI * f * i / fs);
  const y = m.process(x, new Float32Array(x.length)).subarray(N);
  const h = []; for (let k = 1; k <= 7; k++) { let re = 0, im = 0; for (let i = 0; i < N; i++) { const a = 2 * Math.PI * f * k * i / fs; re += y[i] * Math.cos(a); im += y[i] * Math.sin(a); } h.push(2 * Math.hypot(re, im) / N); }
  const g = 20 * Math.log10(h[0] / lvl), rel = h.slice(1).map((v) => (20 * Math.log10(v / h[0])).toFixed(0));
  console.log(`${model} drive ${d.toFixed(2)}: gain ${g.toFixed(1)} dB, h2..h7 ${rel.join(' ')} dB`);
}
