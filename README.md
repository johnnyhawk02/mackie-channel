# Mackie CR1604-VLZ channel, component-level model

A circuit simulation of one input channel of a Mackie CR1604-VLZ, used as an overdrive. The interface is one **Drive** knob, which is the channel's TRIM pot. Everything was read from the CR1604-VLZ service manual: pod board 219 (mic/line preamp) and main board 220 (EQ, fader).

**Try it:** https://johnnyhawk02.github.io/mackie-channel/

## How it works

Each stage is a netlist of the real parts, solved every sample as a nonlinear circuit:

- **Solver:** nodal analysis reduced to the K-method (DK) form, with trapezoidal companion models and backward Euler for the stiff parts. Newton iteration uses junction limiting (SPICE `pnjlim`) and a monotonicity-damped step. If Newton does not converge it falls back to sub-stepping.
- **Transistors:** Ebers-Moll transport model with Early effect.
- **Diodes:** Shockley.
- **Op-amps:** a macromodel. It has an input transconductance into a compensation integrator, set by GBW and A0, a smooth output-swing limit at the datasheet headroom, and the output resistance.
- **Operating point:** found by ramping the ±16 V supplies up from zero, like powering on the desk.

- **Auto level:** the output follows the Drive knob so loudness stays about the same as it is turned up. The curve was measured with `node tools/autolevel.js`: it is the K-weighted (BS.1770) loudness of the four bundled bass samples through the channel at each Drive step, in 0.05 steps, for the line input with 0 dBFS = +18 dBu. At Drive 0 the channel is unity at 1 kHz and clean. The real circuit still shows there: the EQ at its centre detents and the coupling caps are 0.4 dB down at 20 Hz with 10° of phase shift. Turn it off with `autoLevel: false`. The curve only holds for the line input and that calibration.
- **Drive slew:** the Drive knob glides rather than steps. Its rotation goes through two one-pole smoothers in series (fixed at 30 ms; `driveSlewMs` in the core, 0 turns it off), so the gain moves evenly in dB and starts and stops gently. The TRIM pot is a variable resistor in the netlist: it is stamped into the matrices at its last value, and a linear port carries the difference, so the circuit sees the exact resistance every sample without rebuilding the matrices each time. Moving the knob costs about nothing. `node tools/slew.js` measures the click from a jump: with no slew it is about 4 dB under the signal peak, with 30 ms it is 75–85 dB under.

Nothing is a waveshaper. Clipping, sticking on the rails, the asymmetry and the recovery all come from the circuit.

The DSP core (`mackie-channel-core.js`) has no UI or Web Audio code in it, so it can be ported to a plugin later.

| Stage | Parts modelled |
|---|---|
| Line jack J68 | C142/C126 47µ, R220/R212 5K62, R197/R168 1K50, phantom feed R523/R524 6K81 via C349/C350 |
| Preamp | Q24/Q8 2SA1084 input pair; Q64/Q80 MMBT4403 current sources (R427/R428, R324/R284, C383/C384); bias string R483, D80 1N4148, R484; reference Q63, R426, R267; collector loads R371/R372; servo amps U17A/U25A NJM2068 with R268/R323 5K11; gain leg C1 1000µ + TRIM + R1 3.32 Ω |
| Diff amp | U33A NJM2068, R492/R425 10K, R370/R482 5K11 |
| Main board coupling | C94/R167, C121/R137 |
| Lo cut | C104–C106, R103–R105, U104A, C107/R106 |
| EQ | Mid: U101A/B, R120 MID pot, R121 FREQ pot, C114, C115, R122–R123, R133–R136. Hi/Low Baxandall: U105A, R117–R119, R124–R127, C108–C111 |
| Fader | C120, R107 fader, C113/R131, U103A with R101/R102 |

### Checked against the manual and spec

- **DC bias:** emitters at 0.60 V, collectors at the reference (−12.70 V, Ic ≈ 1.33 mA).
- **Clean gain:** within 0.33 dB of theory at every drive setting, line and mic.
- **EQ:** matches the published spec. Hi ±15 dB at 12 kHz, Low ±15 dB at 80 Hz, Mid ±15 dB sweeping 100 Hz–8 kHz, and Lo cut 18 dB/oct at 75 Hz.
- **Low-level distortion:** falls with signal level, as a real circuit's does (h2 about 3e-9 at 10 mV).

## What is not from the parts list

These values can't be read from the schematic. Each was given a standard value:

| Item | Value used | Why |
|---|---|---|
| 0 dBFS calibration | +18 dBu at the jack (EBU R68) | The model works in volts, so a digital level has to map to a voltage. |
| TRIM taper | dB-linear across the rotation | The manual lists "10KZY" but gives no curve. Mackie's trim is marked in dB. |
| FREQ pot R121 taper | 500K reverse-log "C", 10% at mid | Standard C taper. |
| 2SA1084 Is, Br, Vaf | 1e-13 A, 4, 100 V | There is no published SPICE model. **Sensitivity:** Is ×10 or ÷10, Vaf 50 V and Br 1 each move gain and harmonics by under 0.1 dB, both clean and clipping, because the servo loops set the operating point. |
| Op-amp Rout | 50 Ω | A typical value. It sits inside feedback loops. |
| Phantom power | Off; the phantom bus is treated as ground | It is the normal state for a line input. |

Device data:

- NJM2068: GBW 27 MHz and SR 6 V/µs (Nisshinbo). A0 110 dB and 1.5 V swing headroom are datasheet typicals.
- NJM4560: GBW 10 MHz, A0 100 dB, 1.0 V headroom (datasheet typicals).
- MMBT4403 and 1N4148: standard published SPICE models.

## Left out

These parts only matter above about 90 kHz:

- C110/C79/C367 470p
- C315/C316 1n
- the small compensation caps C158/C182, C214/C237, C123, C112, C103

L1 (4.7 µH) is also left out: −0.13 dB at 20 kHz at full gain.

The op-amp slew rate is not modelled. At these levels it never limits within one sample.

The meter taps and everything after U103A are not modelled.

## Running

- **Browser:** open `index.html` (any static server). Live playback runs the circuit at the audio device's sample rate, mono, in an AudioWorklet. The load is typically 0.2–0.5× real time on one core, and about 1× at full drive with heavy clipping.
- **Offline, higher quality:**

  ```
  node tools/render.js in.wav out.wav <drive 0..1> [outputDb=0] [oversample=4]
  ```

  `renders/` holds the four test samples at drive 0.15, 0.3 and 0.6, rendered at 4× oversampling.

- **Core API:** `new MackieChannel(sampleRate, { drive, input: 'line'|'mic', loCut, eqHigh, eqMid, eqLow, eqFreq, faderDb, outputDb, fullScaleVolts, autoLevel, driveSlewMs, oversample })`, then `process(input, output)`, `setParams({...})`, `readPeaks()` and `info()`.

## Validating against a real desk

To validate against a real desk:

1. Play a 1 kHz sine at a known dBu into the line input, with the trim at several marked positions.
2. Record the main or direct out.
3. Compare the gain and the h2/h3 levels with `tools/test.js`.

If the trim marks disagree, the trim taper is the first thing to adjust (`trimResistance` in the core).
