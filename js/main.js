(function () {
  document.getElementById('year').textContent = new Date().getFullYear();

  /* Reveal on scroll */
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        var el = entry.target;
        var group = Array.prototype.slice.call(el.parentElement.querySelectorAll(':scope > .reveal'));
        var idx = group.indexOf(el);
        el.style.transitionDelay = (Math.max(idx, 0) * 80) + 'ms';
        el.classList.add('in');
        io.unobserve(el);
      }
    });
  }, { threshold: 0.14, rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('.reveal').forEach(function (el) { io.observe(el); });

  /* Mobile menu */
  var btn = document.getElementById('menu-btn');
  var menu = document.getElementById('mobile-menu');
  btn.addEventListener('click', function () {
    var open = menu.classList.toggle('open');
    btn.classList.toggle('open', open);
  });
  menu.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', function () { menu.classList.remove('open'); btn.classList.remove('open'); });
  });

  /* Active nav link */
  var links = document.querySelectorAll('.nav-links a');
  var map = {};
  links.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a; });
  var navIo = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      var link = map[e.target.id];
      if (!link) return;
      if (e.isIntersecting) {
        links.forEach(function (l) { l.style.color = ''; });
        link.style.color = 'var(--text)';
      }
    });
  }, { threshold: 0.5 });
  ['about', 'services', 'work', 'skills', 'pricing'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) navIo.observe(el);
  });
})();
