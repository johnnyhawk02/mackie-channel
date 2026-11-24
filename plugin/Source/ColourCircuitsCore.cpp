// C++ twin of colour-circuits-core.js. Every function below is the JS function
// of the same name, translated statement by statement. Keep them in step.
#include "ColourCircuitsCore.h"
#include "JsMath.h"

#include <algorithm>
#include <cmath>

namespace mackie
{

// ============================================================================
// Device data (see the JS for sources and assumptions)
// ============================================================================
static const OpAmpModel JRC4558 { 3e6, 1.7e6, jsmath::pow (10.0, 100.0 / 20.0), 1.5, 30e-12, 50 };
static const DiodeModel D1N914 { 2.52e-9, 1.752 };
static const BjtModel Q2SC1815 { 1e-14, 300, 3, 100, true };
static const BjtModel AC128_Q1 { 2e-7, 75, 5, 40 };
static const BjtModel AC128_Q2 { 2e-7, 120, 5, 40 };
static const TriodeModel T12AX7 { 100, 1.4, 1060, 600, 300, 1500, 0.2, 0.1 };
static const DiodeModel GRID6V6 { 1e-8, 2 };

using PV = std::shared_ptr<ColourCircuit::Values>;

// audio ("A") taper: 10% of the track at mid rotation
static double aTaper (double rot) { const double b = 81; return (jsmath::pow (b, rot) - 1) / (b - 1); }
// a pot as two variable resistors either side of the wiper; ratio = wiper's
// share of the track measured from endB
static void potRV (Netlist& n, const std::string& endA, const std::string& wiper, const std::string& endB,
                   double total, std::function<double()> ratio)
{
    n.RV (endA, wiper, [total, ratio] { return std::max (1.0, total * (1 - ratio())); });
    n.RV (wiper, endB, [total, ratio] { return std::max (1.0, total * ratio()); });
}

// ============================================================================
// Circuits
// ============================================================================
struct CircuitDef
{
    double fullScaleVolts;
    std::vector<double> supplies;
    void (*setDrive) (ColourCircuit::Values&, double);
    std::shared_ptr<Netlist> (*build) (PV);
    std::array<double, 21> autoLevelDb;
    std::array<double, 21> autoLevelDbLite;
};

static std::shared_ptr<Netlist> buildTs808 (PV P)
{
    auto np = std::make_shared<Netlist>(); Netlist& n = *np;
    n.V ("in", "IN"); n.V ("vcc", "VCC");
    // 4.5 V bias: R32/R33 10K divider, C17 100u
    n.R ("VCC", "VB", 10e3); n.R ("VB", "0", 10e3); n.C ("VB", "0", 100e-6, true);
    // input buffer
    n.R ("IN", "I1", 1e3); n.C ("I1", "B1", 0.02e-6); n.R ("B1", "VB", 510e3);
    n.Q ("VCC", "B1", "E1", Q2SC1815); n.R ("E1", "0", 10e3);
    // clipping amp U1A
    n.C ("E1", "P", 1e-6); n.R ("P", "VB", 10e3);
    n.R ("N", "M", 4.7e3); n.C ("M", "0", 0.047e-6);
    n.R ("O1", "F", 51e3); n.RV ("F", "N", [P] { return std::max (1.0, P->drive); });
    n.C ("O1", "N", 51e-12);
    n.D ("O1", "N", D1N914); n.D ("N", "O1", D1N914);
    n.U ("U1A", "P", "N", "O1", JRC4558, 9, 0);
    // tone stage U1B, tone at noon
    n.R ("O1", "T1", 1e3); n.C ("T1", "0", 0.22e-6);
    n.R ("T1", "TP", 1e3); n.R ("TP", "VB", 10e3);
    n.R ("TP", "TW", 10e3); n.R ("TW", "TN", 10e3);
    n.R ("TW", "TR", 220); n.C ("TR", "VB", 0.22e-6);
    n.R ("O2", "TN", 1e3);
    n.U ("U1B", "TP", "TN", "O2", JRC4558, 9, 0);
    // output buffer
    n.C ("O2", "L1", 1e-6); n.R ("L1", "0", 100e3);
    n.C ("L1", "B3", 1e-6); n.R ("B3", "VB", 510e3);
    n.Q ("VCC", "B3", "E3", Q2SC1815); n.R ("E3", "0", 10e3);
    n.R ("E3", "OX", 100); n.C ("OX", "OUT", 10e-6); n.R ("OUT", "0", 10e3);
    n.out ("out", "OUT"); n.out ("clip", "O1");
    return np;
}

static std::shared_ptr<Netlist> buildFuzz (PV P)
{
    auto np = std::make_shared<Netlist>(); Netlist& n = *np;
    n.V ("in", "IN"); n.V ("vee", "VEE");
    n.R ("IN", "PU", 8e3);
    potRV (n, "PU", "I0", "0", 250e3, [P] { return P->gvol; });
    n.C ("I0", "B1", 2.2e-6);
    n.Q ("C1", "B1", "0", AC128_Q1); n.R ("C1", "VEE", 33e3);
    n.Q ("C2", "C1", "E2", AC128_Q2);
    n.R ("C2", "X", 8.2e3); n.R ("X", "VEE", 470);
    n.R ("E2", "B1", 100e3);
    potRV (n, "E2", "W", "0", 1000, [P] { return P->fuzz; });
    n.C ("W", "0", 20e-6);
    n.C ("X", "OUT", 0.01e-6); n.R ("OUT", "0", 500e3);
    n.out ("out", "OUT"); n.out ("clip", "C2");
    return np;
}

static std::shared_ptr<Netlist> buildTweed (PV P)
{
    auto np = std::make_shared<Netlist>(); Netlist& n = *np;
    n.V ("in", "IN"); n.V ("bp", "BP"); n.V ("vk6", "K6");
    n.R ("IN", "G1", 68e3);
    n.TRI ("P1", "G1", "K1", T12AX7);
    n.C ("G1", "P1", 1.7e-12); n.C ("G1", "K1", 1.6e-12);
    n.R ("P1", "BP", 100e3); n.R ("K1", "0", 1500); n.C ("K1", "0", 25e-6);
    n.C ("P1", "VT", 0.022e-6);
    potRV (n, "VT", "G2", "0", 1e6, [P] { return P->vol; });
    n.TRI ("P2", "G2", "K2", T12AX7);
    n.C ("G2", "P2", 1.7e-12); n.C ("G2", "K2", 1.6e-12);
    n.R ("P2", "BP", 100e3); n.R ("K2", "0", 1500);
    n.C ("P2", "OUT", 0.022e-6); n.R ("OUT", "0", 220e3);
    n.D ("OUT", "G6", GRID6V6); n.R ("G6", "K6", 1000);
    n.out ("out", "OUT"); n.out ("clip", "P2");
    return np;
}

static const CircuitDef& circuitDef (int model)
{
    static const CircuitDef defs[3] = {
        { 1.0, { 9 }, [] (ColourCircuit::Values& P, double d) { P.drive = 500e3 * aTaper (d); }, buildTs808,
          { -0.98, -0.95, -0.93, -0.89, -0.85, -0.81, -0.76, -0.7, -0.64, -0.57, -0.5, -0.43, -0.36, -0.29, -0.22, -0.16, -0.11, -0.06, -0.01, 0.02, 0.06 },
          { -0.8, -0.77, -0.74, -0.7, -0.66, -0.61, -0.55, -0.48, -0.4, -0.32, -0.22, -0.12, -0.02, 0.09, 0.19, 0.29, 0.39, 0.49, 0.57, 0.65, 0.72 } },
        { 1.0, { -9 }, [] (ColourCircuit::Values& P, double d) { P.fuzz = 1 - jsmath::pow (1 - d, 3); P.gvol = aTaper (0.7 + 0.3 * d); }, buildFuzz,
          { -13.9, -12.92, -11.59, -10.38, -9.35, -8.49, -7.75, -7.12, -6.58, -6.12, -5.71, -5.34, -5, -4.68, -4.39, -4.16, -3.98, -3.87, -3.82, -3.87, -4.06 },
          { -14.46, -13.16, -11.89, -10.69, -9.59, -8.61, -7.76, -7.03, -6.41, -5.88, -5.43, -5.03, -4.68, -4.36, -4.08, -3.85, -3.67, -3.53, -3.42, -3.33, -3.22 } },
        { 1.0, { 250, 20 }, [] (ColourCircuit::Values& P, double d) { P.vol = aTaper (0.2 + 0.8 * d); }, buildTweed,
          { 26.99, 29.23, 31.15, 32.88, 34.46, 35.86, 37.05, 38.02, 38.79, 39.42, 39.94, 40.37, 40.75, 41.08, 41.38, 41.66, 41.93, 42.22, 42.54, 42.95, 43.62 },
          { 26.35, 28.58, 30.54, 32.31, 33.97, 35.53, 37.04, 38.47, 39.81, 41.01, 42.05, 42.91, 43.62, 44.2, 44.67, 45.06, 45.37, 45.64, 45.86, 46.06, 46.23 } },
    };
    return defs[std::min (2, std::max (0, model))];
}

static double autoLevelGain (int model, bool lite, double rot)
{
    const auto& t = lite ? circuitDef (model).autoLevelDbLite : circuitDef (model).autoLevelDb; const int len = (int) t.size();
    const double x = std::min (1.0, std::max (0.0, rot)) * (len - 1);
    const int i = std::min (len - 2, (int) std::floor (x)); const double f = x - i;
    return jsmath::pow (10.0, -(t[i] + f * (t[i + 1] - t[i])) / 20);
}

static constexpr double DRIVE_TICK = 5e-3;

// ============================================================================
// Lite (see the JS): a few filters and a smooth clipper per circuit, at 4x
// ============================================================================
static constexpr double PI_ = 3.141592653589793;
static double tanhE (double u) { return u > 20 ? 1 : u < -20 ? -1 : 1 - 2 / (jsmath::exp (2 * u) + 1); }
static double sclip (double u, double lo, double hi) { return u > 0 ? hi * tanhE (u / hi) : lo * tanhE (u / lo); }
static double hclip (double u, double lo, double hi) { const double r = u / (u > 0 ? hi : lo), r2 = r * r; return u / jsmath::pow (1 + r2 * r2, 0.25); }
static double bend (double u, double k) { return u + k * u * u; }
static double pole (double fc, double T) { return jsmath::exp (-2 * PI_ * fc * T); }
static const double FUZZ_LITE_GAIN_DB[21] = { -12.94, -11.42, -9.81, -8.11, -6.3, -4.37, -2.31, -0.1, 2.28, 4.85, 7.62, 10.62, 13.85, 17.32, 20.97, 24.69, 28.33, 31.75, 35.09, 38.65, 45.17 };
static double tableAt (const double* t, int len, double rot)
{
    const double x = std::min (1.0, std::max (0.0, rot)) * (len - 1);
    const int i = std::min (len - 2, (int) std::floor (x)); const double f = x - i;
    return t[i] + f * (t[i + 1] - t[i]);
}
static const double TS_LITE_TRIM = jsmath::pow (10.0, -2.2 / 20);
static constexpr double TWEED_A1 = 55, TWEED_A2 = 26, TWEED_BEND = 0.1, TWEED_BEND2 = 0.03;

// ============================================================================
// ColourCircuit
// ============================================================================
ColourCircuit::ColourCircuit (double sampleRate, const Settings& s)
    : fs (sampleRate), os (s.lite ? 4 : s.oversample > 0 ? s.oversample : 1), T (1 / (sampleRate * os)), ovs (os), p (s), lite (s.lite)
{
    osBuf.assign (os, 0.0);
    // _build
    const CircuitDef& def = circuitDef (p.model);
    P = std::make_shared<Values>();
    driveNow = driveMid = p.drive;
    def.setDrive (*P, driveNow);
    fullScale = def.fullScaleVolts;
    if (lite)
    {
        // liteInit
        L.in = pole (15.6, T); L.hp = pole (720, T); L.tone = pole (723, T); L.miller = pole (14000, T);
        L.out = pole (p.model == Tweed ? 33 : p.model == Fuzz ? 32 : 1.6, T);
        liteDrive();
        slewCount = 0; derive(); return;
    }
    cir = std::make_unique<Circuit> (def.build (P), T);
    u.assign (1 + def.supplies.size(), 0.0);
    for (size_t k = 0; k < def.supplies.size(); k++) u[k + 1] = def.supplies[k];
    cir->settle (u.data(), T);
    ixOut = cir->outIndex ("out"); ixClip = cir->outIndex ("clip");
    dc = cir->y[(size_t) ixOut];
    slewCount = 0;
    derive();
}

void ColourCircuit::liteDrive()
{
    if (p.model == TS808) L.fb = pole (1 / (2 * PI_ * (51e3 + P->drive) * 51e-12), T);
    if (p.model == Fuzz) L.g = jsmath::pow (10.0, tableAt (FUZZ_LITE_GAIN_DB, 21, driveNow) / 20);
}

void ColourCircuit::derive()
{
    const double tau = std::max (0.0, p.driveSlewMs) / 1000;
    slewA = tau > 0 ? 1 - jsmath::exp (-2 * T / tau) : 1;
    slewTick = std::max (1, (int) std::floor (DRIVE_TICK / T + 0.5));
    inGain = fullScale;
    outGainBase = jsmath::pow (10.0, p.outputDb / 20) / fullScale;
    outGain = outGainBase * (p.autoLevel ? autoLevelGain (p.model, lite, driveNow) : 1);
}

void ColourCircuit::setParams (const Settings& s)
{
    p.drive = s.drive; p.driveSlewMs = s.driveSlewMs; p.outputDb = s.outputDb; p.autoLevel = s.autoLevel;
    derive();
}

void ColourCircuit::processLite (const float* input, float* output, int n)
{
    const double target = p.drive; double* st = L.s; const Values& Pv = *P;
    bool gliding = driveNow != target;
    for (int s = 0; s < n; s++)
    {
        const double* up = ovs.up ((double) input[s] * inGain);
        for (int k = 0; k < os; k++)
        {
            if (gliding)
            {
                const double a = slewA, m1 = driveMid += (target - driveMid) * a;
                double d = driveNow + (m1 - driveNow) * a;
                if (std::abs (target - d) < 1e-5 && std::abs (target - m1) < 1e-5) { d = driveMid = target; gliding = false; }
                driveNow = d;
                circuitDef (p.model).setDrive (*P, d); liteDrive();
                if (p.autoLevel) outGain = outGainBase * autoLevelGain (p.model, lite, d);
            }
            // liteStep
            const double x = up[k]; double y;
            if (p.model == TS808)
            {
                const double x1 = x - (st[0] = st[0] + (1 - L.in) * (x - st[0]));
                const double xh = x1 - (st[1] = st[1] + (1 - L.hp) * (x1 - st[1]));
                const double g = (51e3 + Pv.drive) / 4.7e3;
                const double v = (st[2] = st[2] + (1 - L.fb) * (g * xh - st[2]));
                const double o1 = x1 + sclip (v, 0.42, 0.40);
                const double t = (st[3] = st[3] + (1 - L.tone) * (o1 - st[3]));
                y = t * TS_LITE_TRIM;
            }
            else if (p.model == Fuzz)
            {
                const double x1 = x - (st[0] = st[0] + (1 - L.in) * (x - st[0]));
                const double yy = hclip (L.g * x1, 0.28, 0.20);
                y = yy - (st[1] = st[1] + (1 - L.out) * (yy - st[1]));
            }
            else
            {
                const double x1 = (st[0] = st[0] + (1 - L.miller) * (x - st[0]));
                const double y1 = -TWEED_A1 * bend (hclip (x1, 1.8, 1.0), TWEED_BEND);
                const double v2 = Pv.vol * y1;
                const double y2 = -TWEED_A2 * bend (hclip (v2, 3.0, 5.0), TWEED_BEND2);
                const double y3 = y2 > 0 ? 25 * tanhE (y2 / 25) : y2;
                y = y3 - (st[1] = st[1] + (1 - L.out) * (y3 - st[1]));
            }
            osBuf[(size_t) k] = y;
        }
        output[s] = (float) (ovs.down (osBuf.data(), os) * outGain);
    }
}

void ColourCircuit::process (const float* input, float* output, int n)
{
    if (lite) { processLite (input, output, n); return; }
    Circuit& C = *cir;
    const double target = p.drive;
    bool gliding = driveNow != target;
    for (int s = 0; s < n; s++)
    {
        const double* up = ovs.up ((double) input[s] * inGain);
        for (int k = 0; k < os; k++)
        {
            if (gliding)
            {
                const double a = slewA, m1 = driveMid += (target - driveMid) * a;
                double d = driveNow + (m1 - driveNow) * a;
                if (std::abs (target - d) < 1e-5 && std::abs (target - m1) < 1e-5) { d = driveMid = target; gliding = false; }
                driveNow = d;
                circuitDef (p.model).setDrive (*P, d);
                if (p.autoLevel) outGain = outGainBase * autoLevelGain (p.model, lite, d);
                if (! gliding || ++slewCount >= slewTick) { slewCount = 0; C.setT (T); }
                else C.updateRV();
            }
            u[0] = up[k];
            C.step (u.data());
            osBuf[(size_t) k] = C.y[(size_t) ixOut] - dc;
        }
        dc += 1e-5 * (C.y[(size_t) ixOut] - dc) * os; // very slow DC tracker
        output[s] = (float) (ovs.down (osBuf.data(), os) * outGain);
    }
}

} // namespace mackie
