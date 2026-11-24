// Quality modes against the reference (4x, the 'high' mode): null residual and speed.
//   node tools/quality.js [config.json]
// Each config is { name, opts } passed to MackieChannel. The residual is the
// difference from the reference, as dB under the reference's RMS and peak.
const { MackieChannel } = require('../mackie-channel-core.js');
const { readWav } = require('./wav.js');
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..', 'samples');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.wav'));
const drives = (process.env.DRIVES || '0,0.15,0.3,0.6,1').split(',').map(Number);
const configs = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2])) : [
  { name: 'high', opts: { quality: 'high' } },
  { name: 'normal', opts: { quality: 'normal' } },
  { name: 'eco', opts: { quality: 'eco' } },
];
const ref = { name: 'reference 4x', opts: { oversample: 4 } };
function render(x, sr, drive, opts) {
  const m = new MackieChannel(sr, Object.assign({ drive }, opts));
  const lat = m.info().latencySamples, tail = Math.ceil(lat);
  const xx = new Float64Array(x.length + tail); xx.set(x);
  const y = new Float64Array(xx.length);
  const t0 = process.hrtime.bigint();
  for (let s = 0; s < xx.length; s += 128) m.process(xx.subarray(s, s + 128), y.subarray(s, s + 128), Math.min(128, xx.length - s));
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  return { y: y.subarray(tail), secs };
}
function fft(re, im) { // in place, radix 2
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const p = i + k, q = p + len / 2, tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr;
      re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } } }
}
// octave-band levels 31.5 Hz .. 16 kHz of the whole signal, dB
function bands(y, sr) {
  let n = 1; while (n < y.length) n <<= 1;
  const re = new Float64Array(n), im = new Float64Array(n); re.set(y); fft(re, im);
  const out = [];
  for (let c = 31.25; c <= 16000; c *= 2) { let e = 0; const lo = Math.floor(c / Math.SQRT2 * n / sr), hi = Math.ceil(c * Math.SQRT2 * n / sr);
    for (let k = lo; k < hi && k < n / 2; k++) e += re[k] * re[k] + im[k] * im[k]; out.push(10 * Math.log10(e + 1e-30)); }
  return out;
}
const db = (v) => (20 * Math.log10(v)).toFixed(1);
const res = {}; let refSecs = 0, audio = 0;
for (const c of configs) res[c.name] = { worstRms: -Infinity, worstPk: -Infinity, secs: 0, rows: [] };
for (const f of files) {
  const w = readWav(path.join(dir, f)), n = w.chans[0].length, x = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (const c of w.chans) s += c[i]; x[i] = s / w.chans.length; }
  for (const d of drives) {
    const R = render(x, w.sr, d, ref.opts); refSecs += R.secs; audio += n / w.sr;
    let rr = 0, rp = 0; for (const v of R.y) { rr += v * v; rp = Math.max(rp, Math.abs(v)); } rr = Math.sqrt(rr / n);
    for (const c of configs) {
      const X = render(x, w.sr, d, c.opts); res[c.name].secs += X.secs;
      const y = X.y;
      let e = 0, ep = 0; for (let i = 64; i < n - 64; i++) { const dd = y[i] - R.y[i]; e += dd * dd; ep = Math.max(ep, Math.abs(dd)); }
      e = Math.sqrt(e / (n - 128));
      const bR = bands(R.y, w.sr), bX = bands(y, w.sr), top = Math.max(...bR);
      let bd = 0; for (let k = 0; k < bR.length; k++) if (bR[k] > top - 50) bd = Math.max(bd, Math.abs(bX[k] - bR[k]));
      const r = res[c.name]; r.worstBand = Math.max(r.worstBand || 0, bd); r.worstRms = Math.max(r.worstRms, 20 * Math.log10(e / rr || 1e-30)); r.worstPk = Math.max(r.worstPk, 20 * Math.log10(ep / rp || 1e-30));
      r.rows.push(`${f.replace('.wav', '').padEnd(16)} drive ${String(d).padEnd(4)} residual ${db(e / rr).padStart(6)} dB rms, ${db(ep / rp).padStart(6)} dB peak, octave bands within ${bd.toFixed(2)} dB`);
    }
  }
}
console.log(`reference 4x: ${(refSecs / audio).toFixed(3)}x realtime`);
for (const c of configs) {
  const r = res[c.name];
  if (process.env.VERBOSE) console.log(r.rows.join('\n'));
  console.log(`${c.name.padEnd(14)} ${(r.secs / audio).toFixed(3)}x realtime (${(refSecs / r.secs).toFixed(2)}x faster)  worst residual ${r.worstRms.toFixed(1)} dB rms, ${r.worstPk.toFixed(1)} dB peak, octave bands within ${r.worstBand.toFixed(2)} dB  ${JSON.stringify(c.opts)}`);
}
