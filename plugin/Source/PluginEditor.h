#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_extra/juce_gui_extra.h>
#include "PluginProcessor.h"
#include <optional>

// A Circuit row, the Drive knob from the web page (the orange-ringed trim knob,
// 0 to 10) and a small Quality row under it, with the three.js pictures
// (web/graphics.html) in a web view to their left.
class DriveKnobLook : public juce::LookAndFeel_V4
{
public:
    int circuit = 0;
    void drawRotarySlider (juce::Graphics&, int x, int y, int width, int height, float sliderPos,
                           float startAngle, float endAngle, juce::Slider&) override;
};

class ColourboxEditor : public juce::AudioProcessorEditor, private juce::Timer
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

    // the pictures: Drive, Circuit and the chosen picture go in at up to 30 Hz, a picture choice comes back
    juce::WebBrowserComponent screen;
    bool screenReady = false;
    float sentDrive = -1.0f;
    int sentCircuit = -1, sentView = -1;
    std::optional<juce::WebBrowserComponent::Resource> serve (const juce::String& url);
    void timerCallback() override;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ColourboxEditor)
};
