# Builds plugin/web/graphics.html from the Colourbox three.js studies page
# (claude.ai artifact 3cjroBaYj4aiRL2XchSJ1Z, saved as studies.html next to this script).
# Keeps the shared parts (renderer, fat lines, the circuit model table) and study E, Partials,
# with its rings moved out to make room for the Drive knob (the Dial study's knob) at their centre.
# The page's own slider, Circuit row and tabs are gone; shell-tail.js links it to the plugin.
import pathlib
here = pathlib.Path(__file__).parent
src = (here / 'studies.html').read_text().split('\n')
def line(prefix): return next(i for i, l in enumerate(src) if l.startswith(prefix))
common = '\n'.join(src[line('(() => {') + 1:line('/* ---- A. Clip')])
partials = '\n'.join(src[line('/* ---- E. Partials'):line('/* ---- stage ---- */')])

def sub(text, old, new):
    assert text.count(old) == 1, old
    return text.replace(old, new)

common = sub(common, "if (!window.THREE) return fail();\n", "")
# rings from just outside the knob's scale outwards
partials = sub(partials, "r = .34 + .135 * (h - 1)", "r = RING0 + RINGSTEP * (h - 1)")
partials = sub(partials, "view: { fov: 24, dir: [0, .56, 1], half: [2.35, 1.5], target: [0, -.1, 0] }",
                         "view: { fov: 24, dir: [0, .9, 1], half: [2.3, 1.85], target: [0, -.05, 0] }")

head = (here / 'shell-head.html').read_text()
tail = (here / 'shell-tail.js').read_text()
out = head + common + '\n' + partials + '\n' + tail
(here.parent / 'graphics.html').write_text(out)
print('wrote', here.parent / 'graphics.html', len(out), 'bytes')
