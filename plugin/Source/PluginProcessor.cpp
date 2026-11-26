#include "PluginProcessor.h"
#include "PluginEditor.h"

#include <cmath>

ColourboxProcessor::ColourboxProcessor()
    : AudioProcessor (BusesProperties()
                          .withInput ("Input", juce::AudioChannelSet::stereo(), true)
                          .withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
      apvts (*this, nullptr, "VLZ", createLayout (this))
{
    driveParam = apvts.getRawParameterValue ("drive");
    qualityParam = apvts.getRawParameterValue ("quality");
    circuitParam = apvts.getRawParameterValue ("circuit");
}

const juce::StringArray ColourboxProcessor::circuitNames { "Mackie", "Tube Screamer", "Fuzz Face", "Tweed Champ" };

namespace
{
    struct MackieVoice : ColourboxVoice
    {
        mackie::Options o; std::unique_ptr<mackie::MackieChannel> ch;
        MackieVoice (double rate, int quality, double drive) { o.drive = drive; o.quality = quality; ch = std::make_unique<mackie::MackieChannel> (rate, o); }
        void setDrive (double d) override { o.drive = d; ch->setParams (o); }
        void process (const float* in, float* out, int n) override { ch->process (in, out, n); }
        double latencySamples() const override { return ch->latencySamples(); }
    };
    // The Mackie at High, with Normal standing by for passages High cannot run in real time.
    // Only one of the two runs, except for the 3 ms of a switch.
    struct AdaptiveMackieVoice : ColourboxVoice
    {
        mackie::Options o; std::unique_ptr<mackie::MackieChannel> hi, norm;
        double rate; bool live = false, onHi = true;
        double load = 0;         // smoothed time taken / time available, of the running channel
        double calm = 0;         // seconds High would have fitted again
        int fade = 0;            // samples left of a switch (warm-up, then crossfade)
        std::vector<float> other;
        static constexpr int warmUp = 16, fadeLen = 112; // the new channel's output filter fills, then the fade
        static constexpr double dropAt = 0.8, backAt = 0.6, costRatio = 1.35, backAfter = 1.0;

        AdaptiveMackieVoice (double r, double drive, int maxBlock) : rate (r), other ((size_t) maxBlock)
        {
            o.drive = drive; o.quality = mackie::Options::High; hi = std::make_unique<mackie::MackieChannel> (r, o);
            o.quality = mackie::Options::Normal; norm = std::make_unique<mackie::MackieChannel> (r, o);
        }
        void setDrive (double d) override { o.drive = d; hi->setParams (o); norm->setParams (o); }
        double latencySamples() const override { return hi->latencySamples(); }
        void setLive (bool l) override { live = l; }

        void process (const float* in, float* out, int n) override
        {
            mackie::MackieChannel& cur = onHi ? *hi : *norm; mackie::MackieChannel& old = onHi ? *norm : *hi;
            if (fade > 0) // finishing a switch: old fades out under cur
            {
                const int k = juce::jmin (n, fade);
                old.process (in, other.data(), k);
                cur.process (in, out, n);
                for (int i = 0; i < k; i++)
                {
                    const int left = fade - i; // fadeLen + warmUp .. 1
                    const float t = left > fadeLen ? 0.0f : 1.0f - (float) left / (float) fadeLen;
                    out[i] = other[(size_t) i] + t * (out[i] - other[(size_t) i]);
                }
                fade -= k;
                return;
            }
            const auto t0 = juce::Time::getHighResolutionTicks();
            cur.process (in, out, n);
            if (! live) { if (! onHi) switchTo (true); load = 0; calm = 0; return; } // a bounce: High, at the next block
            const double took = juce::Time::highResolutionTicksToSeconds (juce::Time::getHighResolutionTicks() - t0);
            const double avail = n / rate;
            load += (took / avail - load) * (1 - std::exp (-avail / 0.05)); // 50 ms smoothing: one late block is not an overload
            if (onHi) { if (load > dropAt) switchTo (false); }
            else
            {
                calm = load * costRatio < backAt ? calm + avail : 0;
                if (calm >= backAfter) switchTo (true);
            }
        }
        void switchTo (bool toHi)
        {
            mackie::MackieChannel& from = onHi ? *hi : *norm; mackie::MackieChannel& to = toHi ? *hi : *norm;
            to.takeStateFrom (from);
            onHi = toHi; fade = warmUp + fadeLen; calm = 0;
            load = toHi ? load * costRatio : load / costRatio;
        }
    };
    struct ColourVoice : ColourboxVoice
    {
        mackie::ColourCircuit::Settings s; std::unique_ptr<mackie::ColourCircuit> ch;
        ColourVoice (double rate, int model, int os, bool lite, double drive) { s.model = model; s.oversample = os; s.lite = lite; s.drive = drive; ch = std::make_unique<mackie::ColourCircuit> (rate, s); }
        void setDrive (double d) override { s.drive = d; ch->setParams (s); }
        void process (const float* in, float* out, int n) override { ch->process (in, out, n); }
        double latencySamples() const override { return ch->latencySamples(); }
    };
}

// circuit: choice index (0 Mackie, then the colour circuits); quality: choice index (Lite, Eco, Normal, High)
ColourboxVoice* ColourboxProcessor::makeVoice (double rate, int circuit, int quality, double drive, int maxBlock)
{
    if (circuit == 0 && quality == 3) return new AdaptiveMackieVoice (rate, drive, maxBlock);
    if (circuit == 0) return new MackieVoice (rate, qualityPreset[quality], drive);
    // every setting keeps the 15-sample latency: 4x at High, 2x for Normal and Eco,
    // and Lite is the formula version at 4x
    return new ColourVoice (rate, circuit - 1, quality == 3 ? 4 : 2, quality == 0, drive);
}

ColourboxProcessor::~ColourboxProcessor()
{
    stopTimer();
    delete incoming.exchange (nullptr);
    delete retired.exchange (nullptr);
}

double ColourboxProcessor::channelGainDb (double drive)
{
    // MackieChannel.info() in the JS: gain leg, preamp gain and the line pad
    const double rg = mackie::trimResistance (drive) + 3.32;
    const double gd = 1 + 2 * 5110 / rg;
    const double shunt = 1 / (1 / 1500.0 + 1 / 6810.0);
    const double pad = shunt / (5620 + shunt);
    return 20 * std::log10 (pad * gd * 5110 / 10000);
}

juce::AudioProcessorValueTreeState::ParameterLayout ColourboxProcessor::createLayout (ColourboxProcessor*)
{
    juce::AudioProcessorValueTreeState::ParameterLayout layout;
    layout.add (std::make_unique<juce::AudioParameterFloat> (
        juce::ParameterID { "drive", 1 }, "Drive", juce::NormalisableRange<float> (0.0f, 1.0f), 0.0f,
        juce::AudioParameterFloatAttributes()
            .withStringFromValueFunction ([] (float v, int)
            {
                // the knob's 0-10 scale, the same on every circuit (the stored value is still 0-1)
                return juce::String (v * 10.0f, 1);
            })));
    // added after Drive: sessions saved before it load as High, the sound they had
    layout.add (std::make_unique<juce::AudioParameterChoice> (
        juce::ParameterID { "quality", 1 }, "Quality", juce::StringArray { "Lite", "Eco", "Normal", "High" }, 3));
    // added after Quality: sessions saved before it load as the Mackie
    layout.add (std::make_unique<juce::AudioParameterChoice> (
        juce::ParameterID { "circuit", 1 }, "Circuit", circuitNames, 0));
    return layout;
}

bool ColourboxProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto& out = layouts.getMainOutputChannelSet();
    if (out != juce::AudioChannelSet::mono() && out != juce::AudioChannelSet::stereo())
        return false;
    return layouts.getMainInputChannelSet() == out;
}

void ColourboxProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
    stopTimer();
    delete incoming.exchange (nullptr);
    delete retired.exchange (nullptr);
    fadingOut.reset();
    // a fresh channel settles to its operating point at the current Drive (no glide)
    rate = sampleRate;
    builtQuality = qualityIndex(); builtCircuit = circuitIndex();
    drive = driveParam->load();
    mono.assign ((size_t) juce::jmax (1, samplesPerBlock), 0.0f);
    channel.reset (makeVoice (sampleRate, builtCircuit, builtQuality, drive, (int) mono.size()));
    wet.assign (mono.size(), 0.0f); wetOld.assign (mono.size(), 0.0f);
    fadeLen = juce::jmax (1, (int) (0.02 * sampleRate)); // 20 ms crossfade on a Circuit or Quality change
    // every circuit and preset has the same latency (15 samples), so a change does not move it
    setLatencySamples ((int) std::ceil (channel->latencySamples()));
    startTimerHz (20);
}

void ColourboxProcessor::timerCallback()
{
    delete retired.exchange (nullptr);
    const int qi = qualityIndex(), ci = circuitIndex();
    if ((qi == builtQuality && ci == builtCircuit) || rate <= 0 || incoming.load() != nullptr) return;
    auto* fresh = makeVoice (rate, ci, qi, driveParam->load(), (int) mono.size()); // settles here, off the audio thread
    builtQuality = qi; builtCircuit = ci;
    delete incoming.exchange (fresh);
}

void ColourboxProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;
    const int numIn = getTotalNumInputChannels(), numOut = getTotalNumOutputChannels();
    const int n = buffer.getNumSamples();
    if (channel == nullptr || numIn == 0) { buffer.clear(); return; }

    // the knob is read once per block and glides inside the core, as in the web page
    const double d = (double) driveParam->load();
    if (d != drive)
    {
        drive = d;
        channel->setDrive (drive);
        if (fadingOut) fadingOut->setDrive (drive);
    }

    // a voice built for a new Circuit or Quality: crossfade to it (unless a fade is still running)
    if (fadingOut == nullptr && retired.load() == nullptr)
        if (auto* fresh = incoming.exchange (nullptr))
        {
            fadingOut = std::move (channel);
            channel.reset (fresh);
            channel->setDrive (drive); // the Drive may have moved since it was built
            fadePos = 0;
        }

    // one channel strip is mono: average the inputs, run one circuit, copy to every output
    const int chunk = (int) mono.size();
    for (int start = 0; start < n; start += chunk)
    {
        const int len = juce::jmin (chunk, n - start);
        for (int i = 0; i < len; i++) mono[(size_t) i] = 0.0f;
        for (int c = 0; c < numIn; c++)
        {
            const float* in = buffer.getReadPointer (c, start);
            for (int i = 0; i < len; i++) mono[(size_t) i] += in[i] / (float) numIn;
        }
        channel->setLive (! isNonRealtime());
        channel->process (mono.data(), wet.data(), len);
        if (fadingOut)
        {
            fadingOut->process (mono.data(), wetOld.data(), len);
            for (int i = 0; i < len; i++)
            {
                const float t = juce::jmin (1.0f, (float) (fadePos + i) / (float) fadeLen);
                wet[(size_t) i] = wetOld[(size_t) i] + t * (wet[(size_t) i] - wetOld[(size_t) i]);
            }
            fadePos += len;
            if (fadePos >= fadeLen) retired.store (fadingOut.release()); // freed on the message thread
        }
        for (int c = 0; c < numOut; c++)
            juce::FloatVectorOperations::copy (buffer.getWritePointer (c, start), wet.data(), len);
    }
}

juce::AudioProcessorEditor* ColourboxProcessor::createEditor()
{
    return new ColourboxEditor (*this);
}

void ColourboxProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    if (auto xml = apvts.copyState().createXml())
        copyXmlToBinary (*xml, destData);
}

void ColourboxProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    if (auto xml = getXmlFromBinary (data, sizeInBytes))
        if (xml->hasTagName (apvts.state.getType()))
            apvts.replaceState (juce::ValueTree::fromXml (*xml));
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new ColourboxProcessor();
}
