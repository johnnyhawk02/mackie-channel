const core = require('../mackie-channel-core.js');
const P = { input: 'line', trimOhms: core.trimResistance(0), loCut: false, hi: .5, low: .5, mid: .5, freqOhms: 50000, faderRatio: 1 / 3.157 };
const fs = 96000, T = 1 / fs;
for (const [name, mk, u0] of [['A', core.stageA, [0, 0, 16, -16]], ['B', core.stageB, [0, 16, -16]], ['C', core.stageC, [0, 16, -16]]]) {
  const c = new core.Circuit(mk(P), T); const u = Float64Array.from(u0); c.settle(u, T);
  const o = c.outNames.length - 1; const N = 9600, f = 1000, amp = +(process.env.AMP || 0.01); const y = [];
  for (let n = 0; n < N; n++) { u[0] = amp * Math.sin(2 * Math.PI * f * n / fs); c.step(u); y.push(c.y[name === 'A' ? 2 : o]); }
  const s = y.slice(N / 2).map((v, i, a) => v * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / a.length))); const h = [1, 2, 3].map(k => { let re = 0, im = 0; s.forEach((v, i) => { re += v * Math.cos(2 * Math.PI * f * k * i / fs); im += v * Math.sin(2 * Math.PI * f * k * i / fs); }); return 2 * Math.hypot(re, im) / s.length; });
  console.log(name, c.outNames, 'gain', (h[0] / amp).toFixed(4), 'h2', (h[1] / h[0]).toExponential(2), 'its/step', (c.iters / N).toFixed(2), 'subs', c.substeps, 'fails', c.fails, 'dc', s.reduce((a, b) => a + b, 0) / s.length);
}
