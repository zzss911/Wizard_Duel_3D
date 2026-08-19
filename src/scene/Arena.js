import * as THREE from 'three';

/**
 * Arena —— 魔法学院决斗场
 * 圆形符文决斗台 + 外围石柱 + 魔法围栏 + 能量结界。
 * 地面使用程序化 Canvas 贴图（石板 + 符文法阵），零外部资源。
 */
export class Arena {
  constructor(scene) {
    this.scene = scene;
    this.radius = 18;
    this.pillars = [];         // {x, z, r} 供弹道碰撞
    this._time = 0;

    this._buildGround();
    this._buildPillars();
    this._buildFence();
    this._buildLights();
  }

  /* ---------------- 程序化地面贴图：石板 + 符文法阵 ---------------- */
  _makeGroundTexture() {
    const S = 1024;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const g = cv.getContext('2d');
    const c = S / 2;

    // 基底：深蓝灰石板
    g.fillStyle = '#383e50';
    g.fillRect(0, 0, S, S);

    // 石板噪点与明暗层次
    for (let i = 0; i < 5200; i++) {
      const x = Math.random() * S, y = Math.random() * S;
      const v = Math.random();
      g.fillStyle = v < 0.5 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.045)';
      g.fillRect(x, y, 2 + Math.random() * 3, 2 + Math.random() * 3);
    }

    // 石板拼缝（同心圆 + 放射线）
    g.strokeStyle = 'rgba(12,14,24,0.55)';
    g.lineWidth = 3;
    for (let r = 70; r < c; r += 78) {
      g.beginPath();
      g.arc(c, c, r, 0, Math.PI * 2);
      g.stroke();
    }
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      g.beginPath();
      g.moveTo(c + Math.cos(a) * 60, c + Math.sin(a) * 60);
      g.lineTo(c + Math.cos(a) * c, c + Math.sin(a) * c);
      g.stroke();
    }

    // 中央磨损高光
    const grad = g.createRadialGradient(c, c, 40, c, c, c);
    grad.addColorStop(0, 'rgba(180,190,220,0.10)');
    grad.addColorStop(0.6, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.28)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);

    // ---- 符文法阵：金色双环 + 符文刻印 ----
    const runeAlpha = 0.85;
    g.strokeStyle = `rgba(216,170,80,${runeAlpha})`;
    g.lineWidth = 6;
    g.beginPath(); g.arc(c, c, c * 0.82, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 3;
    g.beginPath(); g.arc(c, c, c * 0.76, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(c, c, c * 0.30, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 4;
    g.beginPath(); g.arc(c, c, c * 0.24, 0, Math.PI * 2); g.stroke();

    // 符文刻印（沿外环分布的抽象刻痕）
    g.strokeStyle = `rgba(226,190,110,${runeAlpha})`;
    g.lineWidth = 4;
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      const r = c * 0.79;
      const x = c + Math.cos(a) * r, y = c + Math.sin(a) * r;
      g.save();
      g.translate(x, y);
      g.rotate(a + Math.PI / 2);
      g.beginPath();
      g.moveTo(-9, -7); g.lineTo(0, 7); g.lineTo(9, -7);
      if (i % 3 === 0) { g.moveTo(-5, 0); g.lineTo(5, 0); }
      if (i % 4 === 0) { g.moveTo(0, 7); g.lineTo(0, -10); }
      g.stroke();
      g.restore();
    }
    // 内环小型符文
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + 0.26;
      const r = c * 0.27;
      const x = c + Math.cos(a) * r, y = c + Math.sin(a) * r;
      g.save();
      g.translate(x, y);
      g.rotate(a);
      g.strokeRect(-6, -6, 12, 12);
      g.restore();
    }

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  _buildGround() {
    const groundGeo = new THREE.CylinderGeometry(this.radius + 1.5, this.radius + 2.5, 1, 64);
    this.groundMat = new THREE.MeshStandardMaterial({
      map: this._makeGroundTexture(),
      roughness: 0.85,
      metalness: 0.08,
    });
    const ground = new THREE.Mesh(groundGeo, this.groundMat);
    ground.position.y = -0.5;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // 法阵发光层（叠加在贴图上方，轻微呼吸）
    this.runeGlowMat = new THREE.MeshBasicMaterial({
      color: 0xd8a84e, transparent: true, opacity: 0.22,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const glowRing = new THREE.Mesh(new THREE.RingGeometry(this.radius * 0.75, this.radius * 0.83, 72), this.runeGlowMat);
    glowRing.rotation.x = -Math.PI / 2;
    glowRing.position.y = 0.03;
    this.scene.add(glowRing);

    // 边界光环（提示活动范围）
    this.edgeMat = new THREE.MeshBasicMaterial({
      color: 0x5f7fd9, transparent: true, opacity: 0.4, side: THREE.DoubleSide,
    });
    const edge = new THREE.Mesh(new THREE.RingGeometry(this.radius - 0.15, this.radius + 0.15, 72), this.edgeMat);
    edge.rotation.x = -Math.PI / 2;
    edge.position.y = 0.05;
    this.scene.add(edge);
  }

  _buildPillars() {
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x4a4356, roughness: 0.85 });
    const capMat = new THREE.MeshStandardMaterial({ color: 0x5d5470, roughness: 0.8 });
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xffb347 });

    const count = 8;
    const pillarR = this.radius + 3.5;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.PI / count;
      const x = Math.cos(a) * pillarR;
      const z = Math.sin(a) * pillarR;

      const h = 6 + (i % 2) * 1.5;
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, h, 10), pillarMat);
      pillar.position.set(x, h / 2, z);
      pillar.castShadow = true;
      this.scene.add(pillar);

      const cap = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.5, 1.7), capMat);
      cap.position.set(x, h + 0.25, z);
      cap.castShadow = true;
      this.scene.add(cap);

      const flame = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 8), flameMat);
      flame.position.set(x, h + 0.8, z);
      this.scene.add(flame);

      if (i % 2 === 0) {
        const light = new THREE.PointLight(0xff9a3d, 14, 17, 2);
        light.position.set(x, h + 0.9, z);
        this.scene.add(light);
      }

      this.pillars.push({ x, z, r: 0.85 });
    }
  }

  /* ---------------- 魔法围栏 + 能量结界 ---------------- */
  _buildFence() {
    const fenceR = this.radius + 1.0;

    // 矮石柱围栏（带发光符文段）
    const postMat = new THREE.MeshStandardMaterial({ color: 0x46405a, roughness: 0.8 });
    const runeMat = new THREE.MeshStandardMaterial({
      color: 0x3a6a8a, roughness: 0.4, metalness: 0.3,
      emissive: 0x4fb8e8, emissiveIntensity: 0.9,
    });
    const postCount = 24;
    for (let i = 0; i < postCount; i++) {
      const a = (i / postCount) * Math.PI * 2;
      const x = Math.cos(a) * fenceR;
      const z = Math.sin(a) * fenceR;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 1.15, 8), postMat);
      post.position.set(x, 0.57, z);
      post.castShadow = true;
      this.scene.add(post);
      const rune = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.16, 8), runeMat);
      rune.position.set(x, 0.82, z);
      this.scene.add(rune);
    }

    // 能量结界：半透明圆柱壁（呼吸脉动）
    this.barrierMat = new THREE.MeshBasicMaterial({
      color: 0x3f8fd9, transparent: true, opacity: 0.07,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const barrier = new THREE.Mesh(
      new THREE.CylinderGeometry(fenceR - 0.1, fenceR - 0.1, 2.6, 72, 1, true),
      this.barrierMat
    );
    barrier.position.y = 1.3;
    this.scene.add(barrier);

    // 结界顶部能量环
    this.topRingMat = new THREE.MeshBasicMaterial({
      color: 0x66baff, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const topRing = new THREE.Mesh(new THREE.TorusGeometry(fenceR - 0.1, 0.05, 8, 72), this.topRingMat);
    topRing.rotation.x = Math.PI / 2;
    topRing.position.y = 2.6;
    this.scene.add(topRing);
  }

  _buildLights() {
    // 夜间蓝黑环境光（略提亮，画面更干净）
    this.scene.add(new THREE.AmbientLight(0x2e3a5e, 1.25));

    const hemi = new THREE.HemisphereLight(0x3a4670, 0x161226, 0.55);
    this.scene.add(hemi);

    // 主方向光（月光，带阴影）
    const moon = new THREE.DirectionalLight(0x93aee8, 1.7);
    moon.position.set(14, 22, 8);
    moon.castShadow = true;
    moon.shadow.mapSize.set(1024, 1024);
    moon.shadow.camera.left = -24;
    moon.shadow.camera.right = 24;
    moon.shadow.camera.top = 24;
    moon.shadow.camera.bottom = -24;
    moon.shadow.camera.far = 60;
    moon.shadow.bias = -0.001;
    this.scene.add(moon);

    // 反向冷色轮廓光，增强角色立体感
    const rim = new THREE.DirectionalLight(0x4a5fa8, 0.7);
    rim.position.set(-12, 10, -14);
    this.scene.add(rim);
  }

  /** 呼吸动画：法阵微光 / 结界脉动 */
  update(dt) {
    this._time += dt;
    const t = this._time;
    this.runeGlowMat.opacity = 0.18 + Math.sin(t * 1.4) * 0.07;
    this.barrierMat.opacity = 0.055 + Math.sin(t * 2.1) * 0.025;
    this.topRingMat.opacity = 0.4 + Math.sin(t * 2.1 + 1.2) * 0.15;
    this.edgeMat.opacity = 0.32 + Math.sin(t * 1.8) * 0.1;
  }
}
