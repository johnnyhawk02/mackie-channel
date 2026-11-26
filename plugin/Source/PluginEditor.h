#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_extra/juce_gui_extra.h>
#include "PluginProcessor.h"
#include <optional>

// A Circuit row, the Partials picture from the three.js studies (web/graphics.html,
// in a web view) with the Drive knob at its centre, and a small Quality row.
class ColourboxEditor : public juce::AudioProcessorEditor, private juce::Timer
{
public:
    explicit ColourboxEditor (ColourboxProcessor&);
    ~ColourboxEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    juce::RangedAudioParameter* driveParam = nullptr;
    bool dragging = false; // a Drive gesture from the picture is open
    juce::TextButton quality[4], circuit[4];
    std::unique_ptr<juce::ParameterAttachment> qualityAttachment, circuitAttachment;
    void showQuality (int index);
    void showCircuit (int index);

    // the picture: Drive and Circuit go in at up to 30 Hz; dragging it sends Drive back
    juce::WebBrowserComponent screen;
    bool screenReady = false;
    float sentDrive = -1.0f;
    int sentCircuit = -1;
    std::optional<juce::WebBrowserComponent::Resource> serve (const juce::String& url);
    void timerCallback() override;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ColourboxEditor)
};
