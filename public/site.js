// DeskCrew site: local price, gentle snow. No trackers, no third-party scripts.
(function () {
  // show the Indian price to visitors in India (by time zone; the checkout confirms the real price)
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
  const india = /^Asia\/(Kolkata|Calcutta)$/.test(tz);
  if (india) {
    document.querySelectorAll('[data-price]').forEach(el => { el.textContent = '₹1,499'; });
    document.querySelectorAll('[data-price-note]').forEach(el => { el.textContent = '$14.99 outside India.'; });
  }
  document.querySelectorAll('[data-buy]').forEach(a => { a.addEventListener('click', () => { try { sessionStorage.setItem('dc_region', india ? 'in' : 'intl'); } catch (e) {} }); });

  // snow
  const cv = document.getElementById('snow');
  if (!cv || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const g = cv.getContext('2d'); let W, H, dpr; const flakes = [];
  function size() { dpr = Math.min(2, devicePixelRatio || 1); W = innerWidth; H = innerHeight; cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px'; g.setTransform(dpr, 0, 0, dpr, 0, 0); }
  size(); addEventListener('resize', size);
  const N = Math.round(Math.min(90, innerWidth / 16));
  for (let i = 0; i < N; i++) flakes.push({ x: Math.random(), y: Math.random(), r: 0.8 + Math.random() * 2.2, s: 0.2 + Math.random() * 0.5, p: Math.random() * 6 });
  let last = 0;
  (function tick(t) {
    const dt = Math.min(0.05, (t - last) / 1000 || 0); last = t;
    g.clearRect(0, 0, W, H); g.fillStyle = 'rgba(255,255,255,0.55)';
    for (const f of flakes) {
      f.y += f.s * dt * 0.08; if (f.y > 1.02) { f.y = -0.02; f.x = Math.random(); }
      const x = (f.x + Math.sin(t / 2600 + f.p) * 0.008) * W, y = f.y * H;
      g.beginPath(); g.arc(x, y, f.r, 0, 6.283); g.fill();
    }
    requestAnimationFrame(tick);
  })(0);
})();
