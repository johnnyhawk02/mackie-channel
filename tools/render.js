// node tools/render.js <in.wav> <out.wav> <drive 0..1> [outputDb]
const { MackieChannel } = require('../mackie-channel-core.js');
const { readWav, writeWav } = require('./wav.js');
const [,, inp, out, drive, outDb] = process.argv;
const w = readWav(inp); const t0 = Date.now(); const peaks = [];
const outs = w.chans.map(ch => { const m = new MackieChannel(w.sr, { drive: +drive, outputDb: outDb !== undefined ? +outDb : 0 });
  const tail = Math.ceil(m.info().latencySamples); const x = new Float32Array(ch.length + tail); x.set(ch);
  const y = m.process(x, new Float32Array(x.length)).subarray(tail); peaks.push(m.readPeaks()); return y; });
writeWav(out, w.sr, outs);
const pk = a => 20 * Math.log10(a.reduce((m, v) => Math.max(m, Math.abs(v)), 0));
const rms = a => 10 * Math.log10(a.reduce((s, v) => s + v * v, 0) / a.length);
console.log(`${out}: in pk ${pk(w.chans[0]).toFixed(1)} rms ${rms(w.chans[0]).toFixed(1)} | out pk ${pk(outs[0]).toFixed(1)} rms ${rms(outs[0]).toFixed(1)} dBFS | stage peaks V ${JSON.stringify(peaks[0], (k, v) => typeof v === 'number' ? +v.toFixed(2) : v)} | ${((Date.now() - t0) / 1000 / (w.chans[0].length / w.sr)).toFixed(3)}x RT`);
