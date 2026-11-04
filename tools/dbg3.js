const core = require('../mackie-channel-core.js');
const P = { input: 'line', trimOhms: core.trimResistance(1) };
const fs = 96000, T = 1 / fs;
const A = new core.Circuit(core.stageA(P), T);
const u = new Float64Array([0, 0, 16, -16]); A.settle(u, T);
for (let n = 0; n < 10; n++) { u[0] = 0.087 * Math.sin(2 * Math.PI * 1000 * n / fs); A.step(u); }
// now instrument step 10
u[0] = 0.087 * Math.sin(2 * Math.PI * 1000 * 10 / fs);
const orig = A.residual.bind(A); let calls = [];
A.residual = function (f) { const r = orig(f); calls.push(r.toExponential(2)); return r; };
const ok = A._solve(u, 40);
console.log('ok', ok, 'norms', calls.join(' '));
console.log('v', Array.from(A.v).map(x => x.toFixed(4)).join(' '));
console.log('f', Array.from(A.f).map(x => x.toExponential(1)).join(' '));
console.log(A.devs.map(d => d.k + '@' + d.p).join(' '));
// redo with dx printing
{
const B = new core.Circuit(core.stageA(P), T); const uu = new Float64Array([0, 0, 16, -16]); B.settle(uu, T);
for (let n = 0; n < 10; n++) { uu[0] = 0.087 * Math.sin(2 * Math.PI * 1000 * n / fs); B.step(uu); }
uu[0] = 0.087 * Math.sin(2 * Math.PI * 1000 * 10 / fs);
const origS = B.residual.bind(B); let k = 0;
B.residual = function (f) { const r = origS(f); if (k++ < 12) console.log('res', r.toExponential(2), 'v', Array.from(B.v).map(x => x.toFixed(3)).join(' ')); return r; };
B._solve(uu, 4);
}
