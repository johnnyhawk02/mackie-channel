const core = require('../mackie-channel-core.js');
const P = { input: 'line', trimOhms: core.trimResistance(0.3), loCut: false, hi: .5, low: .5, mid: .5, freqOhms: 50000, faderRatio: 1/3.157 };
const T = 1 / 88200;
const A = new core.Circuit(core.stageA(P), T);
const u = new Float64Array([0, 0, 16, -16]);
let t0 = Date.now(); A.settle(u, T); console.log('settle ms', Date.now() - t0);
A.outNames.forEach((n, k) => console.log(n.padEnd(10), A.y[k].toFixed(4)));
console.log('ports', A.m, 'reactive', A.r, 'N', A.N);
