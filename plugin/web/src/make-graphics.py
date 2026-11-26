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
# face on, looking straight down: the ripples go in and out instead of up and down (none on the note
# itself, a plain circle), and each ring pulses in brightness and thickness at a rate set by its
# harmonic number, by as much as that harmonic is present
partials = sub(partials, "view: { fov: 24, dir: [0, .56, 1], half: [2.35, 1.5], target: [0, -.1, 0] }",
                         "view: { fov: 24, dir: [0, 1, 0], half: [1.2, 1.2], target: [0, 0, 0] }")
partials = sub(partials, "const HN = 14, M = 256, rings = [];", "const HN = 14, M = 256, rings = [], lv = new Float32Array(HN + 1), base = new Float32Array(HN + 1);")
partials = sub(partials, """    spin.rotation.y = reduce ? 0.5 : 0.5 + t * 0.1;
    if (!changed) return;""", """    spin.rotation.y = reduce ? 0.5 : 0.5 + t * 0.1;
    if (!changed) pulse(t);
    if (!changed) return;""")
partials = sub(partials, "l.p[j * 3] = r * Math.cos(th); l.p[j * 3 + 1] = disp * Math.sin(h * th + phi); l.p[j * 3 + 2] = r * Math.sin(th);",
                         "const rr = r + (h === 1 ? 0 : .19 * disp * Math.sin(h * th + phi)); l.p[j * 3] = rr * Math.cos(th); l.p[j * 3 + 1] = 0; l.p[j * 3 + 2] = rr * Math.sin(th);")
partials = sub(partials, "l.commit(); l.mat.uniforms.opacity.value = h === 1 ? .95 : .1 + .9 * Math.pow(lvl, 1.2);\n    }\n  }",
                         "l.commit(); base[h] = h === 1 ? .95 : .1 + .9 * Math.pow(lvl, 1.2); lv[h] = h === 1 ? 0 : lvl;\n    }\n    pulse(t);\n  }\n"
                         "  function pulse(t) {\n"
                         "    for (let h = 1; h <= HN; h++) {\n"
                         "      const u = rings[h - 1].mat.uniforms, w = reduce ? .5 : .5 + .5 * Math.sin(t * (.9 + .45 * h) + h * 1.7), k = lv[h] * lv[h];\n"
                         "      u.opacity.value = base[h] * (1 - .45 * k * (1 - w));\n"
                         "      u.width.value = (h === 1 ? 1.5 : 1) * (1 + .9 * k * w);\n"
                         "    }\n  }")

head = (here / 'shell-head.html').read_text()
tail = (here / 'shell-tail.js').read_text()
out = head + common + '\n' + partials + '\n' + tail
(here.parent / 'graphics.html').write_text(out)
print('wrote', here.parent / 'graphics.html', len(out), 'bytes')
