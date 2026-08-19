import * as THREE from 'three';

/**
 * EnemyAI —— 敌人状态机
 *
 * 状态：Idle(Observe) → Chase → Strafe ⇄ Attack(前摇→施法→Recover) → Dodge → Dead
 * 原则（开发文档 6.2）：
 *   不读玩家输入；攻击前 0.35s 可识别前摇（杖头变亮）；
 *   命中靠轻微随机偏移调节；低血量提高闪避频率但不无限闪避。
 * 只决定“现在该做什么”，动作由 Enemy / CombatSystem 执行。
 */

const STATE = { IDLE: 'idle', CHASE: 'chase', STRAFE: 'strafe', ATTACK: 'attack', RECOVER: 'recover', DODGE: 'dodge' };

const FIGHT_RANGE = 9;       // 进入对射距离
const ATTACK_RANGE = 13;     // 可开火距离
const TOO_FAR = 12;          // 超过则重新追击
const TELEGRAPH = 0.35;      // 攻击前摇（杖头亮起）
const DODGE_CD = 3.5;

export class EnemyAI {
  constructor(enemy, combat) {
    this.enemy = enemy;
    this.combat = combat;
    this.state = STATE.IDLE;
    this.timer = 1.2;              // 开局观察，避免贴脸
    this.strafeDir = 1;
    this.strafeTimer = 0;
    this.dodgeCd = 0;
    this._aim = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._dodgeVec = new THREE.Vector3();
  }

  reset() {
    this.state = STATE.IDLE;
    this.timer = 1.2;
    this.dodgeCd = 0;
    this.enemy.setCastGlow(0);
  }

  update(dt, player, arena) {
    const e = this.enemy;
    e.moveIntent.set(0, 0, 0);

    if (e.dead) return;
    if (player.dead) { e.setCastGlow(0); return; }

    this.dodgeCd = Math.max(0, this.dodgeCd - dt);
    this.timer -= dt;
    this.strafeTimer -= dt;

    const dist = e.position.distanceTo(player.position);

    // 硬直期间不决策，但仍面向玩家
    if (e.stagger > 0) {
      e.faceTowards(player.position, dt);
      return;
    }

    // ---- 闪避检测：玩家弹道逼近且冷却就绪 ----
    if (this.dodgeCd <= 0 && this.state !== STATE.DODGE && this._incomingProjectile(player)) {
      this.state = STATE.DODGE;
      this.timer = 0.28;
      this.dodgeCd = DODGE_CD;
      // 侧向闪避方向
      this._dodgeVec.subVectors(e.position, player.position).normalize();
      this._dodgeVec.set(-this._dodgeVec.z * this.strafeDir, 0, this._dodgeVec.x * this.strafeDir);
    }

    switch (this.state) {
      case STATE.IDLE:
        e.faceTowards(player.position, dt);
        if (this.timer <= 0) this.state = dist > FIGHT_RANGE ? STATE.CHASE : STATE.STRAFE;
        break;

      case STATE.CHASE: {
        e.faceTowards(player.position, dt);
        this._tmp.subVectors(player.position, e.position).setY(0).normalize();
        e.moveIntent.copy(this._tmp);
        if (dist <= FIGHT_RANGE) {
          this.state = STATE.STRAFE;
          this.strafeTimer = this._rand(1.2, 2.4);
        }
        break;
      }

      case STATE.STRAFE: {
        e.faceTowards(player.position, dt);
        // 绕玩家横移，保持对射感
        this._tmp.subVectors(e.position, player.position).setY(0).normalize();
        e.moveIntent.set(-this._tmp.z * this.strafeDir, 0, this._tmp.x * this.strafeDir);
        // 距离修正：太远稍靠近，太近稍拉开
        if (dist > FIGHT_RANGE + 1.5) e.moveIntent.addScaledVector(this._tmp, -0.5);
        else if (dist < FIGHT_RANGE - 2.5) e.moveIntent.addScaledVector(this._tmp, 0.6);
        e.moveIntent.normalize();

        if (this.strafeTimer <= 0) {
          this.strafeDir *= -1;
          this.strafeTimer = this._rand(1.2, 2.6);
        }
        if (dist > TOO_FAR) { this.state = STATE.CHASE; break; }
        if (e.cooldown <= 0 && dist < ATTACK_RANGE) {
          this.state = STATE.ATTACK;
          this.timer = TELEGRAPH;
        }
        break;
      }

      case STATE.ATTACK: {
        e.faceTowards(player.position, dt);
        e.setCastGlow(1 - Math.max(0, this.timer) / TELEGRAPH); // 前摇：杖头渐亮
        if (this.timer <= 0) {
          // 瞄准玩家胸口 + 轻微随机偏移（调节命中率）
          this._aim.copy(player.headPosition);
          this._aim.x += this._rand(-0.55, 0.55);
          this._aim.y += this._rand(-0.25, 0.35);
          this._aim.z += this._rand(-0.55, 0.55);
          e.getCastOrigin(this._tmp);
          this._aim.sub(this._tmp).normalize();
          this.combat.tryFire(e, this._aim, { damage: 9, speed: 19, tint: 0xff5a3c });
          e.setCastGlow(0);
          this.state = STATE.RECOVER;
          this.timer = this._rand(0.35, 0.6);
        }
        break;
      }

      case STATE.RECOVER:
        e.faceTowards(player.position, dt);
        if (this.timer <= 0) {
          this.state = STATE.STRAFE;
          this.strafeTimer = this._rand(1.0, 2.2);
        }
        break;

      case STATE.DODGE:
        e.moveIntent.copy(this._dodgeVec).multiplyScalar(1.8); // 短促侧移爆发
        if (this.timer <= 0) this.state = STATE.STRAFE;
        break;
    }
  }

  /** 检测是否有玩家弹道正朝自己飞来（4.5m 内且逼近） */
  _incomingProjectile(player) {
    const e = this.enemy;
    // 低血量时更警觉（闪避触发距离更远）
    const alertR = e.hp < 35 ? 6.0 : 4.5;
    for (const p of this.combat.pool) {
      if (!p.active || p.owner !== player) continue;
      const dx = e.position.x - p.group.position.x;
      const dz = e.position.z - p.group.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > alertR * alertR) continue;
      // 速度方向与指向敌人的夹角足够小才算“来袭”
      const d = Math.sqrt(d2) || 1;
      const dot = (p.velocity.x * dx + p.velocity.z * dz) / (p.velocity.length() * d);
      if (dot > 0.85) return true;
    }
    return false;
  }

  _rand(a, b) { return a + Math.random() * (b - a); }
}
