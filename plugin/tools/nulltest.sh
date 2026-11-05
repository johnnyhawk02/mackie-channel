#!/bin/sh
# Null test: the installed VST3 against the JS model, on the four bass samples.
#   plugin/tools/nulltest.sh            (after building vst3null and VlzChannelDrive_VST3)
# For each sample and Drive setting it renders the JS core (raw float32, 4x
# oversampling) and the VST3 through a host, and prints the residual a - b.
set -e
here=$(cd "$(dirname "$0")" && pwd)
repo="$here/../.."
host="$here/../build/vst3null_artefacts/Release/vst3null"
tmp=${TMPDIR:-/tmp}/vlz-null; mkdir -p "$tmp"
for wav in "$repo"/samples/*.wav; do
  name=$(basename "$wav" .wav)
  for d in 0 0.15 0.3 0.6 1; do
    sr=$(node "$here/jsrender.js" "$wav" "$tmp/in.f32" "$tmp/js.f32" $d 4 512)
    "$host" "$tmp/in.f32" "$tmp/vst.f32" $sr $d 512 2>/dev/null
    printf '%-16s drive %-4s  ' "$name" "$d"; node "$here/compare.js" "$tmp/js.f32" "$tmp/vst.f32"
  done
  # Drive moved mid-sample (block-aligned), so the 30 ms glide is tested too
  sr=$(node "$here/jsrender.js" "$wav" "$tmp/in.f32" "$tmp/js.f32" 0.1 4 512 0.8 10240)
  "$host" "$tmp/in.f32" "$tmp/vst.f32" $sr 0.1 512 0.8 10240 2>/dev/null
  printf '%-16s 0.1->0.8   ' "$name"; node "$here/compare.js" "$tmp/js.f32" "$tmp/vst.f32"
done
