# CR1604-VLZ channel drive model

A component-level JavaScript model of one input channel of a Mackie CR1604-VLZ,
built from the service manual schematics (pod board 219 rev B and main board
220 rev A, channel 1), with a single Drive control (the channel TRIM pot).

**Try it:** https://johnnyhawk02.github.io/mackie-channel/

## Files

- `mackie-channel-core.js`: the DSP. Pure JS, no Web Audio or DOM. Works as a
  browser global (`MackieChannelCore`), a CommonJS module in Node, and inside an
  AudioWorklet (the page builds the worklet from this same file). This is the
  file to port to C++ for a plugin.
- `index.html`: test page. Drive knob, line/mic jack, lo cut, output trim,
  input calibration, per-op-amp headroom meters and a scope.
- `samples/`: the four bass samples, loadable from the page.
- `renders/`: the samples processed offline at drive 0.3 and 0.6, output -6 dB.
- `tools/render.js`: offline render, `node tools/render.js in.wav out.wav <drive 0..1> [outputDb]`.
- `tools/test.js`: gain law and sine THD check.

## Using the core

```js
const { MackieChannel } = require('./mackie-channel-core.js'); // or window.MackieChannelCore
const ch = new MackieChannel(48000, { drive: 0.4 });  // one instance per audio channel
ch.setParams({ drive: 0.6, input: 'line', loCut: false, outputDb: -6 });
ch.process(inputFloat32, outputFloat32);             // digital full scale in and out
ch.readPeaks();  // peak volts at each op-amp since the last call
ch.info();       // trim ohms, preamp gain, C1 corner, latency
```

Parameters: `drive` (0..1 trim rotation), `input` ('line' | 'mic'),
`fullScaleVolts` (peak volts at the jack for 0 dBFS, default 8.68 V = +18 dBu),
`loCut`, `eqLow`/`eqMid`/`eqMidFreq`/`eqHigh` (dB, Hz), `faderDb` (0 = U, max +10),
`outputDb`.

## Circuit summary

| Stage | Parts | Model |
|---|---|---|
| Line jack J68 | R220/R212 5K62, R197/R168 1K50 | −13.5 dB pad, unbalanced (half the signal is common mode) |
| Preamp | Q24/Q8 2SA1084, U17A/U25A NJM2068, R268/R323 5K11, trim R162 10K + R1 3R32 + C1 1000 µF | Gd = 1 + 2·5K11 / (Rtrim + 3.32 + 1/sC1), each op-amp output clipped |
| Diff amp | U33A NJM2068, R482/R492 | ×0.511, clipped |
| Coupling | C94/R167, C121/R137 | 0.34 Hz and 0.17 Hz high passes |
| Lo cut | U104A NJM4560 | 75 Hz 3rd-order Butterworth, clipped |
| EQ | U101A/B, U105A NJM4560 | behavioural shelves/peak, flat by default, clipped |
| Fader | R107 10K, U103A NJM4560, R101 1K1 / R102 510 | U = −10 dB at wiper, +10 dB make-up, clipped |

Gain range on the line input is −13.2 dB to +50.4 dB, mic 0 to +64 dB, in line
with Mackie's published spec. At full drive the C1 corner rises to 48 Hz, so
the lowest octave of a bass is pushed less hard than the rest.

## Known approximations

- Op-amp rails (about ±14.4 V on ±16 V supplies) and their +/− mismatch are
  estimated from datasheet typicals, not measured.
- When U17A/U25A clip, the real feedback loop opens and the input pair can
  misbehave briefly; the model clips each output cleanly instead.
- The trim taper is set to be dB-linear across rotation. The real "10KZY" pot
  curve is not in the manual.
- EQ is fitted to the published curves rather than solved from U101/U105.
- Slew rate and op-amp bandwidth are ignored (they matter above the audio band
  at these levels).
