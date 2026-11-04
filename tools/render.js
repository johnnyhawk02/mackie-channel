// Offline render through the circuit model (mono, as a single channel strip is mono).
// node tools/render.js <in.wav> <out.wav> <drive 0..1> [outputDb=0] [oversample=4]  (AUTOLEVEL=0 turns auto level off)
const { MackieChannel } = require('../mackie-channel-core.js');
const { readWav, writeWav } = require('./wav.js');
const [,, inp, out, drive, outDb = '0', os = '4'] = process.argv;
const w = readWav(inp);
const n = w.chans[0].length, x = new Float32Array(n);
for (let i = 0; i < n; i++) { let s = 0; for (const c of w.chans) s += c[i]; x[i] = s / w.chans.length; }
const m = new MackieChannel(w.sr, { drive: +drive, outputDb: +outDb, oversample: +os, autoLevel: process.env.AUTOLEVEL !== '0' });
const tail = Math.ceil(m.info().latencySamples), xx = new Float32Array(n + tail); xx.set(x);
const t0 = Date.now(); const y = m.process(xx, new Float32Array(n + tail)).subarray(tail); const pk = m.readPeaks();
writeWav(out, w.sr, [y]);
const db = (a) => (20 * Math.log10(a)).toFixed(1);
let p = 0, r = 0, bad = 0; for (const v of y) { if (!isFinite(v)) bad++; p = Math.max(p, Math.abs(v)); r += v * v; }
const inf = m.info();
console.log(`${out}: out peak ${db(p)} dBFS rms ${db(Math.sqrt(r / n))} | stage peaks V pre ${pk.pre.toFixed(1)} diff ${pk.diff.toFixed(1)} eq ${pk.eq.toFixed(1)} fader ${pk.fader.toFixed(1)} | ${((Date.now() - t0) / 1000 / (n / w.sr)).toFixed(2)}x RT, ${inf.avgIterations.toFixed(2)} it, ${inf.substeps} substeps, ${inf.unconverged} unconverged, ${bad} bad`);
