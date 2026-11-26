# Builds plugin/web/graphics.html from the Colourbox three.js studies page
# (claude.ai artifact 3cjroBaYj4aiRL2XchSJ1Z, saved as studies.html next to this script):
# its five pictures and the circuit model table, without its own Drive slider and Circuit row.
# The plugin pushes Drive, Circuit and the chosen picture in; the picture choice goes back out.
import pathlib, sys
here = pathlib.Path(__file__).parent
src = (here / 'studies.html').read_text().split('\n')
start = next(i for i, l in enumerate(src) if l.startswith('(() => {')) + 1
end = next(i for i, l in enumerate(src) if l.startswith('/* ---- controls ---- */'))
body = '\n'.join(src[start:end])

def sub(old, new):
    global body
    assert body.count(old) == 1, old
    body = body.replace(old, new)

sub("if (!window.THREE) return fail();\n", "")
# 30 frames a second at most, to keep the picture light on the CPU
sub("let last = performance.now(), time = 0, shown = -1, lastDrive = -1;\nfunction frame(now) {\n",
    "let last = performance.now(), time = 0, shown = -1, lastDrive = -1, lastDraw = -1e9;\nfunction frame(now) {\n"
    "  requestAnimationFrame(frame);\n  if (now - lastDraw < 31) return;\n  lastDraw = now;\n")
sub("  renderer.render(scene, camera);\n  requestAnimationFrame(frame);\n}", "  renderer.render(scene, camera);\n}")

head = (here / 'shell-head.html').read_text()
tail = (here / 'shell-tail.js').read_text()
out = head + body + '\n' + tail
(here.parent / 'graphics.html').write_text(out)
print('wrote', here.parent / 'graphics.html', len(out), 'bytes')
