/*
 * mackie-channel-core.js
 *
 * Component-level model of one input channel of a Mackie CR1604-VLZ, built
 * from the service-manual schematics (pod board 219 rev B, channel 1, and
 * main board 220 rev A, channel 1). Pure DSP: no Web Audio, no DOM. It runs in
 * an AudioWorklet, a ScriptProcessor, Node, or can be ported line for line to
 * C++ for a plugin.
 *
 * Signal path modelled (designators from the schematic):
 *
 *   LINE IN (J68, unbalanced TS)  R220/R212 5K62 into R197/R168 1K50  -> -13.5 dB pad
 *   MIC IN  (J84, balanced XLR)   straight to the input pair
 *        |
 *   PREAMP  Q24/Q8 2SA1084 input pair, Q64/Q80 current sources,
 *           U17A/U25A NJM2068 feedback amps, R268/R323 5K11 feedback,
 *           gain leg = TRIM R162 10K + R1 3.32R + C1 1000uF between emitters.
 *           Differential gain  Gd(s) = 1 + 2*5K11 / (Rtrim + 3.32 + 1/(s*1000u))
 *           Each NJM2068 output clips at its own rail (+/-16 VA supply).
 *   DIFF AMP U33A NJM2068, gain R482/R492 = 5K11/10K0 = 0.511, clips.
 *   INSERT  C94 47u / R167 10K, C121 47u / R137 20K (AC coupling)
 *   LO CUT  U104A NJM4560 3rd-order high pass, 75 Hz (switch SW101)
 *   EQ      U101A/B, U105A NJM4560 (hi shelf 12 kHz, sweep mid, low shelf 80 Hz)
 *   FADER   R107 10K (unity = -10 dB at the wiper) into U103A NJM4560,
 *           gain 1 + R101/R102 = 1 + 1K1/510 = +10 dB, clips.
 *
 * Every op-amp output is passed through a rail-saturation curve. The EQ
 * filters are behavioural (they hit the published curves) rather than a nodal
 * solve of U101/U105; at flat EQ the stage is unity gain and only its clipping
 * matters. The nonlinear section runs oversampled (default 4x).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MackieChannelCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function MackieChannelCoreFactory() {
  'use strict';

  // ---------------------------------------------------------------------------
  // Component values (from the schematic)
  // ---------------------------------------------------------------------------
  const C = {
    // input
    R_LINE_SERIES: 5620,   // R220 / R212
    R_LINE_SHUNT: 1500,    // R197 / R168
    // preamp
    R_FB: 5110,            // R268 / R323
    R_GAIN_MIN: 3.32,      // R1 3R32 in series with the trim pot
    R_TRIM: 10000,         // R162 10K trim
    C_GAIN: 1000e-6,       // C1 1000uF in the gain leg
    // diff amp U33A
    DIFF_GAIN: 5110 / 10000, // R482 / R492
    // AC coupling after the pre
    HP_INSERT_HZ: 1 / (2 * Math.PI * 10000 * 47e-6), // C94 + R167
    HP_MAIN_HZ: 1 / (2 * Math.PI * 20000 * 47e-6),   // C121 + R137
    // fader amp U103A
    FADER_AMP_GAIN: 1 + 1100 / 510,  // R101 / R102, +10 dB
    FADER_UNITY_ATTEN: 1 / (1 + 1100 / 510), // fader "U" mark sits 10 dB down
    // lo cut
    LOCUT_HZ: 75,
  };

  // Op-amp output swing on +/-16 V rails. Datasheet typicals (NJM2068: +/-13.5 V
  // at +/-15 V, 2k load; NJM4560 similar) scaled to 16 V rails. The small
  // positive/negative mismatch is an estimate and adds a trace of even order.
  const RAILS = {
    NJM2068: { pos: 14.6, neg: -14.2, knee: 0.92 },
    NJM4560: { pos: 14.4, neg: -14.0, knee: 0.9 },
  };

  // Rail saturation: exactly linear until `knee` of the rail, then a rational
  // curve that bends into the rail with continuous slope. Op-amp outputs are
  // linear right up to a few hundred mV from saturation, so the knee is high.
  function rail(x, r) {
    if (x >= 0) {
      const k = r.pos * r.knee;
      if (x <= k) return x;
      const w = r.pos - k, t = (x - k) / w;
      return k + w * t / (1 + t);
    }
    const k = r.neg * r.knee;
    if (x >= k) return x;
    const w = r.neg - k, t = (x - k) / w;
    return k + w * t / (1 + t);
  }

  // ---------------------------------------------------------------------------
  // Small filter helpers
  // ---------------------------------------------------------------------------
  class OnePoleHP {            // bilinear one-pole high pass
    constructor() { this.b0 = 1; this.b1 = -1; this.a1 = 0; this.x1 = 0; this.y1 = 0; }
    set(fc, fs) {
      const k = Math.tan(Math.PI * Math.min(fc, 0.49 * fs) / fs);
      const n = 1 / (1 + k);
      this.b0 = n; this.b1 = -n; this.a1 = (k - 1) * n;
    }
    process(x) {
      const y = this.b0 * x + this.b1 * this.x1 - this.a1 * this.y1;
      this.x1 = x; this.y1 = y; return y;
    }
    reset() { this.x1 = this.y1 = 0; }
  }

  class Biquad {               // RBJ cookbook, transposed direct form II
    constructor() { this.b0 = 1; this.b1 = this.b2 = this.a1 = this.a2 = 0; this.z1 = this.z2 = 0; }
    setCoefs(b0, b1, b2, a0, a1, a2) {
      this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    }
    highpass(fc, q, fs) {
      const w = 2 * Math.PI * fc / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q);
      this.setCoefs((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
    }
    peak(fc, q, db, fs) {
      const A = Math.pow(10, db / 40), w = 2 * Math.PI * fc / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q);
      this.setCoefs(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
    }
    shelf(fc, db, fs, high) {   // shelf slope S = 1
      const A = Math.pow(10, db / 40), w = 2 * Math.PI * fc / fs, c = Math.cos(w), s = Math.sin(w);
      const al = s / 2 * Math.SQRT2, sa = 2 * Math.sqrt(A) * al;
      if (high) this.setCoefs(A * ((A + 1) + (A - 1) * c + sa), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - sa),
        (A + 1) - (A - 1) * c + sa, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - sa);
      else this.setCoefs(A * ((A + 1) - (A - 1) * c + sa), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - sa),
        (A + 1) + (A - 1) * c + sa, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - sa);
    }
    process(x) {
      const y = this.b0 * x + this.z1;
      this.z1 = this.b1 * x - this.a1 * y + this.z2;
      this.z2 = this.b2 * x - this.a2 * y;
      return y;
    }
    reset() { this.z1 = this.z2 = 0; }
  }

  // Linear-phase polyphase FIR for integer up/down sampling.
  function designLowpass(taps, cutoff /* fraction of output Nyquist */, factor) {
    const h = new Float64Array(taps), beta = 8, m = taps - 1;
    const i0 = (x) => { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; };
    const fc = cutoff / factor / 2; // cycles per (oversampled) sample
    let sum = 0;
    for (let n = 0; n < taps; n++) {
      const x = n - m / 2;
      const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
      const r = 2 * n / m - 1;
      h[n] = sinc * i0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0(beta);
      sum += h[n];
    }
    for (let n = 0; n < taps; n++) h[n] /= sum;
    return h;
  }

  class Oversampler {
    constructor(factor, tapsPerPhase = 24) {
      this.factor = factor;
      this.taps = factor * tapsPerPhase;
      this.h = designLowpass(this.taps, 0.90, factor);
      this.upBuf = new Float64Array(tapsPerPhase * 2);   // base-rate history (doubled ring)
      this.upPos = 0; this.tpp = tapsPerPhase;
      this.downBuf = new Float64Array(this.taps * 2);
      this.downPos = 0;
      this.out = new Float64Array(factor);
    }
    // one base-rate sample in -> factor oversampled samples in this.out
    up(x) {
      const L = this.factor, P = this.tpp, h = this.h;
      this.upPos = (this.upPos + 1) % P;
      this.upBuf[this.upPos] = x; this.upBuf[this.upPos + P] = x;
      for (let p = 0; p < L; p++) {
        let acc = 0;
        for (let k = 0; k < P; k++) acc += h[p + k * L] * this.upBuf[this.upPos + P - k];
        this.out[p] = acc * L;
      }
      return this.out;
    }
    // push factor oversampled samples, get one base-rate sample
    down(arr) {
      const N = this.taps, h = this.h;
      for (let i = 0; i < arr.length; i++) {
        this.downPos = (this.downPos + 1) % N;
        this.downBuf[this.downPos] = arr[i]; this.downBuf[this.downPos + N] = arr[i];
      }
      let acc = 0;
      for (let k = 0; k < N; k++) acc += h[k] * this.downBuf[this.downPos + N - k];
      return acc;
    }
    reset() { this.upBuf.fill(0); this.downBuf.fill(0); }
    get latency() { return (this.taps - 1) / this.factor; } // base-rate samples
  }

  // ---------------------------------------------------------------------------
  // Trim pot taper. The R162 part is a special taper ("10KZY") chosen so the
  // printed gain scale is close to dB-linear. We reproduce that: rotation 0..1
  // maps linearly in dB across the full preamp range, and the pot resistance
  // is solved back from the gain.
  // ---------------------------------------------------------------------------
  const GD_MIN = 1 + 2 * C.R_FB / (C.R_TRIM + C.R_GAIN_MIN);
  const GD_MAX = 1 + 2 * C.R_FB / C.R_GAIN_MIN;
  function trimResistance(rotation) {
    const r = Math.min(1, Math.max(0, rotation));
    const gdDb = 20 * Math.log10(GD_MIN) + r * (20 * Math.log10(GD_MAX) - 20 * Math.log10(GD_MIN));
    const gd = Math.pow(10, gdDb / 20);
    return Math.max(0, 2 * C.R_FB / (gd - 1) - C.R_GAIN_MIN);
  }

  // ---------------------------------------------------------------------------
  // One channel (mono). Use one instance per audio channel.
  // ---------------------------------------------------------------------------
  const DEFAULTS = {
    drive: 0.5,             // trim rotation 0..1
    input: 'line',          // 'line' (J68 unbalanced) or 'mic' (J84 balanced)
    fullScaleVolts: 8.68,   // peak volts at the jack for 0 dBFS (+18 dBu)
    loCut: false,
    eqHigh: 0, eqMid: 0, eqMidFreq: 1000, eqLow: 0, // dB, Hz
    faderDb: 0,             // -inf..+10, 0 = "U"
    outputDb: 0,            // digital trim after the model
  };

  class MackieChannel {
    constructor(sampleRate, opts = {}) {
      this.fs = sampleRate;
      this.os = opts.oversample || 4;
      this.fsOs = this.fs * this.os;
      this.ovs = new Oversampler(this.os);
      this.p = Object.assign({}, DEFAULTS);
      // preamp state
      this.gainLegHP = new OnePoleHP();     // current through Rg + C1
      this.driveSmoothed = this.p.drive;
      this.driveTarget = this.p.drive;
      this.coefCountdown = 0;
      this.rg = 0; this.kPre = 0;
      // coupling / filters (oversampled rate)
      this.hpInsert = new OnePoleHP(); this.hpMain = new OnePoleHP();
      this.locut1 = new OnePoleHP(); this.locut2 = new Biquad();
      this.eqLow = new Biquad(); this.eqMid = new Biquad(); this.eqHigh = new Biquad();
      this.hpInsert.set(C.HP_INSERT_HZ, this.fsOs);
      this.hpMain.set(C.HP_MAIN_HZ, this.fsOs);
      this.locut1.set(C.LOCUT_HZ, this.fsOs);
      this.locut2.highpass(C.LOCUT_HZ, 1.0, this.fsOs); // 1-pole + Q=1 biquad = 3rd-order Butterworth
      this.osBuf = new Float64Array(this.os);
      this.peaks = { pre: 0, diff: 0, eq: 0, fader: 0 };
      this.setParams(opts);
      this._updatePreCoefs(true);
    }

    setParams(o = {}) {
      for (const k of Object.keys(DEFAULTS)) if (o[k] !== undefined) this.p[k] = o[k];
      if (o.drive !== undefined) this.driveTarget = Math.min(1, Math.max(0, o.drive));
      this.eqLow.shelf(80, this.p.eqLow, this.fsOs, false);
      this.eqHigh.shelf(12000, this.p.eqHigh, this.fsOs, true);
      this.eqMid.peak(Math.min(8000, Math.max(100, this.p.eqMidFreq)), 0.8, this.p.eqMid, this.fsOs);
      this.eqActive = this.p.eqLow !== 0 || this.p.eqMid !== 0 || this.p.eqHigh !== 0;
      this.inGain = this.p.fullScaleVolts;
      this.pad = this.p.input === 'mic' ? 1 : C.R_LINE_SHUNT / (C.R_LINE_SERIES + C.R_LINE_SHUNT);
      this.unbalanced = this.p.input !== 'mic';
      this.faderGain = this.p.faderDb <= -90 ? 0 : C.FADER_UNITY_ATTEN * Math.pow(10, this.p.faderDb / 20);
      this.outGain = Math.pow(10, this.p.outputDb / 20) / this.p.fullScaleVolts;
    }

    _updatePreCoefs(force) {
      const d = this.driveTarget - this.driveSmoothed;
      if (!force && Math.abs(d) < 1e-6) return;
      this.driveSmoothed += force ? d : d * 0.25;
      this.rg = trimResistance(this.driveSmoothed) + C.R_GAIN_MIN;
      this.kPre = 2 * C.R_FB / this.rg;                           // gain-leg contribution
      this.gainLegHP.set(1 / (2 * Math.PI * this.rg * C.C_GAIN), this.fsOs); // C1 corner
    }

    // Static info for UIs.
    info() {
      const gdMid = 1 + 2 * C.R_FB / this.rg;
      const lineOrMic = this.pad;
      return {
        trimOhms: this.rg - C.R_GAIN_MIN,
        gainLegOhms: this.rg,
        preGainDb: 20 * Math.log10(gdMid * C.DIFF_GAIN),
        channelGainDb: 20 * Math.log10(lineOrMic * gdMid * C.DIFF_GAIN),
        c1CornerHz: 1 / (2 * Math.PI * this.rg * C.C_GAIN),
        latencySamples: this.ovs.latency,
      };
    }

    readPeaks() { const p = this.peaks; this.peaks = { pre: 0, diff: 0, eq: 0, fader: 0 }; return p; }

    reset() {
      this.ovs.reset(); this.gainLegHP.reset(); this.hpInsert.reset(); this.hpMain.reset();
      this.locut1.reset(); this.locut2.reset(); this.eqLow.reset(); this.eqMid.reset(); this.eqHigh.reset();
    }

    // Process one oversampled sample of jack voltage (volts in, volts out).
    _tick(vIn) {
      const R2068 = RAILS.NJM2068, R4560 = RAILS.NJM4560, pk = this.peaks;
      // input network -> differential and common-mode voltage at the bases
      const vd = vIn * this.pad;
      const vcm = this.unbalanced ? 0.5 * vd : 0;
      // preamp: Gd*vd = vd + (2Rf/Rg) * HP_C1(vd)
      const gdv = vd + this.kPre * this.gainLegHP.process(vd);
      const va = rail(vcm + 0.5 * gdv, R2068);   // U17A output
      const vb = rail(vcm - 0.5 * gdv, R2068);   // U25A output
      const ma = Math.max(Math.abs(va), Math.abs(vb)); if (ma > pk.pre) pk.pre = ma;
      // diff amp U33A
      let v = rail(C.DIFF_GAIN * (va - vb), R2068);
      if (Math.abs(v) > pk.diff) pk.diff = Math.abs(v);
      // insert jack coupling and main-board input coupling
      v = this.hpMain.process(this.hpInsert.process(v));
      // lo cut (U104A)
      if (this.p.loCut) v = rail(this.locut2.process(this.locut1.process(v)), R4560);
      // EQ (U101/U105)
      if (this.eqActive) v = this.eqHigh.process(this.eqMid.process(this.eqLow.process(v)));
      v = rail(v, R4560);
      if (Math.abs(v) > pk.eq) pk.eq = Math.abs(v);
      // fader + U103A (+10 dB make-up)
      v = rail(v * this.faderGain * C.FADER_AMP_GAIN, R4560);
      if (Math.abs(v) > pk.fader) pk.fader = Math.abs(v);
      return v;
    }

    // Process a block. input/output are Float32Array (or any array) of samples
    // in digital full scale. input and output may be the same array.
    process(input, output, n = input.length) {
      const os = this.os, buf = this.osBuf;
      for (let i = 0; i < n; i++) {
        if (--this.coefCountdown <= 0) { this._updatePreCoefs(false); this.coefCountdown = 16; }
        const up = this.ovs.up(input[i] * this.inGain);
        for (let k = 0; k < os; k++) buf[k] = this._tick(up[k]);
        output[i] = this.ovs.down(buf) * this.outGain;
      }
      return output;
    }
  }

  return { MackieChannel, trimResistance, COMPONENTS: C, RAILS, DEFAULTS, factory: MackieChannelCoreFactory };
});
