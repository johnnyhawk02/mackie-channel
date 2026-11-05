#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include "PluginProcessor.h"

// Just the Drive knob from the web page: the orange-ringed trim knob and its
// channel-gain scale, nothing else.
class DriveKnobLook : public juce::LookAndFeel_V4
{
public:
    void drawRotarySlider (juce::Graphics&, int x, int y, int width, int height, float sliderPos,
                           float startAngle, float endAngle, juce::Slider&) override;
};

class VlzChannelDriveEditor : public juce::AudioProcessorEditor
{
public:
    explicit VlzChannelDriveEditor (VlzChannelDriveProcessor&);
    ~VlzChannelDriveEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    DriveKnobLook look;
    juce::Slider knob;
    std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> attachment;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (VlzChannelDriveEditor)
};
