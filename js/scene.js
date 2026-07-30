/* WebGL scene: shader aurora background + distorted glowing core */
(function () {
  var canvas = document.getElementById('gl');
  if (!canvas || typeof THREE === 'undefined') { window.__sceneReady = true; return; }

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var W = window.innerWidth, H = window.innerHeight;
  var isMobile = W < 760;

  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(W, H);
  renderer.autoClear = false;

  /* ---------- shared uniforms ---------- */
  var uTime = { value: 0 };
  var uProg = { value: 0 };
  var uMouse = { value: new THREE.Vector2(0.5, 0.5) };
  var uRes = { value: new THREE.Vector2(W, H) };

  /* ================= BACKGROUND (ortho quad) ================= */
  var bgScene = new THREE.Scene();
  var bgCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  var bgMat = new THREE.ShaderMaterial({
    uniforms: { uTime: uTime, uProg: uProg, uMouse: uMouse, uRes: uRes },
    vertexShader: [
      'varying vec2 vUv;',
      'void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }'
    ].join('\n'),
    fragmentShader: [
      'precision highp float;',
      'varying vec2 vUv;',
      'uniform float uTime; uniform float uProg; uniform vec2 uMouse; uniform vec2 uRes;',
      'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }',
      'float noise(vec2 p){',
      '  vec2 i=floor(p), f=fract(p);',
      '  float a=hash(i), b=hash(i+vec2(1.,0.)), c=hash(i+vec2(0.,1.)), d=hash(i+vec2(1.,1.));',
      '  vec2 u=f*f*(3.-2.*f);',
      '  return mix(a,b,u.x)+(c-a)*u.y*(1.-u.x)+(d-b)*u.x*u.y;',
      '}',
      'float fbm(vec2 p){',
      '  float v=0.0, amp=0.5;',
      '  for(int i=0;i<5;i++){ v+=amp*noise(p); p*=2.02; amp*=0.5; }',
      '  return v;',
      '}',
      'void main(){',
      '  vec2 uv = vUv;',
      '  vec2 p = uv * vec2(uRes.x/uRes.y, 1.0) * 2.2;',
      '  float t = uTime * 0.05;',
      '  vec2 q = vec2(fbm(p + t), fbm(p + vec2(3.2,1.7) - t));',
      '  float f = fbm(p + q*1.6 + vec2(uMouse.x, uMouse.y)*0.6);',
      '  vec3 base = vec3(0.027,0.027,0.031);',
      '  vec3 lime = vec3(0.847,1.0,0.278);',
      '  vec3 cyan = vec3(0.435,0.878,1.0);',
      '  vec3 mag  = vec3(1.0,0.36,0.68);',
      '  vec3 col = base;',
      '  float glow = smoothstep(0.35,0.95,f);',
      '  vec3 tint = mix(lime, cyan, uProg);',
      '  tint = mix(tint, mag, smoothstep(0.6,1.0,uProg));',
      '  col += tint * glow * 0.14;',
      '  col += lime * pow(f,3.0) * 0.05;',
      '  float vig = smoothstep(1.15,0.25,length(uv-0.5));',
      '  col *= vig;',
      '  gl_FragColor = vec4(col, 1.0);',
      '}'
    ].join('\n'),
    depthTest: false, depthWrite: false
  });
  bgScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat));

  /* ================= CORE (perspective) ================= */
  var mainScene = new THREE.Scene();
  var cam = new THREE.PerspectiveCamera(45, W / H, 0.1, 100);
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
    '  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));',
    '  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;',
    '  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);',
    '  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));',
    '  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;',
    '  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;',
    '  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));',
    '}'
  ].join('\n');

  var coreUniforms = { uTime: uTime, uAmp: { value: 0.28 }, uProg: uProg };

  var coreMat = new THREE.ShaderMaterial({
    uniforms: coreUniforms,
    transparent: true,
    vertexShader: [
      snoise,
      'uniform float uTime; uniform float uAmp;',
      'varying float vN; varying vec3 vNormalW; varying vec3 vViewDir;',
      'void main(){',
      '  float n = snoise(normal * 1.3 + uTime * 0.25);',
      '  float n2 = snoise(position * 2.4 - uTime * 0.15);',
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
      'uniform float uProg;',
      'varying float vN; varying vec3 vNormalW; varying vec3 vViewDir;',
      'void main(){',
      '  float fres = pow(1.0 - max(dot(vNormalW, vViewDir), 0.0), 2.4);',
      '  vec3 lime = vec3(0.847,1.0,0.278);',
      '  vec3 cyan = vec3(0.435,0.878,1.0);',
      '  vec3 mag  = vec3(1.0,0.36,0.68);',
      '  vec3 rim = mix(lime, cyan, clamp(vN*2.0+0.5,0.0,1.0));',
      '  rim = mix(rim, mag, uProg*0.6);',
      '  vec3 col = rim * fres * 1.6;',
      '  col += lime * smoothstep(0.15,0.35,vN) * 0.4;',
      '  float alpha = clamp(fres*1.4 + smoothstep(0.2,0.4,vN)*0.5, 0.0, 1.0);',
      '  gl_FragColor = vec4(col, alpha);',
      '}'
    ].join('\n')
  });

  var geo = new THREE.IcosahedronGeometry(1.7, isMobile ? 12 : 24);
  var core = new THREE.Mesh(geo, coreMat);
  mainScene.add(core);

  // wireframe lattice shell
  var wireMat = coreMat.clone();
  wireMat.uniforms = coreUniforms;
  wireMat.wireframe = true;
  wireMat.blending = THREE.AdditiveBlending;
  wireMat.depthWrite = false;
  var wire = new THREE.Mesh(geo, wireMat);
  wire.scale.setScalar(1.04);
  mainScene.add(wire);

  /* ---------- interaction ---------- */
  var mx = 0.5, my = 0.5, tmx = 0.5, tmy = 0.5;
  window.addEventListener('mousemove', function (e) {
    tmx = e.clientX / window.innerWidth;
    tmy = e.clientY / window.innerHeight;
  }, { passive: true });

  window.addEventListener('resize', function () {
    W = window.innerWidth; H = window.innerHeight;
    renderer.setSize(W, H);
    cam.aspect = W / H; cam.updateProjectionMatrix();
    uRes.value.set(W, H);
  });

  var clock = new THREE.Clock();

  function render() {
    requestAnimationFrame(render);
    var dt = clock.getDelta();
    uTime.value += reduce ? dt * 0.3 : dt;

    mx += (tmx - mx) * 0.05; my += (tmy - my) * 0.05;
    uMouse.value.set(mx, my);

    uProg.value = window.__progress || 0;

    // core reacts to mouse proximity to center + scroll
    var cd = Math.hypot(mx - 0.5, my - 0.5);
    coreUniforms.uAmp.value += ((0.22 + (0.5 - Math.min(cd, 0.5)) * 0.6 + uProg.value * 0.25) - coreUniforms.uAmp.value) * 0.06;

    core.rotation.y += 0.0016 + (mx - 0.5) * 0.002;
    core.rotation.x = (my - 0.5) * 0.4 + uProg.value * 0.8;
    wire.rotation.copy(core.rotation);

    // drift core toward side as you scroll / on wide screens keep it right of hero
    core.position.x = wire.position.x = 1.7 + Math.sin(uTime.value * 0.2) * 0.15;
    core.position.y = wire.position.y = -uProg.value * 2.0;
    var s = 1 + (isMobile ? -0.35 : 0);
    core.scale.setScalar(s); wire.scale.setScalar(s * 1.04);

    renderer.clear();
    renderer.render(bgScene, bgCam);
    renderer.clearDepth();
    renderer.render(mainScene, cam);
  }
  render();

  // signal that first frame is up
  requestAnimationFrame(function () { window.__sceneReady = true; });
})();
