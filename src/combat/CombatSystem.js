import * as THREE from 'three';
import { Projectile } from './Projectile.js';

/**
 * CombatSystem —— 唯一负责：伤害 / 冷却 / 命中 / 阵营判断
 * 弹道移动、寿命、场景碰撞、目标碰撞全部在这里基于 deltaTime 驱动。
 *
 * 技能表（开发文档 5.3）：
 *   普攻    伤害 10 / 速度 22 / 冷却 0.45s（owner.attackCooldown）
 *   爆裂咒  伤害 28 / 速度 12 / 大弹道 / 爆炸 power 1.5 / 冷却 6s
 *   束缚咒  伤害 5  / 速度 16 / 命中减速 40% 持续 1.5s / 冷却 8s
 */
const SKILLS = {
  1: { damage: 28, speed: 12, tint: 0xffa03c, scale: 2.4, power: 1.5, cdKey: 'skill1Cd' },
  2: { damage: 5, speed: 16, tint: 0xb46aff, scale: 1.35, power: 0.8, slow: 1.5, cdKey: 'skill2Cd' },
};

export class CombatSystem {
  constructor(scene, effects, explosion = null) {
    this.scene = scene;
    this.effects = effects;
    this.explosion = explosion;  // TargetImpactExplosion，由 Game 注入
    this.onDamage = null;        // (worldPos, amount, target) => void
    this.onImpact = null;        // (worldPos, power, target) => void，大爆炸编排
    this.onPlayerHit = null;     // (worldPos, amount) => void，玩家受击编排

    this.projectileSpeed = 22;
    this.baseDamage = 10;
    this.impactPower = 1;        // 普攻爆炸规模

    // 对象池
    this.pool = [];
    for (let i = 0; i < 24; i++) this.pool.push(new Projectile(scene));

    this._origin = new THREE.Vector3();
    this._hitPos = new THREE.Vector3();
    this._hitDir = new THREE.Vector3();
  }

  /** 生成弹道（内部共用） */
  _spawn(owner, dir, opts) {
    const p = this.pool.find((p) => !p.active);
    if (!p) return null;
    owner.getCastOrigin(this._origin);
    p.fire(owner, this._origin, dir, opts.speed, opts.damage, opts.tint, opts);
    return p;
  }

  /** 普攻入口：检查普攻冷却与死亡状态 */
  tryFire(owner, dir, opts = {}) {
    if (owner.dead || owner.cooldown > 0) return false;
    const p = this._spawn(owner, dir, {
      speed: opts.speed ?? this.projectileSpeed,
      damage: opts.damage ?? this.baseDamage,
      tint: opts.tint ?? 0x8fd0ff,
    });
    if (!p) return false;
    owner.cooldown = owner.attackCooldown;
    return true;
  }

  /**
   * 技能入口：检查技能冷却（不占普攻冷却）。
   * @param {1|2} id 1=爆裂咒 2=束缚咒
   */
  castSkill(owner, id, dir) {
    const sk = SKILLS[id];
    if (!sk || owner.dead) return false;
    if (owner[sk.cdKey] > 0) return false;
    const p = this._spawn(owner, dir, sk);
    if (!p) return false;
    owner[sk.cdKey] = owner[sk.cdKey + 'Max'] ?? 6;
    return true;
  }

  update(dt, combatants, arena) {
    for (const p of this.pool) {
      if (!p.active) continue;

      p.group.position.addScaledVector(p.velocity, dt);
      p.life -= dt;

      const pos = p.group.position;

      // ---- 场景命中：落地 / 出界 / 超时 ----
      const outOfArena = Math.hypot(pos.x, pos.z) > arena.radius + 6;
      if (p.life <= 0 || pos.y < 0.05 || outOfArena) {
        if (pos.y < 0.05) this.effects.burst(pos, 0x7fb8ff, 6);
        p.despawn();
        continue;
      }

      // ---- 场景命中：石柱 ----
      let hitScene = false;
      for (const pil of arena.pillars) {
        const dx = pos.x - pil.x, dz = pos.z - pil.z;
        if (dx * dx + dz * dz < pil.r * pil.r && pos.y < 8) {
          this.effects.burst(pos, 0x7fb8ff, 8);
          p.despawn();
          hitScene = true;
          break;
        }
      }
      if (hitScene) continue;

      // ---- 目标命中（球体近似） ----
      for (const c of combatants) {
        if (c === p.owner || c.dead) continue;
        const center = c.headPosition;
        const dx = pos.x - center.x, dy = pos.y - center.y, dz = pos.z - center.z;
        const rr = c.radius + 0.25;
        if (dx * dx + dy * dy + dz * dz < rr * rr) {
          this._hitPos.copy(pos);
          this._hitDir.copy(p.velocity).normalize();

          // 闪避无敌窗口：伤害无效，播放“擦过”反馈
          if (c.isInvincible) {
            this.effects.burst(this._hitPos, 0xd8ecff, 6);
            p.despawn();
            break;
          }

          c.takeDamage(p.damage);

          // 束缚咒：减速目标
          if (p.slow > 0 && c.applySlow) c.applySlow(0.6, p.slow);

          const power = p.power ?? 1;
          if (c.isTarget || power > 1) {
            // 训练靶 或 大威力技能：电影感爆炸（弹道命中即销毁，同次攻击只触发一次）
            const ep = Math.max(power, c.isTarget ? this.impactPower : power);
            if (this.explosion) {
              this.explosion.playMagicExplosion(this._hitPos, ep);
            } else {
              this.effects.burst(this._hitPos, 0xffd76a, 14);
            }
            this.onImpact && this.onImpact(this._hitPos, ep, c);
          } else if (c.isPlayer) {
            // 玩家被敌方命中：红色爆点 + 受击反馈（不放大爆炸，避免遮挡视野）
            this.effects.burst(this._hitPos, 0xff5a3c, 12);
            this.onPlayerHit && this.onPlayerHit(this._hitPos, p.damage);
          } else if (p.slow > 0) {
            // 束缚命中：紫色符文爆点
            this.effects.burst(this._hitPos, 0xb46aff, 14);
          } else {
            // 敌人被普攻命中：金色爆点 + 伤害数字
            this.effects.burst(this._hitPos, 0xffd76a, 12);
          }

          // 击退/旋转反馈
          if (c.applyImpact) c.applyImpact(this._hitDir, power);

          this.onDamage && this.onDamage(this._hitPos, p.damage, c);
          p.despawn();
          break;
        }
      }
    }
  }
}
