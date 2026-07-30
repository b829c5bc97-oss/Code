(function () {
  document.getElementById('year').textContent = new Date().getFullYear();

  // Loader
  window.addEventListener('load', function () {
    var loader = document.getElementById('loader');
    setTimeout(function () { loader.classList.add('hidden'); }, 400);
  });

  // Nav toggle (mobile)
  var toggle = document.getElementById('nav-toggle');
  var links = document.getElementById('nav-links');
  toggle.addEventListener('click', function () {
    links.classList.toggle('open');
  });
  links.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', function () { links.classList.remove('open'); });
  });

  // Cursor glow
  var glow = document.getElementById('cursor-glow');
  window.addEventListener('mousemove', function (e) {
    glow.style.transform = 'translate(' + (e.clientX - 210) + 'px,' + (e.clientY - 210) + 'px)';
  }, { passive: true });

  // Scroll reveal
  var revealEls = document.querySelectorAll('.reveal');
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry, idx) {
      if (entry.isIntersecting) {
        var el = entry.target;
        var siblings = Array.from(el.parentElement.children).filter(function (c) {
          return c.classList.contains('reveal');
        });
        var delay = siblings.indexOf(el) * 90;
        setTimeout(function () { el.classList.add('in-view'); }, delay);
        observer.unobserve(el);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -60px 0px' });
  revealEls.forEach(function (el) { observer.observe(el); });

  // 3D tilt on project cards
  var tiltCards = document.querySelectorAll('.tilt-card');
  tiltCards.forEach(function (card) {
    var bounds;
    card.addEventListener('mouseenter', function () { bounds = card.getBoundingClientRect(); });
    card.addEventListener('mousemove', function (e) {
      if (!bounds) bounds = card.getBoundingClientRect();
      var x = (e.clientX - bounds.left) / bounds.width - 0.5;
      var y = (e.clientY - bounds.top) / bounds.height - 0.5;
      card.style.transform = 'perspective(1200px) rotateX(' + (-y * 12) + 'deg) rotateY(' + (x * 12) + 'deg) scale3d(1.02,1.02,1.02)';
    });
    card.addEventListener('mouseleave', function () {
      card.style.transform = 'perspective(1200px) rotateX(0deg) rotateY(0deg) scale3d(1,1,1)';
    });
  });

  // Active nav link highlight
  var sections = document.querySelectorAll('main .section[id]');
  var navAnchors = document.querySelectorAll('#nav-links a');
  var navObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      var id = entry.target.getAttribute('id');
      var link = document.querySelector('#nav-links a[href="#' + id + '"]');
      if (!link) return;
      if (entry.isIntersecting) {
        navAnchors.forEach(function (a) { a.classList.remove('active'); });
        link.classList.add('active');
      }
    });
  }, { threshold: 0.5 });
  sections.forEach(function (s) { navObserver.observe(s); });
})();
