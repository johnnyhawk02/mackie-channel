/* ---- plugin link: Drive, Circuit and the picture come in from the plugin; a picture choice goes back ---- */
const backend = window.__JUCE__ && window.__JUCE__.backend;
const emit = (id, payload) => { try { if (backend) backend.emitEvent(id, payload); } catch (e) {} };
const tabs = $('tabs');
concepts.forEach((c, i) => {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = c.name;
  b.addEventListener('click', () => { setConcept(i); emit('view', { index: i }); });
  tabs.append(b);
});
function setConcept(i) {
  state.concept = Math.max(0, Math.min(concepts.length - 1, i | 0));
  [...tabs.children].forEach((b, j) => b.setAttribute('aria-selected', j === state.concept ? 'true' : 'false'));
}
function setState(s) {
  if (s.drive != null) state.drive = clamp01(+s.drive);
  if (s.circuit != null) state.model = Math.max(0, Math.min(3, s.circuit | 0));
  if (s.view != null && (s.view | 0) !== state.concept) setConcept(s.view);
}
window.colourbox = setState;
if (backend) backend.addEventListener('state', setState);
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect(); pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1; pointer.y = ((e.clientY - r.top) / r.height) * 2 - 1;
});
canvas.addEventListener('pointerleave', () => { pointer.x = pointer.y = 0; });
document.addEventListener('contextmenu', (e) => e.preventDefault());
setConcept(0);
requestAnimationFrame(frame);
emit('ready', {});
})();
</script>
</body></html>
