const core = require('../mackie-channel-core.js');
const [drive, f, amp] = process.argv.slice(2).map(Number);
const P = { input: 'line', trimOhms: core.trimResistance(drive) };
const fs = 96000, T = 1 / fs;
const A = new core.Circuit(core.stageA(P), T);
const u = new Float64Array([0, 0, 16, -16]); A.settle(u, T);
const names = A.outNames; let prevIt = 0, prevSub = 0;
for (let n = 0; n < fs * 0.004; n++) {
  u[0] = amp * Math.sin(2 * Math.PI * f * n / fs);
  A.step(u);
  const it = A.iters - prevIt, sub = A.substeps - prevSub; prevIt = A.iters; prevSub = A.substeps;
  if (n % 4 === 0 || sub) console.log(n, it, sub ? 'SUB' : '', u[0].toFixed(3), names.slice(0,4).map((k, j) => k + '=' + A.y[j].toFixed(3)).join(' '), 'Ch=' + A.y[6].toFixed(2), 'fails', A.fails);
}
