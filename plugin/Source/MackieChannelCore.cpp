// C++ twin of mackie-channel-core.js. Every function below is the JS function
// of the same name, translated statement by statement. Keep them in step.
#include "MackieChannelCore.h"
#include "JsMath.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace mackie
{

static constexpr double VT = 0.025852; // thermal voltage at 27 C
// Op-amp output swing limit inside the macromodel (see the JS).
static constexpr double CLAMP_G = 0.1, CLAMP_W = 0.002;
static constexpr double PI = 3.141592653589793;
static constexpr double EXP80 = 5.54062238439351e34;

// ============================================================================
// Device data (see the JS for sources and assumptions)
// ============================================================================
static const BjtModel MMBT4403 { 650.6e-18, 216.2, 3.578, 115.7 };
static const BjtModel Q2SA1084 { 1e-13, 400, 4, 100 };
static const DiodeModel D1N4148 { 2.52e-9, 1.752 };
static const OpAmpModel NJM2068 { 27e6, 6e6, jsmath::pow (10.0, 110.0 / 20.0), 1.5, 30e-12, 50 };
static const OpAmpModel NJM4560 { 10e6, 4e6, jsmath::pow (10.0, 100.0 / 20.0), 1.0, 30e-12, 50 };

// ============================================================================
// Netlist
// ============================================================================
void Netlist::R (const std::string& a, const std::string& b, double r)
{
    Element e { Element::R }; e.a = a; e.b = b; e.r = r; els.push_back (std::move (e));
}
void Netlist::R (const std::string& a, const std::string& b, std::function<double()> r)
{
    Element e { Element::R }; e.a = a; e.b = b; e.rf = std::move (r); els.push_back (std::move (e));
}
void Netlist::RV (const std::string& a, const std::string& b, std::function<double()> r)
{
    Element e { Element::RV }; e.a = a; e.b = b; e.rf = std::move (r); els.push_back (std::move (e));
}
void Netlist::C (const std::string& a, const std::string& b, double c, bool stiff)
{
    Element e { Element::C }; e.a = a; e.b = b; e.val = c; e.be = stiff; els.push_back (std::move (e));
}
void Netlist::L (const std::string& a, const std::string& b, double l, bool stiff)
{
    Element e { Element::L }; e.a = a; e.b = b; e.val = l; e.be = stiff; els.push_back (std::move (e));
}
void Netlist::V (const std::string& name, const std::string& a)
{
    inputs.push_back (name);
    Element e { Element::V }; e.a = a; e.idx = (int) inputs.size() - 1; els.push_back (std::move (e));
}
void Netlist::D (const std::string& a, const std::string& b, const DiodeModel& m)
{
    Element e { Element::D }; e.a = a; e.b = b; e.dm = m; els.push_back (std::move (e));
}
void Netlist::Q (const std::string& c, const std::string& b, const std::string& e_, const BjtModel& m)
{
    Element e { Element::Q }; e.c = c; e.b = b; e.e = e_; e.qm = m; els.push_back (std::move (e));
}
void Netlist::U (const std::string& name, const std::string& inP, const std::string& inN, const std::string& out,
                 const OpAmpModel& M, double vcc, double vee)
{
    const std::string x = name + ".x";
    // integrator stage: gm into the compensation capacitance, finite DC gain
    const double gm = 2 * PI * M.gbw * M.cc;
    C (x, "0", M.cc, true);
    R (x, "0", M.a0 / gm);
    { Element e { Element::GM }; e.p = inP; e.n = inN; e.x = x; e.gm = gm; els.push_back (std::move (e)); }
    { Element e { Element::CLAMP }; e.x = x; e.hi = vcc - M.headroom; e.lo = vee + M.headroom; els.push_back (std::move (e)); }
    { Element e { Element::BUF }; e.x = x; e.o = out; e.g = 1 / M.rout; els.push_back (std::move (e)); }
}
void Netlist::out (const std::string& name, const std::string& n) { outputs.emplace_back (name, n); }

// ============================================================================
// Small dense linear algebra
// ============================================================================
static double softplus (double z) { return z > 30 ? z : z < -30 ? jsmath::exp (z) : jsmath::log1p (jsmath::exp (z)); }
static double sigmoid (double z) { return z > 30 ? 1 : z < -30 ? jsmath::exp (z) : 1 / (1 + jsmath::exp (-z)); }

// SPICE junction voltage limiting
static double pnjlim (double vnew, double vold, double vt, double vcrit)
{
    if (vnew > vcrit && std::abs (vnew - vold) > 2 * vt)
    {
        if (vold > 0) { const double arg = 1 + (vnew - vold) / vt; vnew = arg > 0 ? vold + vt * jsmath::log (arg) : vcrit; }
        else vnew = vt * jsmath::log (vnew / vt);
    }
    return vnew;
}

static void luFactor (double* A, int n, int* perm) // in place, partial pivoting
{
    for (int i = 0; i < n; i++) perm[i] = i;
    for (int c = 0; c < n; c++)
    {
        int p = c; double best = std::abs (A[c * n + c]);
        for (int r = c + 1; r < n; r++) { const double v = std::abs (A[r * n + c]); if (v > best) { best = v; p = r; } }
        if (p != c)
        {
            for (int j = 0; j < n; j++) { const double t = A[c * n + j]; A[c * n + j] = A[p * n + j]; A[p * n + j] = t; }
            const int t = perm[c]; perm[c] = perm[p]; perm[p] = t;
        }
        double d = A[c * n + c];
        if (d == 0 || std::isnan (d)) d = 1e-30; // JS: A[c*n+c] || 1e-30
        A[c * n + c] = d;
        for (int r = c + 1; r < n; r++)
        {
            const double f = A[r * n + c] / d; A[r * n + c] = f; if (f == 0) continue;
            for (int j = c + 1; j < n; j++) A[r * n + j] -= f * A[c * n + j];
        }
    }
}

static void luSolve (const double* A, double* b, int n, const int* perm)
{
    double y[256];
    for (int i = 0; i < n; i++) y[i] = b[perm[i]];
    for (int i = 0; i < n; i++) { double s = y[i]; for (int j = 0; j < i; j++) s -= A[i * n + j] * y[j]; y[i] = s; }
    for (int i = n - 1; i >= 0; i--) { double s = y[i]; for (int j = i + 1; j < n; j++) s -= A[i * n + j] * y[j]; y[i] = s / A[i * n + i]; }
    for (int i = 0; i < n; i++) b[i] = y[i];
}

// Gauss-Jordan on Mm, result in S
void Circuit::invert()
{
    const int n = N, w = 2 * n;
    double* M = Minv.data();
    std::fill (Minv.begin(), Minv.end(), 0.0);
    for (int i = 0; i < n; i++) { for (int j = 0; j < n; j++) M[i * w + j] = Mm[i * n + j]; M[i * w + n + i] = 1; }
    for (int c = 0; c < n; c++)
    {
        int p = c; double best = std::abs (M[c * w + c]);
        for (int r = c + 1; r < n; r++) { const double v = std::abs (M[r * w + c]); if (v > best) { best = v; p = r; } }
        if (best < 1e-300) throw std::runtime_error ("singular circuit matrix (floating node?)");
        if (p != c) for (int j = 0; j < w; j++) { const double t = M[c * w + j]; M[c * w + j] = M[p * w + j]; M[p * w + j] = t; }
        const double d = 1 / M[c * w + c];
        for (int j = 0; j < w; j++) M[c * w + j] *= d;
        for (int r = 0; r < n; r++) if (r != c)
        {
            const double f = M[r * w + c]; if (f == 0) continue;
            for (int j = 0; j < w; j++) M[r * w + j] -= f * M[c * w + j];
        }
    }
    for (int i = 0; i < n; i++) for (int j = 0; j < n; j++) S[i * n + j] = M[i * w + n + j];
}

// ============================================================================
// Compiled circuit
// ============================================================================
int Circuit::node (const std::string& n)
{
    auto it = nodeIndex.find (n);
    if (it != nodeIndex.end()) return it->second;
    const int k = (int) nodeIndex.size() - 1;
    nodeIndex.emplace (n, k);
    return k;
}

int Circuit::outIndex (const std::string& name) const
{
    for (size_t k = 0; k < outNames.size(); k++) if (outNames[k] == name) return (int) k;
    return -1;
}

Circuit::Circuit (std::shared_ptr<Netlist> net_, double T_, int fineLevels, bool build) : net (std::move (net_))
{
    // node numbering, in the JS field order a b c e p n x o
    nodeIndex.emplace ("0", -1);
    for (auto& e : net->els)
        for (const std::string* fld : { &e.a, &e.b, &e.c, &e.e, &e.p, &e.n, &e.x, &e.o })
            if (! fld->empty()) node (*fld);
    for (auto& kv : net->outputs) node (kv.second);
    nn = (int) nodeIndex.size() - 1; q = (int) net->inputs.size(); N = nn + q;
    // ports and reactive elements
    for (auto& e : net->els)
    {
        if (e.k == Element::D)
        {
            devs.push_back ({ Dev::Dd, (int) ports.size(), &e });
            ports.push_back ({ node (e.a), node (e.b), node (e.a), node (e.b) });
        }
        else if (e.k == Element::Q)
        {
            // pnp only in this circuit: port1 = EB, port2 = CB
            const int Bn = node (e.b), Cn = node (e.c), En = node (e.e);
            devs.push_back ({ Dev::Qd, (int) ports.size(), &e });
            ports.push_back ({ En, Bn, En, Bn });
            ports.push_back ({ Cn, Bn, Cn, Bn });
        }
        else if (e.k == Element::CLAMP)
        {
            devs.push_back ({ Dev::CL, (int) ports.size(), &e });
            ports.push_back ({ node (e.x), -1, node (e.x), -1 });
        }
        else if (e.k == Element::RV)
        {
            devs.push_back ({ Dev::RVd, (int) ports.size(), &e });
            ports.push_back ({ node (e.a), node (e.b), node (e.a), node (e.b) });
        }
        else if (e.k == Element::C || e.k == Element::L)
            reac.push_back ({ node (e.a), node (e.b), e.k == Element::C, e.val, e.be, 0 });
    }
    lim.assign (ports.size(), 0);
    for (auto& d : devs)
    {
        if (d.k == Dev::Qd) { QA.insert (QA.end(), { (double) d.p, d.el->qm.Is, d.el->qm.Bf, d.el->qm.Br, d.el->qm.Vaf }); lim[d.p] = 1; lim[d.p + 1] = 1; }
        else if (d.k == Dev::Dd) { DA.insert (DA.end(), { (double) d.p, d.el->dm.Is, d.el->dm.N * VT }); lim[d.p] = 2; }
        else if (d.k == Dev::RVd) RVs.push_back (d);
        else { CA.insert (CA.end(), { (double) d.p, d.el->hi, d.el->lo }); lim[d.p] = 3; }
    }
    clampsOnly = QA.empty() && DA.empty() && RVs.empty();
    RVg.assign (RVs.size(), 0.0);
    limA.assign (ports.size(), 0.0); limB.assign (ports.size(), 0.0);
    for (auto& d : devs)
    {
        if (d.k == Dev::Dd) limA[d.p] = d.el->dm.N * VT;
        if (d.k == Dev::CL) { limA[d.p] = d.el->hi; limB[d.p] = d.el->lo; }
    }
    m = (int) ports.size(); r = (int) reac.size();
    for (auto& kv : net->outputs) { outNames.push_back (kv.first); outNodes.push_back (node (kv.second)); }
    o = (int) outNodes.size();

    Dh.assign (m * r, 0); Du.assign (m * q, 0); K.assign (m * m, 0);
    Ah.assign (r * r, 0); Au.assign (r * q, 0); Ai.assign (r * m, 0);
    Oh.assign (o * r, 0); Ou.assign (o * q, 0); Oi.assign (o * m, 0);
    Mm.assign (N * N, 0); S.assign (N * N, 0); Minv.assign (N * 2 * N, 0); tmp.assign (N, 0);
    J.assign (r, 0); v.assign (m, 0); i.assign (m, 0); p.assign (m, 0); f.assign (m, 0); jac.assign (m * m, 0);
    dI.assign (m * 2, 0); dx.assign (m, 0); y.assign (o, 0); vr.assign (r, 0); perm.assign (m, 0);
    vtmp.assign (m, 0); ftmp.assign (m, 0); sx.assign (m, 0); physI.assign (r, 0); vSave.assign (m, 0);
    uPrev.assign (q, 0); u0.assign (q, 0); ui.assign (q, 0);
    if (m > 256) throw std::runtime_error ("too many device ports");

    if (fineLevels > 0) fine = std::make_unique<Circuit> (net, T_, fineLevels - 1, false);
    if (build) setT (T_);
    else T = T_;
}

double Circuit::gOf (const Reac& re, double T_) const
{
    if (re.isC) return re.be ? re.val / T_ : 2 * re.val / T_;
    return re.be ? T_ / re.val : T_ / (2 * re.val);
}

// (Re)build matrices for time step T with current element values.
void Circuit::setT (double T_)
{
    T = T_;
    if (fine) fineDirty = true;
    std::fill (Mm.begin(), Mm.end(), 0.0);
    double* M = Mm.data();
    auto add = [&] (int a, int b, double val) { if (a >= 0 && b >= 0) M[a * N + b] += val; };
    auto stampG = [&] (int a, int b, double g) { add (a, a, g); add (b, b, g); add (a, b, -g); add (b, a, -g); };
    auto nd = [&] (const std::string& s) { return nodeIndex.at (s); };
    for (auto& e : net->els)
    {
        if (e.k == Element::R) stampG (nd (e.a), nd (e.b), 1 / (e.rf ? e.rf() : e.r));
        else if (e.k == Element::RV) { e.g0 = 1 / e.rf(); stampG (nd (e.a), nd (e.b), e.g0); }
        else if (e.k == Element::V) { const int a = nd (e.a), row = nn + e.idx; add (a, row, 1); add (row, a, 1); }
        else if (e.k == Element::BUF) { const int on = nd (e.o), x = nd (e.x); add (on, on, e.g); add (on, x, -e.g); }
        else if (e.k == Element::GM) { const int x = nd (e.x); add (x, nd (e.p), -e.gm); add (x, nd (e.n), e.gm); }
    }
    for (auto& re : reac) { re.g = gOf (re, T); stampG (re.a, re.b, re.g); }
    std::fill (RVg.begin(), RVg.end(), 0.0); factored = false;
    // tiny conductance to ground on every node keeps open-circuit nodes solvable
    for (int k = 0; k < nn; k++) M[k * N + k] += 1e-12;
    invert();
    auto rowDiff = [&] (int va, int vb, double* out)
    {
        for (int j = 0; j < N; j++) out[j] = (va >= 0 ? S[va * N + j] : 0) - (vb >= 0 ? S[vb * N + j] : 0);
    };
    auto colDiff = [] (const double* row, int ia, int ib) { return (ia >= 0 ? row[ia] : 0) - (ib >= 0 ? row[ib] : 0); };
    auto build = [&] (int rows, double* H, double* U, double* I, auto getRow)
    {
        for (int k = 0; k < rows; k++)
        {
            getRow (k, tmp.data());
            for (int j = 0; j < r; j++) H[k * r + j] = -colDiff (tmp.data(), reac[j].a, reac[j].b);
            for (int j = 0; j < q; j++) U[k * q + j] = tmp[nn + j];
            for (int j = 0; j < m; j++) I[k * m + j] = -colDiff (tmp.data(), ports[j].ia, ports[j].ib);
        }
    };
    build (m, Dh.data(), Du.data(), K.data(), [&] (int k, double* t) { rowDiff (ports[k].va, ports[k].vb, t); });
    build (r, Ah.data(), Au.data(), Ai.data(), [&] (int k, double* t) { rowDiff (reac[k].a, reac[k].b, t); });
    build (o, Oh.data(), Ou.data(), Oi.data(), [&] (int k, double* t) { rowDiff (outNodes[k], -1, t); });
}

// Evaluate device currents and their port derivatives at v.
void Circuit::evalDevices()
{
    // BJTs: packed [p, Is, Bf, Br, Vaf]
    for (size_t n = 0; n < QA.size(); n += 5)
    {
        const int pp = (int) QA[n]; const double Is = QA[n + 1], Bf = QA[n + 2], Br = QA[n + 3], Vaf = QA[n + 4];
        const double v1 = v[pp], v2 = v[pp + 1];
        const double x1 = v1 / VT, x2 = v2 / VT;
        const double e1 = x1 < 80 ? jsmath::exp (x1) : EXP80 * (1 + x1 - 80);
        const double e2 = x2 < 80 ? jsmath::exp (x2) : EXP80 * (1 + x2 - 80);
        const double d1 = x1 < 80 ? e1 : EXP80, d2 = x2 < 80 ? e2 : EXP80;
        const double gf = Is * d1 / VT, gr = Is * d2 / VT;
        const double ea = 1 - v2 / Vaf;
        const double icc = Is * (e1 - e2);
        const double ibf = Is / Bf * (e1 - 1), ibr = Is / Br * (e2 - 1);
        const double ic = icc * ea - ibr;
        i[pp] = ic + ibf + ibr; i[pp + 1] = -ic;
        const double dic1 = gf * ea, dic2 = -gr * ea - icc / Vaf - gr / Br;
        dI[2 * pp] = dic1 + gf / Bf; dI[2 * pp + 1] = dic2 + gr / Br;
        dI[2 * pp + 2] = -dic1; dI[2 * pp + 3] = -dic2;
    }
    // diodes: packed [p, Is, nVt]
    for (size_t n = 0; n < DA.size(); n += 3)
    {
        const int pp = (int) DA[n]; const double Is = DA[n + 1], nvt = DA[n + 2], x = v[pp] / nvt;
        const double e = x < 80 ? jsmath::exp (x) : EXP80 * (1 + x - 80);
        i[pp] = Is * (e - 1); dI[2 * pp] = Is * (x < 80 ? e : EXP80) / nvt + 1e-12; dI[2 * pp + 1] = 0;
    }
    // variable resistors: the conductance change, a linear port
    for (size_t n = 0; n < RVs.size(); n++) { const int pp = RVs[n].p; const double g = RVg[n]; i[pp] = g * v[pp]; dI[2 * pp] = g; dI[2 * pp + 1] = 0; }
    // swing clamps: packed [p, hi, lo]
    for (size_t n = 0; n < CA.size(); n += 3)
    {
        const int pp = (int) CA[n]; const double a = (v[pp] - CA[n + 1]) / CLAMP_W, b = (CA[n + 2] - v[pp]) / CLAMP_W;
        if (a < -30 && b < -30) { i[pp] = 0; dI[2 * pp] = 1e-12; dI[2 * pp + 1] = 0; continue; }
        i[pp] = CLAMP_G * CLAMP_W * (softplus (a) - softplus (b));
        dI[2 * pp] = CLAMP_G * (sigmoid (a) + sigmoid (b)) + 1e-12; dI[2 * pp + 1] = 0;
    }
}

// residual f = v - p - K i(v) at v; returns squared norm
double Circuit::residual (double* fo)
{
    evalDevices();
    double nrm = 0;
    for (int k = 0; k < m; k++)
    {
        double s = 0; const int row = k * m;
        for (int j = 0; j < m; j++) s += K[row + j] * i[j];
        const double rr = v[k] - p[k] - s; fo[k] = rr; nrm += rr * rr;
    }
    return nrm;
}

// Jacobian I - K dI/dv at the last evaluated point, LU-factored in place
void Circuit::factor()
{
    std::fill (jac.begin(), jac.end(), 0.0);
    for (int k = 0; k < m; k++) jac[k * m + k] = 1;
    for (auto& d : devs)
    {
        const int p0 = d.p, w = d.k == Dev::Qd ? 2 : 1;
        for (int a = 0; a < w; a++) for (int b = 0; b < w; b++)
        {
            const double g = dI[2 * (p0 + b) + a]; if (g == 0) continue;
            const int c = p0 + a, col = p0 + b;
            for (int k = 0; k < m; k++) jac[k * m + c] -= K[k * m + col] * g;
        }
    }
    luFactor (jac.data(), m, perm.data());
    factored = true;
}

// Solve one time step for inputs u (see the JS for the method).
bool Circuit::solve (const double* u, int maxIt)
{
    for (int k = 0; k < m; k++)
    {
        double s = 0;
        for (int j = 0; j < r; j++) s += Dh[k * r + j] * J[j];
        for (int j = 0; j < q; j++) s += Du[k * q + j] * u[j];
        p[k] = s;
    }
    double* v0 = vtmp.data(); double* f1 = ftmp.data();
    // fast path for stages whose only devices are swing clamps
    if (clampsOnly)
    {
        bool far = true;
        for (size_t n = 0; n < CA.size(); n += 3)
        {
            const double x = p[(int) CA[n]];
            if (x > CA[n + 1] - 0.6 || x < CA[n + 2] + 0.6) { far = false; break; }
        }
        if (far) { v = p; std::fill (i.begin(), i.end(), 0.0); factored = false; iters++; return true; }
    }
    residual (f.data());
    int it = 0; bool ok = false, fresh = false, haveDx = false; double ndx = 0;
    const double tol = 1e-18 * m;
    for (; it < maxIt; it++)
    {
        if (! haveDx)
        {
            if (! factored) { factor(); fresh = true; } else fresh = false;
            for (int k = 0; k < m; k++) dx[k] = -f[k];
            luSolve (jac.data(), dx.data(), m, perm.data());
            ndx = 0; for (int k = 0; k < m; k++) ndx += dx[k] * dx[k];
        }
        else fresh = false;
        haveDx = false;
        if (ndx < tol) // apply the last (tiny) correction, currents updated to first order
        {
            for (int k = 0; k < m; k++) v[k] += dx[k];
            for (size_t n = 0; n < QA.size(); n += 5)
            {
                const int pp = (int) QA[n]; const double a1 = dx[pp], a2 = dx[pp + 1];
                i[pp] += dI[2 * pp] * a1 + dI[2 * pp + 1] * a2; i[pp + 1] += dI[2 * pp + 2] * a1 + dI[2 * pp + 3] * a2;
            }
            for (size_t n = 0; n < DA.size(); n += 3) { const int pp = (int) DA[n]; i[pp] += dI[2 * pp] * dx[pp]; }
            for (size_t n = 0; n < CA.size(); n += 3) { const int pp = (int) CA[n]; i[pp] += dI[2 * pp] * dx[pp]; }
            for (size_t n = 0; n < RVs.size(); n++) { const int pp = RVs[n].p; i[pp] += dI[2 * pp] * dx[pp]; }
            ok = true; break;
        }
        std::copy (v.begin(), v.end(), v0);
        // damped Newton with the natural monotonicity test (Deuflhard)
        double alpha = 1, ns = 0; bool accepted = false;
        for (int tries = 0; tries < 10; tries++)
        {
            for (int k = 0; k < m; k++)
            {
                double nv = v0[k] + alpha * dx[k];
                const int t = lim[k];
                if (t == 1) nv = pnjlim (nv, v0[k], VT, 0.6);
                else if (t == 2) nv = pnjlim (nv, v0[k], limA[k], 0.6);
                else if (t == 3) // entering the clamp: stop at the knee
                {
                    const double hi = limA[k], lo = limB[k];
                    if (nv > hi + 2 * CLAMP_W && v0[k] < hi + CLAMP_W) nv = hi + 2 * CLAMP_W;
                    else if (nv < lo - 2 * CLAMP_W && v0[k] > lo - CLAMP_W) nv = lo - 2 * CLAMP_W;
                }
                v[k] = nv;
            }
            residual (f1);
            for (int k = 0; k < m; k++) sx[k] = -f1[k];
            luSolve (jac.data(), sx.data(), m, perm.data());
            ns = 0; for (int k = 0; k < m; k++) ns += sx[k] * sx[k];
            if (ns < ndx * (1 - alpha / 4) || ns < tol) { accepted = true; contract = ns / ndx; break; }
            alpha *= 0.5;
        }
        std::copy (f1, f1 + m, f.begin());
        if (! accepted && ! fresh) { factored = false; continue; }
        if (! accepted || alpha < 1 || contract > 1e-3) factored = false;
        else { dx = sx; ndx = ns; haveDx = true; }
    }
    iters += it + 1;
    if (ok) factored = true; // the last Jacobian is a good chord for the next step
    return ok;
}

// reactive branch voltages and currents, outputs, state update
void Circuit::finish (const double* u)
{
    for (int k = 0; k < r; k++)
    {
        double s = 0;
        for (int j = 0; j < r; j++) s += Ah[k * r + j] * J[j];
        for (int j = 0; j < q; j++) s += Au[k * q + j] * u[j];
        for (int j = 0; j < m; j++) s += Ai[k * m + j] * i[j];
        vr[k] = s;
    }
    for (int k = 0; k < o; k++)
    {
        double s = 0;
        for (int j = 0; j < r; j++) s += Oh[k * r + j] * J[j];
        for (int j = 0; j < q; j++) s += Ou[k * q + j] * u[j];
        for (int j = 0; j < m; j++) s += Oi[k * m + j] * i[j];
        y[k] = s;
    }
    for (int k = 0; k < r; k++)
    {
        const Reac& re = reac[k]; const double g = re.g, vv = vr[k];
        physI[k] = g * vv + J[k];
        if (re.isC) J[k] = re.be ? -g * vv : -(2 * g * vv + J[k]);
        else J[k] = re.be ? g * vv + J[k] : 2 * g * vv + J[k];
    }
    std::copy (u, u + q, uPrev.begin());
}

// set the history sources from a physical state (branch v and i)
void Circuit::importState (const double* vr_, const double* ir, const double* v_)
{
    for (int k = 0; k < r; k++)
    {
        const Reac& re = reac[k]; const double g = re.g;
        if (re.isC) J[k] = re.be ? -g * vr_[k] : -(g * vr_[k] + ir[k]);
        else J[k] = re.be ? ir[k] : ir[k] + g * vr_[k];
    }
    if (vr_ != vr.data()) std::copy (vr_, vr_ + r, vr.begin());
    if (ir != physI.data()) std::copy (ir, ir + r, physI.begin());
    if (v_ != v.data()) std::copy (v_, v_ + m, v.begin());
    factored = false;
}

// Re-read the variable resistors' values.
void Circuit::updateRV()
{
    for (size_t n = 0; n < RVs.size(); n++)
    {
        Element* e = RVs[n].el; const double g = 1 / e->rf() - e->g0;
        if (g != RVg[n]) { RVg[n] = g; factored = false; }
    }
}

// One time step. If Newton fails the step is redone as 8 sub-steps, recursively.
void Circuit::step (const double* u, int depth)
{
    vSave = v;
    if (solve (u, 40)) { finish (u); return; }
    if (depth >= 2 || ! fine) { fails++; finish (u); return; }
    substeps++;
    const int NS = 8;
    if (fineDirty) { fine->setT (T / NS); fineDirty = false; }
    Circuit& F = *fine;
    F.updateRV();
    F.importState (vr.data(), physI.data(), vSave.data());
    std::copy (uPrev.begin(), uPrev.end(), F.uPrev.begin());
    std::copy (uPrev.begin(), uPrev.end(), u0.begin());
    for (int s = 1; s <= NS; s++)
    {
        for (int j = 0; j < q; j++) ui[j] = u0[j] + (u[j] - u0[j]) * s / NS;
        F.step (ui.data(), depth + 1);
    }
    importState (F.vr.data(), F.physI.data(), F.v.data());
    y = F.y; std::copy (u, u + q, uPrev.begin());
    fails += F.fails; F.fails = 0;
}

// Settle to the DC operating point (power-up ramp), then back to time step T.
void Circuit::settle (const double* u, double T_)
{
    std::vector<bool> keep; for (auto& re : reac) keep.push_back (re.be);
    for (auto& re : reac) re.be = true;
    setT (1e-3);
    std::vector<double> ur (q);
    for (int n = 1; n <= 200; n++) { for (int j = 0; j < q; j++) ur[j] = u[j] * n / 200; solve (ur.data(), 200); finish (ur.data()); }
    for (int n = 0; n < 400; n++) { solve (u, 200); finish (u); }
    setT (1e-2);
    for (int n = 0; n < 200; n++) { solve (u, 200); finish (u); }
    std::vector<double> sv = vr, si (r);
    for (int j = 0; j < r; j++) si[j] = reac[j].isC ? 0 : reac[j].g * vr[j] + J[j];
    for (int j = 0; j < r; j++) reac[j].be = keep[j];
    setT (T_);
    importState (sv.data(), si.data(), v.data());
    std::copy (u, u + q, uPrev.begin());
}

// ============================================================================
// The schematic, stage by stage
// ============================================================================
static constexpr double VCC = 16, VEE = -16;

// Pot model: a 3-terminal pot of total R with wiper ratio a (0 = end "a").
static void pot (Netlist& net, const std::string& endA, const std::string& wiper, const std::string& endB,
                 double total, std::function<double()> ratio)
{
    net.R (endA, wiper, [total, ratio] { return std::max (1e-3, total * ratio()); });
    net.R (wiper, endB, [total, ratio] { return std::max (1e-3, total * (1 - ratio())); });
}

template <typename PV>
static std::shared_ptr<Netlist> stageA (std::shared_ptr<PV> P)
{
    auto np = std::make_shared<Netlist>(); Netlist& n = *np;
    n.V ("in", "SRC"); n.V ("inN", "SRCN");
    n.V ("vcc", "VCC"); n.V ("vee", "VEE");
    if (! P->mic)
    {
        n.C ("SRC", "LTh", 47e-6); n.R ("LTh", "Bh", 5620);      // C142, R220
        n.C ("SRCN", "LTc", 47e-6); n.R ("LTc", "Bc", 5620);     // C126, R212
        n.C ("Bh", "MPh", 47e-6); n.C ("Bc", "MPc", 47e-6);
    }
    else
    {
        n.R ("SRC", "MPh", 6.81); n.R ("SRCN", "MPc", 6.81);
        n.C ("MPh", "Bh", 47e-6); n.C ("MPc", "Bc", 47e-6);
        n.R ("Bh", "0", 1e9); n.R ("Bc", "0", 1e9);
    }
    n.R ("MPh", "0", 6810); n.R ("MPc", "0", 6810);               // R523, R524
    n.R ("Bh", "0", 1500); n.R ("Bc", "0", 1500);                 // R197, R168
    n.Q ("Ch", "Bh", "Eh", Q2SA1084);                             // Q24
    n.Q ("Cc", "Bc", "Ec", Q2SA1084);                             // Q8
    n.R ("Ch", "VEE", 2490); n.R ("Cc", "VEE", 2490);             // R371, R372
    n.R ("VCC", "DA", 2490); n.D ("DA", "BIAS", D1N4148); n.R ("BIAS", "VEE", 20000);
    n.Q ("Sh", "BIAS", "SEh", MMBT4403); n.R ("SEh", "VCC", 2490); n.C ("SEh", "BIAS", 0.01e-6); n.R ("Sh", "Eh", 470);
    n.Q ("Sc", "BIAS", "SEc", MMBT4403); n.R ("SEc", "VCC", 2490); n.C ("SEc", "BIAS", 0.01e-6); n.R ("Sc", "Ec", 470);
    n.Q ("REF", "BIAS", "SEr", MMBT4403); n.R ("SEr", "VCC", 2490); n.R ("REF", "VEE", 2490);
    n.C ("Ec", "G1", 1000e-6);
    n.RV ("G1", "Eh", [P] { return P->trimOhms + 3.32; });
    n.U ("U17A", "REF", "Cc", "Oc", NJM2068, VCC, VEE);
    n.U ("U25A", "REF", "Ch", "Oh", NJM2068, VCC, VEE);
    n.R ("Oc", "Ec", 5110); n.R ("Oh", "Eh", 5110);               // R268, R323
    n.R ("Oc", "D33n", 10000); n.R ("Oh", "D33p", 10000);         // R492, R425
    n.R ("D33p", "0", 5110);                                      // R370
    n.R ("O33", "D33n", 5110);                                    // R482
    n.U ("U33A", "D33p", "D33n", "O33", NJM2068, VCC, VEE);
    n.out ("pre_hot", "Oh"); n.out ("pre_cold", "Oc"); n.out ("diff", "O33");
    return np;
}

template <typename PV>
static std::shared_ptr<Netlist> stageB (std::shared_ptr<PV> P)
{
    auto np = std::make_shared<Netlist>(); Netlist& n = *np;
    n.V ("in", "O33"); n.V ("vcc", "VCC"); n.V ("vee", "VEE");
    n.C ("O33", "INS", 47e-6); n.R ("INS", "0", 10000);           // C94, R167
    n.C ("INS", "C121", 47e-6); n.R ("C121", "0", 20000);         // C121, R137
    n.C ("INS", "LCa", 0.22e-6); n.R ("LCa", "0", 5100);          // C106, R104
    n.C ("LCa", "LCb", 0.22e-6); n.R ("LCb", "LCo", 1300);        // C105, R105
    n.C ("LCb", "LCc", 0.22e-6); n.R ("LCc", "0", 62000);         // C104, R103
    n.U ("U104A", "LCc", "LCo", "LCo", NJM4560, VCC, VEE);
    n.C ("LCo", "LCd", 47e-6); n.R ("LCd", "0", 20000);           // C107, R106
    if (P->loCut) n.R ("LCd", "EQI", 1e-3); else n.R ("C121", "EQI", 1e-3);
    n.R ("EQI", "N6", 10000); n.R ("N6", "EQO", 10000);           // R122, R123
    n.U ("U101B", "VA", "N6", "EQO", NJM4560, VCC, VEE);
    pot (n, "EQI", "MW", "EQO", 10000, [P] { return P->mid; });
    n.C ("MW", "M7", 0.0047e-6);                                  // C114
    n.R ("M7", "M8", [P] { return P->freqOhms; });                // R121A
    n.R ("M8", "G", 6200);                                        // R135
    n.R ("VA", "M9", 6200); n.R ("M9", "G", [P] { return P->freqOhms; }); // R136, R121B
    n.C ("VA", "G", 0.0022e-6);                                   // C115
    n.R ("P", "0", 3900); n.R ("P", "VA", 5100);                  // R134, R133
    n.U ("U101A", "P", "G", "VA", NJM4560, VCC, VEE);
    n.C ("EQO", "H1", 0.0068e-6); pot (n, "H1", "HW", "H2", 50000, [P] { return P->hi; }); n.C ("H2", "POST", 0.0068e-6);
    n.R ("HW", "M", 3900);                                        // R124
    n.R ("EQO", "L1", 5600); pot (n, "L1", "LW", "L2", 50000, [P] { return P->low; }); n.R ("L2", "POST", 5600);
    n.C ("L1", "LW", 0.033e-6); n.C ("LW", "L2", 0.033e-6);       // C109, C108
    n.R ("LW", "M", 10000);                                       // R126
    n.R ("M", "POST", 1e6);                                       // R127
    n.U ("U105A", "0", "M", "POST", NJM4560, VCC, VEE);
    n.out ("locut", "LCo"); n.out ("eqmid", "EQO"); n.out ("va", "VA"); n.out ("post", "POST");
    return np;
}

template <typename PV>
static std::shared_ptr<Netlist> stageC (std::shared_ptr<PV> P)
{
    auto np = std::make_shared<Netlist>(); Netlist& n = *np;
    n.V ("in", "POST"); n.V ("vcc", "VCC"); n.V ("vee", "VEE");
    n.C ("POST", "F1", 47e-6);                                    // C120
    pot (n, "F1", "FW", "0", 10000, [P] { return 1 - P->faderRatio; }); // R107
    n.C ("FW", "F2", 47e-6); n.R ("F2", "0", 100000);             // C113, R131
    n.R ("F3", "0", 510); n.R ("FO", "F3", 1100);                 // R102, R101
    n.U ("U103A", "F2", "F3", "FO", NJM4560, VCC, VEE);
    n.out ("fader", "FO");
    return np;
}

// ============================================================================
// Controls that are not on the schematic
// ============================================================================
static constexpr double RFB = 5110, RG_MIN = 3.32;
static const double AUTO_LEVEL_RAW[21] = { -15.19, -12.01, -8.83, -5.65, -2.46, 0.72, 3.9, 6.69, 8.62, 9.89, 10.72, 11.27,
                                           11.67, 12, 12.28, 12.53, 12.75, 12.92, 13.08, 13.21, 13.32 };
static double autoLevelDb (int k) { return AUTO_LEVEL_RAW[k] + 0.23; }

double autoLevelGain (double rot)
{
    const double x = std::min (1.0, std::max (0.0, rot)) * (21 - 1);
    const int i = (int) std::min (21.0 - 2, std::floor (x)); const double t = x - i;
    return jsmath::pow (10.0, -(autoLevelDb (i) + t * (autoLevelDb (i + 1) - autoLevelDb (i))) / 20);
}

static constexpr double DRIVE_TICK = 5e-3; // s between stage A rebuilds while Drive glides
static const double GD_MIN = 1 + 2 * RFB / (10000 + RG_MIN), GD_MAX = 1 + 2 * RFB / RG_MIN;

double trimResistance (double rotation)
{
    const double r = std::min (1.0, std::max (0.0, rotation));
    const double gd = jsmath::exp (jsmath::log (GD_MIN) + r * (jsmath::log (GD_MAX) - jsmath::log (GD_MIN)));
    return std::max (0.0, 2 * RFB / (gd - 1) - RG_MIN);
}

static double cTaper (double rot) { const double b = 81; return (jsmath::pow (b, 1 - rot) - 1) / (b - 1); }

// ============================================================================
// Oversampler
// ============================================================================
static std::vector<double> designLowpass (int taps, double cutoff, int factor)
{
    std::vector<double> h (taps); const double beta = 8; const int m = taps - 1;
    auto i0 = [] (double x) { double s = 1, t = 1; for (int k = 1; k < 30; k++) { t *= jsmath::pow (x / (2 * k), 2.0); s += t; } return s; };
    const double fc = cutoff / factor / 2; double sum = 0;
    for (int n = 0; n < taps; n++)
    {
        const double x = n - m / 2.0, sinc = x == 0 ? 2 * fc : std::sin (2 * PI * fc * x) / (PI * x), r = 2.0 * n / m - 1;
        h[n] = sinc * i0 (beta * std::sqrt (std::max (0.0, 1 - r * r))) / i0 (beta); sum += h[n];
    }
    for (int n = 0; n < taps; n++) h[n] /= sum;
    return h;
}

Oversampler::Oversampler (int factor_, int tpp_) : factor (factor_), tpp (tpp_), taps (factor_ * tpp_)
{
    h = designLowpass (taps, 0.9, factor);
    upBuf.assign (tpp * 2, 0); downBuf.assign (taps * 2, 0); outBuf.assign (factor, 0);
}

const double* Oversampler::up (double x)
{
    const int L = factor, P = tpp;
    if (L == 1) { outBuf[0] = x; return outBuf.data(); }
    upPos = (upPos + 1) % P; upBuf[upPos] = x; upBuf[upPos + P] = x;
    for (int pp = 0; pp < L; pp++) { double a = 0; for (int k = 0; k < P; k++) a += h[pp + k * L] * upBuf[upPos + P - k]; outBuf[pp] = a * L; }
    return outBuf.data();
}

double Oversampler::down (const double* arr, int n)
{
    if (factor == 1) return arr[0];
    const int Nt = taps;
    for (int i = 0; i < n; i++) { downPos = (downPos + 1) % Nt; downBuf[downPos] = arr[i]; downBuf[downPos + Nt] = arr[i]; }
    double a = 0; for (int k = 0; k < Nt; k++) a += h[k] * downBuf[downPos + Nt - k];
    return a;
}

// ============================================================================
// Channel
// ============================================================================
Options::Options() : fullScaleVolts (0.7746 * jsmath::pow (10.0, 18.0 / 20) * 1.4142135623730951) {}

MackieChannel::MackieChannel (double sampleRate, const Options& opts)
    : fs (sampleRate), os (opts.oversample > 0 ? opts.oversample : 1), T (1 / (fs * os)), ovs (os), p (opts),
      P (std::make_shared<CircuitValues>())
{
    p.oversample = os;
    driveNow = driveMid = p.drive;
    slewCount = 0;
    derive();
    uA[2] = uB[1] = uC[1] = VCC; uA[3] = uB[2] = uC[2] = VEE;
    build (true);
    osBuf.assign (os, 0);
}

void MackieChannel::derive()
{
    P->trimOhms = trimResistance (driveNow);
    const double tau = std::max (0.0, p.driveSlewMs) / 1000;
    slewA = tau > 0 ? 1 - jsmath::exp (-2 * T / tau) : 1;
    slewTick = (int) std::max (1.0, std::floor (DRIVE_TICK / T + 0.5));
    P->mic = p.mic; P->loCut = p.loCut;
    P->hi = 1 - p.eqHigh; P->low = 1 - p.eqLow; P->mid = 1 - p.eqMid;
    P->freqOhms = std::max (50.0, 500000 * cTaper (p.eqFreq));
    const double ampGain = 1 + 1100.0 / 510;
    P->faderRatio = p.faderDb <= -90 ? 0 : std::min (1.0, jsmath::pow (10.0, p.faderDb / 20) / ampGain);
    inGain = p.fullScaleVolts;
    outGainBase = jsmath::pow (10.0, p.outputDb / 20) / p.fullScaleVolts;
    outGain = outGainBase * (p.autoLevel ? autoLevelGain (driveNow) : 1);
}

void MackieChannel::build (bool fresh)
{
    const std::string key = std::string (P->mic ? "mic" : "line") + "|" + (P->loCut ? "true" : "false");
    if (fresh || key != topoKey)
    {
        topoKey = key;
        A = std::make_unique<Circuit> (stageA (P), T);
        B = std::make_unique<Circuit> (stageB (P), T);
        C = std::make_unique<Circuit> (stageC (P), T);
        uA[0] = uA[1] = 0; uB[0] = 0; uC[0] = 0;
        A->settle (uA.data(), T);
        uB[0] = A->y[A->outIndex ("diff")];
        B->settle (uB.data(), T);
        uC[0] = B->y[B->outIndex ("post")];
        C->settle (uC.data(), T);
        ixHot = A->outIndex ("pre_hot"); ixCold = A->outIndex ("pre_cold"); ixDiff = A->outIndex ("diff");
        ixPost = B->outIndex ("post"); ixMid = B->outIndex ("eqmid"); ixVa = B->outIndex ("va");
        ixFader = C->outIndex ("fader");
    }
    else
    {
        if (changedA) A->setT (T);
        if (changedB) B->setT (T);
        if (changedC) C->setT (T);
    }
    changedA = changedB = changedC = false;
}

void MackieChannel::setParams (const Options& o)
{
    bool changed = false;
    auto set = [&] (auto& dst, auto src, bool* stage)
    {
        if (src != dst) { dst = src; changed = true; if (stage) *stage = true; }
    };
    set (p.drive, o.drive, nullptr);
    set (p.driveSlewMs, o.driveSlewMs, nullptr);
    set (p.mic, o.mic, &changedA);
    set (p.fullScaleVolts, o.fullScaleVolts, nullptr);
    set (p.loCut, o.loCut, &changedB);
    set (p.eqHigh, o.eqHigh, &changedB);
    set (p.eqMid, o.eqMid, &changedB);
    set (p.eqLow, o.eqLow, &changedB);
    set (p.eqFreq, o.eqFreq, &changedB);
    set (p.faderDb, o.faderDb, &changedC);
    set (p.outputDb, o.outputDb, nullptr);
    set (p.autoLevel, o.autoLevel, nullptr);
    if (! changed) return;
    derive();
    pending = true; // applied at the start of the next block
}

void MackieChannel::process (const float* input, float* output, int n)
{
    if (pending) { pending = false; build (false); }
    double* buf = osBuf.data();
    Circuit& cA = *A; Circuit& cB = *B; Circuit& cC = *C;
    const bool mic = p.mic; const double target = p.drive;
    bool gliding = driveNow != target;
    for (int s = 0; s < n; s++)
    {
        const double* up = ovs.up (input[s] * inGain);
        for (int k = 0; k < os; k++)
        {
            const double vin = up[k];
            if (gliding)
            {
                const double a = slewA; const double m1 = driveMid += (target - driveMid) * a;
                double d = driveNow + (m1 - driveNow) * a;
                if (std::abs (target - d) < 1e-5 && std::abs (target - m1) < 1e-5) { d = driveMid = target; gliding = false; }
                driveNow = d;
                P->trimOhms = trimResistance (d);
                if (p.autoLevel) outGain = outGainBase * autoLevelGain (d);
                if (! gliding || ++slewCount >= slewTick) { slewCount = 0; cA.setT (T); }
                else cA.updateRV();
            }
            if (mic) { uA[0] = 0.5 * vin; uA[1] = -0.5 * vin; } else { uA[0] = vin; uA[1] = 0; }
            cA.step (uA.data());
            const auto& ya = cA.y;
            const double ph = std::max (std::abs (ya[ixHot]), std::abs (ya[ixCold])); if (ph > peaks.pre) peaks.pre = ph;
            const double d = ya[ixDiff]; if (std::abs (d) > peaks.diff) peaks.diff = std::abs (d);
            uB[0] = d; cB.step (uB.data());
            const auto& yb = cB.y;
            const double pe = std::max ({ std::abs (yb[ixPost]), std::abs (yb[ixMid]), std::abs (yb[ixVa]) }); if (pe > peaks.eq) peaks.eq = pe;
            uC[0] = yb[ixPost]; cC.step (uC.data());
            const double fo = cC.y[ixFader]; if (std::abs (fo) > peaks.fader) peaks.fader = std::abs (fo);
            buf[k] = fo;
        }
        output[s] = (float) (ovs.down (buf, os) * outGain);
    }
}

} // namespace mackie
