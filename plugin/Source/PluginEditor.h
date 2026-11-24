#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include "PluginProcessor.h"

// A Circuit row, the Drive knob from the web page (the orange-ringed trim knob
// with the Mackie's channel-gain scale, or 0-10 for the colour circuits) and a
// small Quality row under it.
class DriveKnobLook : public juce::LookAndFeel_V4
{
public:
    int circuit = 0;
    void drawRotarySlider (juce::Graphics&, int x, int y, int width, int height, float sliderPos,
                           float startAngle, float endAngle, juce::Slider&) override;
};

class ColourboxEditor : public juce::AudioProcessorEditor
{
public:
    explicit ColourboxEditor (ColourboxProcessor&);
    ~ColourboxEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    DriveKnobLook look;
    juce::Slider knob;
    std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> attachment;
    juce::TextButton quality[4], circuit[4];
    std::unique_ptr<juce::ParameterAttachment> qualityAttachment, circuitAttachment;
    void showQuality (int index);
    void showCircuit (int index);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ColourboxEditor)
};
