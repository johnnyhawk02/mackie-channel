// JS reference for the null tests: the same steps as ../../tools/render.js,
// but raw float32 out (no 16-bit rounding) and the mono input saved too.
//   node jsrender.js in.wav in.f32 out.f32 <drive> [oversample=4] [block] [drive2 at-sample]
const fs = require('fs');
const { MackieChannel } = require('../../mackie-channel-core.js');
const { readWav } = require('../../tools/wav.js');
const [,, inp, inRaw, outRaw, drive, os = '4', block, drive2, at] = process.argv;
const w = readWav(inp);
const n = w.chans[0].length, x = new Float32Array(n);
for (let i = 0; i < n; i++) { let s = 0; for (const c of w.chans) s += c[i]; x[i] = s / w.chans.length; }
fs.writeFileSync(inRaw, Buffer.from(x.buffer));
// a host parameter is a float, so the drive values are rounded to float32 the way the plugin sees them
const m = new MackieChannel(w.sr, { drive: Math.fround(+drive), oversample: +os });
const tail = Math.ceil(m.info().latencySamples), xx = new Float32Array(n + tail), yy = new Float32Array(n + tail); xx.set(x);
const B = block ? +block : xx.length;
for (let s = 0; s < xx.length; s += B) {
  if (at !== undefined && s >= +at) m.setParams({ drive: Math.fround(+drive2) });
  const k = Math.min(B, xx.length - s);
  m.process(xx.subarray(s, s + k), yy.subarray(s, s + k), k);
}
const y = yy.slice(tail);
fs.writeFileSync(outRaw, Buffer.from(y.buffer));
console.log(w.sr);
