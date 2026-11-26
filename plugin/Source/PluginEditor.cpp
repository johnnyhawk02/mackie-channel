#include "PluginEditor.h"
#include "BinaryData.h"

#include <cmath>
#include <cstring>

namespace
{
    // the web page's dark theme
    const juce::Colour bench (0xff15191b), inkSoft (0xff9aa4a7), accent (0xffea6a2c);

    constexpr int width = 400, screenHeight = 400; // the picture with the knob at its centre
    constexpr int row = 30;                        // the Circuit row over it and the Quality row under it

    void styleRowButton (juce::TextButton& b)
    {
        b.setClickingTogglesState (false);
        b.setColour (juce::TextButton::buttonColourId, bench);
        b.setColour (juce::TextButton::buttonOnColourId, bench);
        b.setColour (juce::TextButton::textColourOffId, inkSoft);
        b.setColour (juce::TextButton::textColourOnId, accent);
        b.setColour (juce::ComboBox::outlineColourId, juce::Colours::transparentBlack);
        b.setConnectedEdges (juce::Button::ConnectedOnLeft | juce::Button::ConnectedOnRight);
    }
}

ColourboxEditor::ColourboxEditor (ColourboxProcessor& p)
    : AudioProcessorEditor (&p),
      screen (juce::WebBrowserComponent::Options{}
                  .withNativeIntegrationEnabled()
                  .withResourceProvider ([this] (const juce::String& url) { return serve (url); })
                  .withEventListener ("ready", [this] (const juce::var&)
                  {
                      screenReady = true;
                      sentDrive = -1.0f; // send everything again
                      // for tests: the page only says ready once WebGL is up and the picture is built
                      if (auto* f = std::getenv ("COLOURBOX_READY_FILE")) juce::File (f).replaceWithText ("ready");
                  })
                  .withEventListener ("gesture", [this] (const juce::var& v)
                  {
                      const bool on = (bool) v.getProperty ("active", false);
                      if (on != dragging) { dragging = on; on ? driveParam->beginChangeGesture() : driveParam->endChangeGesture(); }
                  })
                  .withEventListener ("drive", [this] (const juce::var& v)
                  {
                      const float value = juce::jlimit (0.0f, 1.0f, (float) (double) v.getProperty ("value", 0.0));
                      driveParam->setValueNotifyingHost (driveParam->convertTo0to1 (value));
                      sentDrive = driveParam->convertFrom0to1 (driveParam->getValue()); // the page already shows it
                  }))
{
    addAndMakeVisible (screen);
    screen.goToURL (juce::WebBrowserComponent::getResourceProviderRoot());

    driveParam = p.apvts.getParameter ("drive");

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
    setSize (width, screenHeight + 2 * row);
    startTimerHz (30);
}

std::optional<juce::WebBrowserComponent::Resource> ColourboxEditor::serve (const juce::String& url)
{
    auto make = [] (const char* data, int bytes, const char* mime)
    {
        std::vector<std::byte> v ((size_t) bytes);
        std::memcpy (v.data(), data, (size_t) bytes);
        return juce::WebBrowserComponent::Resource { std::move (v), mime };
    };
    if (url == "/" || url == "/graphics.html")
        return make (BinaryData::graphics_html, BinaryData::graphics_htmlSize, "text/html");
    if (url == "/three.module.min.js")
        return make (BinaryData::three_module_min_js, BinaryData::three_module_min_jsSize, "text/javascript");
    return std::nullopt;
}

void ColourboxEditor::timerCallback()
{
    if (! screenReady) return;
    auto& apvts = static_cast<ColourboxProcessor&> (processor).apvts;
    const float drive = apvts.getRawParameterValue ("drive")->load();
    const int circuitIndex = (int) apvts.getRawParameterValue ("circuit")->load();
    if (drive == sentDrive && circuitIndex == sentCircuit) return;
    sentDrive = drive; sentCircuit = circuitIndex;
    auto* o = new juce::DynamicObject();
    o->setProperty ("drive", drive);
    o->setProperty ("circuit", circuitIndex);
    screen.emitEventIfBrowserIsVisible ("state", juce::var (o));
}

void ColourboxEditor::showCircuit (int index)
{
    for (int i = 0; i < 4; i++) circuit[i].setToggleState (i == index, juce::dontSendNotification);
}

void ColourboxEditor::showQuality (int index)
{
    for (int i = 0; i < 4; i++) quality[i].setToggleState (i == index, juce::dontSendNotification);
}

ColourboxEditor::~ColourboxEditor()
{
    stopTimer();
    if (dragging) driveParam->endChangeGesture();
}

void ColourboxEditor::paint (juce::Graphics& g)
{
    g.fillAll (bench);
}

void ColourboxEditor::resized()
{
    auto r = getLocalBounds();
    auto layRow = [] (juce::Rectangle<int> area, juce::TextButton* buttons)
    {
        area = area.withSizeKeepingCentre (280, row - 8);
        const int w = area.getWidth() / 4;
        for (int i = 0; i < 4; i++) buttons[i].setBounds (area.removeFromLeft (w));
    };
    layRow (r.removeFromTop (row).translated (0, 3), circuit);
    layRow (r.removeFromBottom (row).translated (0, -3), quality);
    screen.setBounds (r);
}
