#!/bin/sh
# Null test: the installed VST3 against the JS model, on the four bass samples.
#   plugin/tools/nulltest.sh            (after building vst3null and Colourbox_VST3)
# For each sample, Quality preset and Drive setting it renders the JS core (raw
# float32) and the VST3 through a host, and prints the residual a - b.
set -e
here=$(cd "$(dirname "$0")" && pwd)
repo="$here/../.."
host="$here/../build/vst3null_artefacts/Release/vst3null"
tmp=${TMPDIR:-/tmp}/vlz-null; mkdir -p "$tmp"
for wav in "$repo"/samples/*.wav; do
  name=$(basename "$wav" .wav)
  for q in high normal eco lite; do
    for d in 0 0.15 0.3 0.6 1; do
      sr=$(node "$here/jsrender.js" "$wav" "$tmp/in.f32" "$tmp/js.f32" $d $q 512)
      QUALITY=$q "$host" "$tmp/in.f32" "$tmp/vst.f32" $sr $d 512 2>/dev/null
      printf '%-16s %-6s drive %-4s  ' "$name" "$q" "$d"; node "$here/compare.js" "$tmp/js.f32" "$tmp/vst.f32"
    done
    # Drive moved mid-sample (block-aligned), so the 30 ms glide is tested too
    sr=$(node "$here/jsrender.js" "$wav" "$tmp/in.f32" "$tmp/js.f32" 0.1 $q 512 0.8 10240)
    QUALITY=$q "$host" "$tmp/in.f32" "$tmp/vst.f32" $sr 0.1 512 0.8 10240 2>/dev/null
    printf '%-16s %-6s 0.1->0.8   ' "$name" "$q"; node "$here/compare.js" "$tmp/js.f32" "$tmp/vst.f32"
  done
done
# the colour circuits: 4x in High, 2x in Normal, the formula version in Lite (Drive values a float holds exactly)
for wav in "$repo"/samples/*.wav; do
  name=$(basename "$wav" .wav)
  for c in ts808 fuzz tweed; do
    for q in high normal lite; do
      os=4; [ $q = normal ] && os=2; [ $q = lite ] && os=lite
      for d in 0 0.25 0.5 0.75 1; do
        sr=$(CIRCUIT=$c node "$here/jsrender.js" "$wav" "$tmp/in.f32" "$tmp/js.f32" $d $os 512)
        CIRCUIT=$c QUALITY=$q "$host" "$tmp/in.f32" "$tmp/vst.f32" $sr $d 512 2>/dev/null
        printf '%-16s %-6s %-6s drive %-4s  ' "$name" $c $q "$d"; node "$here/compare.js" "$tmp/js.f32" "$tmp/vst.f32"
      done
    done
  done
done
