#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include "MackieChannelCore.h"
#include <memory>
#include <vector>

// One input channel of a CR1604-VLZ as an overdrive, with the Drive knob as its
// TRIM. The sound is MackieChannel from MackieChannelCore (the C++ twin of
// mackie-channel-core.js). The Quality choice picks the core's preset: High is
// 4x oversampling like tools/render.js; Normal, Eco and Lite trade accuracy for CPU.
class ColourboxProcessor : public juce::AudioProcessor, private juce::Timer
{
public:
    // Quality choice index -> mackie::Options::Quality (the order shown in the editor)
    static constexpr int qualityPreset[4] = { mackie::Options::Lite, mackie::Options::Eco, mackie::Options::Normal, mackie::Options::High };

    ColourboxProcessor();
    ~ColourboxProcessor() override;

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

    void timerCallback() override;
    int qualityIndex() const { return juce::jlimit (0, 3, (int) qualityParam->load()); }

    std::atomic<float>* driveParam = nullptr;
    std::atomic<float>* qualityParam = nullptr;
    std::unique_ptr<mackie::MackieChannel> channel;
    mackie::Options options;
    std::vector<float> mono, wet, wetOld;
    double rate = 0;

    // A Quality change builds a new channel on the message thread (timer), hands it
    // to the audio thread, which crossfades from the old one and hands that back.
    int builtQuality = -1;                                   // message thread
    std::atomic<mackie::MackieChannel*> incoming { nullptr }; // message -> audio
    std::atomic<mackie::MackieChannel*> retired { nullptr };  // audio -> message
    std::unique_ptr<mackie::MackieChannel> fadingOut;        // audio thread
    int fadePos = 0, fadeLen = 1;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ColourboxProcessor)
};
