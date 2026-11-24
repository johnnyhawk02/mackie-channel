#include "PluginEditor.h"

#include <cmath>

namespace
{
    // the web page's dark theme
    const juce::Colour panel (0xff2a3033), ink (0xffe7e9e4), inkSoft (0xff9aa4a7), accent (0xffea6a2c),
                       cap (0xff101315), capHi (0xff2a3134), pointer (0xfff1eee4);

    constexpr float a0 = -135.0f, a1 = 135.0f; // knob travel in degrees, as on the page
    constexpr int size = 236;                  // the page's knob area, in its own units
    constexpr int row = 30;                    // the Quality row under the knob, and the Circuit row over it

    void styleRowButton (juce::TextButton& b)
    {
        b.setClickingTogglesState (false);
        b.setColour (juce::TextButton::buttonColourId, panel);
        b.setColour (juce::TextButton::buttonOnColourId, panel);
        b.setColour (juce::TextButton::textColourOffId, inkSoft);
        b.setColour (juce::TextButton::textColourOnId, accent);
        b.setColour (juce::ComboBox::outlineColourId, juce::Colours::transparentBlack);
        b.setConnectedEdges (juce::Button::ConnectedOnLeft | juce::Button::ConnectedOnRight);
    }
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
    g.setFont (juce::FontOptions (14.0f * s, juce::Font::bold));
    if (circuit != 0) // colour circuits: 0 to 10, as on the circuits page
        for (int m = 0; m <= 10; m += 2)
        {
            const float a = juce::degreesToRadians (a0 + m / 10.0f * (a1 - a0));
            const juce::Point<float> p (c.x + 101 * s * std::sin (a), c.y - 101 * s * std::cos (a));
            g.setColour (ink);
            g.drawText (juce::String (m), juce::Rectangle<float> (40 * s, 18 * s).withCentre (p), juce::Justification::centred);
        }
    const double lo = ColourboxProcessor::channelGainDb (0), hi = ColourboxProcessor::channelGainDb (1);
    if (circuit == 0)
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

ColourboxEditor::ColourboxEditor (ColourboxProcessor& p)
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

    auto* param = p.apvts.getParameter ("quality");
    qualityAttachment = std::make_unique<juce::ParameterAttachment> (*param, [this] (float v) { showQuality ((int) v); });
    const char* names[4] = { "Lite", "Eco", "Normal", "High" };
    for (int i = 0; i < 4; i++)
    {
        auto& b = quality[i];
        b.setButtonText (names[i]);
        styleRowButton (b);
        b.setTooltip ("Quality: High is the full circuit at 4x; lower settings use less CPU");
        b.onClick = [this, i] { qualityAttachment->setValueAsCompleteGesture ((float) i); };
        addAndMakeVisible (b);
    }
    qualityAttachment->sendInitialUpdate();

    auto* cparam = p.apvts.getParameter ("circuit");
    circuitAttachment = std::make_unique<juce::ParameterAttachment> (*cparam, [this] (float v) { showCircuit ((int) v); });
    const char* shortNames[4] = { "Mackie", "TS", "Fuzz", "Tweed" };
    for (int i = 0; i < 4; i++)
    {
        auto& b = circuit[i];
        b.setButtonText (shortNames[i]);
        styleRowButton (b);
        b.setTooltip (ColourboxProcessor::circuitNames[i]);
        b.onClick = [this, i] { circuitAttachment->setValueAsCompleteGesture ((float) i); };
        addAndMakeVisible (b);
    }
    circuitAttachment->sendInitialUpdate();
    setSize (size, size + 2 * row);
}

void ColourboxEditor::showCircuit (int index)
{
    for (int i = 0; i < 4; i++) circuit[i].setToggleState (i == index, juce::dontSendNotification);
    look.circuit = index;
    knob.repaint();
}

void ColourboxEditor::showQuality (int index)
{
    for (int i = 0; i < 4; i++) quality[i].setToggleState (i == index, juce::dontSendNotification);
}

ColourboxEditor::~ColourboxEditor()
{
    knob.setLookAndFeel (nullptr);
}

void ColourboxEditor::paint (juce::Graphics& g)
{
    g.fillAll (panel);
}

void ColourboxEditor::resized()
{
    auto r = getLocalBounds();
    {
        auto top = r.removeFromTop (row).withSizeKeepingCentre (size - 24, row - 8).translated (0, 4);
        const int w = top.getWidth() / 4;
        for (auto& b : circuit) b.setBounds (top.removeFromLeft (w));
    }
    knob.setBounds (r.removeFromTop (size));
    r = r.withSizeKeepingCentre (size - 40, row - 8).translated (0, -12);
    const int w = r.getWidth() / 4;
    for (auto& b : quality) b.setBounds (r.removeFromLeft (w));
}
