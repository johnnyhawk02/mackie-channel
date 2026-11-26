/* ---- the Drive knob at the centre of the rings: the Dial study's knob, scaled down ---- */
const RING0 = 1.02, RINGSTEP = .088, KS = .6;
function makeKnob() {
  const group = new THREE.Group(), rot = new THREE.Group(); group.scale.setScalar(KS);
  const ringMat = new THREE.ShaderMaterial({
    uniforms: { colA: { value: new THREE.Color(TRACK) }, colB: { value: new THREE.Color(ACC) }, cut: { value: 0 }, aa: { value: .01 } },
    vertexShader: `varying vec2 vP; void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
    fragmentShader: `uniform vec3 colA; uniform vec3 colB; uniform float cut; uniform float aa; varying vec2 vP;
      void main() { float a = atan(vP.x, vP.y), lim = 2.35619;
        float inArc = 1. - smoothstep(lim, lim + aa, abs(a)); if (inArc < .01) discard;
        gl_FragColor = vec4(mix(colA, colB, 1. - smoothstep(cut - aa, cut, a)), inArc);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.12, 160, 1), ringMat); ring.rotation.x = -Math.PI / 2; ring.position.y = .004; ring.renderOrder = 2;
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(.79, .83, .36, 96), new THREE.MeshStandardMaterial({ color: CAP, roughness: .45, metalness: .05 })); cap.position.y = .18;
  const inset = new THREE.Mesh(new THREE.CylinderGeometry(.59, .59, .01, 96), new THREE.MeshStandardMaterial({ color: CAPHI, roughness: .75 })); inset.position.y = .362;
  const ptr = new THREE.Mesh(new THREE.CapsuleGeometry(.034, .38, 6, 16), new THREE.MeshBasicMaterial({ color: PTR }));
  ptr.rotation.x = Math.PI / 2; ptr.scale.set(1, 1, .3); ptr.position.set(0, .37, -.5);
  rot.add(cap, inset, ptr);
  const TN = 41, ticks = new FatSegs(TN, { a: '#667076', b: PTR, width: 1.25, depthTest: true, order: 3 });
  for (let i = 0; i < TN; i++) {
    const a = (-135 + 270 * i / (TN - 1)) * Math.PI / 180, r0 = 1.26, r1 = i % 5 === 0 ? 1.43 : 1.34;
    ticks.p.set([r0 * Math.sin(a), .004, -r0 * Math.cos(a), r1 * Math.sin(a), .004, -r1 * Math.cos(a)], i * 6);
  }
  ticks.commit();
  group.add(ring, ticks.mesh, rot);
  function update(changed) {
    const a = (-135 + 270 * driveNow) * Math.PI / 180;
    rot.rotation.y = -a; ringMat.uniforms.cut.value = a;
    ringMat.uniforms.aa.value = 2.4 * camDist * Math.tan(camera.fov * Math.PI / 360) / (stageH * DPR * KS);
    if (changed) for (let i = 0; i < TN; i++) ticks.each(ticks.aTint, i, smooth(-.012, .012, driveNow - i / (TN - 1) + .004));
  }
  return { group, update };
}

/* ---- stage ---- */
const pointer = { x: 0, y: 0 };
const partials = makePartials(), knob = makeKnob();
scene.add(partials.group, knob.group);

function fit() {
  const v = partials.view, w = stage.clientWidth || 1, h = stage.clientHeight || 1, tan = Math.tan(v.fov * Math.PI / 360);
  camera.fov = v.fov; camera.aspect = w / h;
  camDist = Math.max(v.half[1] / tan, v.half[0] / (tan * camera.aspect));
  const d = new THREE.Vector3(...v.dir).normalize().multiplyScalar(camDist), tg = new THREE.Vector3(...v.target);
  camera.position.copy(tg).add(d); camera.lookAt(tg); camera.updateProjectionMatrix();
}
function resize() {
  const w = stage.clientWidth || 1, h = stage.clientHeight || 1;
  renderer.setSize(w, h, false); RES.value.set(w / 2, h / 2); stageH = h; fit();
}
new ResizeObserver(resize).observe(stage); resize();

// 30 frames a second at most, to keep it light on the CPU
let last = performance.now(), time = 0, lastDrive = -1, lastDraw = -1e9, first = true;
function frame(now) {
  requestAnimationFrame(frame);
  if (now - lastDraw < 31) return;
  lastDraw = now;
  const dt = Math.min(.05, (now - last) / 1000); last = now; time += dt;
  easeField(dt);
  const dd = state.drive - driveNow; driveNow = Math.abs(dd) < 2e-4 ? state.drive : driveNow + dd * (1 - Math.exp(-dt * 16));
  const changed = first || fieldMoving || driveNow !== lastDrive;
  if (changed) for (let k = 0; k < N; k++) cyc[k] = sample(driveNow, k / N);
  partials.update(dt, time, changed, first);
  knob.update(changed);
  first = false; lastDrive = driveNow;
  renderer.render(scene, camera);
}

/* ---- plugin link: Drive and Circuit come in; dragging the picture turns Drive (260 px for the whole travel, double-click for 0) ---- */
const backend = window.__JUCE__ && window.__JUCE__.backend;
const emit = (id, payload) => { try { if (backend) backend.emitEvent(id, payload); } catch (e) {} };
let drag = null;
function setState(s) {
  if (s.drive != null && !drag) state.drive = clamp01(+s.drive);
  if (s.circuit != null) state.model = Math.max(0, Math.min(3, s.circuit | 0));
}
window.colourbox = setState;
if (backend) backend.addEventListener('state', setState);
const turn = (v) => { state.drive = clamp01(v); emit('drive', { value: state.drive }); };
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  drag = { y: e.clientY, d: state.drive }; emit('gesture', { active: true });
  try { canvas.setPointerCapture(e.pointerId); } catch (x) {}
});
canvas.addEventListener('pointermove', (e) => { if (drag) turn(drag.d + (drag.y - e.clientY) / (e.shiftKey ? 1300 : 260)); });
const endDrag = () => { if (drag) { drag = null; emit('gesture', { active: false }); } };
canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('dblclick', () => { emit('gesture', { active: true }); turn(0); emit('gesture', { active: false }); });
document.addEventListener('contextmenu', (e) => e.preventDefault());
requestAnimationFrame(frame);
emit('ready', {});
})();
</script>
</body></html>
