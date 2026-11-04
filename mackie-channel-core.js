/*
 * mackie-channel-core.js
 *
 * Circuit-level model of one input channel of a Mackie CR1604-VLZ, solved
 * node by node from the service-manual schematics (pod board 219 rev B, ch 1,
 * and main board 220 rev A, ch 1). No Web Audio, no DOM: it runs in an
 * AudioWorklet, a ScriptProcessor, or Node, and ports line for line to C++.
 *
 * How it works
 * ------------
 * Each stage is a netlist of the real parts. The netlist is turned into a
 * modified-nodal-analysis system once per control change; every linear part
 * (resistors, capacitors, inductors, sources, op-amp output buffers) is folded
 * into fixed matrices, leaving a small nonlinear system in the device port
 * voltages only (the "DK" / nodal K-method). That system is solved by Newton
 * iteration every oversampled sample. Capacitors and inductors are discretised
 * with the trapezoidal rule, or backward Euler for the ones whose time constant
 * is far above the audio band (RF filters, op-amp compensation), which keeps
 * the stiff parts stable.
 *
 * Devices
 *   BJT     Ebers-Moll transport model with Early effect (Gummel-Poon
 *           DC core without high-injection terms).
 *   Diode   Shockley.
 *   Op-amp  Macromodel: input transconductance into an integrator node
 *           (datasheet gain-bandwidth and open-loop gain), clamp to the
 *           datasheet output swing, output resistance. Clipping, loop
 *           break-up and recovery come out of the circuit.
 *
 * Stages (see STAGES below for the full netlists with designators)
 *   A  Pod board: line jack J68 / mic input network, Q24/Q8 2SA1084 input
 *      pair, Q64/Q80/Q63 MMBT4403 current sources with the D80 bias string,
 *      U17A/U25A NJM2068 servo amps, TRIM R162 + R1 + C1 + L1 gain leg,
 *      U33A NJM2068 differential output amp.
 *   B  Main board: C94/R167 and C121/R137 coupling, LO CUT U104A (SW101),
 *      mid EQ U101A/U101B, hi/low EQ U105A, all NJM4560.
 *   C  Main board: C120, fader R107, C113, U103A NJM4560 (+10 dB).
 * OMITTED, because they act only far above the audio band and cannot be
 * represented at the model's sample rate anyway (corner frequencies at the
 * circuit impedances in brackets):
 *   C110, C79, C367 470p RF filter at the input bases (~95 kHz)
 *   C315, C316 1n on the phantom feed (~135 kHz)
 *   L1 4.7uH ferrite in the gain leg (112 kHz with R1; -0.13 dB at 20 kHz at full gain)
 *   C158, C182 10p, C214, C237 150p, C123 20p, C112 10p, C103 220p
 *     op-amp stability caps (200 kHz to 6 MHz)
 *   Op-amp slew rate: the slowest part (NJM4560, 4 V/us) crosses its whole
 *     28 V swing in 7 us, under one sample at 96 kHz.
 * Metering taps (OL/-20 LED comparators, R138) and everything after U103A
 * (pan, mix buses) are not part of the channel path modelled here.
 *
 * Stages are joined at op-amp outputs. Each op-amp output drives the next
 * stage as a voltage source; the loading of the next stage on that output is
 * not fed back (the closed-loop output impedance is milliohms against loads
 * of 5 kOhm and up).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MackieChannelCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function MackieChannelCoreFactory() {
  'use strict';

  const VT = 0.025852; // thermal voltage at 27 C
  // Op-amp output swing limit inside the macromodel: beyond the swing the
  // integrator node is held by a 0.1 S conductance (tens of mV at the mA the
  // input stage can push into it), with a 2 mV smooth knee.
  const CLAMP_G = 0.1, CLAMP_W = 0.002;

  // ===========================================================================
  // Device data. Where a number is not from a datasheet or published model it
  // is marked ASSUMED, with the reason.
  // ===========================================================================
  const MODELS = {
    // MMBT4403 / 2N4403: Fairchild SPICE model (LTspice standard.bjt).
    MMBT4403: { type: 'pnp', Is: 650.6e-18, Bf: 216.2, Br: 3.578, Vaf: 115.7 },
    // 2SA1084: Hitachi low-noise PNP. hFE grades D 250-500, E 400-800 (datasheet).
    // No SPICE model is published. Bf = 400 (grade boundary). Is ASSUMED 1e-13,
    // typical of large-area low-noise small-signal PNPs. Both have almost no
    // effect: the servo loop fixes the collector currents, so Is only shifts
    // Vbe by a common-mode amount. Br and Vaf ASSUMED from the 4403 family.
    '2SA1084': { type: 'pnp', Is: 1e-13, Bf: 400, Br: 4, Vaf: 100 },
    // DL4148 = 1N4148 (MELF). LTspice standard.dio model.
    '1N4148': { Is: 2.52e-9, N: 1.752 },
    // Op-amps. GBW / slew / gain / swing are datasheet typicals. Swing is
    // given at +/-15 V, so the headroom to each rail is taken from it and
    // applied to the +/-16 V rails. Compensation capacitance sets the internal
    // scale only (gm = 2*pi*GBW*Cc, slew current = SR*Cc), it does not change
    // the transfer function. Output resistance ASSUMED 50 Ohm (not given in
    // either datasheet; typical for this class of bipolar output stage).
    NJM2068: { gbw: 27e6, sr: 6e6, a0: Math.pow(10, 110 / 20), headroom: 1.5, cc: 30e-12, rout: 50 },
    NJM4560: { gbw: 10e6, sr: 4e6, a0: Math.pow(10, 100 / 20), headroom: 1.0, cc: 30e-12, rout: 50 },
  };

  // ===========================================================================
  // Netlist
  // ===========================================================================
  class Netlist {
    constructor() { this.els = []; this.inputs = []; this.outputs = {}; }
    R(a, b, r) { this.els.push({ k: 'R', a, b, r }); }
    // variable resistor (a pot moved while running): stamped at its value from
    // the last matrix build, plus a linear port carrying the difference
    RV(a, b, r) { this.els.push({ k: 'RV', a, b, r }); }
    C(a, b, c, stiff) { this.els.push({ k: 'C', a, b, c, be: !!stiff }); }
    L(a, b, l, stiff) { this.els.push({ k: 'L', a, b, l, be: !!stiff }); }
    V(name, a) { this.inputs.push(name); this.els.push({ k: 'V', a, idx: this.inputs.length - 1 }); }
    D(a, b, m) { this.els.push({ k: 'D', a, b, m }); }
    Q(c, b, e, m) { this.els.push({ k: 'Q', c, b, e, m }); }
    // op-amp: rails are the numeric supply voltages
    U(name, inP, inN, out, m, vcc, vee) {
      const x = name + '.x';
      const M = MODELS[m];
      // integrator stage: gm into the compensation capacitance, finite DC gain
      const gm = 2 * Math.PI * M.gbw * M.cc;
      this.C(x, '0', M.cc, true);
      this.R(x, '0', M.a0 / gm);
      this.els.push({ k: 'GM', p: inP, n: inN, x, gm });
      this.els.push({ k: 'CLAMP', x, hi: vcc - M.headroom, lo: vee + M.headroom });
      this.els.push({ k: 'BUF', x, o: out, g: 1 / M.rout });
    }
    out(name, node) { this.outputs[name] = node; }
  }

  // ===========================================================================
  // Small dense linear algebra
  // ===========================================================================
  function invert(A, n) { // Gauss-Jordan, returns new Float64Array
    const M = new Float64Array(n * 2 * n);
    for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) M[i * 2 * n + j] = A[i * n + j]; M[i * 2 * n + n + i] = 1; }
    const w = 2 * n;
    for (let c = 0; c < n; c++) {
      let p = c, best = Math.abs(M[c * w + c]);
      for (let r = c + 1; r < n; r++) { const v = Math.abs(M[r * w + c]); if (v > best) { best = v; p = r; } }
      if (best < 1e-300) throw new Error('singular circuit matrix (floating node?)');
      if (p !== c) for (let j = 0; j < w; j++) { const t = M[c * w + j]; M[c * w + j] = M[p * w + j]; M[p * w + j] = t; }
      const d = 1 / M[c * w + c];
      for (let j = 0; j < w; j++) M[c * w + j] *= d;
      for (let r = 0; r < n; r++) if (r !== c) {
        const f = M[r * w + c]; if (f === 0) continue;
        for (let j = 0; j < w; j++) M[r * w + j] -= f * M[c * w + j];
      }
    }
    const R = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) R[i * n + j] = M[i * w + n + j];
    return R;
  }

  // ===========================================================================
  // Compiled circuit: v = Dh*J + Du*u + K*i  (device port voltages)
  //                   vr = Ah*J + Au*u + Ai*i (reactive branch voltages)
  //                   y  = Oh*J + Ou*u + Oi*i (named outputs)
  // ===========================================================================
  class Circuit {
    constructor(net, T) {
      this.net = net;
      // node numbering
      const idx = new Map(); idx.set('0', -1);
      const node = (n) => { if (!idx.has(n)) idx.set(n, idx.size - 1); return idx.get(n); };
      for (const e of net.els) for (const f of ['a', 'b', 'c', 'e', 'p', 'n', 'x', 'o']) if (e[f] !== undefined) node(e[f]);
      for (const k in net.outputs) node(net.outputs[k]);
      this.nodeIndex = idx;
      const nn = idx.size - 1, nv = net.inputs.length, N = nn + nv;
      this.N = N; this.nn = nn; this.q = nv;
      // ports and reactive elements
      const ports = []; // {va, vb, ia, ib}
      const devs = [];
      const reac = []; // {a, b, g, type}
      for (const e of net.els) {
        if (e.k === 'D') { devs.push({ k: 'D', p: ports.length, Is: e.m.Is, nvt: e.m.N * VT }); ports.push({ va: node(e.a), vb: node(e.b), ia: node(e.a), ib: node(e.b) }); }
        else if (e.k === 'Q') {
          const pnp = e.m.type === 'pnp';
          const B = node(e.b), C = node(e.c), E = node(e.e);
          // port1 = BE junction, port2 = BC junction, oriented forward for the polarity
          const p1 = pnp ? { va: E, vb: B, ia: E, ib: B } : { va: B, vb: E, ia: B, ib: E };
          const p2 = pnp ? { va: C, vb: B, ia: C, ib: B } : { va: B, vb: C, ia: B, ib: C };
          devs.push({ k: 'Q', p: ports.length, Is: e.m.Is, Bf: e.m.Bf, Br: e.m.Br, Vaf: e.m.Vaf });
          ports.push(p1, p2);
        } else if (e.k === 'CLAMP') { devs.push({ k: 'CL', p: ports.length, hi: e.hi, lo: e.lo }); ports.push({ va: node(e.x), vb: -1, ia: node(e.x), ib: -1 }); }
        else if (e.k === 'RV') { devs.push({ k: 'RV', p: ports.length, el: e }); ports.push({ va: node(e.a), vb: node(e.b), ia: node(e.a), ib: node(e.b) }); }
        else if (e.k === 'C' || e.k === 'L') reac.push({ a: node(e.a), b: node(e.b), k: e.k, val: e.k === 'C' ? e.c : e.l, be: e.be });
      }
      this.ports = ports; this.devs = devs; this.reac = reac;
      const qa = [], da = [], ca = [], rv = [], lim = new Int8Array(ports.length);
      for (const d of devs) {
        if (d.k === 'Q') { qa.push(d.p, d.Is, d.Bf, d.Br, d.Vaf); lim[d.p] = 1; lim[d.p + 1] = 1; }
        else if (d.k === 'D') { da.push(d.p, d.Is, d.nvt); lim[d.p] = 2; }
        else if (d.k === 'RV') rv.push(d);
        else { ca.push(d.p, d.hi, d.lo); lim[d.p] = 3; }
      }
      this.clampsOnly = qa.length === 0 && da.length === 0 && rv.length === 0;
      this.RV = rv; this.RVg = new Float64Array(rv.length); // conductance change since the last build
      this.QA = Float64Array.from(qa); this.DA = Float64Array.from(da); this.CA = Float64Array.from(ca); this.lim = lim;
      this.limA = new Float64Array(ports.length); this.limB = new Float64Array(ports.length);
      for (const d of devs) { if (d.k === 'D') this.limA[d.p] = d.nvt; if (d.k === 'CL') { this.limA[d.p] = d.hi; this.limB[d.p] = d.lo; } }
      this.m = ports.length; this.r = reac.length;
      this.outNames = Object.keys(net.outputs);
      this.outNodes = this.outNames.map((k) => node(net.outputs[k]));
      this.setT(T);
    }

    gOf(re, T) {
      if (re.k === 'C') return re.be ? re.val / T : 2 * re.val / T;
      return re.be ? T / re.val : T / (2 * re.val);
    }

    // (Re)build matrices for time step T with current element values.
    setT(T) {
      this.T = T;
      if (this.fine) this.fine.dirty = true;
      const { N, nn, net } = this;
      const node = (n) => this.nodeIndex.get(n);
      const M = new Float64Array(N * N);
      const add = (i, j, v) => { if (i >= 0 && j >= 0) M[i * N + j] += v; };
      const stampG = (a, b, g) => { add(a, a, g); add(b, b, g); add(a, b, -g); add(b, a, -g); };
      for (const e of net.els) {
        if (e.k === 'R') stampG(node(e.a), node(e.b), 1 / (typeof e.r === 'function' ? e.r() : e.r));
        else if (e.k === 'RV') { e.g0 = 1 / e.r(); stampG(node(e.a), node(e.b), e.g0); }
        else if (e.k === 'V') { const a = node(e.a), row = nn + e.idx; add(a, row, 1); add(row, a, 1); }
        else if (e.k === 'BUF') { const o = node(e.o), x = node(e.x); add(o, o, e.g); add(o, x, -e.g); }
        else if (e.k === 'GM') { const x = node(e.x); add(x, node(e.p), -e.gm); add(x, node(e.n), e.gm); }
      }
      for (const re of this.reac) { re.g = this.gOf(re, T); stampG(re.a, re.b, re.g); }
      if (this.RVg) { this.RVg.fill(0); this.factored = false; }
      // tiny conductance to ground on every node keeps open-circuit nodes solvable
      for (let i = 0; i < nn; i++) M[i * N + i] += 1e-12;
      const S = invert(M, N);
      // incidence helpers: rows of S picked by a voltage incidence (va - vb)
      const rowDiff = (va, vb, out) => { for (let j = 0; j < N; j++) out[j] = (va >= 0 ? S[va * N + j] : 0) - (vb >= 0 ? S[vb * N + j] : 0); };
      const colDiff = (row, ia, ib) => (ia >= 0 ? row[ia] : 0) - (ib >= 0 ? row[ib] : 0);
      const { m, r, q } = this, o = this.outNodes.length;
      const tmp = new Float64Array(N);
      const build = (rows, getRow) => {
        const H = new Float64Array(rows * r), U = new Float64Array(rows * q), I = new Float64Array(rows * m);
        for (let k = 0; k < rows; k++) {
          getRow(k, tmp);
          // rhs = -E_r^T J + U u - E_i^T i
          for (let j = 0; j < r; j++) H[k * r + j] = -colDiff(tmp, this.reac[j].a, this.reac[j].b);
          for (let j = 0; j < q; j++) U[k * q + j] = tmp[nn + j];
          for (let j = 0; j < m; j++) I[k * m + j] = -colDiff(tmp, this.ports[j].ia, this.ports[j].ib);
        }
        return [H, U, I];
      };
      [this.Dh, this.Du, this.K] = build(m, (k, t) => rowDiff(this.ports[k].va, this.ports[k].vb, t));
      [this.Ah, this.Au, this.Ai] = build(r, (k, t) => rowDiff(this.reac[k].a, this.reac[k].b, t));
      [this.Oh, this.Ou, this.Oi] = build(o, (k, t) => rowDiff(this.outNodes[k], -1, t));
      if (!this.J) {
        this.J = new Float64Array(r); this.v = new Float64Array(m); this.i = new Float64Array(m);
        this.p = new Float64Array(m); this.f = new Float64Array(m); this.jac = new Float64Array(m * m);
        this.dI = new Float64Array(m * 2); this.dx = new Float64Array(m); this.y = new Float64Array(o);
        this.vr = new Float64Array(r); this.perm = new Int32Array(m);
        this.vtmp = new Float64Array(m); this.ftmp = new Float64Array(m); this.sx = new Float64Array(m); this.factored = false;
        this.physI = new Float64Array(r); this.vSave = new Float64Array(m); this.uPrev = new Float64Array(q);
        this.iters = 0; this.fails = 0; this.substeps = 0;
      }
    }

    // Evaluate device currents and their port derivatives at this.v.
    evalDevices() {
      const v = this.v, i = this.i, dI = this.dI;
      // BJTs: packed [p, Is, Bf, Br, Vaf]
      const QA = this.QA;
      for (let n = 0; n < QA.length; n += 5) {
        const p = QA[n], Is = QA[n + 1], Bf = QA[n + 2], Br = QA[n + 3], Vaf = QA[n + 4];
        const v1 = v[p], v2 = v[p + 1];
        const x1 = v1 / VT, x2 = v2 / VT;
        const e1 = x1 < 80 ? Math.exp(x1) : 5.54062238439351e34 * (1 + x1 - 80);
        const e2 = x2 < 80 ? Math.exp(x2) : 5.54062238439351e34 * (1 + x2 - 80);
        const d1 = x1 < 80 ? e1 : 5.54062238439351e34, d2 = x2 < 80 ? e2 : 5.54062238439351e34;
        const gf = Is * d1 / VT, gr = Is * d2 / VT;
        const ea = 1 - v2 / Vaf;
        const icc = Is * (e1 - e2);
        const ibf = Is / Bf * (e1 - 1), ibr = Is / Br * (e2 - 1);
        const ic = icc * ea - ibr;
        i[p] = ic + ibf + ibr; i[p + 1] = -ic;
        const dic1 = gf * ea, dic2 = -gr * ea - icc / Vaf - gr / Br;
        dI[2 * p] = dic1 + gf / Bf; dI[2 * p + 1] = dic2 + gr / Br;
        dI[2 * p + 2] = -dic1; dI[2 * p + 3] = -dic2;
      }
      // diodes: packed [p, Is, nVt]
      const DA = this.DA;
      for (let n = 0; n < DA.length; n += 3) {
        const p = DA[n], Is = DA[n + 1], nvt = DA[n + 2], x = v[p] / nvt;
        const e = x < 80 ? Math.exp(x) : 5.54062238439351e34 * (1 + x - 80);
        i[p] = Is * (e - 1); dI[2 * p] = Is * (x < 80 ? e : 5.54062238439351e34) / nvt + 1e-12; dI[2 * p + 1] = 0;
      }
      // variable resistors: the conductance change, a linear port
      const RV = this.RV, RVg = this.RVg;
      for (let n = 0; n < RV.length; n++) { const p = RV[n].p, g = RVg[n]; i[p] = g * v[p]; dI[2 * p] = g; dI[2 * p + 1] = 0; }
      // swing clamps: packed [p, hi, lo]
      const CA = this.CA;
      for (let n = 0; n < CA.length; n += 3) {
        const p = CA[n], a = (v[p] - CA[n + 1]) / CLAMP_W, b = (CA[n + 2] - v[p]) / CLAMP_W;
        if (a < -30 && b < -30) { i[p] = 0; dI[2 * p] = 1e-12; dI[2 * p + 1] = 0; continue; }
        i[p] = CLAMP_G * CLAMP_W * (softplus(a) - softplus(b));
        dI[2 * p] = CLAMP_G * (sigmoid(a) + sigmoid(b)) + 1e-12; dI[2 * p + 1] = 0;
      }
    }

    // residual f = v - p - K i(v) at this.v; returns squared norm
    residual(f) {
      const { m, K, v, i, p } = this;
      this.evalDevices();
      let nrm = 0;
      for (let k = 0; k < m; k++) {
        let s = 0; const row = k * m;
        for (let j = 0; j < m; j++) s += K[row + j] * i[j];
        const r = v[k] - p[k] - s; f[k] = r; nrm += r * r;
      }
      return nrm;
    }

    // Jacobian I - K dI/dv at the last evaluated point, LU-factored in place
    factor() {
      const { m, K, jac, dI, devs } = this;
      jac.fill(0);
      for (let k = 0; k < m; k++) jac[k * m + k] = 1;
      for (let di = 0; di < devs.length; di++) {
        const d = devs[di], p0 = d.p, w = d.k === 'Q' ? 2 : 1;
        for (let a = 0; a < w; a++) for (let b = 0; b < w; b++) {
          const g = dI[2 * (p0 + b) + a]; if (g === 0) continue;
          const c = p0 + a, col = p0 + b;
          for (let k = 0; k < m; k++) jac[k * m + c] -= K[k * m + col] * g;
        }
      }
      luFactor(jac, m, this.perm);
      this.factored = true;
    }

    // Solve one time step for inputs u. Returns iteration count.
    // Newton with a reused (chord) Jacobian while it converges fast, a fresh
    // Jacobian when it does not, and backtracking on the residual norm.
    _solve(u, maxIt) {
      const { m, r, q, Dh, Du, J, v, p, f, dx, lim, limA, limB } = this;
      for (let k = 0; k < m; k++) {
        let s = 0;
        for (let j = 0; j < r; j++) s += Dh[k * r + j] * J[j];
        for (let j = 0; j < q; j++) s += Du[k * q + j] * u[j];
        p[k] = s;
      }
      const v0 = this.vtmp, f1 = this.ftmp, sx = this.sx;
      // fast path for stages whose only devices are swing clamps: if every
      // clamp is far from its limits with zero clamp current, the step is linear
      if (this.clampsOnly) {
        const CA = this.CA; let far = true;
        for (let n = 0; n < CA.length; n += 3) { const x = p[CA[n]]; if (x > CA[n + 1] - 0.6 || x < CA[n + 2] + 0.6) { far = false; break; } }
        if (far) { v.set(p); this.i.fill(0); this.factored = false; this.iters++; return true; }
      }
      this.residual(f);
      let it = 0, ok = false, fresh = false, haveDx = false, ndx = 0;
      const tol = 1e-18 * m;
      for (; it < maxIt; it++) {
        if (!haveDx) {
          if (!this.factored) { this.factor(); fresh = true; } else fresh = false;
          for (let k = 0; k < m; k++) dx[k] = -f[k];
          luSolve(this.jac, dx, m, this.perm);
          ndx = 0; for (let k = 0; k < m; k++) ndx += dx[k] * dx[k];
        } else fresh = false;
        haveDx = false;
        if (ndx < tol) { // apply the last (tiny) correction, currents updated to first order
          const i = this.i, dI = this.dI;
          for (let k = 0; k < m; k++) v[k] += dx[k];
          for (let n = 0; n < this.QA.length; n += 5) { const p = this.QA[n]; const a1 = dx[p], a2 = dx[p + 1];
            i[p] += dI[2 * p] * a1 + dI[2 * p + 1] * a2; i[p + 1] += dI[2 * p + 2] * a1 + dI[2 * p + 3] * a2; }
          for (let n = 0; n < this.DA.length; n += 3) { const p = this.DA[n]; i[p] += dI[2 * p] * dx[p]; }
          for (let n = 0; n < this.CA.length; n += 3) { const p = this.CA[n]; i[p] += dI[2 * p] * dx[p]; }
          for (let n = 0; n < this.RV.length; n++) { const p = this.RV[n].p; i[p] += dI[2 * p] * dx[p]; }
          ok = true; break;
        }
        v0.set(v);
        // damped Newton with the natural monotonicity test (Deuflhard):
        // accept when the next Newton correction, using the same Jacobian, is smaller
        let alpha = 1, accepted = false, ns = 0;
        for (let tries = 0; tries < 10; tries++) {
          for (let k = 0; k < m; k++) {
            let nv = v0[k] + alpha * dx[k];
            const t = lim[k];
            if (t === 1) nv = pnjlim(nv, v0[k], VT, 0.6);
            else if (t === 2) nv = pnjlim(nv, v0[k], limA[k], 0.6);
            else if (t === 3) { // entering the clamp: stop at the knee, let the next Jacobian see it
              const hi = limA[k], lo = limB[k];
              if (nv > hi + 2 * CLAMP_W && v0[k] < hi + CLAMP_W) nv = hi + 2 * CLAMP_W;
              else if (nv < lo - 2 * CLAMP_W && v0[k] > lo - CLAMP_W) nv = lo - 2 * CLAMP_W;
            }
            v[k] = nv;
          }
          this.residual(f1);
          for (let k = 0; k < m; k++) sx[k] = -f1[k];
          luSolve(this.jac, sx, m, this.perm);
          ns = 0; for (let k = 0; k < m; k++) ns += sx[k] * sx[k];
          if (ns < ndx * (1 - alpha / 4) || ns < tol) { accepted = true; this.contract = ns / ndx; break; }
          alpha *= 0.5;
        }
        f.set(f1);
        if (!accepted && !fresh) { this.factored = false; continue; }
        // keep the (chord) Jacobian while it contracts fast; refresh otherwise.
        // With the Jacobian kept, the monotonicity correction is the next step.
        if (!accepted || alpha < 1 || this.contract > 1e-3) this.factored = false;
        else { dx.set(sx); ndx = ns; haveDx = true; }
      }
      let nrm = 0; for (let k = 0; k < m; k++) nrm += f[k] * f[k];
      this.lastNorm = nrm;
      this.iters += it + 1;
      if (ok) this.factored = true; // the last Jacobian is a good chord for the next step
      return ok;
    }

    // reactive branch voltages and currents, outputs, state update
    _finish(u) {
      const { m, r, q, J, i, Ah, Au, Ai, vr, reac, physI } = this;
      for (let k = 0; k < r; k++) {
        let s = 0;
        for (let j = 0; j < r; j++) s += Ah[k * r + j] * J[j];
        for (let j = 0; j < q; j++) s += Au[k * q + j] * u[j];
        for (let j = 0; j < m; j++) s += Ai[k * m + j] * i[j];
        vr[k] = s;
      }
      const y = this.y, o = y.length, { Oh, Ou, Oi } = this;
      for (let k = 0; k < o; k++) {
        let s = 0;
        for (let j = 0; j < r; j++) s += Oh[k * r + j] * J[j];
        for (let j = 0; j < q; j++) s += Ou[k * q + j] * u[j];
        for (let j = 0; j < m; j++) s += Oi[k * m + j] * i[j];
        y[k] = s;
      }
      for (let k = 0; k < r; k++) {
        const re = reac[k], g = re.g, vv = vr[k];
        physI[k] = g * vv + J[k];
        if (re.k === 'C') J[k] = re.be ? -g * vv : -(2 * g * vv + J[k]);
        else J[k] = re.be ? g * vv + J[k] : 2 * g * vv + J[k];
      }
      this.uPrev.set(u);
    }

    // set the history sources from a physical state (branch v and i)
    importState(vr, ir, v) {
      this.reac.forEach((re, k) => {
        const g = re.g;
        if (re.k === 'C') this.J[k] = re.be ? -g * vr[k] : -(g * vr[k] + ir[k]);
        else this.J[k] = re.be ? ir[k] : ir[k] + g * vr[k];
      });
      this.vr.set(vr); this.physI.set(ir); this.v.set(v); this.factored = false;
    }

    // Re-read the variable resistors' values. Exact at any value; call setT
    // now and then during a long sweep to fold the change back into the matrices.
    updateRV() {
      const RV = this.RV, RVg = this.RVg;
      for (let n = 0; n < RV.length; n++) {
        const e = RV[n].el, g = 1 / e.r() - e.g0;
        if (g !== RVg[n]) { RVg[n] = g; this.factored = false; }
      }
    }

    // One time step. If Newton fails (a hard switching event inside the step),
    // the step is redone as 8 sub-steps on a finer grid, recursively.
    step(u, depth = 0) {
      this.vSave.set(this.v);
      if (this._solve(u, 40)) { this._finish(u); return; }
      if (depth >= 2) { this.fails++; this._finish(u); return; }
      this.substeps++;
      const NS = 8;
      if (!this.fine || this.fine.dirty) {
        if (!this.fine) this.fine = new Circuit(this.net, this.T / NS);
        else this.fine.setT(this.T / NS);
        this.fine.dirty = false;
      }
      const F = this.fine;
      F.updateRV();
      F.importState(this.vr, this.physI, this.vSave);
      F.uPrev.set(this.uPrev);
      const u0 = this.uPrev.slice(), ui = new Float64Array(u.length);
      for (let s = 1; s <= NS; s++) {
        for (let j = 0; j < u.length; j++) ui[j] = u0[j] + (u[j] - u0[j]) * s / NS;
        F.step(ui, depth + 1);
      }
      this.importState(F.vr, F.physI, F.v);
      this.y.set(F.y); this.uPrev.set(u);
      this.fails += F.fails; F.fails = 0;
    }

    // Settle to the DC operating point: backward-Euler steps with a long time
    // step, then switch back to the audio time step keeping the state.
    settle(u, T) {
      const keep = this.reac.map((re) => re.be);
      this.reac.forEach((re) => { re.be = true; });
      this.setT(1e-3);
      // power-up: ramp the sources from zero so Newton tracks the operating point
      const ur = new Float64Array(u.length);
      for (let n = 1; n <= 200; n++) { for (let j = 0; j < u.length; j++) ur[j] = u[j] * n / 200; this._solve(ur, 200); this._finish(ur); }
      for (let n = 0; n < 400; n++) { this._solve(u, 200); this._finish(u); }
      this.setT(1e-2);
      for (let n = 0; n < 200; n++) { this._solve(u, 200); this._finish(u); }
      // capture physical state, go back to the audio time step
      const sv = this.vr.slice(), si = this.reac.map((re, j) => (re.k === 'C' ? 0 : re.g * this.vr[j] + this.J[j]));
      this.reac.forEach((re, j) => { re.be = keep[j]; });
      this.setT(T);
      this.importState(sv, Float64Array.from(si), this.v);
      this.uPrev.set(u);
    }

    nodeVoltageNames() { return this.outNames; }
  }

  function softplus(z) { return z > 30 ? z : z < -30 ? Math.exp(z) : Math.log1p(Math.exp(z)); }
  function sigmoid(z) { return z > 30 ? 1 : z < -30 ? Math.exp(z) : 1 / (1 + Math.exp(-z)); }
  // limited exponential (linear continuation beyond e^80)
  function lexp(x) { return x < 80 ? Math.exp(x) : Math.exp(80) * (1 + x - 80); }
  function dexp(x) { return x < 80 ? Math.exp(x) : Math.exp(80); }
  // SPICE junction voltage limiting
  function pnjlim(vnew, vold, vt, vcrit) {
    if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
      if (vold > 0) { const arg = 1 + (vnew - vold) / vt; vnew = arg > 0 ? vold + vt * Math.log(arg) : vcrit; }
      else vnew = vt * Math.log(vnew / vt);
    }
    return vnew;
  }
  function luFactor(A, n, perm) { // in place, partial pivoting, row permutation in perm
    for (let i = 0; i < n; i++) perm[i] = i;
    for (let c = 0; c < n; c++) {
      let p = c, best = Math.abs(A[c * n + c]);
      for (let r = c + 1; r < n; r++) { const v = Math.abs(A[r * n + c]); if (v > best) { best = v; p = r; } }
      if (p !== c) { for (let j = 0; j < n; j++) { const t = A[c * n + j]; A[c * n + j] = A[p * n + j]; A[p * n + j] = t; } const t = perm[c]; perm[c] = perm[p]; perm[p] = t; }
      const d = A[c * n + c] || 1e-30; A[c * n + c] = d;
      for (let r = c + 1; r < n; r++) {
        const f = A[r * n + c] / d; A[r * n + c] = f; if (f === 0) continue;
        for (let j = c + 1; j < n; j++) A[r * n + j] -= f * A[c * n + j];
      }
    }
  }
  const luTmp = new Float64Array(256);
  function luSolve(A, b, n, perm) {
    const y = luTmp;
    for (let i = 0; i < n; i++) y[i] = b[perm[i]];
    for (let i = 0; i < n; i++) { let s = y[i]; for (let j = 0; j < i; j++) s -= A[i * n + j] * y[j]; y[i] = s; }
    for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let j = i + 1; j < n; j++) s -= A[i * n + j] * y[j]; y[i] = s / A[i * n + i]; }
    for (let i = 0; i < n; i++) b[i] = y[i];
  }

  // ===========================================================================
  // The schematic, stage by stage
  // ===========================================================================
  const VCC = 16, VEE = -16; // +/-16 VA (pod), +/-16 V (main board)

  // Pot model: a 3-terminal pot of total R with wiper ratio a (0 = end "a").
  function pot(net, endA, wiper, endB, total, ratio) {
    net.R(endA, wiper, () => Math.max(1e-3, total * ratio()));
    net.R(wiper, endB, () => Math.max(1e-3, total * (1 - ratio())));
  }

  function stageA(P) {
    const n = new Netlist();
    n.V('in', 'SRC');         // jack voltage (line: tip; mic: pin 2 relative to pin 3 / 2)
    n.V('inN', 'SRCN');       // cold side (line: ring, grounded by a TS plug)
    n.V('vcc', 'VCC'); n.V('vee', 'VEE');
    if (P.input === 'line') {
      // J68 TRS line input
      n.C('SRC', 'LTh', 47e-6); n.R('LTh', 'Bh', 5620);      // C142, R220
      n.C('SRCN', 'LTc', 47e-6); n.R('LTc', 'Bc', 5620);     // C126, R212
      // mic side with nothing plugged: C349/C350 into the phantom feed
      n.C('Bh', 'MPh', 47e-6); n.C('Bc', 'MPc', 47e-6);
    } else {
      // J84 XLR: R556/R540 6.81 Ohm, L48 common-mode choke (transparent to
      // differential signal), C349/C350
      n.R('SRC', 'MPh', 6.81); n.R('SRCN', 'MPc', 6.81);
      n.C('MPh', 'Bh', 47e-6); n.C('MPc', 'Bc', 47e-6);
      n.R('Bh', '0', 1e9); n.R('Bc', '0', 1e9);
    }
    // phantom feed R523/R524 6K81 to the phantom bus (phantom off: bus at ground)
    n.R('MPh', '0', 6810); n.R('MPc', '0', 6810);
    // base networks: R197/R168 1K50 to ground, C110/C79 470p, C367 470p
    n.R('Bh', '0', 1500); n.R('Bc', '0', 1500);
    // input pair
    n.Q('Ch', 'Bh', 'Eh', MODELS['2SA1084']);   // Q24
    n.Q('Cc', 'Bc', 'Ec', MODELS['2SA1084']);   // Q8
    n.R('Ch', 'VEE', 2490); n.R('Cc', 'VEE', 2490);  // R371, R372
    // bias string R483, D80, R484
    n.R('VCC', 'DA', 2490); n.D('DA', 'BIAS', MODELS['1N4148']); n.R('BIAS', 'VEE', 20000);
    // current sources Q64 (hot), Q80 (cold), reference Q63
    n.Q('Sh', 'BIAS', 'SEh', MODELS.MMBT4403); n.R('SEh', 'VCC', 2490); n.C('SEh', 'BIAS', 0.01e-6); n.R('Sh', 'Eh', 470); // Q64 R427 C383 R324
    n.Q('Sc', 'BIAS', 'SEc', MODELS.MMBT4403); n.R('SEc', 'VCC', 2490); n.C('SEc', 'BIAS', 0.01e-6); n.R('Sc', 'Ec', 470); // Q80 R428 C384 R284
    n.Q('REF', 'BIAS', 'SEr', MODELS.MMBT4403); n.R('SEr', 'VCC', 2490); n.R('REF', 'VEE', 2490);                         // Q63 R426 R236(0R)+R267
    // gain leg between the emitters: C1 1000u, TRIM R162 + R1 3R32 (L1 4.7uH: see OMITTED)
    n.C('Ec', 'G1', 1000e-6);
    n.RV('G1', 'Eh', () => P.trimOhms + 3.32);
    // servo amps and feedback
    n.U('U17A', 'REF', 'Cc', 'Oc', 'NJM2068', VCC, VEE);
    n.U('U25A', 'REF', 'Ch', 'Oh', 'NJM2068', VCC, VEE);
    n.R('Oc', 'Ec', 5110); n.R('Oh', 'Eh', 5110);                                          // R268, R323
    // U33A differential amp
    n.R('Oc', 'D33n', 10000); n.R('Oh', 'D33p', 10000);         // R492, R425
    n.R('D33p', '0', 5110);                                    // R370
    n.R('O33', 'D33n', 5110);                                   // R482
    n.U('U33A', 'D33p', 'D33n', 'O33', 'NJM2068', VCC, VEE);
    n.out('pre_hot', 'Oh'); n.out('pre_cold', 'Oc'); n.out('diff', 'O33');
    return n;
  }

  function stageB(P) {
    const n = new Netlist();
    n.V('in', 'O33'); n.V('vcc', 'VCC'); n.V('vee', 'VEE');
    n.C('O33', 'INS', 47e-6); n.R('INS', '0', 10000);          // C94, R167 (insert jack, nothing plugged)
    n.C('INS', 'C121', 47e-6); n.R('C121', '0', 20000);        // C121, R137
    // LO CUT network U104A (always loads INS)
    n.C('INS', 'LCa', 0.22e-6); n.R('LCa', '0', 5100);          // C106, R104
    n.C('LCa', 'LCb', 0.22e-6); n.R('LCb', 'LCo', 1300);        // C105, R105
    n.C('LCb', 'LCc', 0.22e-6); n.R('LCc', '0', 62000);         // C104, R103
    n.U('U104A', 'LCc', 'LCo', 'LCo', 'NJM4560', VCC, VEE);
    n.C('LCo', 'LCd', 47e-6); n.R('LCd', '0', 20000);           // C107, R106
    // SW101: select the EQ input
    if (P.loCut) n.R('LCd', 'EQI', 1e-3); else n.R('C121', 'EQI', 1e-3);
    // mid EQ: U101B difference stage
    n.R('EQI', 'N6', 10000); n.R('N6', 'EQO', 10000);           // R122, R123
    n.U('U101B', 'VA', 'N6', 'EQO', 'NJM4560', VCC, VEE);
    // MID pot R120 10K lin between EQI and EQO, wiper into the sweep network
    pot(n, 'EQI', 'MW', 'EQO', 10000, () => P.mid);
    n.C('MW', 'M7', 0.0047e-6);                                // C114
    n.R('M7', 'M8', () => P.freqOhms);                         // R121A
    n.R('M8', 'G', 6200);                                      // R135
    n.R('VA', 'M9', 6200); n.R('M9', 'G', () => P.freqOhms);   // R136, R121B
    n.C('VA', 'G', 0.0022e-6);                                 // C115
    n.R('P', '0', 3900); n.R('P', 'VA', 5100);                 // R134, R133
    n.U('U101A', 'P', 'G', 'VA', 'NJM4560', VCC, VEE);
    // HI: C110, R119 50K lin, C111 ; LOW: R117, R118 50K lin, R125, C109, C108
    n.C('EQO', 'H1', 0.0068e-6); pot(n, 'H1', 'HW', 'H2', 50000, () => P.hi); n.C('H2', 'POST', 0.0068e-6);
    n.R('HW', 'M', 3900);                                      // R124
    n.R('EQO', 'L1', 5600); pot(n, 'L1', 'LW', 'L2', 50000, () => P.low); n.R('L2', 'POST', 5600);
    n.C('L1', 'LW', 0.033e-6); n.C('LW', 'L2', 0.033e-6);      // C109, C108
    n.R('LW', 'M', 10000);                                     // R126
    n.R('M', 'POST', 1e6);                                     // R127
    n.U('U105A', '0', 'M', 'POST', 'NJM4560', VCC, VEE);
    n.out('locut', 'LCo'); n.out('eqmid', 'EQO'); n.out('va', 'VA'); n.out('post', 'POST');
    return n;
  }

  function stageC(P) {
    const n = new Netlist();
    n.V('in', 'POST'); n.V('vcc', 'VCC'); n.V('vee', 'VEE');
    n.C('POST', 'F1', 47e-6);                                  // C120
    pot(n, 'F1', 'FW', '0', 10000, () => 1 - P.faderRatio);    // R107 (ratio = wiper/top)
    n.C('FW', 'F2', 47e-6); n.R('F2', '0', 100000);            // C113, R131
    n.R('F3', '0', 510); n.R('FO', 'F3', 1100);                 // R102, R101
    n.U('U103A', 'F2', 'F3', 'FO', 'NJM4560', VCC, VEE);
    n.out('fader', 'FO');
    return n;
  }

  // ===========================================================================
  // Controls that are not on the schematic
  // ===========================================================================
  // TRIM R162 is a 10K special-taper part ("10KZY") whose curve is not in the
  // manual. Choice: the taper that makes the printed gain scale even, i.e.
  // preamp gain linear in dB with rotation from the pot's 10K end to its 0R end.
  const RFB = 5110, RG_MIN = 3.32;
  const DRIVE_TICK = 5e-3; // s between stage A rebuilds while Drive glides
  const GD_MIN = 1 + 2 * RFB / (10000 + RG_MIN), GD_MAX = 1 + 2 * RFB / RG_MIN;
  function trimResistance(rotation) {
    const r = Math.min(1, Math.max(0, rotation));
    const gd = Math.exp(Math.log(GD_MIN) + r * (Math.log(GD_MAX) - Math.log(GD_MIN)));
    return Math.max(0, 2 * RFB / (gd - 1) - RG_MIN);
  }
  // FREQ R121 is a 500K dual "C" (reverse log) taper. Standard C law: 10% of
  // the resistance at mid rotation, measured from the clockwise end.
  function cTaper(rot) { const b = 81; return (Math.pow(b, 1 - rot) - 1) / (b - 1); }

  // ===========================================================================
  // Oversampler (linear-phase polyphase FIR)
  // ===========================================================================
  function designLowpass(taps, cutoff, factor) {
    const h = new Float64Array(taps), beta = 8, m = taps - 1;
    const i0 = (x) => { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; };
    const fc = cutoff / factor / 2; let sum = 0;
    for (let n = 0; n < taps; n++) {
      const x = n - m / 2, sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x), r = 2 * n / m - 1;
      h[n] = sinc * i0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0(beta); sum += h[n];
    }
    for (let n = 0; n < taps; n++) h[n] /= sum;
    return h;
  }
  class Oversampler {
    constructor(factor, tpp = 16) {
      this.factor = factor; this.tpp = tpp; this.taps = factor * tpp;
      this.h = designLowpass(this.taps, 0.9, factor);
      this.upBuf = new Float64Array(tpp * 2); this.upPos = 0;
      this.downBuf = new Float64Array(this.taps * 2); this.downPos = 0;
      this.out = new Float64Array(factor);
    }
    up(x) {
      const L = this.factor, P = this.tpp, h = this.h;
      if (L === 1) { this.out[0] = x; return this.out; }
      this.upPos = (this.upPos + 1) % P; this.upBuf[this.upPos] = x; this.upBuf[this.upPos + P] = x;
      for (let p = 0; p < L; p++) { let a = 0; for (let k = 0; k < P; k++) a += h[p + k * L] * this.upBuf[this.upPos + P - k]; this.out[p] = a * L; }
      return this.out;
    }
    down(arr) {
      if (this.factor === 1) return arr[0];
      const N = this.taps, h = this.h;
      for (let i = 0; i < arr.length; i++) { this.downPos = (this.downPos + 1) % N; this.downBuf[this.downPos] = arr[i]; this.downBuf[this.downPos + N] = arr[i]; }
      let a = 0; for (let k = 0; k < N; k++) a += h[k] * this.downBuf[this.downPos + N - k];
      return a;
    }
    get latency() { return this.factor === 1 ? 0 : (this.taps - 1) / this.factor; }
  }

  // ===========================================================================
  // Channel
  // ===========================================================================
  const DEFAULTS = {
    drive: 0.3,            // TRIM rotation 0..1
    driveSlewMs: 30,       // Drive smoothing time constant in ms (0 = jump)
    input: 'line',         // 'line' (J68, unbalanced TS plug) or 'mic' (J84, balanced)
    fullScaleVolts: 0.7746 * Math.pow(10, 18 / 20) * Math.SQRT2, // 0 dBFS = +18 dBu (EBU R68)
    loCut: false,
    eqHigh: 0.5, eqMid: 0.5, eqLow: 0.5, eqFreq: 0.5, // pot rotations, 0.5 = centre detent
    faderDb: 0,            // 0 = "U" mark, max +10
    outputDb: 0,
  };

  class MackieChannel {
    constructor(sampleRate, opts = {}) {
      this.fs = sampleRate;
      this.os = opts.oversample || 1; // circuit runs at fs * os
      this.T = 1 / (this.fs * this.os);
      this.ovs = new Oversampler(this.os);
      this.p = Object.assign({}, DEFAULTS);
      for (const k of Object.keys(DEFAULTS)) if (opts[k] !== undefined) this.p[k] = opts[k];
      this.P = {}; // circuit-level values read by the netlists
      this.driveNow = this.driveMid = this.p.drive; // smoothed TRIM rotation the circuit actually sees
      this.slewCount = 0;
      this._derive();
      this.uA = new Float64Array(4); this.uB = new Float64Array(3); this.uC = new Float64Array(3);
      this.uA[2] = this.uB[1] = this.uC[1] = VCC; this.uA[3] = this.uB[2] = this.uC[2] = VEE;
      this._build(true);
      this.osBuf = new Float64Array(this.os);
      this.peaks = { pre: 0, diff: 0, eq: 0, fader: 0 };
      this.iters = 0; this.steps = 0;
      this.pending = false;
    }

    _derive() {
      const p = this.p, P = this.P;
      P.trimOhms = trimResistance(this.driveNow);
      // Drive slew: two one-poles in series (tau/2 each) on the rotation, so the
      // glide starts and ends gently. The taper is dB-linear, so the gain glides
      // evenly in dB. The trim is exact every sample through the variable-
      // resistor port; stage A's matrices are rebuilt every DRIVE_TICK.
      const tau = Math.max(0, p.driveSlewMs) / 1000;
      this.slewA = tau > 0 ? 1 - Math.exp(-2 * this.T / tau) : 1;
      this.slewTick = Math.max(1, Math.round(DRIVE_TICK / this.T));
      P.input = p.input; P.loCut = !!p.loCut;
      // pot ratio 0 is the boost end on all three EQ pots; controls are clockwise rotation
      P.hi = 1 - p.eqHigh; P.low = 1 - p.eqLow; P.mid = 1 - p.eqMid;
      P.freqOhms = Math.max(50, 500000 * cTaper(p.eqFreq));
      // fader: U103A gain is 1 + R101/R102; "U" puts the wiper at 1/gain
      const ampGain = 1 + 1100 / 510;
      P.faderRatio = p.faderDb <= -90 ? 0 : Math.min(1, Math.pow(10, p.faderDb / 20) / ampGain);
      this.inGain = p.fullScaleVolts;
      this.outGain = Math.pow(10, p.outputDb / 20) / p.fullScaleVolts;
    }

    _build(fresh) {
      const P = this.P;
      const key = P.input + '|' + P.loCut;
      if (fresh || key !== this.topoKey) {
        // topology change: new circuits, settle each to its operating point
        this.topoKey = key;
        this.A = new Circuit(stageA(P), this.T);
        this.B = new Circuit(stageB(P), this.T);
        this.C = new Circuit(stageC(P), this.T);
        this.uA[0] = this.uA[1] = 0; this.uB[0] = 0; this.uC[0] = 0;
        this.A.settle(this.uA, this.T);
        this.uB[0] = this.A.y[this.A.outNames.indexOf('diff')];
        this.B.settle(this.uB, this.T);
        this.uC[0] = this.B.y[this.B.outNames.indexOf('post')];
        this.C.settle(this.uC, this.T);
        this.ixA = { hot: this.A.outNames.indexOf('pre_hot'), cold: this.A.outNames.indexOf('pre_cold'), diff: this.A.outNames.indexOf('diff') };
        this.ixB = { post: this.B.outNames.indexOf('post'), mid: this.B.outNames.indexOf('eqmid'), va: this.B.outNames.indexOf('va') };
        this.ixC = { fader: this.C.outNames.indexOf('fader') };
      } else {
        // value change only: rebuild the affected stages' matrices, keep the state
        const k = this.changed || {};
        if (k.A) this.A.setT(this.T);
        if (k.B) this.B.setT(this.T);
        if (k.C) this.C.setT(this.T);
      }
      this.changed = {};
    }

    setParams(o = {}) {
      let changed = false;
      const stageOf = { input: 'A', loCut: 'B', eqHigh: 'B', eqMid: 'B', eqLow: 'B', eqFreq: 'B', faderDb: 'C' };
      this.changed = this.changed || {};
      for (const k of Object.keys(DEFAULTS)) if (o[k] !== undefined && o[k] !== this.p[k]) {
        this.p[k] = o[k]; changed = true; if (stageOf[k]) this.changed[stageOf[k]] = true;
      }
      if (!changed) return;
      this._derive();
      this.pending = true; // applied at the start of the next block
    }

    info() {
      // readouts follow the knob (the target), not the gliding value
      const rg = trimResistance(this.p.drive) + RG_MIN;
      const gd = 1 + 2 * RFB / rg;
      // line pad: R197 || R523 (phantom feed, via C349) against R220
      const shunt = 1 / (1 / 1500 + 1 / 6810);
      const pad = this.p.input === 'mic' ? 1 : shunt / (5620 + shunt);
      return {
        trimOhms: rg - RG_MIN, gainLegOhms: rg, driveNow: this.driveNow,
        preGainDb: 20 * Math.log10(gd * 5110 / 10000),
        channelGainDb: 20 * Math.log10(pad * gd * 5110 / 10000),
        padDb: 20 * Math.log10(pad),
        c1CornerHz: 1 / (2 * Math.PI * rg * 1000e-6),
        latencySamples: this.ovs.latency,
        avgIterations: this.steps ? this.A.iters / this.steps : 0,
        substeps: this.A.substeps + this.B.substeps + this.C.substeps,
        unconverged: this.A.fails + this.B.fails + this.C.fails,
      };
    }

    readPeaks() { const p = this.peaks; this.peaks = { pre: 0, diff: 0, eq: 0, fader: 0 }; return p; }

    process(input, output, n = input.length) {
      if (this.pending) { this.pending = false; this._build(false); }
      const os = this.os, buf = this.osBuf, A = this.A, B = this.B, C = this.C, pk = this.peaks;
      const uA = this.uA, uB = this.uB, uC = this.uC, ia = this.ixA, ib = this.ixB, ic = this.ixC;
      const mic = this.p.input === 'mic', target = this.p.drive;
      let gliding = this.driveNow !== target;
      for (let s = 0; s < n; s++) {
        const up = this.ovs.up(input[s] * this.inGain);
        for (let k = 0; k < os; k++) {
          const v = up[k];
          if (gliding) {
            const a = this.slewA, m1 = this.driveMid += (target - this.driveMid) * a;
            let d = this.driveNow + (m1 - this.driveNow) * a;
            if (Math.abs(target - d) < 1e-5 && Math.abs(target - m1) < 1e-5) { d = this.driveMid = target; gliding = false; }
            this.driveNow = d;
            this.P.trimOhms = trimResistance(d);
            if (!gliding || ++this.slewCount >= this.slewTick) { this.slewCount = 0; A.setT(this.T); }
            else A.updateRV();
          }
          if (mic) { uA[0] = 0.5 * v; uA[1] = -0.5 * v; } else { uA[0] = v; uA[1] = 0; }
          A.step(uA); this.steps++;
          const ya = A.y;
          const ph = Math.max(Math.abs(ya[ia.hot]), Math.abs(ya[ia.cold])); if (ph > pk.pre) pk.pre = ph;
          const d = ya[ia.diff]; if (Math.abs(d) > pk.diff) pk.diff = Math.abs(d);
          uB[0] = d; B.step(uB);
          const yb = B.y;
          const pe = Math.max(Math.abs(yb[ib.post]), Math.abs(yb[ib.mid]), Math.abs(yb[ib.va])); if (pe > pk.eq) pk.eq = pe;
          uC[0] = yb[ib.post]; C.step(uC);
          const f = C.y[ic.fader]; if (Math.abs(f) > pk.fader) pk.fader = Math.abs(f);
          buf[k] = f;
        }
        output[s] = this.ovs.down(buf) * this.outGain;
      }
      return output;
    }
  }

  // swing limits per stage, for meters
  const LIMITS = {
    pre: VCC - MODELS.NJM2068.headroom, diff: VCC - MODELS.NJM2068.headroom,
    eq: VCC - MODELS.NJM4560.headroom, fader: VCC - MODELS.NJM4560.headroom,
  };

  return { MackieChannel, Circuit, Netlist, stageA, stageB, stageC, trimResistance, MODELS, LIMITS, DEFAULTS, factory: MackieChannelCoreFactory };
});
