# VLZ Channel Drive (VST3)

The circuit model in `../mackie-channel-core.js` as a VST3 effect, with the web page's Drive knob as its only control.

- **Sound:** `Source/MackieChannelCore.cpp` is the JS core ported statement by statement: the same netlists, node numbering and order of every floating-point operation. It runs at 4x oversampling, line input, auto level on and the fixed 30 ms Drive glide, as `tools/render.js` does. Stereo input is averaged to mono (one channel strip is mono) and the result goes to both outputs, like the web page's worklet.
- **Exact rounding:** `Source/JsMath.cpp` has `exp`, `log`, `log1p` and `pow` exactly as V8 (Node, Chrome) computes `Math.exp` and the rest. The Mac's own `exp` and `log` differ from V8's in the last bit about 10% of the time. The core is built with `-ffp-contract=off`, because a fused multiply-add rounds differently from JS. `JsMath.cpp` turns contraction back on with a pragma, because Node builds V8's math that way.
- **Latency:** 16 samples, reported to the host (the oversampling filters, 15.75 samples).
- **Codes:** plugin code `Vlzd`, manufacturer `Jhny`, bundle id `com.johnny.vlzchanneldrive`. The parameter id is `drive` (0 to 1, shown as channel gain in dB). Do not change these, or saved sets lose their settings.

## Build

```
cmake -S plugin -B plugin/build -DCMAKE_BUILD_TYPE=Release
cmake --build plugin/build --target VlzChannelDrive_VST3 -j8
```

The build copies `VLZ Channel Drive.vst3` to `~/Library/Audio/Plug-Ins/VST3/Johnny/`. JUCE 8.0.10 comes from `~/Developer/Plugins/JUCE`; pass `-DJUCE_DIR=...` to use another copy. The `snapshot` target renders the editor to a PNG: `plugin/build/snapshot_artefacts/Release/snapshot knob.png 0.35`.

## Null test

```
cmake --build plugin/build --target vst3null -j8
plugin/tools/nulltest.sh
```

For each bass sample in `samples/`, at Drive 0, 0.15, 0.3, 0.6 and 1, and with Drive moved from 0.1 to 0.8 partway through, it renders the JS core to raw float32 (`tools/jsrender.js`). It runs the installed VST3 through a host (`tools/vst3null.cpp`) and prints the residual. Every case is bit-identical: the residual is −inf and 100% of samples match.

A host parameter is a 32-bit float, so the plugin sees Drive 0.3 as 0.30000001. `jsrender.js` rounds Drive the same way. The committed 16-bit renders in `renders/` use the exact double 0.3. Against those, the VST3 differs by 1 LSB on a few dozen samples per file, which comes from that rounding.

`tools/corerender.cpp` runs the C++ core alone, with no JUCE, for finding where a port diverges.

If the JS core changes, port the change to `MackieChannelCore.cpp` and run the null test again.
