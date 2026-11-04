const core = require('../mackie-channel-core.js');
const P = { input: 'line', trimOhms: core.trimResistance(0.3), loCut: false, hi: .5, low: .5, mid: .5, freqOhms: 50000, faderRatio: 1 / 3.157 };
const fs = 96000, T = 1 / fs;
for (const [name, mk, u0] of [['A', core.stageA, [0, 0, 16, -16]], ['B', core.stageB, [0, 16, -16]], ['C', core.stageC, [0, 16, -16]]]) {
  const c = new core.Circuit(mk(P), T); const u = Float64Array.from(u0); c.settle(u, T);
  const N = 96000; let t0 = process.hrtime.bigint();
  for (let n = 0; n < N; n++) { u[0] = 0.01 * Math.sin(2 * Math.PI * 100 * n / fs); c.step(u); }
  const us = Number(process.hrtime.bigint() - t0) / 1e3 / N;
  console.log(name, 'm', c.m, 'r', c.r, 'q', c.q, 'o', c.y.length, 'us/step', us.toFixed(2), 'it', (c.iters / N).toFixed(2));
}
