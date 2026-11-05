#include "PluginEditor.h"

#include <cmath>

namespace
{
    // the web page's dark theme
    const juce::Colour panel (0xff2a3033), ink (0xffe7e9e4), inkSoft (0xff9aa4a7), accent (0xffea6a2c),
                       cap (0xff101315), capHi (0xff2a3134), pointer (0xfff1eee4);

    constexpr float a0 = -135.0f, a1 = 135.0f; // knob travel in degrees, as on the page
    constexpr int size = 236;                  // the page's knob area, in its own units
}

void DriveKnobLook::drawRotarySlider (juce::Graphics& g, int x, int y, int width, int height, float sliderPos,
                                      float, float, juce::Slider&)
{
    // the page's SVG: viewBox 0 0 236 236, centre 118
    const float s = (float) juce::jmin (width, height) / size;
    const juce::Point<float> c ((float) x + width * 0.5f, (float) y + height * 0.5f);
    auto disc = [&] (float r, juce::Colour col) { g.setColour (col); g.fillEllipse (c.x - r * s, c.y - r * s, 2 * r * s, 2 * r * s); };

    // scale: 41 fine ticks, then the channel gain in dB at the marks
    for (int i = 0; i <= 40; i++)
    {
        const float a = juce::degreesToRadians (a0 + i / 40.0f * (a1 - a0));
        const float r0 = 78, r1 = i % 5 ? 83.0f : 86.0f;
        g.setColour (inkSoft);
        g.drawLine (c.x + r0 * s * std::sin (a), c.y - r0 * s * std::cos (a),
                    c.x + r1 * s * std::sin (a), c.y - r1 * s * std::cos (a), 1.2f * s);
    }
    const double lo = VlzChannelDriveProcessor::channelGainDb (0), hi = VlzChannelDriveProcessor::channelGainDb (1);
    g.setFont (juce::FontOptions (14.0f * s, juce::Font::bold));
    for (int m : { -10, 0, 10, 20, 30, 40, 50 })
    {
        if (m < lo || m > hi) continue;
        const float a = juce::degreesToRadians (a0 + (float) ((m - lo) / (hi - lo)) * (a1 - a0));
        const juce::Point<float> p (c.x + 101 * s * std::sin (a), c.y - 101 * s * std::cos (a));
        g.setColour (ink);
        g.drawText (m == 0 ? juce::String ("U") : (m > 0 ? "+" : "") + juce::String (m),
                    juce::Rectangle<float> (40 * s, 18 * s).withCentre (p), juce::Justification::centred);
    }

    disc (70, accent);
    disc (64, cap);
    disc (52, capHi);
    // pointer: rect x 115.5 y 56 w 5 h 34 rx 2.5, rotated about the centre
    juce::Path ptr;
    ptr.addRoundedRectangle (c.x - 2.5f * s, c.y - 62 * s, 5 * s, 34 * s, 2.5f * s);
    ptr.applyTransform (juce::AffineTransform::rotation (juce::degreesToRadians (a0 + sliderPos * (a1 - a0)), c.x, c.y));
    g.setColour (pointer);
    g.fillPath (ptr);
}

VlzChannelDriveEditor::VlzChannelDriveEditor (VlzChannelDriveProcessor& p)
    : AudioProcessorEditor (&p)
{
    knob.setLookAndFeel (&look);
    knob.setSliderStyle (juce::Slider::RotaryHorizontalVerticalDrag);
    knob.setTextBoxStyle (juce::Slider::NoTextBox, false, 0, 0);
    knob.setMouseDragSensitivity (260); // the page: 260 px of drag for the whole travel
    knob.setPopupDisplayEnabled (true, true, this);
    knob.setTooltip ("Drive");
    attachment = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment> (p.apvts, "drive", knob);
    knob.setDoubleClickReturnValue (true, 0.0); // the page: double-click goes back to 0
    addAndMakeVisible (knob);
    setSize (size, size);
}

VlzChannelDriveEditor::~VlzChannelDriveEditor()
{
    knob.setLookAndFeel (nullptr);
}

void VlzChannelDriveEditor::paint (juce::Graphics& g)
{
    g.fillAll (panel);
}

void VlzChannelDriveEditor::resized()
{
    knob.setBounds (getLocalBounds());
}
