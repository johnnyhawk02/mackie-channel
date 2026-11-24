/*
 * colour-circuits-core.js
 *
 * More colouring circuits, modelled part by part like the Mackie channel:
 *
 *   ts808  Ibanez TS808 Tube Screamer: 2SC1815 input buffer, JRC4558
 *          non-inverting clipper with 1N914 diodes in the feedback, tone stage,
 *          output buffer. Drive = the 500K DRIVE pot.
 *   fuzz   Dallas Arbiter Fuzz Face: two AC128 germanium PNPs, 9 V positive
 *          ground. Drive = the 1K FUZZ pot.
 *   tweed  Fender 5F1 Champ preamp: two 12AX7 triode stages with the 1M VOLUME
 *          pot between them, into the 6V6 grid. Drive = the VOLUME pot.
 *
 * The solver is a copy of the Mackie core's (nodal DK form, Newton, sub-step
 * fallback) with one addition: a triode (Koren plate-current model plus a
 * smooth grid-conduction diode). It is a copy so the Mackie core and its
 * bit-exact VST3 port are not touched.
 *
 * Values are from the published schematics and circuit analyses
 * (electrosmash.com Fuzz Face and Tube Screamer analyses, Fender 5F1 layout
 * as described by robrobinette.com and ampbooks.com). Device parameters marked
 * ASSUMED are typical values, not measured parts.
 *
 * Same API shape as MackieChannel: new ColourCircuit(sampleRate, { model,
 * drive, oversample, autoLevel, outputDb }), process(input, output),
 * setParams({...}), info().
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ColourCircuitsCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function ColourCircuitsCoreFactory() {
  'use strict';

  const VT = 0.025852; // thermal voltage at 27 C
  const CLAMP_G = 0.1, CLAMP_W = 0.002;

  const MODELS = {
    // JRC4558: GBW 3 MHz, A0 100 dB (datasheet typicals). Swing headroom
    // ASSUMED 1.5 V to each rail on a 9 V single supply.
    JRC4558: { gbw: 3e6, sr: 1.7e6, a0: Math.pow(10, 100 / 20), headroom: 1.5, cc: 30e-12, rout: 50 },
    // 1N914 = 1N4148 die (LTspice standard.dio model).
    '1N914': { Is: 2.52e-9, N: 1.752 },
    // 2SC1815 GR: hFE 200-400. Is ASSUMED 1e-14 (typical small-signal NPN).
    '2SC1815': { type: 'npn', Is: 1e-14, Bf: 300, Br: 3, Vaf: 100 },
    // AC128 germanium PNP. Electrosmash gives beta 70-80 for Q1 and 110-130 for
    // Q2 in a good-sounding unit. Is ASSUMED 2e-7 (germanium Vbe ~0.2 V at
    // 0.3 mA), chosen so Q2's collector sits near the -4.5 V a Fuzz Face is
    // biased to. Leakage is not modelled separately.
    AC128_Q1: { type: 'pnp', Is: 2e-7, Bf: 75, Br: 5, Vaf: 40 },
    AC128_Q2: { type: 'pnp', Is: 2e-7, Bf: 120, Br: 5, Vaf: 40 },
    // 12AX7 Koren parameters (Koren 1996 / Duncan tube data). Grid conduction
    // ASSUMED: about 1.5 kOhm above +0.2 V, smooth 0.1 V knee.
    '12AX7': { mu: 100, ex: 1.4, kg1: 1060, kp: 600, kvb: 300, rgk: 1500, vg0: 0.2, gw: 0.1 },
    // 6V6 grid-cathode junction as a diode, for where the preamp drives it
    // into grid current. ASSUMED.
    GRID6V6: { Is: 1e-8, N: 2 },
  };

  // ===========================================================================
  // Netlist and solver (copied from mackie-channel-core.js, plus the triode)
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
    // triode: plate, grid, cathode
    TRI(p, g, k, m) { this.els.push({ k: 'TRI', c: p, b: g, e: k, m }); }
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
        } else if (e.k === 'TRI') {
          const G = node(e.b), P = node(e.c), K = node(e.e);
          // port1 = grid-cathode (grid current), port2 = plate-cathode (plate current)
          devs.push({ k: 'TRI', p: ports.length, m: e.m });
          ports.push({ va: G, vb: K, ia: G, ib: K }, { va: P, vb: K, ia: P, ib: K });
        } else if (e.k === 'CLAMP') { devs.push({ k: 'CL', p: ports.length, hi: e.hi, lo: e.lo }); ports.push({ va: node(e.x), vb: -1, ia: node(e.x), ib: -1 }); }
        else if (e.k === 'RV') { devs.push({ k: 'RV', p: ports.length, el: e }); ports.push({ va: node(e.a), vb: node(e.b), ia: node(e.a), ib: node(e.b) }); }
        else if (e.k === 'C' || e.k === 'L') reac.push({ a: node(e.a), b: node(e.b), k: e.k, val: e.k === 'C' ? e.c : e.l, be: e.be });
      }
      this.ports = ports; this.devs = devs; this.reac = reac;
      const qa = [], ta = [], da = [], ca = [], rv = [], lim = new Int8Array(ports.length);
      for (const d of devs) {
        if (d.k === 'Q') { qa.push(d.p, d.Is, d.Bf, d.Br, d.Vaf); lim[d.p] = 1; lim[d.p + 1] = 1; }
        else if (d.k === 'D') { da.push(d.p, d.Is, d.nvt); lim[d.p] = 2; }
        else if (d.k === 'RV') rv.push(d);
        else if (d.k === 'TRI') { const M = d.m; ta.push(d.p, M.mu, M.ex, M.kg1, M.kp, M.kvb, M.rgk, M.vg0, M.gw); lim[d.p] = 4; }
        else { ca.push(d.p, d.hi, d.lo); lim[d.p] = 3; }
      }
      this.clampsOnly = qa.length === 0 && ta.length === 0 && da.length === 0 && rv.length === 0;
      this.RV = rv; this.RVg = new Float64Array(rv.length); // conductance change since the last build
      this.QA = Float64Array.from(qa); this.TA = Float64Array.from(ta); this.DA = Float64Array.from(da); this.CA = Float64Array.from(ca); this.lim = lim;
      this.limA = new Float64Array(ports.length); this.limB = new Float64Array(ports.length);
      for (const d of devs) { if (d.k === 'TRI') this.limA[d.p] = d.m.vg0; if (d.k === 'D') this.limA[d.p] = d.nvt; if (d.k === 'CL') { this.limA[d.p] = d.hi; this.limB[d.p] = d.lo; } }
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
        this.vr = new Float64Array(r); this.perm = new Int32Array(m); this.invPiv = new Float64Array(m);
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
      // triodes (Koren 1996 plate current, smooth grid-conduction diode):
      // packed [p, mu, ex, kg1, kp, kvb, rgk, vg0, gw]
      const TA = this.TA;
      for (let n = 0; n < TA.length; n += 9) {
        const p = TA[n], mu = TA[n + 1], ex = TA[n + 2], kg1 = TA[n + 3], kp = TA[n + 4], kvb = TA[n + 5];
        const rgk = TA[n + 6], vg0 = TA[n + 7], gw = TA[n + 8];
        const vg = v[p], vp = v[p + 1];
        const zg = (vg - vg0) / gw;
        i[p] = gw / rgk * softplus(zg); dI[2 * p] = sigmoid(zg) / rgk + 1e-12; dI[2 * p + 1] = 0;
        const s = Math.sqrt(kvb + vp * vp), z = kp * (1 / mu + vg / s), Lz = softplus(z), sz = sigmoid(z);
        const e1 = vp * Lz / kp;
        if (e1 > 0) {
          const pw = Math.pow(e1, ex - 1), k2 = 2 / kg1;
          i[p + 1] = k2 * pw * e1;
          const dE1g = vp * sz / s, dE1p = Lz / kp - vp * vp * vg * sz / (s * s * s);
          dI[2 * p + 2] = k2 * ex * pw * dE1g + 0; dI[2 * p + 3] = k2 * ex * pw * dE1p + 1e-12;
        } else { i[p + 1] = 0; dI[2 * p + 2] = 0; dI[2 * p + 3] = 1e-12; }
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
        let s0 = 0, s1 = 0, j = 0; // two interleaved partial sums (as the C++: a shorter dependency chain)
        for (; j + 1 < m; j += 2) { s0 += K[row + j] * i[j]; s1 += K[row + j + 1] * i[j + 1]; }
        if (j < m) s0 += K[row + j] * i[j];
        s = s0 + s1;
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
        const d = devs[di], p0 = d.p, w = d.k === 'Q' || d.k === 'TRI' ? 2 : 1;
        for (let a = 0; a < w; a++) for (let b = 0; b < w; b++) {
          const g = dI[2 * (p0 + b) + a]; if (g === 0) continue;
          const c = p0 + a, col = p0 + b;
          for (let k = 0; k < m; k++) jac[k * m + c] -= K[k * m + col] * g;
        }
      }
      luFactor(jac, m, this.perm, this.invPiv);
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
          luSolve(this.jac, dx, m, this.perm, this.invPiv);
          ndx = 0; for (let k = 0; k < m; k++) ndx += dx[k] * dx[k];
        } else fresh = false;
        haveDx = false;
        if (ndx < tol) { // apply the last (tiny) correction, currents updated to first order
          const i = this.i, dI = this.dI;
          for (let k = 0; k < m; k++) v[k] += dx[k];
          for (let n = 0; n < this.QA.length; n += 5) { const p = this.QA[n]; const a1 = dx[p], a2 = dx[p + 1];
            i[p] += dI[2 * p] * a1 + dI[2 * p + 1] * a2; i[p + 1] += dI[2 * p + 2] * a1 + dI[2 * p + 3] * a2; }
          for (let n = 0; n < this.DA.length; n += 3) { const p = this.DA[n]; i[p] += dI[2 * p] * dx[p]; }
          for (let n = 0; n < this.TA.length; n += 9) { const p = this.TA[n]; const a1 = dx[p], a2 = dx[p + 1];
            i[p] += dI[2 * p] * a1; i[p + 1] += dI[2 * p + 2] * a1 + dI[2 * p + 3] * a2; }
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
            else if (t === 4) { // grid entering conduction: at most 0.25 V a step
              const top = Math.max(v0[k], limA[k]);
              if (nv > top + 0.25) nv = top + 0.25;
            }
            else if (t === 3) { // entering the clamp: stop at the knee, let the next Jacobian see it
              const hi = limA[k], lo = limB[k];
              if (nv > hi + 2 * CLAMP_W && v0[k] < hi + CLAMP_W) nv = hi + 2 * CLAMP_W;
              else if (nv < lo - 2 * CLAMP_W && v0[k] > lo - CLAMP_W) nv = lo - 2 * CLAMP_W;
            }
            v[k] = nv;
          }
          this.residual(f1);
          for (let k = 0; k < m; k++) sx[k] = -f1[k];
          luSolve(this.jac, sx, m, this.perm, this.invPiv);
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
  function luFactor(A, n, perm, inv) { // in place, partial pivoting, row permutation in perm, inv = 1 / the pivots
    for (let i = 0; i < n; i++) perm[i] = i;
    for (let c = 0; c < n; c++) {
      let p = c, best = Math.abs(A[c * n + c]);
      for (let r = c + 1; r < n; r++) { const v = Math.abs(A[r * n + c]); if (v > best) { best = v; p = r; } }
      if (p !== c) { for (let j = 0; j < n; j++) { const t = A[c * n + j]; A[c * n + j] = A[p * n + j]; A[p * n + j] = t; } const t = perm[c]; perm[c] = perm[p]; perm[p] = t; }
      const d = A[c * n + c] || 1e-30; A[c * n + c] = d; inv[c] = 1 / d;
      for (let r = c + 1; r < n; r++) {
        const f = A[r * n + c] / d; A[r * n + c] = f; if (f === 0) continue;
        for (let j = c + 1; j < n; j++) A[r * n + j] -= f * A[c * n + j];
      }
    }
  }
  const luTmp = new Float64Array(256);
  function luSolve(A, b, n, perm, inv) { // two interleaved partial sums per row, as the C++
    const y = luTmp;
    for (let i = 0; i < n; i++) y[i] = b[perm[i]];
    for (let i = 0; i < n; i++) {
      const row = i * n; let s0 = 0, s1 = 0, j = 0;
      for (; j + 1 < i; j += 2) { s0 += A[row + j] * y[j]; s1 += A[row + j + 1] * y[j + 1]; }
      if (j < i) s0 += A[row + j] * y[j];
      y[i] = y[i] - (s0 + s1);
    }
    for (let i = n - 1; i >= 0; i--) {
      const row = i * n; let s0 = 0, s1 = 0, j = i + 1;
      for (; j + 1 < n; j += 2) { s0 += A[row + j] * y[j]; s1 += A[row + j + 1] * y[j + 1]; }
      if (j < n) s0 += A[row + j] * y[j];
      y[i] = (y[i] - (s0 + s1)) * inv[i];
    }
    for (let i = 0; i < n; i++) b[i] = y[i];
  }



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
    // up and down filters together delay by taps - factor fast samples: tpp - 1 at the base rate
    get latency() { return this.factor === 1 ? 0 : this.tpp - 1; }
  }


  // ===========================================================================
  // Circuits
  // ===========================================================================
  // audio ("A") taper: 10% of the track at mid rotation
  function aTaper(rot) { const b = 81; return (Math.pow(b, rot) - 1) / (b - 1); }
  // a pot as two variable resistors either side of the wiper; ratio = wiper's
  // share of the track measured from endB
  function potRV(n, endA, wiper, endB, total, ratio) {
    n.RV(endA, wiper, () => Math.max(1, total * (1 - ratio())));
    n.RV(wiper, endB, () => Math.max(1, total * ratio()));
  }

  const CIRCUITS = {
    ts808: {
      name: 'Tube Screamer',
      desc: 'Ibanez TS808: JRC4558 op-amp with 1N914 diodes in its feedback, mid-hump tone stage.',
      fullScaleVolts: 1.0, // 0 dBFS = 1 V peak at the input jack (a hot pickup)
      supplies: [9],
      // DRIVE pot P1 500K log, in series with R6 51K
      setDrive(P, d) { P.drive = 500e3 * aTaper(d); },
      build(P) {
        const n = new Netlist();
        n.V('in', 'IN'); n.V('vcc', 'VCC');
        // 4.5 V bias: R32/R33 10K divider, C17 100u
        n.R('VCC', 'VB', 10e3); n.R('VB', '0', 10e3); n.C('VB', '0', 100e-6, true);
        // input buffer: R1 1K, C1 0.02u, R2 510K bias, Q1 emitter follower, R3 10K
        n.R('IN', 'I1', 1e3); n.C('I1', 'B1', 0.02e-6); n.R('B1', 'VB', 510e3);
        n.Q('VCC', 'B1', 'E1', MODELS['2SC1815']); n.R('E1', '0', 10e3);
        // clipping amp U1A: C2 1u, R5 10K to bias, R4 4K7 + C3 0.047u to ground,
        // feedback R6 51K + DRIVE, C4 51p, D1/D2 1N914 anti-parallel
        n.C('E1', 'P', 1e-6); n.R('P', 'VB', 10e3);
        n.R('N', 'M', 4.7e3); n.C('M', '0', 0.047e-6);
        n.R('O1', 'F', 51e3); n.RV('F', 'N', () => Math.max(1, P.drive));
        n.C('O1', 'N', 51e-12);
        n.D('O1', 'N', MODELS['1N914']); n.D('N', 'O1', MODELS['1N914']);
        n.U('U1A', 'P', 'N', 'O1', 'JRC4558', 9, 0);
        // tone: R7 1K + C5 0.22u low-pass, U1B with the 20K TONE pot between its
        // inputs, wiper through R10 220R + C6 0.22u to AC ground. Tone at noon.
        n.R('O1', 'T1', 1e3); n.C('T1', '0', 0.22e-6);
        n.R('T1', 'TP', 1e3); n.R('TP', 'VB', 10e3);
        n.R('TP', 'TW', 10e3); n.R('TW', 'TN', 10e3);
        n.R('TW', 'TR', 220); n.C('TR', 'VB', 0.22e-6);
        n.R('O2', 'TN', 1e3);
        n.U('U1B', 'TP', 'TN', 'O2', 'JRC4558', 9, 0);
        // output: C7 1u to the 100K LEVEL pot (full up), C8 to Q3 biased by
        // 510K, R13 10K emitter, 100R + C9 10u, 10K load
        n.C('O2', 'L1', 1e-6); n.R('L1', '0', 100e3);
        n.C('L1', 'B3', 1e-6); n.R('B3', 'VB', 510e3);
        n.Q('VCC', 'B3', 'E3', MODELS['2SC1815']); n.R('E3', '0', 10e3);
        n.R('E3', 'OX', 100); n.C('OX', 'OUT', 10e-6); n.R('OUT', '0', 10e3);
        n.out('out', 'OUT'); n.out('clip', 'O1');
        return n;
      },
    },

    fuzz: {
      name: 'Fuzz Face',
      desc: 'Dallas Arbiter Fuzz Face: two AC128 germanium transistors, 9 V positive ground.',
      fullScaleVolts: 1.0,
      supplies: [-9],
      // Drive turns up the FUZZ pot (1K linear) and the guitar's own volume
      // pot together. Backing the guitar volume off is how a Fuzz Face is
      // cleaned up: it lowers the level and raises the source impedance the
      // germanium input sees.
      setDrive(P, d) { P.fuzz = 1 - Math.pow(1 - d, 3); P.gvol = aTaper(0.7 + 0.3 * d); },
      build(P) {
        const n = new Netlist();
        n.V('in', 'IN'); n.V('vee', 'VEE');
        // source: a passive pickup (ASSUMED 8K) through a 250K audio volume pot
        n.R('IN', 'PU', 8e3);
        potRV(n, 'PU', 'I0', '0', 250e3, () => P.gvol);
        n.C('I0', 'B1', 2.2e-6);                                  // C1 2.2u
        n.Q('C1', 'B1', '0', MODELS.AC128_Q1); n.R('C1', 'VEE', 33e3); // Q1, R1 33K
        n.Q('C2', 'C1', 'E2', MODELS.AC128_Q2);                   // Q2
        n.R('C2', 'X', 8.2e3); n.R('X', 'VEE', 470);              // R3 8K2, R2 470R
        n.R('E2', 'B1', 100e3);                                   // R4 100K feedback
        potRV(n, 'E2', 'W', '0', 1000, () => P.fuzz);             // FUZZ 1K
        n.C('W', '0', 20e-6);                                     // C2 20u from the wiper
        n.C('X', 'OUT', 0.01e-6); n.R('OUT', '0', 500e3);         // C3 10n, VOLUME 500K full up
        n.out('out', 'OUT'); n.out('clip', 'C2');
        return n;
      },
    },

    tweed: {
      name: 'Tweed Champ',
      desc: 'Fender 5F1 Champ preamp: two 12AX7 stages with the volume pot between them, into the 6V6 grid.',
      fullScaleVolts: 1.0,
      supplies: [250, 20],
      // VOLUME 1M audio taper. Drive 0 is a low (clean) setting, not off.
      setDrive(P, d) { P.vol = aTaper(0.2 + 0.8 * d); },
      build(P) {
        const n = new Netlist();
        n.V('in', 'IN'); n.V('bp', 'BP'); n.V('vk6', 'K6');
        // V1A: 68K grid stopper, 100K plate, 1K5 cathode with 25u bypass
        n.R('IN', 'G1', 68e3);
        n.TRI('P1', 'G1', 'K1', MODELS['12AX7']);
        n.C('G1', 'P1', 1.7e-12); n.C('G1', 'K1', 1.6e-12); // 12AX7 Cgp, Cgk
        n.R('P1', 'BP', 100e3); n.R('K1', '0', 1500); n.C('K1', '0', 25e-6);
        // coupling 0.022u into the VOLUME pot; the wiper is V1B's grid
        n.C('P1', 'VT', 0.022e-6);
        potRV(n, 'VT', 'G2', '0', 1e6, () => P.vol);
        // V1B: 100K plate, 1K5 cathode unbypassed (the feedback point; the
        // output-transformer feedback itself is not modelled)
        n.TRI('P2', 'G2', 'K2', MODELS['12AX7']);
        n.C('G2', 'P2', 1.7e-12); n.C('G2', 'K2', 1.6e-12);
        n.R('P2', 'BP', 100e3); n.R('K2', '0', 1500);
        // 0.022u into the 6V6 grid: 220K grid leak, grid-cathode diode at the
        // 6V6 cathode-bias voltage (about +20 V on its 470R)
        n.C('P2', 'OUT', 0.022e-6); n.R('OUT', '0', 220e3);
        n.D('OUT', 'G6', MODELS.GRID6V6); n.R('G6', 'K6', 1000);
        n.out('out', 'OUT'); n.out('clip', 'P2');
        return n;
      },
    },
  };

  // Auto level: loudness of each circuit against Drive (K-weighted, the four
  // bundled bass samples), dB at Drive 0, 0.05 ... 1, measured by
  // tools/colour-autolevel.js (QUALITY=lite for the Lite tables). The output is scaled by the inverse, so the
  // loudness stays where the dry signal was.
  const AUTO_LEVEL_DB = {
    ts808: [-0.98,  -0.95,  -0.93,  -0.89,  -0.85,  -0.81,  -0.76,  -0.7,  -0.64,  -0.57,  -0.5,  -0.43,  -0.36,  -0.29,  -0.22,  -0.16,  -0.11,  -0.06,  -0.01,  0.02,  0.06],
    fuzz: [-13.9,  -12.92,  -11.59,  -10.38,  -9.35,  -8.49,  -7.75,  -7.12,  -6.58,  -6.12,  -5.71,  -5.34,  -5,  -4.68,  -4.39,  -4.16,  -3.98,  -3.87,  -3.82,  -3.87,  -4.06],
    ts808Lite: [-0.8,  -0.77,  -0.74,  -0.7,  -0.66,  -0.61,  -0.55,  -0.48,  -0.4,  -0.32,  -0.22,  -0.12,  -0.02,  0.09,  0.19,  0.29,  0.39,  0.49,  0.57,  0.65,  0.72],
    fuzzLite: [-14.46,  -13.16,  -11.89,  -10.69,  -9.59,  -8.61,  -7.76,  -7.03,  -6.41,  -5.88,  -5.43,  -5.03,  -4.68,  -4.36,  -4.08,  -3.85,  -3.67,  -3.53,  -3.42,  -3.33,  -3.22],
    tweedLite: [26.35,  28.58,  30.54,  32.31,  33.97,  35.53,  37.04,  38.47,  39.81,  41.01,  42.05,  42.91,  43.62,  44.2,  44.67,  45.06,  45.37,  45.64,  45.86,  46.06,  46.23],
    ts808Lite2: [-0.83,  -0.81,  -0.78,  -0.75,  -0.72,  -0.68,  -0.64,  -0.59,  -0.53,  -0.48,  -0.41,  -0.35,  -0.29,  -0.23,  -0.17,  -0.12,  -0.07,  -0.03,  0.01,  0.04,  0.07],
    fuzzLite2: [-14.46,  -13.15,  -11.88,  -10.67,  -9.57,  -8.6,  -7.75,  -7.02,  -6.41,  -5.88,  -5.43,  -5.03,  -4.68,  -4.36,  -4.08,  -3.86,  -3.68,  -3.54,  -3.43,  -3.35,  -3.24],
    tweedLite2: [26.86,  29.01,  30.67,  32.01,  33.14,  34.08,  34.87,  35.54,  36.11,  36.61,  37.05,  37.44,  37.78,  38.09,  38.37,  38.62,  38.85,  39.06,  39.27,  39.49,  39.63],
    tweed: [26.99,  29.23,  31.15,  32.88,  34.46,  35.86,  37.05,  38.02,  38.79,  39.42,  39.94,  40.37,  40.75,  41.08,  41.38,  41.66,  41.93,  42.22,  42.54,  42.95,  43.62],
  };
  function autoLevelGain(model, rot) {
    const t = AUTO_LEVEL_DB[model]; if (!t) return 1;
    const x = Math.min(1, Math.max(0, rot)) * (t.length - 1), i = Math.min(t.length - 2, Math.floor(x)), f = x - i;
    return Math.pow(10, -(t[i] + f * (t[i + 1] - t[i])) / 20);
  }

  const DRIVE_TICK = 5e-3;
  const DEFAULTS = { model: 'ts808', drive: 0.3, driveSlewMs: 30, outputDb: 0, autoLevel: true };

  // ===========================================================================
  // Lite: each circuit reduced to a few filters and a smooth clipper, run at 4x
  // (quality: 'lite'). Not a circuit solve. The filter corners come from the
  // parts, the gains and clip levels from the full model (small-signal gain at
  // 1 kHz, output swing at full drive), and each has its own auto-level table.
  // Only exp and arithmetic, so the C++ twin rounds the same.
  // ===========================================================================
  const tanhE = (u) => (u > 20 ? 1 : u < -20 ? -1 : 1 - 2 / (Math.exp(2 * u) + 1));
  const sclip = (u, lo, hi) => (u > 0 ? hi * tanhE(u / hi) : lo * tanhE(u / lo)); // soft limits +hi / -lo
  // harder knee: u / (1 + (u/L)^4)^(1/4), limits +hi / -lo
  const hclip = (u, lo, hi) => { const r = u / (u > 0 ? hi : lo), r2 = r * r; return u / Math.pow(1 + r2 * r2, 0.25); };
  const bend = (u, k) => u + k * u * u; // square-law bend, on a clipped (bounded) signal so it stays monotonic
  const pole = (fc, T) => Math.exp(-2 * Math.PI * fc * T); // one-pole low-pass coefficient
  // Fuzz Face small-signal gain at 1 kHz against Drive, dB, measured from the full model
  const FUZZ_LITE_GAIN_DB = [-12.94, -11.42, -9.81, -8.11, -6.3, -4.37, -2.31, -0.1, 2.28, 4.85, 7.62, 10.62, 13.85, 17.32, 20.97, 24.69, 28.33, 31.75, 35.09, 38.65, 45.17];
  function tableAt(t, rot) {
    const x = Math.min(1, Math.max(0, rot)) * (t.length - 1), i = Math.min(t.length - 2, Math.floor(x)), f = x - i;
    return t[i] + f * (t[i + 1] - t[i]);
  }
  const TS_LITE_TRIM = Math.pow(10, -2.2 / 20);  // the tone stage's loss at noon (lines the 1 kHz gain up)
  const TWEED_A1 = 55, TWEED_A2 = 26;            // stage gains (V1A bypassed, V1B with 1K5 unbypassed)
  const TWEED_BEND = 0.1, TWEED_BEND2 = 0.03;    // square-law bend of each stage (V1B's is flattened by its cathode feedback)

  function liteInit(L, model, T) {
    L.s = new Float64Array(6); // filter states
    L.a = {
      in: pole(15.6, T),            // TS: C1 0.02u into the 510K bias; Fuzz: C1 2.2u; Tweed: unused
      hp: pole(720, T),             // TS: R4 4K7 + C3 47n
      tone: pole(723, T),           // TS: R7 1K + C5 0.22u
      miller: pole(14000, T),       // Tweed: 68K stopper into V1A's Miller capacitance
      out: pole(model === 'tweed' ? 33 : model === 'fuzz' ? 32 : 1.6, T), // output coupling
    };
  }
  function liteFb(P, T) { return pole(1 / (2 * Math.PI * (51e3 + P.drive) * 51e-12), T); } // TS: C4 across the feedback


  // one lite step at the oversampled rate: x in volts at the input jack, returns volts out
  function liteStep(model, L, P, x) {
    const st = L.s, a = L.a;
    if (model === 'ts808') {
      const x1 = x - (st[0] = st[0] + (1 - a.in) * (x - st[0]));          // input coupling high-pass
      const xh = x1 - (st[1] = st[1] + (1 - a.hp) * (x1 - st[1]));        // 4K7 + 47n leg
      const g = (51e3 + P.drive) / 4.7e3;
      const v = (st[2] = st[2] + (1 - L.fb) * (g * xh - st[2]));          // C4 in the feedback
      const o1 = x1 + sclip(v, 0.42, 0.40);                               // D1/D2 limit the feedback voltage
      const t = (st[3] = st[3] + (1 - a.tone) * (o1 - st[3]));
      return t * TS_LITE_TRIM;
    }
    if (model === 'fuzz') {
      const x1 = x - (st[0] = st[0] + (1 - a.in) * (x - st[0]));
      const y = hclip(L.g * x1, 0.28, 0.20);                              // Q2 saturates one way, cuts off the other
      return y - (st[1] = st[1] + (1 - a.out) * (y - st[1]));
    }
    // tweed
    const x1 = (st[0] = st[0] + (1 - a.miller) * (x - st[0]));
    // each stage: cutoff below and grid current above, then the triode's square-law bend
    const y1 = -TWEED_A1 * bend(hclip(x1, 1.8, 1.0), TWEED_BEND);         // V1A
    const v2 = P.vol * y1;
    const y2 = -TWEED_A2 * bend(hclip(v2, 3.0, 5.0), TWEED_BEND2);        // V1B through the VOLUME pot
    const y3 = y2 > 0 ? 25 * tanhE(y2 / 25) : y2;                         // 6V6 grid current
    return y3 - (st[1] = st[1] + (1 - a.out) * (y3 - st[1]));
  }

  // 'lite2' (experimental): the same reductions, but the one nonlinear node in
  // each circuit is solved with its reactive parts, so they interact:
  //   TS     the clipping diodes, C4 and the feedback resistor are solved together
  //          against the 4K7 + 47n leg (one node, Newton): clipping changes the tone
  //   Fuzz   Q1's base current on the clipping side charges C1 2.2u, so the bias
  //          shifts with playing: gating and sputter, recovering as C1 discharges
  //   Tweed  grid current through each coupling cap (into V1B and the 6V6) charges
  //          it and shifts the bias: blocking, sag and recovery
  const TS2 = { R4: 4.7e3, C3: 0.047e-6, C4: 51e-12, Is: 2.52e-9, nvt: 1.752 * 0.025852 };
  function tsFeedback(L, P, i, T) {
    // solve i = vd/Rf + C4 (vd - vd0)/T + 2 Is sinh(vd/nVt) for vd (backward Euler on C4)
    const g = 1 / (51e3 + P.drive) + TS2.C4 / T, rhs = i + TS2.C4 / T * L.vd, nvt = TS2.nvt, k = 2 * TS2.Is;
    let v = L.vd;
    for (let it = 0; it < 12; it++) {
      const e = Math.exp(v / nvt), sh = (e - 1 / e) / 2, ch = (e + 1 / e) / 2;
      const f = g * v + k * sh - rhs, df = g + k * ch / nvt;
      let dv = -f / df;
      if (dv > 0.05) dv = 0.05; else if (dv < -0.05) dv = -0.05;
      v += dv;
      if (dv < 1e-9 && dv > -1e-9) break;
    }
    L.vd = v;
    return v;
  }
  function liteStep2(model, L, P, x, T) {
    const st = L.s, a = L.a;
    if (model === 'ts808') {
      const x1 = x - (st[0] = st[0] + (1 - a.in) * (x - st[0]));
      // the leg R4 + C3 from the inverting input (at x1) to ground, backward Euler
      const kc = T / (TS2.R4 * TS2.C3);
      st[1] = (st[1] + kc * x1) / (1 + kc);
      const i = (x1 - st[1]) / TS2.R4;
      const o1 = x1 + tsFeedback(L, P, i, T);
      const t = (st[3] = st[3] + (1 - a.tone) * (o1 - st[3]));
      return t * TS_LITE_TRIM;
    }
    if (model === 'fuzz') {
      // C1 as an explicit cap: the input high-pass, plus base current on the clipping side
      const x1 = x - st[0];
      const u = L.g * x1, y = hclip(u, 0.28, 0.20);
      const over = u > 0 ? (u - y) / L.g : 0;                              // drive beyond the clip, in input volts
      st[0] = st[0] + (1 - a.in) * (x - st[0]) + T * over / (10e3 * 2.2e-6); // C1 charges through about 10K of source
      return y - (st[1] = st[1] + (1 - a.out) * (y - st[1]));
    }
    // tweed. Signals are relative to each grid's bias; grid current starts 1 V above it.
    const x1 = (st[0] = st[0] + (1 - a.miller) * (x - st[0]));
    const g1 = x1 > 1 ? 1 + (x1 - 1) * (1500 / (1500 + 68e3)) : x1;       // V1A grid through the 68K stopper
    const y1 = -TWEED_A1 * bend(hclip(g1, 1.8, 8), TWEED_BEND);
    // V1B: 0.022u coupling cap into the VOLUME pot, the wiper drives the grid
    const rs = 38e3 * P.vol + 1e6 * P.vol * (1 - P.vol);                   // source impedance at the wiper
    let v2 = P.vol * y1 - st[2];
    let ig = 0;
    if (v2 > 1) { ig = (v2 - 1) / (rs + 1500); v2 = 1 + ig * 1500; }
    st[2] += T * (ig - st[2] / (1e6 + 38e3)) / 0.022e-6;                   // charges with grid current, leaks through the pot
    const y2 = -TWEED_A2 * bend(hclip(v2, 3.0, 8), TWEED_BEND2);
    // 6V6 grid: 0.022u into 220K, grid current above its bias (+20 V on the 470R)
    let v3 = y2 - st[3], ig3 = 0;
    if (v3 > 20) { ig3 = (v3 - 20) / (38e3 + 1000); v3 = 20 + ig3 * 1000; }
    st[3] += T * (ig3 - st[3] / (220e3 + 38e3)) / 0.022e-6;
    return v3 - (st[1] = st[1] + (1 - a.out) * (v3 - st[1]));
  }

  class ColourCircuit {
    constructor(sampleRate, opts = {}) {
      this.fs = sampleRate;
      this.lite = opts.quality === 'lite' || opts.quality === 'lite2'; this.lite2 = opts.quality === 'lite2';
      this.os = this.lite ? 4 : opts.oversample || 1;
      this.T = 1 / (this.fs * this.os);
      this.ovs = new Oversampler(this.os);
      this.p = Object.assign({}, DEFAULTS);
      for (const k of Object.keys(DEFAULTS)) if (opts[k] !== undefined) this.p[k] = opts[k];
      this.osBuf = new Float64Array(this.os);
      this.steps = 0; this.peak = 0;
      this._build();
    }

    _build() {
      const def = this.def = CIRCUITS[this.p.model];
      if (!def) throw new Error('unknown circuit ' + this.p.model);
      this.P = {};
      this.driveNow = this.driveMid = this.p.drive;
      def.setDrive(this.P, this.driveNow);
      this.alKey = this.p.model + (this.lite2 ? 'Lite2' : this.lite ? 'Lite' : '');
      if (this.lite) {
        this.L = { vd: 0 }; liteInit(this.L, this.p.model, this.T); this._liteDrive();
        this.slewCount = 0; this._derive(); return;
      }
      this.cir = new Circuit(def.build(this.P), this.T);
      this.u = Float64Array.from([0, ...def.supplies]);
      this.cir.settle(this.u, this.T);
      this.ixOut = this.cir.outNames.indexOf('out'); this.ixClip = this.cir.outNames.indexOf('clip');
      // remove the DC operating point at the output (the coupling caps would,
      // but slowly after power-up)
      this.dc = this.cir.y[this.ixOut];
      this.slewCount = 0;
      this._derive();
    }

    _liteDrive() {
      const L = this.L;
      if (this.p.model === 'ts808') L.fb = liteFb(this.P, this.T);
      if (this.p.model === 'fuzz') L.g = Math.pow(10, tableAt(FUZZ_LITE_GAIN_DB, this.driveNow) / 20);
    }

    _derive() {
      const p = this.p, tau = Math.max(0, p.driveSlewMs) / 1000;
      this.slewA = tau > 0 ? 1 - Math.exp(-2 * this.T / tau) : 1;
      this.slewTick = Math.max(1, Math.round(DRIVE_TICK / this.T));
      this.inGain = this.def.fullScaleVolts;
      this.outGainBase = Math.pow(10, p.outputDb / 20) / this.def.fullScaleVolts;
      this.outGain = this.outGainBase * (p.autoLevel ? autoLevelGain(this.alKey, this.driveNow) : 1);
    }

    setParams(o = {}) {
      const modelChange = o.model !== undefined && o.model !== this.p.model;
      for (const k of Object.keys(DEFAULTS)) if (o[k] !== undefined) this.p[k] = o[k];
      if (modelChange) this._build(); else this._derive();
    }

    info() {
      return {
        name: this.def.name, desc: this.def.desc, latencySamples: this.ovs.latency, driveNow: this.driveNow,
        autoLevelDb: this.p.autoLevel ? 20 * Math.log10(autoLevelGain(this.alKey, this.p.drive)) : 0,
        avgIterations: this.steps && !this.lite ? this.cir.iters / this.steps : 0,
        substeps: this.lite ? 0 : this.cir.substeps, unconverged: this.lite ? 0 : this.cir.fails,
      };
    }

    _processLite(input, output, n) {
      const os = this.os, buf = this.osBuf, L = this.L, P = this.P, model = this.p.model, target = this.p.drive;
      let gliding = this.driveNow !== target;
      for (let s = 0; s < n; s++) {
        const up = this.ovs.up(input[s] * this.inGain);
        for (let k = 0; k < os; k++) {
          if (gliding) {
            const a = this.slewA, m1 = this.driveMid += (target - this.driveMid) * a;
            let d = this.driveNow + (m1 - this.driveNow) * a;
            if (Math.abs(target - d) < 1e-5 && Math.abs(target - m1) < 1e-5) { d = this.driveMid = target; gliding = false; }
            this.driveNow = d;
            this.def.setDrive(P, d); this._liteDrive();
            if (this.p.autoLevel) this.outGain = this.outGainBase * autoLevelGain(this.alKey, d);
          }
          buf[k] = this.lite2 ? liteStep2(model, L, P, up[k], this.T) : liteStep(model, L, P, up[k]);
        }
        output[s] = this.ovs.down(buf) * this.outGain;
      }
      return output;
    }

    readPeaks() { const p = this.peak; this.peak = 0; return { clip: p }; }

    process(input, output, n = input.length) {
      if (this.lite) return this._processLite(input, output, n);
      const os = this.os, buf = this.osBuf, C = this.cir, u = this.u, io = this.ixOut, ic = this.ixClip;
      const target = this.p.drive;
      let gliding = this.driveNow !== target;
      for (let s = 0; s < n; s++) {
        const up = this.ovs.up(input[s] * this.inGain);
        for (let k = 0; k < os; k++) {
          if (gliding) {
            const a = this.slewA, m1 = this.driveMid += (target - this.driveMid) * a;
            let d = this.driveNow + (m1 - this.driveNow) * a;
            if (Math.abs(target - d) < 1e-5 && Math.abs(target - m1) < 1e-5) { d = this.driveMid = target; gliding = false; }
            this.driveNow = d;
            this.def.setDrive(this.P, d);
            if (this.p.autoLevel) this.outGain = this.outGainBase * autoLevelGain(this.alKey, d);
            if (!gliding || ++this.slewCount >= this.slewTick) { this.slewCount = 0; C.setT(this.T); }
            else C.updateRV();
          }
          u[0] = up[k];
          C.step(u); this.steps++;
          const pc = Math.abs(C.y[ic]); if (pc > this.peak) this.peak = pc;
          buf[k] = C.y[io] - this.dc;
        }
        this.dc += 1e-5 * (C.y[io] - this.dc) * os; // very slow DC tracker (about 0.3 Hz)
        output[s] = this.ovs.down(buf) * this.outGain;
      }
      return output;
    }
  }

  return { ColourCircuit, Circuit, Netlist, CIRCUITS, MODELS, DEFAULTS, AUTO_LEVEL_DB, factory: ColourCircuitsCoreFactory };
});
