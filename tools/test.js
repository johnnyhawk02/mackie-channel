const { MackieChannel, trimResistance } = require('../mackie-channel-core.js');
const fs = 48000;
// gain law
for (const d of [0, 0.25, 0.5, 0.75, 1]) { const m = new MackieChannel(fs, { drive: d }); const i = m.info();
  console.log(`drive ${d}: Rtrim ${i.trimOhms.toFixed(1)} ohm, pre ${i.preGainDb.toFixed(1)} dB, line chan ${i.channelGainDb.toFixed(1)} dB, C1 corner ${i.c1CornerHz.toFixed(2)} Hz`); }
// measure 1k sine gain and THD at a few drives (-20 dBFS in)
function measure(drive, f, amp, opts = {}) {
  const m = new MackieChannel(fs, Object.assign({ drive }, opts)); const N = fs; const x = new Float32Array(N);
  for (let i = 0; i < N; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / fs);
  const y = m.process(x, new Float32Array(N));
  const s = y.subarray(fs / 2); const harm = [];
  for (let h = 1; h <= 9; h++) { let re = 0, im = 0; for (let i = 0; i < s.length; i++) { const w = 2 * Math.PI * f * h * i / fs; re += s[i] * Math.cos(w); im += s[i] * Math.sin(w); }
    harm.push(2 * Math.hypot(re, im) / s.length); }
  const thd = Math.sqrt(harm.slice(1).reduce((a, b) => a + b * b, 0)) / harm[0];
  return { gainDb: 20 * Math.log10(harm[0] / amp), thd, h2: harm[1] / harm[0], h3: harm[2] / harm[0] };
}
for (const d of [0.2, 0.4, 0.5, 0.6, 0.7, 0.8, 1]) for (const f of [40, 1000]) { const r = measure(d, f, 0.1);
  console.log(`drive ${d} ${f}Hz -20dBFS: gain ${r.gainDb.toFixed(2)} dB THD ${(r.thd * 100).toFixed(2)}% h2 ${(r.h2*100).toFixed(3)}% h3 ${(r.h3*100).toFixed(2)}%`); }
