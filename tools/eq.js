// frequency response of stage B (EQ) for given pot settings
const core = require('../mackie-channel-core.js');
const fs = 96000, T = 1 / fs;
function resp(P, freqs) {
  return freqs.map((f) => {
    const c = new core.Circuit(core.stageB(P), T); const u = new Float64Array([0, 16, -16]); c.settle(u, T);
    const N = Math.max(9600, Math.round(fs * 20 / f)); let re = 0, im = 0, cnt = 0;
    const o = c.outNames.indexOf('post');
    for (let n = 0; n < N; n++) { u[0] = 0.1 * Math.sin(2 * Math.PI * f * n / fs); c.step(u); if (n >= N / 2) { re += c.y[o] * Math.cos(2 * Math.PI * f * n / fs); im += c.y[o] * Math.sin(2 * Math.PI * f * n / fs); cnt++; } }
    return 20 * Math.log10(2 * Math.hypot(re, im) / cnt / 0.1);
  });
}
const freqs = [30, 80, 250, 1000, 2500, 8000, 12000, 18000];
const base = { loCut: false, hi: .5, low: .5, mid: .5, freqOhms: 500000 * 0.1 };
const show = (name, P) => console.log(name.padEnd(22), resp(Object.assign({}, base, P), freqs).map((d) => d.toFixed(1).padStart(6)).join(''));
console.log(' '.repeat(22), freqs.map((f) => String(f).padStart(6)).join(''));
show('flat', {});
show('hi full cw', { hi: 0 }); show('hi full ccw', { hi: 1 });
show('low full cw', { low: 0 }); show('low full ccw', { low: 1 });
show('mid cw, freq mid', { mid: 0 }); show('mid ccw, freq mid', { mid: 1 });
show('mid cw, freq lo', { mid: 0, freqOhms: 500000 }); show('mid cw, freq hi', { mid: 0, freqOhms: 2000 });
show('lo cut', { loCut: true });
