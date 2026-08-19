import * as THREE from 'three';

/**
 * TrapSystem —— 地面危险圈陷阱
 *
 * 周期性在场内随机点生成红色预警圈：
 *   预警 2.0s（外圈常亮 + 内圈逐渐填满）→ 爆炸（复用魔法爆炸系统）
 *   对半径内的玩家 / 敌人 / 训练靶造成伤害与击退。
 * 最多 2 个陷阱同时存在，不干扰基础战斗节奏。
 */

const WARN_TIME = 2.0;
const BLAST_RADIUS = 3.0;
const DAMAGE = 15;
const MAX_ACTIVE = 2;

class Trap {
  constructor(scene) {
    this.scene = scene;
    this.active = false;
    this.t = 0;

    // 预警外圈
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(BLAST_RADIUS - 0.18, BLAST_RADIUS, 40),
      new THREE.MeshBasicMaterial({
        color: 0xff3a2a, transparent: true, opacity: 0,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    scene.add(this.ring);

    // 内圈填充盘（随预警进度涨满）
    this.disc = new THREE.Mesh(
      new THREE.CircleGeometry(BLAST_RADIUS - 0.2, 40),
      new THREE.MeshBasicMaterial({
        color: 0xd92a1a, transparent: true, opacity: 0,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    this.disc.rotation.x = -Math.PI / 2;
    this.disc.visible = false;
    scene.add(this.disc);
  }

  trigger(x, z) {
    this.active = true;
    this.t = 0;
    this.ring.position.set(x, 0.06, z);
    this.disc.position.set(x, 0.055, z);
    this.ring.visible = true;
    this.disc.visible = true;
  }

  hide() {
    this.active = false;
    this.ring.visible = false;
    this.disc.visible = false;
  }
}

export class TrapSystem {
  /**
   * @param {TargetImpactExplosion} explosion 复用爆炸特效
   * @param {Function} onBlast (center, radius, damage) => void 由 Game 应用伤害
   */
  constructor(scene, explosion, onBlast) {
    this.scene = scene;
    this.explosion = explosion;
    this.onBlast = onBlast;
    this.traps = [new Trap(scene), new Trap(scene)];
    this.cooldown = 4.5;         // 开局 4.5s 后第一个陷阱
    this._center = new THREE.Vector3();
  }

  update(dt, arenaRadius) {
    // ---- 激活中的陷阱推进 ----
    for (const trap of this.traps) {
      if (!trap.active) continue;
      trap.t += dt;
      const p = Math.min(1, trap.t / WARN_TIME);

      // 预警表现：外圈闪烁加快，内圈逐渐填满
      const blink = 0.55 + Math.sin(trap.t * (6 + p * 14)) * 0.35;
      trap.ring.material.opacity = blink;
      trap.disc.material.opacity = 0.1 + p * 0.32;
      trap.disc.scale.setScalar(Math.max(0.05, p));

      if (trap.t >= WARN_TIME) {
        // 爆炸
        this._center.set(trap.ring.position.x, 0.6, trap.ring.position.z);
        this.explosion.playMagicExplosion(this._center, 0.85);
        this.onBlast && this.onBlast(this._center, BLAST_RADIUS, DAMAGE);
        trap.hide();
      }
    }

    // ---- 生成新陷阱 ----
    this.cooldown -= dt;
    if (this.cooldown <= 0) {
      const free = this.traps.filter((t) => !t.active);
      if (free.length > 0 && this.traps.filter((t) => t.active).length < MAX_ACTIVE) {
        // 场内随机点（离中心 3~13m）
        const a = Math.random() * Math.PI * 2;
        const r = 3 + Math.random() * 10;
        free[0].trigger(Math.cos(a) * r, Math.sin(a) * r);
      }
      this.cooldown = 6 + Math.random() * 3; // 6~9s 一个
    }
  }
}
