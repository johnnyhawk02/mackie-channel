#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include "PluginProcessor.h"

// The Drive knob from the web page (the orange-ringed trim knob and its
// channel-gain scale) and a small Quality row under it.
class DriveKnobLook : public juce::LookAndFeel_V4
{
public:
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
    juce::TextButton quality[4];
    std::unique_ptr<juce::ParameterAttachment> qualityAttachment;
    void showQuality (int index);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ColourboxEditor)
};
