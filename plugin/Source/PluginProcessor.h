#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include "MackieChannelCore.h"
#include <memory>
#include <vector>

// One input channel of a CR1604-VLZ as an overdrive, with the Drive knob as its
// TRIM. The sound is MackieChannel from MackieChannelCore (the C++ twin of
// mackie-channel-core.js), run at 4x oversampling like tools/render.js.
class VlzChannelDriveProcessor : public juce::AudioProcessor
{
public:
    static constexpr int oversample = 4;

    VlzChannelDriveProcessor();
    ~VlzChannelDriveProcessor() override = default;

    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return JucePlugin_Name; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    // Channel gain at a Drive rotation, line input (the web page's readout and knob scale).
    static double channelGainDb (double drive);

    juce::AudioProcessorValueTreeState apvts;

private:
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout();

    std::atomic<float>* driveParam = nullptr;
    std::unique_ptr<mackie::MackieChannel> channel;
    mackie::Options options;
    std::vector<float> mono, wet;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (VlzChannelDriveProcessor)
};
