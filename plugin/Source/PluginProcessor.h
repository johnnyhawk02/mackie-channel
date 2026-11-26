#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include "MackieChannelCore.h"
#include "ColourCircuitsCore.h"
#include <memory>
#include <vector>

// One Drive knob in front of a choice of circuits. The Circuit choice picks the
// Mackie CR1604-VLZ channel (MackieChannel, the C++ twin of mackie-channel-core.js)
// or one of the colour circuits (ColourCircuit, the twin of colour-circuits-core.js):
// Tube Screamer, Fuzz Face, tweed Champ preamp. The Quality choice picks the Mackie
// core's preset (High is 4x oversampling like tools/render.js); for the colour
// circuits High runs them at 4x and the other settings at 2x.
//
// The Mackie at High watches its own CPU use. While a passage costs more than about
// 80% of real time (very bright, hard-driven input), it crossfades to Normal (3x), which
// continues from the same circuit state, and goes back once High would fit again.
// Offline bounces always run High.

// The circuit the audio thread runs, whichever kind it is.
struct ColourboxVoice
{
    virtual ~ColourboxVoice() = default;
    virtual void setDrive (double drive) = 0;
    virtual void process (const float* in, float* out, int n) = 0;
    virtual double latencySamples() const = 0;
    // live playback (not an offline bounce): the Mackie at High may step down to Normal while it is overloaded
    virtual void setLive (bool) {}
};

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
    static const juce::StringArray circuitNames;
    int circuitIndex() const { return circuitParam == nullptr ? 0 : juce::jlimit (0, 3, (int) circuitParam->load()); }

    juce::AudioProcessorValueTreeState apvts;

private:
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout (ColourboxProcessor* self);
    static ColourboxVoice* makeVoice (double rate, int circuit, int quality, double drive, int maxBlock);

    void timerCallback() override;
    int qualityIndex() const { return juce::jlimit (0, 3, (int) qualityParam->load()); }

    std::atomic<float>* driveParam = nullptr;
    std::atomic<float>* qualityParam = nullptr;
    std::atomic<float>* circuitParam = nullptr;
    std::unique_ptr<ColourboxVoice> channel;
    double drive = 0;
    std::vector<float> mono, wet, wetOld;
    double rate = 0;

    // A Circuit or Quality change builds a new voice on the message thread (timer),
    // hands it to the audio thread, which crossfades from the old one and hands that back.
    int builtQuality = -1, builtCircuit = -1;                // message thread
    std::atomic<ColourboxVoice*> incoming { nullptr };      // message -> audio
    std::atomic<ColourboxVoice*> retired { nullptr };       // audio -> message
    std::unique_ptr<ColourboxVoice> fadingOut;              // audio thread
    int fadePos = 0, fadeLen = 1;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ColourboxProcessor)
};
