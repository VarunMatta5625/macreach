/** VideoToolbox emits SPS without VUI bitstream_restriction, so browser decoders assume frame reordering and
 *  hold back output (frames only appear after flush). We rewrite the SPS inside the avcC description to declare
 *  max_num_reorder_frames=0 / max_dec_frame_buffering=num_ref_frames, which makes decoders output immediately. */

class BitReader {
  constructor(buf) { this.b = buf; this.p = 0; }
  u(n) { let v = 0; for (let i = 0; i < n; i++) { v = v * 2 + this.bit(); } return v; }
  bit() { const byte = this.b[this.p >> 3]; if (byte === undefined) throw new Error('eof'); const r = (byte >> (7 - (this.p & 7))) & 1; this.p++; return r; }
  ue() { let z = 0; while (this.bit() === 0) { if (++z > 32) throw new Error('bad ue'); } return z ? 2 ** z - 1 + this.u(z) : 0; }
  se() { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -k / 2; }
}
class BitWriter {
  constructor() { this.bits = []; }
  u(n, v) { for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(v / 2 ** i) & 1); }
  ue(v) { const x = v + 1, len = Math.floor(Math.log2(x)); this.u(len, 0); this.u(len + 1, x); }
  copy(src, from, to) { for (let i = from; i < to; i++) this.bits.push((src[i >> 3] >> (7 - (i & 7))) & 1); }
  bytes() {
    const bits = [...this.bits, 1]; while (bits.length % 8) bits.push(0);
    const out = Buffer.alloc(bits.length / 8);
    bits.forEach((b, i) => { out[i >> 3] |= b << (7 - (i & 7)); });
    return out;
  }
}

const unescape_ = (b) => { const o = []; let z = 0; for (const x of b) { if (z >= 2 && x === 3) { z = 0; continue; } o.push(x); z = x === 0 ? z + 1 : 0; } return Buffer.from(o); };
const escape_ = (b) => { const o = []; let z = 0; for (const x of b) { if (z >= 2 && x <= 3) { o.push(3); z = 0; } o.push(x); z = x === 0 ? z + 1 : 0; } return Buffer.from(o); };

function skipHrd(r) {
  const cnt = r.ue() + 1; r.u(8);
  for (let i = 0; i < cnt; i++) { r.ue(); r.ue(); r.u(1); }
  r.u(20);
}

/** returns patched SPS NAL (with header byte) or null if it can't/needn't be patched */
export function patchSps(nal) {
  const rbsp = unescape_(nal.subarray(1));
  const r = new BitReader(rbsp);
  const profile = r.u(8); r.u(8); r.u(8); r.ue();
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    const cf = r.ue(); if (cf === 3) r.u(1);
    r.ue(); r.ue(); r.u(1);
    if (r.u(1)) return null; // scaling matrices: not expected from VT
  }
  r.ue();
  const poc = r.ue();
  if (poc === 0) r.ue();
  else if (poc === 1) { r.u(1); r.se(); r.se(); const n = r.ue(); for (let i = 0; i < n; i++) r.se(); }
  const maxRef = r.ue(); r.u(1); r.ue(); r.ue();
  if (!r.u(1)) r.u(1);
  r.u(1);
  if (r.u(1)) { r.ue(); r.ue(); r.ue(); r.ue(); }
  const vuiFlagPos = r.p;
  const hasVui = r.u(1);
  let restrictPos = -1; // bit position where bitstream_restriction_flag lives (or must be inserted)
  if (hasVui) {
    if (r.u(1)) { if (r.u(8) === 255) r.u(32); }
    if (r.u(1)) r.u(1);
    if (r.u(1)) { r.u(4); if (r.u(1)) r.u(24); }
    if (r.u(1)) { r.ue(); r.ue(); }
    if (r.u(1)) { r.u(32); r.u(32); r.u(1); }
    const nal_ = r.u(1); if (nal_) skipHrd(r);
    const vcl = r.u(1); if (vcl) skipHrd(r);
    if (nal_ || vcl) r.u(1);
    r.u(1);
    restrictPos = r.p;
    if (r.u(1)) { r.u(1); r.ue(); r.ue(); r.ue(); r.ue(); const reorder = r.ue(); r.ue(); if (reorder === 0) return null; }
  }
  const w = new BitWriter();
  if (hasVui) w.copy(rbsp, 0, restrictPos);
  else { w.copy(rbsp, 0, vuiFlagPos); w.u(1, 1); w.u(8, 0); /* aspect,overscan,signal,chroma,timing,nal,vcl,pic_struct all 0 */ }
  w.u(1, 1);            // bitstream_restriction_flag
  w.u(1, 1);            // motion_vectors_over_pic_boundaries
  w.ue(2); w.ue(1); w.ue(16); w.ue(16);
  w.ue(0);              // max_num_reorder_frames
  w.ue(Math.max(1, maxRef)); // max_dec_frame_buffering
  return Buffer.concat([nal.subarray(0, 1), escape_(w.bytes())]);
}

/** avcC (Buffer) -> avcC with patched SPS; returns the original on any problem */
export function patchAvcC(avcC) {
  try {
    if (avcC[0] !== 1 || (avcC[5] & 31) !== 1) return avcC;
    const spsLen = avcC.readUInt16BE(6);
    const sps = avcC.subarray(8, 8 + spsLen);
    const patched = patchSps(sps);
    if (!patched) return avcC;
    const rest = avcC.subarray(8 + spsLen);
    const head = Buffer.from(avcC.subarray(0, 8)); head.writeUInt16BE(patched.length, 6);
    return Buffer.concat([head, patched, rest]);
  } catch { return avcC; }
}
