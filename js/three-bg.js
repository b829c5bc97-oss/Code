(function () {
  var canvas = document.getElementById('bg-canvas');
  if (!canvas || typeof THREE === 'undefined') return;

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x06070a, 0.055);

  var camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0, 14);

  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  // Lights
  var ambient = new THREE.AmbientLight(0x8899ff, 0.6);
  scene.add(ambient);
  var point1 = new THREE.PointLight(0x7c5cff, 6, 30);
  point1.position.set(6, 4, 8);
  scene.add(point1);
  var point2 = new THREE.PointLight(0x26e0c9, 5, 30);
  point2.position.set(-6, -4, 6);
  scene.add(point2);

  // Floating wireframe shapes
  var shapes = [];
  var geometries = [
    new THREE.IcosahedronGeometry(1.6, 0),
    new THREE.OctahedronGeometry(1.3, 0),
    new THREE.TorusKnotGeometry(1, 0.32, 120, 16),
    new THREE.TetrahedronGeometry(1.4, 0),
    new THREE.IcosahedronGeometry(0.9, 1),
  ];

  var palette = [0x7c5cff, 0x26e0c9, 0x9d7bff, 0x1fd6c1];

  var shapeCount = window.innerWidth < 720 ? 6 : 10;
  for (var i = 0; i < shapeCount; i++) {
    var geo = geometries[i % geometries.length];
    var color = palette[i % palette.length];

    var mat = new THREE.MeshStandardMaterial({
      color: color,
      wireframe: true,
      transparent: true,
      opacity: 0.55,
      roughness: 0.4,
      metalness: 0.2,
    });

    var mesh = new THREE.Mesh(geo, mat);
    var radius = 9 + Math.random() * 6;
    var angle = (i / shapeCount) * Math.PI * 2;

    mesh.position.set(
      Math.cos(angle) * radius * (0.6 + Math.random() * 0.6),
      (Math.random() - 0.5) * 18,
      Math.sin(angle) * radius * 0.6 - 4
    );

    mesh.userData = {
      rotSpeedX: (Math.random() - 0.5) * 0.006,
      rotSpeedY: (Math.random() - 0.5) * 0.006,
      floatSpeed: 0.3 + Math.random() * 0.5,
      floatOffset: Math.random() * Math.PI * 2,
      baseY: mesh.position.y,
    };

    scene.add(mesh);
    shapes.push(mesh);
  }

  // Particle field
  var particleCount = window.innerWidth < 720 ? 250 : 550;
  var positions = new Float32Array(particleCount * 3);
  for (var p = 0; p < particleCount; p++) {
    positions[p * 3] = (Math.random() - 0.5) * 60;
    positions[p * 3 + 1] = (Math.random() - 0.5) * 60;
    positions[p * 3 + 2] = (Math.random() - 0.5) * 40 - 10;
  }
  var particleGeo = new THREE.BufferGeometry();
  particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  var particleMat = new THREE.PointsMaterial({
    color: 0x8fa0ff,
    size: 0.045,
    transparent: true,
    opacity: 0.5,
    sizeAttenuation: true,
  });
  var particles = new THREE.Points(particleGeo, particleMat);
  scene.add(particles);

  // Mouse parallax
  var mouseX = 0, mouseY = 0, targetX = 0, targetY = 0;
  window.addEventListener('mousemove', function (e) {
    mouseX = (e.clientX / window.innerWidth - 0.5) * 2;
    mouseY = (e.clientY / window.innerHeight - 0.5) * 2;
  }, { passive: true });

  // Scroll-driven camera movement
  var scrollProgress = 0;
  function updateScroll() {
    var h = document.documentElement.scrollHeight - window.innerHeight;
    scrollProgress = h > 0 ? window.scrollY / h : 0;
  }
  window.addEventListener('scroll', updateScroll, { passive: true });
  updateScroll();

  window.addEventListener('resize', function () {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  var clock = new THREE.Clock();

  function animate() {
    requestAnimationFrame(animate);
    var t = clock.getElapsedTime();

    targetX += (mouseX - targetX) * 0.04;
    targetY += (mouseY - targetY) * 0.04;

    camera.position.x = targetX * 1.2;
    camera.position.y = -targetY * 0.8 + scrollProgress * -6;
    camera.rotation.y = targetX * 0.05;
    camera.lookAt(0, scrollProgress * -6, 0);

    shapes.forEach(function (mesh) {
      var d = mesh.userData;
      mesh.rotation.x += d.rotSpeedX * (reduceMotion ? 0.2 : 1);
      mesh.rotation.y += d.rotSpeedY * (reduceMotion ? 0.2 : 1);
      mesh.position.y = d.baseY + Math.sin(t * d.floatSpeed + d.floatOffset) * 0.6;
    });

    particles.rotation.y = t * 0.01;

    renderer.render(scene, camera);
  }
  animate();
})();
