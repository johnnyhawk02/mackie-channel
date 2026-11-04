const core = require('../mackie-channel-core.js');
const P = { input: 'line', trimOhms: core.trimResistance(+process.argv[2]) };
const fs = 96000, T = 1 / fs, f = +process.argv[3], amp = +process.argv[4];
const A = new core.Circuit(core.stageA(P), T);
const u = new Float64Array([0, 0, 16, -16]); A.settle(u, T);
const names = A.outNames;
for (let n = 0; n < fs * 0.03; n++) {
  u[0] = amp * Math.sin(2 * Math.PI * f * n / fs);
  const it = A.step(u, 60);
  if (it > 10 || n % 40 === 0) console.log(n, it, u[0].toFixed(3), names.map((k, j) => k + '=' + A.y[j].toFixed(3)).join(' '));
  if (it > 10 && ++global.bad > 8) break;
}
