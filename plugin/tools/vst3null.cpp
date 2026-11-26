// Runs the installed VST3 like a host would and saves its output, for the null
// test against the JS model (see nulltest.sh).
//   vst3null in.f32 out.f32 <sampleRate> <drive> [block=512] [drive2 at-sample]
// QUALITY=lite|eco|normal|high (default high) sets the Quality choice.
// CIRCUIT=mackie|ts808|fuzz|tweed (default mackie) sets the Circuit choice.
// The mono input goes to both channels of a stereo bus; the output is channel 1
// with the reported latency trimmed off.
#include <juce_audio_processors/juce_audio_processors.h>
#include <cstdio>
#include <cstdlib>
#include <vector>

int main (int argc, char** argv)
{
    juce::ScopedJuceInitialiser_GUI init;
    if (argc < 5) { std::fprintf (stderr, "usage: vst3null in.f32 out.f32 sr drive [block] [drive2 at]\n"); return 1; }
    std::vector<float> x;
    { FILE* f = std::fopen (argv[1], "rb"); if (! f) return 1; float b; while (std::fread (&b, 4, 1, f) == 1) x.push_back (b); std::fclose (f); }
    const double sr = std::atof (argv[3]);
    const float drive = (float) std::atof (argv[4]);
    const int block = argc > 5 ? std::atoi (argv[5]) : 512;
    const float drive2 = argc > 7 ? (float) std::atof (argv[6]) : -1.0f;
    const long at = argc > 7 ? std::atol (argv[7]) : -1;

    juce::AudioPluginFormatManager fm;
    fm.addFormat (new juce::VST3PluginFormat());
    const auto path = juce::File::getSpecialLocation (juce::File::userHomeDirectory)
                          .getChildFile ("Library/Audio/Plug-Ins/VST3/Johnny Hawk/Colourbox.vst3").getFullPathName();
    juce::OwnedArray<juce::PluginDescription> types;
    juce::VST3PluginFormat vst3;
    vst3.findAllTypesForFile (types, path);
    if (types.isEmpty()) { std::fprintf (stderr, "no plugin at %s\n", path.toRawUTF8()); return 1; }
    juce::String err;
    auto plugin = fm.createPluginInstance (*types[0], sr, block, err);
    if (! plugin) { std::fprintf (stderr, "load failed: %s\n", err.toRawUTF8()); return 1; }
    plugin->setPlayConfigDetails (2, 2, sr, block);
    auto* param = plugin->getParameters()[0];
    param->setValue (drive);
    if (const char* qn = std::getenv ("QUALITY"))
    {
        const juce::StringArray names { "lite", "eco", "normal", "high" };
        const int qi = names.indexOf (qn);
        if (qi < 0) { std::fprintf (stderr, "unknown QUALITY %s\n", qn); return 1; }
        plugin->getParameters()[1]->setValue ((float) qi / 3.0f);
    }
    if (const char* cn = std::getenv ("CIRCUIT"))
    {
        const juce::StringArray names { "mackie", "ts808", "fuzz", "tweed" };
        const int ci = names.indexOf (cn);
        if (ci < 0) { std::fprintf (stderr, "unknown CIRCUIT %s\n", cn); return 1; }
        plugin->getParameters()[2]->setValue ((float) ci / 3.0f);
    }
    // offline (a bounce) unless LIVE=1: live, the Mackie at High steps down to Normal when it is overloaded
    plugin->setNonRealtime (std::getenv ("LIVE") == nullptr);
    plugin->prepareToPlay (sr, block);
    const int latency = plugin->getLatencySamples();

    const size_t total = x.size() + (size_t) latency;
    std::vector<float> y (total, 0.0f);
    juce::AudioBuffer<float> buf (2, block);
    juce::MidiBuffer midi;
    bool switched = false;
    const auto t0 = juce::Time::getMillisecondCounterHiRes();
    for (size_t s = 0; s < total; s += (size_t) block)
    {
        if (at >= 0 && ! switched && (long) s >= at) { param->setValue (drive2); switched = true; }
        const int n = (int) std::min ((size_t) block, total - s);
        buf.setSize (2, n, false, false, true);
        for (int c = 0; c < 2; c++)
            for (int i = 0; i < n; i++) buf.setSample (c, i, s + i < x.size() ? x[s + i] : 0.0f);
        plugin->processBlock (buf, midi);
        for (int i = 0; i < n; i++) y[s + i] = buf.getSample (0, i);
    }
    const double secs = (juce::Time::getMillisecondCounterHiRes() - t0) / 1000.0;
    std::fprintf (stderr, "latency %d, %.3fx realtime\n", latency, secs / (x.size() / sr));
    plugin->releaseResources();
    FILE* fo = std::fopen (argv[2], "wb"); std::fwrite (y.data() + latency, 4, x.size(), fo); std::fclose (fo);
    return 0;
}
