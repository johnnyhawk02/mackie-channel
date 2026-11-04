const core = require('../mackie-channel-core.js');
const P = { input: 'line', trimOhms: core.trimResistance(0.3) };
const T = 1 / 88200;
const A = new core.Circuit(core.stageA(P), T);
const u = new Float64Array([0, 0, 16, -16]);
A.reac.forEach((re) => { re.be = true; });
A.setT(1e-3);
for (let n = 0; n < 30; n++) { const it = A.step(u, 200); if (n % 3 == 0) console.log(n, it, A.outNames.map((k, j) => k + '=' + A.y[j].toFixed(3)).join(' ')); }
