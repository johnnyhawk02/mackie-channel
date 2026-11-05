// node compare.js a.f32 b.f32 : peak and RMS of a-b relative to a's peak, and bit-identical count
const fs = require('fs');
const rd = (f) => { const b = fs.readFileSync(f); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
const a = rd(process.argv[2]), b = rd(process.argv[3]);
let pk = 0, dpk = 0, ds = 0, same = 0; const n = Math.min(a.length, b.length);
for (let i = 0; i < n; i++) { pk = Math.max(pk, Math.abs(a[i])); const d = a[i] - b[i]; dpk = Math.max(dpk, Math.abs(d)); ds += d * d; if (a[i] === b[i]) same++; }
const db = (v) => v === 0 ? '-inf' : (20 * Math.log10(v)).toFixed(1);
console.log(`n ${n}${a.length !== b.length ? ' LENGTH MISMATCH' : ''}  peak ${db(pk)} dBFS  residual peak ${db(dpk)} dBFS  rms ${db(Math.sqrt(ds / n))} dBFS  identical ${(100 * same / n).toFixed(2)}%`);
