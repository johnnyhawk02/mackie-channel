# Colourbox (VST3)

The circuit models in `../mackie-channel-core.js` and `../colour-circuits-core.js` as a VST3 effect: a Circuit row (Mackie, Tube Screamer, Fuzz Face, Tweed Champ), the Drive knob at the centre of a three.js picture of the output's harmonics, and a Quality row under it. (It was called VLZ Channel Drive until November 2026. The plugin codes did not change, so sessions saved with it load Colourbox. Delete the old `VLZ Channel Drive.vst3`.)

- **Sound:** `Source/MackieChannelCore.cpp` is the JS core ported statement by statement: the same netlists, node numbering and order of every floating-point operation. It runs the line input, auto level on and the fixed 30 ms Drive glide, as `tools/render.js` does. Stereo input is averaged to mono (one channel strip is mono) and the result goes to both outputs, like the web page's worklet.
- **Exact rounding:** `Source/JsMath.cpp` has `exp`, `log`, `log1p` and `pow` exactly as V8 (Node, Chrome) computes `Math.exp` and the rest. The Mac's own `exp` and `log` differ from V8's in the last bit about 10% of the time. The core is built with `-ffp-contract=off`, because a fused multiply-add rounds differently from JS. `JsMath.cpp` turns contraction back on with a pragma, because Node builds V8's math that way.
- **Circuit:** a choice parameter (`circuit`): Mackie (the default, and what sessions saved before it load as), Tube Screamer, Fuzz Face or Tweed Champ. The three colour circuits are `Source/ColourCircuitsCore.cpp`, ported from `colour-circuits-core.js` the same way, on the Mackie core's Netlist, Circuit and Oversampler (the triode was added to that Circuit; the Mackie never uses it, so its numbers are unchanged). They run the full circuit at 4x in High and 2x in Normal and Eco. In Lite each is a formula version instead (a few filters and a smooth clipper, matched to the full model's gain, clip levels and loudness), at 4x and about a tenth of the CPU, like the Mackie's Lite. The latency stays 15 samples in every setting. A change builds the new circuit on the message thread and crossfades over 20 ms, like a Quality change. For the colour circuits the Drive readout is the 0-10 knob scale instead of channel gain.
- **Quality:** a choice parameter (`quality`), one of the core's presets. High (the default, and what sessions saved before it load as) is the full circuit at 4x. Normal, Eco and Lite use less CPU; see the main README. A change builds the new channel on the message thread and crossfades to it over 20 ms on the audio thread.
- **High under load:** played live, the Mackie at High times its own processing. While a passage takes more than about 80% of real time (very bright, hard-driven input makes the solver iterate far more), it steps down to Normal (3x): Normal takes over the circuit's state (capacitor voltages, Drive glide, input history), so the 3 ms crossfade has no thump, and from then on the output is what Normal would have given. It returns to High after a second in which High would have used under 60%. An offline bounce always runs High, and so does the null test (`vst3null` runs offline unless `LIVE=1`).
- **Latency:** 15 samples in every Quality setting, reported to the host. (Before November 2026 it reported 16, one more than the filters' real delay.)
- **Picture and knob (1.2.0):** the editor is the Circuit row, a web view with the Partials picture from the Colourbox three.js studies, and the Quality row. The Drive knob is drawn in the picture, at the centre of the harmonic rings (one ring per harmonic of the output, which wake up as Drive adds them). Drag up or down anywhere on the picture to turn it (260 px for the whole travel, Shift for fine), double-click for 0; the page sends Drive and the gesture to the plugin, and the plugin sends Drive and Circuit back at up to 30 Hz, so automation moves the knob. The rings come from the circuit models' output for a 100 Hz sine at −12 dBFS, a table of 21 Drive steps per circuit baked into the page. `web/graphics.html` is built from the saved studies page by `web/src/make-graphics.py`. Drawing is capped at 30 frames a second. The page and `three.module.min.js` (r160) are compiled into the plugin, so it works offline. `COLOURBOX_READY_FILE=path` makes the editor write that file once the page has WebGL running and the picture built.
- **Codes:** plugin code `Vlzd`, manufacturer `Jhny`, bundle id `com.johnny.vlzchanneldrive`. The parameter ids are `drive` (0 to 1, shown as channel gain in dB for the Mackie), `quality` and `circuit`. Do not change these, or saved sets lose their settings.

## Build

```
cmake -S plugin -B plugin/build -DCMAKE_BUILD_TYPE=Release
cmake --build plugin/build --target Colourbox_VST3 -j8
```

The build copies `Colourbox.vst3` to `~/Library/Audio/Plug-Ins/VST3/Johnny Hawk/`. JUCE 8.0.10 comes from `~/Developer/Plugins/JUCE`; pass `-DJUCE_DIR=...` to use another copy. The `snapshot` target renders the editor to a PNG: `plugin/build/snapshot_artefacts/Release/snapshot knob.png 0.35`.

## Null test

```
cmake --build plugin/build --target vst3null -j8
plugin/tools/nulltest.sh
```

For each bass sample in `samples/`, in each Quality setting, at Drive 0, 0.15, 0.3, 0.6 and 1, and with Drive moved from 0.1 to 0.8 partway through, it renders the JS core to raw float32 (`tools/jsrender.js`). It runs the installed VST3 through a host (`tools/vst3null.cpp`) and prints the residual. Every case is bit-identical (residual −inf, 100% of samples match) when built on Linux x86-64. Before November 24 2026 the Mac build of the old Normal setting (2× preamp, EQ at the base rate) differed from the JS by up to −97 dBFS for a reason never found; that setting is gone. Run the null test on the Mac after a build to check the current ones.

A host parameter is a 32-bit float, so the plugin sees Drive 0.3 as 0.30000001. `jsrender.js` rounds Drive the same way. The committed 16-bit renders in `renders/` use the exact double 0.3. Against those, the VST3 differs by 1 LSB on a few dozen samples per file, which comes from that rounding.

The colour circuits: `CIRCUIT=ts808|fuzz|tweed` makes `tools/jsrender.js` and `tools/corerender.cpp` render that circuit (the oversample argument is a number, or `lite`). Built on Linux x86-64, the C++ core is bit-identical to the JS for every bass sample at Drive 0.25, 0.5 and 0.75 at 4x, and for Drive moved from 0.125 to 0.75 in the Fuzz Face and Tweed Champ. The Tube Screamer with Drive moving differs on 85 samples by −144.5 dBFS at most (one float step); the cause is not found yet. Use Drive values a float holds exactly (0.25, 0.5) when comparing `corerender` with `jsrender`: `jsrender` rounds Drive to a float like a host, `corerender` does not.

`tools/corerender.cpp` runs the C++ core alone, with no JUCE, for finding where a port diverges.

If the JS core changes, port the change to `MackieChannelCore.cpp` and run the null test again.
