import * as THREE from 'three';

/**
 * ArenaProps —— 场景装饰：漂浮烛火 / 旗帜 / 火盆 / 碎石
 * 全部低面数 + 共享材质，烛火与火盆火焰有动画。
 */
export class ArenaProps {
  constructor(scene, arena) {
    this.scene = scene;
    this.arena = arena;
    this._time = 0;
    this.candles = [];
    this.flames = [];

    this._buildCandles();
    this._buildBanners();
    this._buildBraziers();
    this._buildRocks();
  }

  /* ---------------- 漂浮烛火 ---------------- */
  _buildCandles() {
    const waxMat = new THREE.MeshStandardMaterial({ color: 0xe8dcc0, roughness: 0.7 });
    const flameMat = new THREE.MeshBasicMaterial({
      color: 0xffc76a, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const count = 12;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + 0.3;
      const r = 12 + (i % 3) * 2.5;
      const holder = new THREE.Group();

      const candle = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.4, 8), waxMat);
      holder.add(candle);
      const flame = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), flameMat.clone());
      flame.position.y = 0.3;
      flame.scale.y = 1.5;
      holder.add(flame);

      const baseY = 2.6 + (i % 4) * 0.7;
      holder.position.set(Math.cos(a) * r, baseY, Math.sin(a) * r);
      this.scene.add(holder);
      this.candles.push({ holder, flame, baseY, phase: Math.random() * Math.PI * 2, speed: 0.6 + Math.random() * 0.5 });
    }
  }

  /* ---------------- 旗帜（挂在外围石柱上） ---------------- */
  _buildBanners() {
    const colors = [0x2b4aa8, 0x6e1d2a, 0x2b4aa8, 0x6e1d2a, 0x3a2a6e, 0x3a2a6e, 0x2b4aa8, 0x6e1d2a];
    this.arena.pillars.forEach((p, i) => {
      const bannerMat = new THREE.MeshStandardMaterial({
        color: colors[i % colors.length], roughness: 0.8, side: THREE.DoubleSide,
      });
      const banner = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 2.2), bannerMat);
      // 朝场地中心悬挂
      const dir = Math.atan2(-p.x, -p.z);
      banner.position.set(p.x * 0.96, 4.6, p.z * 0.96);
      banner.rotation.y = dir;
      this.scene.add(banner);
      // 顶部横杆
      const rod = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.03, 1.1, 6),
        new THREE.MeshStandardMaterial({ color: 0x8a7a5a, roughness: 0.5, metalness: 0.6 })
      );
      rod.rotation.z = Math.PI / 2;
      rod.rotation.y = dir;
      rod.position.set(p.x * 0.96, 5.75, p.z * 0.96);
      this.scene.add(rod);
    });
  }

  /* ---------------- 火盆（2 个，配真实点光源） ---------------- */
  _buildBraziers() {
    const bowlMat = new THREE.MeshStandardMaterial({ color: 0x3a3430, roughness: 0.6, metalness: 0.5 });
    const spots = [
      { x: 6, z: 6 }, { x: -6, z: 6 },
    ];
    for (const s of spots) {
      const g = new THREE.Group();
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, 1.0, 8), bowlMat);
      stem.position.y = 0.5;
      stem.castShadow = true;
      g.add(stem);
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.2, 0.35, 12), bowlMat);
      bowl.position.y = 1.1;
      g.add(bowl);

      const flame = new THREE.Sprite(new THREE.SpriteMaterial({
        color: 0xff9a3d, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      flame.position.y = 1.45;
      flame.scale.set(0.8, 1.1, 1);
      g.add(flame);

      const light = new THREE.PointLight(0xff8a3d, 10, 12, 2);
      light.position.y = 1.6;
      g.add(light);

      g.position.set(s.x, 0, s.z);
      this.scene.add(g);
      this.flames.push({ flame, light, phase: Math.random() * Math.PI * 2 });
    }
  }

  /* ---------------- 碎石点缀 ---------------- */
  _buildRocks() {
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x424a5e, roughness: 0.95 });
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 3 + Math.random() * 12;
      const s = 0.15 + Math.random() * 0.3;
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), rockMat);
      rock.position.set(Math.cos(a) * r, s * 0.5, Math.sin(a) * r);
      rock.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      rock.castShadow = true;
      this.scene.add(rock);
    }
  }

  update(dt) {
    this._time += dt;
    const t = this._time;

    // 烛火漂浮 + 火苗闪烁
    for (const c of this.candles) {
      c.holder.position.y = c.baseY + Math.sin(t * c.speed + c.phase) * 0.25;
      c.holder.rotation.y = t * 0.3 + c.phase;
      const f = 0.85 + Math.sin(t * 9 + c.phase) * 0.15;
      c.flame.scale.set(f, 1.5 * f, f);
    }
    // 火盆火焰跳动
    for (const b of this.flames) {
      const f = 0.9 + Math.sin(t * 11 + b.phase) * 0.12 + Math.sin(t * 23 + b.phase) * 0.05;
      b.flame.scale.set(0.8 * f, 1.1 * f, 1);
      b.light.intensity = 10 * (0.9 + Math.sin(t * 13 + b.phase) * 0.15);
    }
  }
}
