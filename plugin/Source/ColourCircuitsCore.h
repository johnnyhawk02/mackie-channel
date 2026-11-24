/*
 * ColourCircuitsCore.h
 *
 * C++ twin of ../../colour-circuits-core.js (Tube Screamer, Fuzz Face, tweed
 * Champ preamp), ported line for line like MackieChannelCore: same netlists,
 * node numbering and order of floating-point operations, so it nulls against
 * the JS. It uses the Mackie core's Netlist, Circuit (with the triode) and
 * Oversampler. Change the JS and this file together.
 */
#pragma once

#include "MackieChannelCore.h"

namespace mackie
{

class ColourCircuit
{
public:
    enum Model { TS808 = 0, Fuzz = 1, Tweed = 2 };
    struct Settings
    {
        int model = TS808;
        double drive = 0.3;
        double driveSlewMs = 30;
        double outputDb = 0;
        bool autoLevel = true;
        int oversample = 1;
    };

    ColourCircuit (double sampleRate, const Settings& s);
    void setParams (const Settings& s); // drive, slew, output and auto level (not model or oversample)
    void process (const float* input, float* output, int n);
    double latencySamples() const { return ovs.latency(); }
    double driveNow = 0;

    struct Values { double drive = 0, fuzz = 0, gvol = 0, vol = 0; };

private:
    void derive();
    void setDrive (double d);

    double fs; int os; double T;
    Oversampler ovs;
    Settings p;
    std::shared_ptr<Values> P;
    std::unique_ptr<Circuit> cir;
    std::vector<double> u, osBuf;
    int ixOut = 0, ixClip = 0;
    double dc = 0, fullScale = 1, driveMid = 0;
    int slewCount = 0, slewTick = 1;
    double slewA = 1, inGain = 1, outGainBase = 1, outGain = 1;
};

} // namespace mackie
