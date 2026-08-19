import * as THREE from 'three';

/**
 * Projectile —— 基础魔法弹
 * 发光弹丸 + 拖尾 + 光晕，对象池复用。
 * 每枚弹道持有自己的材质实例，fire() 时可按阵营着色：
 * 玩家偏蓝白，敌人偏红紫。
 * 移动、寿命、命中判定由 CombatSystem 统一驱动（基于 deltaTime）。
 */
let _sharedGeo = null;

export class Projectile {
  constructor(scene) {
    this.scene = scene;

    if (!_sharedGeo) {
      _sharedGeo = new THREE.SphereGeometry(0.16, 10, 10);
    }

    this.coreMat = new THREE.MeshBasicMaterial({ color: 0x8fd0ff });
    this.trailMat = new THREE.MeshBasicMaterial({
      color: 0x5aa8ff, transparent: true, opacity: 0.45,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.glowMat = new THREE.SpriteMaterial({
      color: 0x9fd8ff, transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });

    this.group = new THREE.Group();
    this.core = new THREE.Mesh(_sharedGeo, this.coreMat);
    this.group.add(this.core);

    // 拖尾：拉伸的加色光带
    this.trail = new THREE.Mesh(_sharedGeo, this.trailMat);
    this.trail.scale.set(0.7, 0.7, 4.5);
    this.trail.position.z = 0.9;
    this.group.add(this.trail);

    // 光晕
    this.glow = new THREE.Sprite(this.glowMat);
    this.glow.scale.set(1.1, 1.1, 1);
    this.group.add(this.glow);

    this.group.visible = false;
    scene.add(this.group);

    this.active = false;
    this.velocity = new THREE.Vector3();
    this.damage = 0;
    this.owner = null;
    this.life = 0;
  }

  /**
   * @param {number} tint 弹丸颜色（默认玩家蓝）
   * @param {object} meta 可选：{ scale, power, slow } 技能弹道元数据
   */
  fire(owner, origin, dir, speed, damage, tint = 0x8fd0ff, meta = {}) {
    this.owner = owner;
    this.damage = damage;
    this.life = 2.5; // 秒，超时回收
    this.power = meta.power ?? 1;      // 命中时的爆炸规模
    this.slow = meta.slow ?? 0;        // 束缚时长（秒）
    this.velocity.copy(dir).multiplyScalar(speed);
    this.group.position.copy(origin);
    this.group.lookAt(origin.x + dir.x, origin.y + dir.y, origin.z + dir.z);

    const s = meta.scale ?? 1;
    this.group.scale.setScalar(s);

    this.coreMat.color.setHex(tint);
    this.glowMat.color.setHex(tint);
    // 拖尾用同色系稍暗的颜色
    this.trailMat.color.setHex(tint).multiplyScalar(0.7);

    this.group.visible = true;
    this.active = true;
  }

  despawn() {
    this.active = false;
    this.owner = null;
    this.group.visible = false;
    this.group.scale.setScalar(1);
    this.power = 1;
    this.slow = 0;
  }
}
