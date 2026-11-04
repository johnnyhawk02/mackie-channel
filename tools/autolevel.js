// Measures the auto-level table: K-weighted loudness (BS.1770) of the bundled
// bass samples through the channel at each Drive step, relative to the input.
// node tools/autolevel.js  -> prints the table to paste into the core
const { MackieChannel } = require('../mackie-channel-core.js');
const { readWav } = require('./wav.js');
function kweight(x, fs) { // BS.1770 pre-filter (shelf) + RLB high-pass, bilinear from the analog prototypes
  const biq = (b, a) => { const y = new Float64Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) { const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; } return y; };
  // shelf
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / fs), Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const s1 = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0], s1a = [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  f0 = 38.13547087602444; Q = 0.5003270373238773; K = Math.tan(Math.PI * f0 / fs); a0 = 1 + K / Q + K * K;
  const s2 = [1, -2, 1], s2a = [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  x = biq(s1, s1a); return (x = biq(s2, s2a));
}
const loud = (x, fs) => { const k = kweight(x, fs); let s = 0; for (const v of k) s += v * v; return 10 * Math.log10(s / k.length); };
const names = ['19-bass-6a', 'arabian-sub-6a', 'aura-bass-9b', 'beta-bass-11a'];
const src = names.map((n) => { const w = readWav(require('path').join(__dirname, '../samples', n + '.wav')); return { sr: w.sr, x: Float32Array.from(w.chans[0]) }; });
const steps = 20, table = [];
for (let s = 0; s <= steps; s++) {
  const d = s / steps; let sum = 0;
  for (const { sr, x } of src) {
    const m = new MackieChannel(sr, { drive: d, autoLevel: false });
    const y = m.process(x, new Float32Array(x.length));
    sum += loud(y, sr) - loud(x, sr);
  }
  table.push(+(sum / src.length).toFixed(2));
  console.error(`drive ${d.toFixed(2)}: ${table[s]} dB`);
}
console.log(JSON.stringify(table));
