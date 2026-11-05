#include "PluginProcessor.h"
#include "PluginEditor.h"

#include <cmath>

VlzChannelDriveProcessor::VlzChannelDriveProcessor()
    : AudioProcessor (BusesProperties()
                          .withInput ("Input", juce::AudioChannelSet::stereo(), true)
                          .withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
      apvts (*this, nullptr, "VLZ", createLayout())
{
    driveParam = apvts.getRawParameterValue ("drive");
    options.oversample = oversample;
}

double VlzChannelDriveProcessor::channelGainDb (double drive)
{
    // MackieChannel.info() in the JS: gain leg, preamp gain and the line pad
    const double rg = mackie::trimResistance (drive) + 3.32;
    const double gd = 1 + 2 * 5110 / rg;
    const double shunt = 1 / (1 / 1500.0 + 1 / 6810.0);
    const double pad = shunt / (5620 + shunt);
    return 20 * std::log10 (pad * gd * 5110 / 10000);
}

juce::AudioProcessorValueTreeState::ParameterLayout VlzChannelDriveProcessor::createLayout()
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
    return layout;
}

bool VlzChannelDriveProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto& out = layouts.getMainOutputChannelSet();
    if (out != juce::AudioChannelSet::mono() && out != juce::AudioChannelSet::stereo())
        return false;
    return layouts.getMainInputChannelSet() == out;
}

void VlzChannelDriveProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
    // a fresh channel settles to its operating point at the current Drive (no glide)
    options.drive = driveParam->load();
    channel = std::make_unique<mackie::MackieChannel> (sampleRate, options);
    mono.assign ((size_t) juce::jmax (1, samplesPerBlock), 0.0f);
    wet.assign (mono.size(), 0.0f);
    setLatencySamples ((int) std::ceil (channel->latencySamples()));
}

void VlzChannelDriveProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;
    const int numIn = getTotalNumInputChannels(), numOut = getTotalNumOutputChannels();
    const int n = buffer.getNumSamples();
    if (channel == nullptr || numIn == 0) { buffer.clear(); return; }

    // the knob is read once per block and glides inside the core, as in the web page
    const double drive = (double) driveParam->load();
    if (drive != options.drive) { options.drive = drive; channel->setParams (options); }

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
        for (int c = 0; c < numOut; c++)
            juce::FloatVectorOperations::copy (buffer.getWritePointer (c, start), wet.data(), len);
    }
}

juce::AudioProcessorEditor* VlzChannelDriveProcessor::createEditor()
{
    return new VlzChannelDriveEditor (*this);
}

void VlzChannelDriveProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    if (auto xml = apvts.copyState().createXml())
        copyXmlToBinary (*xml, destData);
}

void VlzChannelDriveProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    if (auto xml = getXmlFromBinary (data, sizeInBytes))
        if (xml->hasTagName (apvts.state.getType()))
            apvts.replaceState (juce::ValueTree::fromXml (*xml));
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new VlzChannelDriveProcessor();
}
