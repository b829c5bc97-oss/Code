/* Hero-only 3D core. Renders into #hero-gl (contained to the hero section),
   transparent background, positioned to the right so it never overlaps text. */
(function () {
  var canvas = document.getElementById('hero-gl');
  var hero = document.querySelector('.hero');
  if (!canvas || !hero || typeof THREE === 'undefined') return;

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function size() { return { w: hero.clientWidth, h: hero.clientHeight }; }
  var s = size();
  var isNarrow = window.innerWidth < 760;

  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(s.w, s.h);

  var scene = new THREE.Scene();
  var cam = new THREE.PerspectiveCamera(45, s.w / s.h, 0.1, 100);
  cam.position.z = 6.2;

  var snoise = [
    'vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}',
    'vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}',
    'vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}',
    'vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}',
    'float snoise(vec3 v){',
    '  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);',
    '  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);',
    '  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);',
    '  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;',
    '  i=mod289(i);',
    '  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));',
    '  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;',
    '  vec4 j=p-49.0*floor(p*ns.z*ns.z);',
    '  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);',
    '  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);',
    '  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);',
    '  vec4 sg0=floor(b0)*2.0+1.0; vec4 sg1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));',
    '  vec4 a0=b0.xzyw+sg0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+sg1.xzyw*sh.zzww;',
    '  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);',
    '  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));',
    '  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;',
    '  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;',
    '  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));',
    '}'
  ].join('\n');

  var uniforms = { uTime: { value: 0 }, uAmp: { value: 0.26 } };

  var mat = new THREE.ShaderMaterial({
    uniforms: uniforms,
    transparent: true,
    vertexShader: [
      snoise,
      'uniform float uTime; uniform float uAmp;',
      'varying float vN; varying vec3 vNormalW; varying vec3 vViewDir;',
      'void main(){',
      '  float n = snoise(normal * 1.3 + uTime * 0.22);',
      '  float n2 = snoise(position * 2.3 - uTime * 0.14);',
      '  float disp = (n * 0.7 + n2 * 0.3) * uAmp;',
      '  vN = disp;',
      '  vec3 pos = position + normal * disp;',
      '  vec4 mv = modelViewMatrix * vec4(pos,1.0);',
      '  vNormalW = normalize(normalMatrix * normal);',
      '  vViewDir = normalize(-mv.xyz);',
      '  gl_Position = projectionMatrix * mv;',
      '}'
    ].join('\n'),
    fragmentShader: [
      'precision highp float;',
      'varying float vN; varying vec3 vNormalW; varying vec3 vViewDir;',
      'void main(){',
      '  float fres = pow(1.0 - max(dot(vNormalW, vViewDir), 0.0), 2.3);',
      '  vec3 indigo = vec3(0.486,0.525,1.0);',
      '  vec3 cyan   = vec3(0.204,0.839,0.918);',
      '  vec3 rim = mix(indigo, cyan, clamp(vN*2.0+0.5,0.0,1.0));',
      '  vec3 col = rim * fres * 1.7;',
      '  col += cyan * smoothstep(0.16,0.36,vN) * 0.35;',
      '  float alpha = clamp(fres*1.35 + smoothstep(0.2,0.4,vN)*0.45, 0.0, 1.0);',
      '  gl_FragColor = vec4(col, alpha);',
      '}'
    ].join('\n')
  });

  var geo = new THREE.IcosahedronGeometry(1.8, isNarrow ? 14 : 26);
  var core = new THREE.Mesh(geo, mat);
  scene.add(core);

  var wire = new THREE.Mesh(geo, mat.clone());
  wire.material.uniforms = uniforms;
  wire.material.wireframe = true;
  wire.material.blending = THREE.AdditiveBlending;
  wire.material.depthWrite = false;
  wire.scale.setScalar(1.05);
  scene.add(wire);

  function place() {
    isNarrow = window.innerWidth < 760;
    // desktop: push core to the right; mobile: center it, smaller, upper area
    var x = isNarrow ? 0 : 2.15;
    var y = isNarrow ? 0.4 : 0;
    var sc = isNarrow ? 0.72 : 1;
    core.position.set(x, y, 0); wire.position.set(x, y, 0);
    core.scale.setScalar(sc); wire.scale.setScalar(sc * 1.05);
  }
  place();

  var tmx = 0, tmy = 0, mx = 0, my = 0;
  hero.addEventListener('mousemove', function (e) {
    var r = hero.getBoundingClientRect();
    tmx = ((e.clientX - r.left) / r.width - 0.5) * 2;
    tmy = ((e.clientY - r.top) / r.height - 0.5) * 2;
  }, { passive: true });

  window.addEventListener('resize', function () {
    var d = size();
    renderer.setSize(d.w, d.h);
    cam.aspect = d.w / d.h; cam.updateProjectionMatrix();
    place();
  });

  var clock = new THREE.Clock();
  var running = true;
  // pause when hero scrolled out of view (perf)
  var io = new IntersectionObserver(function (e) { running = e[0].isIntersecting; if (running) clock.getDelta(); }, { threshold: 0 });
  io.observe(hero);

  function loop() {
    requestAnimationFrame(loop);
    if (!running) return;
    var dt = clock.getDelta();
    uniforms.uTime.value += reduce ? dt * 0.3 : dt;
    mx += (tmx - mx) * 0.05; my += (tmy - my) * 0.05;
    var cd = Math.hypot(mx, my);
    uniforms.uAmp.value += ((0.22 + (1 - Math.min(cd, 1)) * 0.16) - uniforms.uAmp.value) * 0.05;
    core.rotation.y += 0.0018 + mx * 0.001;
    core.rotation.x = my * 0.35;
    wire.rotation.copy(core.rotation);
    renderer.render(scene, cam);
  }
  loop();
})();
