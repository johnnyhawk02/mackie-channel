#include "PluginProcessor.h"
#include "PluginEditor.h"

#include <cmath>

ColourboxProcessor::ColourboxProcessor()
    : AudioProcessor (BusesProperties()
                          .withInput ("Input", juce::AudioChannelSet::stereo(), true)
                          .withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
      apvts (*this, nullptr, "VLZ", createLayout())
{
    driveParam = apvts.getRawParameterValue ("drive");
    qualityParam = apvts.getRawParameterValue ("quality");
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

juce::AudioProcessorValueTreeState::ParameterLayout ColourboxProcessor::createLayout()
{
    juce::AudioProcessorValueTreeState::ParameterLayout layout;
    layout.add (std::make_unique<juce::AudioParameterFloat> (
        juce::ParameterID { "drive", 1 }, "Drive", juce::NormalisableRange<float> (0.0f, 1.0f), 0.0f,
        juce::AudioParameterFloatAttributes()
            .withStringFromValueFunction ([] (float v, int)
            {
                const double db = channelGainDb (v);
                return (db >= 0 ? "+" : "-") + juce::String (std::abs (db), 1) + " dB";
            })));
    // added after Drive: sessions saved before it load as High, the sound they had
    layout.add (std::make_unique<juce::AudioParameterChoice> (
        juce::ParameterID { "quality", 1 }, "Quality", juce::StringArray { "Lite", "Eco", "Normal", "High" }, 3));
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
    builtQuality = qualityIndex();
    options.drive = driveParam->load();
    options.quality = qualityPreset[builtQuality];
    channel = std::make_unique<mackie::MackieChannel> (sampleRate, options);
    mono.assign ((size_t) juce::jmax (1, samplesPerBlock), 0.0f);
    wet.assign (mono.size(), 0.0f); wetOld.assign (mono.size(), 0.0f);
    fadeLen = juce::jmax (1, (int) (0.02 * sampleRate)); // 20 ms crossfade on a Quality change
    // every preset has the same latency (15 samples), so a Quality change does not move it
    setLatencySamples ((int) std::ceil (channel->latencySamples()));
    startTimerHz (20);
}

void ColourboxProcessor::timerCallback()
{
    delete retired.exchange (nullptr);
    const int qi = qualityIndex();
    if (qi == builtQuality || rate <= 0 || incoming.load() != nullptr) return;
    mackie::Options o;
    o.drive = driveParam->load(); o.quality = qualityPreset[qi];
    auto* fresh = new mackie::MackieChannel (rate, o); // settles here, off the audio thread
    builtQuality = qi;
    delete incoming.exchange (fresh);
}

void ColourboxProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;
    const int numIn = getTotalNumInputChannels(), numOut = getTotalNumOutputChannels();
    const int n = buffer.getNumSamples();
    if (channel == nullptr || numIn == 0) { buffer.clear(); return; }

    // the knob is read once per block and glides inside the core, as in the web page
    const double drive = (double) driveParam->load();
    if (drive != options.drive)
    {
        options.drive = drive;
        channel->setParams (options);
        if (fadingOut) fadingOut->setParams (options);
    }

    // a channel built for a new Quality: crossfade to it (unless a fade is still running)
    if (fadingOut == nullptr && retired.load() == nullptr)
        if (auto* fresh = incoming.exchange (nullptr))
        {
            fadingOut = std::move (channel);
            channel.reset (fresh);
            channel->setParams (options); // the Drive may have moved since it was built
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
