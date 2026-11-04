// gain law, sine response and speed of the circuit model
const { MackieChannel } = require('../mackie-channel-core.js');
const fs = 48000;
function measure(opts, f, ampDbfs, secs = 0.4) {
  const m = new MackieChannel(fs, Object.assign({ autoLevel: false }, opts)); const N = Math.round(fs * secs); const x = new Float32Array(N), amp = Math.pow(10, ampDbfs / 20);
  for (let i = 0; i < N; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / fs);
  const t0 = process.hrtime.bigint(); const y = m.process(x, new Float32Array(N)); const dt = Number(process.hrtime.bigint() - t0) / 1e9;
  const s = y.subarray(Math.round(N / 2)), harm = [];
  for (let h = 1; h <= 9; h++) { let re = 0, im = 0; for (let i = 0; i < s.length; i++) { const w = 2 * Math.PI * f * h * i / fs; re += s[i] * Math.cos(w); im += s[i] * Math.sin(w); } harm.push(2 * Math.hypot(re, im) / s.length); }
  return { gainDb: 20 * Math.log10(harm[0] / amp), thd: Math.sqrt(harm.slice(1).reduce((a, b) => a + b * b, 0)) / harm[0], h2: harm[1] / harm[0], h3: harm[2] / harm[0], rt: dt / secs, info: m.info(), pk: m.readPeaks() };
}
const fmt = (r) => `gain ${r.gainDb.toFixed(2)} dB (theory ${r.info.channelGainDb.toFixed(2)}) THD ${(r.thd * 100).toFixed(3)}% h2 ${(r.h2 * 100).toFixed(3)}% h3 ${(r.h3 * 100).toFixed(3)}% | ${r.rt.toFixed(2)}x RT, ${r.info.avgIterations.toFixed(2)} it/sample`;
for (const d of [0, 0.3, 0.5, 0.7, 1]) console.log(`line drive ${d} 1k -40dBFS:`, fmt(measure({ drive: d }, 1000, -40)));
console.log('line drive 1 40Hz -40dBFS:', fmt(measure({ drive: 1 }, 40, -40, 0.6)));
for (const d of [0.3, 0.5, 0.8]) console.log(`line drive ${d} 100Hz -6dBFS:`, fmt(measure({ drive: d }, 100, -6)));
console.log('mic drive 0.5 1k -50dBFS:', fmt(measure({ drive: 0.5, input: 'mic' }, 1000, -50)));
console.log('locut drive .3 75Hz -40:', fmt(measure({ drive: 0.3, loCut: true }, 75, -40, 0.6)));
