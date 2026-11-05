/*
 * MackieChannelCore.h
 *
 * C++ twin of ../../mackie-channel-core.js, ported line for line: same
 * netlists, same node numbering, same order of every floating-point
 * operation, so the plugin nulls against the JS renders. No JUCE in here,
 * so tools/nulltest can build it on its own. Change the two together.
 *
 * Build with -ffp-contract=off: a fused multiply-add rounds differently
 * from JS and the outputs drift apart.
 */
#pragma once

#include <array>
#include <functional>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace mackie
{

struct BjtModel { double Is, Bf, Br, Vaf; };
struct DiodeModel { double Is, N; };
struct OpAmpModel { double gbw, sr, a0, headroom, cc, rout; };

// ============================================================================
// Netlist
// ============================================================================
struct Element
{
    enum Kind { R, RV, C, L, V, D, Q, GM, CLAMP, BUF } k;
    // node names; empty = not used by this element
    std::string a, b, c, e, p, n, x, o;
    double r = 0;                    // R (when rf is empty)
    std::function<double()> rf;      // R / RV value read at matrix build time
    double val = 0; bool be = false; // C / L
    int idx = 0;                     // V
    DiodeModel dm {};                // D
    BjtModel qm {};                  // Q
    double gm = 0;                   // GM
    double hi = 0, lo = 0;           // CLAMP
    double g = 0;                    // BUF
    double g0 = 0;                   // RV: conductance stamped at the last build (shared by a circuit and its sub-step copies, as in JS)
};

struct Netlist
{
    std::vector<Element> els;
    std::vector<std::string> inputs;
    std::vector<std::pair<std::string, std::string>> outputs; // insertion order

    void R (const std::string& a, const std::string& b, double r);
    void R (const std::string& a, const std::string& b, std::function<double()> r);
    void RV (const std::string& a, const std::string& b, std::function<double()> r);
    void C (const std::string& a, const std::string& b, double c, bool stiff = false);
    void L (const std::string& a, const std::string& b, double l, bool stiff = false);
    void V (const std::string& name, const std::string& a);
    void D (const std::string& a, const std::string& b, const DiodeModel& m);
    void Q (const std::string& c, const std::string& b, const std::string& e, const BjtModel& m);
    void U (const std::string& name, const std::string& inP, const std::string& inN, const std::string& out,
            const OpAmpModel& m, double vcc, double vee);
    void out (const std::string& name, const std::string& node);
};

// ============================================================================
// Compiled circuit (see the JS for the derivation)
// ============================================================================
class Circuit
{
public:
    // fineLevels: how many levels of sub-step circuits to make up front
    // (the JS makes them lazily on the first failed step; making them here
    // keeps allocation off the audio thread and gives the same numbers).
    Circuit (std::shared_ptr<Netlist> net, double T, int fineLevels = 2, bool build = true);

    void setT (double T);
    void step (const double* u, int depth = 0);
    void settle (const double* u, double T);
    void updateRV();
    int outIndex (const std::string& name) const;

    std::vector<double> y;
    long iters = 0, fails = 0, substeps = 0;

private:
    struct Port { int va, vb, ia, ib; };
    struct Dev { enum { Dd, Qd, CL, RVd } k; int p; Element* el; };
    struct Reac { int a, b; bool isC; double val; bool be; double g; };

    void evalDevices();
    double residual (double* f);
    void factor();
    bool solve (const double* u, int maxIt);
    void finish (const double* u);
    void importState (const double* vr, const double* ir, const double* v);
    double gOf (const Reac& re, double T) const;
    void invert();

    std::shared_ptr<Netlist> net;
    std::unordered_map<std::string, int> nodeIndex;
    int node (const std::string& n);
    int N = 0, nn = 0, q = 0, m = 0, r = 0, o = 0;
    double T = 0;

    std::vector<Port> ports;
    std::vector<Dev> devs;
    std::vector<Reac> reac;
    std::vector<double> QA, DA, CA, RVg, limA, limB;
    std::vector<Dev> RVs;
    std::vector<signed char> lim;
    bool clampsOnly = false;
    std::vector<std::string> outNames;
    std::vector<int> outNodes;

    std::vector<double> Dh, Du, K, Ah, Au, Ai, Oh, Ou, Oi;
    std::vector<double> Mm, S, Minv, tmp;
    std::vector<double> J, v, i, p, f, jac, dI, dx, vr, vtmp, ftmp, sx, physI, vSave, uPrev, u0, ui;
    std::vector<int> perm;
    bool factored = false;
    double contract = 0;

    std::unique_ptr<Circuit> fine;
    bool fineDirty = true;
};

// ============================================================================
// Oversampler (linear-phase polyphase FIR)
// ============================================================================
class Oversampler
{
public:
    explicit Oversampler (int factor, int tpp = 16);
    const double* up (double x);
    double down (const double* arr, int n);
    double latency() const { return factor == 1 ? 0.0 : (double) (taps - 1) / factor; }
    int factor, tpp, taps;
    std::vector<double> h;
private:
    std::vector<double> upBuf, downBuf, outBuf;
    int upPos = 0, downPos = 0;
};

// ============================================================================
// Channel
// ============================================================================
struct Options
{
    double drive = 0.3;          // TRIM rotation 0..1
    double driveSlewMs = 30;     // Drive smoothing time constant in ms (0 = jump)
    bool mic = false;            // false: 'line' (J68), true: 'mic' (J84)
    double fullScaleVolts;       // 0 dBFS = +18 dBu (EBU R68)
    bool loCut = false;
    double eqHigh = 0.5, eqMid = 0.5, eqLow = 0.5, eqFreq = 0.5;
    double faderDb = 0;
    double outputDb = 0;
    bool autoLevel = true;
    int oversample = 1;
    Options();
};

struct Peaks { double pre = 0, diff = 0, eq = 0, fader = 0; };

class MackieChannel
{
public:
    MackieChannel (double sampleRate, const Options& opts);
    void setParams (const Options& o);  // every field but oversample
    void process (const float* input, float* output, int n);
    Peaks readPeaks() { Peaks pk = peaks; peaks = {}; return pk; }
    double latencySamples() const { return ovs.latency(); }
    double driveNow = 0;

private:
    struct CircuitValues { double trimOhms = 0; bool mic = false, loCut = false; double hi = 0, low = 0, mid = 0, freqOhms = 0, faderRatio = 0; };
    void derive();
    void build (bool fresh);

    double fs; int os; double T;
    Oversampler ovs;
    Options p;
    std::shared_ptr<CircuitValues> P;
    double driveMid = 0;
    int slewCount = 0, slewTick = 1;
    double slewA = 1, inGain = 1, outGainBase = 1, outGain = 1;
    std::array<double, 4> uA {}; std::array<double, 3> uB {}, uC {};
    std::unique_ptr<Circuit> A, B, C;
    int ixHot = 0, ixCold = 0, ixDiff = 0, ixPost = 0, ixMid = 0, ixVa = 0, ixFader = 0;
    std::string topoKey;
    bool changedA = false, changedB = false, changedC = false;
    std::vector<double> osBuf;
    Peaks peaks;
    bool pending = false;
};

double trimResistance (double rotation);
double autoLevelGain (double rot);

} // namespace mackie
