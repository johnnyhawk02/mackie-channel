const fs = require('fs');
function readWav(path) {
  const b = fs.readFileSync(path); let p = 12, fmt, data;
  while (p < b.length - 8) { const id = b.toString('ascii', p, p + 4), sz = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(p + 10), sr: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22), fmt: b.readUInt16LE(p + 8) };
    if (id === 'data') data = b.subarray(p + 8, p + 8 + sz);
    p += 8 + sz + (sz & 1); }
  const n = data.length / (fmt.bits / 8) / fmt.ch, chans = [];
  for (let c = 0; c < fmt.ch; c++) chans.push(new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < fmt.ch; c++) { const o = (i * fmt.ch + c) * fmt.bits / 8;
    chans[c][i] = fmt.bits === 16 ? data.readInt16LE(o) / 32768 : fmt.bits === 24 ? (data.readIntLE(o, 3)) / 8388608 : fmt.fmt === 3 ? data.readFloatLE(o) : data.readInt32LE(o) / 2147483648; }
  return { sr: fmt.sr, chans };
}
function writeWav(path, sr, chans) {
  const n = chans[0].length, ch = chans.length, b = Buffer.alloc(44 + n * ch * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * ch * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(ch, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * ch * 2, 28);
  b.writeUInt16LE(ch * 2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * ch * 2, 40);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(chans[c][i] * 32767))), 44 + (i * ch + c) * 2);
  fs.writeFileSync(path, b);
}
module.exports = { readWav, writeWav };
