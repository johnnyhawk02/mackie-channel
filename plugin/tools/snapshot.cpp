// Renders the editor to a PNG without a host:  snapshot out.png [drive 0..1] [scale]
#include <juce_audio_processors/juce_audio_processors.h>

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter();

int main (int argc, char** argv)
{
    juce::ScopedJuceInitialiser_GUI init;
    if (argc < 2) { std::fprintf (stderr, "usage: snapshot out.png [drive] [scale]\n"); return 1; }
    const juce::File out = juce::File::getCurrentWorkingDirectory().getChildFile (argv[1]);
    std::unique_ptr<juce::AudioProcessor> processor (createPluginFilter());
    if (argc > 2) processor->getParameters()[0]->setValueNotifyingHost ((float) std::atof (argv[2]));
    std::unique_ptr<juce::AudioProcessorEditor> editor (processor->createEditorIfNeeded());
    editor->setVisible (true);
    const auto image = editor->createComponentSnapshot (editor->getLocalBounds(), true, argc > 3 ? (float) std::atof (argv[3]) : 2.0f);
    out.deleteFile();
    juce::FileOutputStream stream (out);
    if (! stream.openedOk() || ! juce::PNGImageFormat().writeImageToStream (image, stream)) return 1;
    std::printf ("%s  %dx%d\n", out.getFullPathName().toRawUTF8(), editor->getWidth(), editor->getHeight());
    editor = nullptr;
    return 0;
}
