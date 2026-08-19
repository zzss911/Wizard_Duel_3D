import * as THREE from 'three';

/**
 * EnemyAI —— 敌人状态机
 *
 * 状态：Idle(Observe) → Chase → Strafe ⇄ Attack(前摇→施法→Recover) → Dodge → Dead
 * 难度系统：rookie / normal / hard，影响前摇、冷却、伤害、弹速、瞄准误差、闪避CD、移速。
 * 新手前两发额外降低准确率，让玩家看到弹道从身边飞过。
 */

const STATE = { IDLE: 'idle', CHASE: 'chase', STRAFE: 'strafe', ATTACK: 'attack', RECOVER: 'recover', DODGE: 'dodge' };

const FIGHT_RANGE = 9;
const ATTACK_RANGE = 13;
const TOO_FAR = 12;

const DIFFICULTY = {
  rookie: {
    observeTime: 1.5,
    telegraph: 0.75,
    attackCooldown: 1.55,
    damage: 7,
    projectileSpeed: 15,
    aimError: 1.25,
    dodgeCooldown: 5,
    speed: 4.0,
  },
  normal: {
    observeTime: 1.0,
    telegraph: 0.50,
    attackCooldown: 1.05,
    damage: 9,
    projectileSpeed: 18,
    aimError: 0.75,
    dodgeCooldown: 3.5,
    speed: 4.6,
  },
  hard: {
    observeTime: 0.6,
    telegraph: 0.32,
    attackCooldown: 0.75,
    damage: 10,
    projectileSpeed: 20,
    aimError: 0.42,
    dodgeCooldown: 2.7,
    speed: 4.9,
  },
};

export class EnemyAI {
  constructor(enemy, combat) {
    this.enemy = enemy;
    this.combat = combat;
    this.state = STATE.IDLE;
    this.strafeDir = 1;
    this.strafeTimer = 0;
    this.dodgeCd = 0;
    this.shotsFired = 0;
    this._aim = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._dodgeVec = new THREE.Vector3();
    this.difficulty = 'rookie';
    this.setDifficulty('rookie');
  }

  setDifficulty(level = 'rookie') {
    this.difficulty = level;
    this.config = DIFFICULTY[level] || DIFFICULTY.rookie;
    this.enemy.attackCooldown = this.config.attackCooldown;
    this.enemy.speed = this.config.speed;
    this.timer = this.config.observeTime;
  }

  reset() {
    this.state = STATE.IDLE;
    this.timer = this.config ? this.config.observeTime : 1.5;
    this.dodgeCd = 0;
    this.shotsFired = 0;
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
      this.dodgeCd = this.config.dodgeCooldown;
      this._dodgeVec.subVectors(e.position, player.position).normalize();
      this._dodgeVec.set(-this._dodgeVec.z * this.strafeDir, 0, this._dodgeVec.x * this.strafeDir);
    }

    const telegraph = this.config.telegraph;

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
        this._tmp.subVectors(e.position, player.position).setY(0).normalize();
        e.moveIntent.set(-this._tmp.z * this.strafeDir, 0, this._tmp.x * this.strafeDir);
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
          this.timer = telegraph;
        }
        break;
      }

      case STATE.ATTACK: {
        e.faceTowards(player.position, dt);
        const progress = 1 - Math.max(0, this.timer) / telegraph;
        // 最后 0.2s 快速脉冲
        let glow = progress;
        if (this.timer < 0.2) {
          glow = progress + Math.sin(this.timer * 30) * 0.2;
        }
        e.setCastGlow(Math.min(1, Math.max(0, glow)));

        if (this.timer <= 0) {
          this._aim.copy(player.headPosition);
          let err = this.config.aimError;
          // 新手前两发额外降低准确率
          if (this.difficulty === 'rookie' && this.shotsFired < 2) {
            err *= 1.6;
          }
          this._aim.x += this._rand(-err, err);
          this._aim.y += this._rand(-err * 0.4, err * 0.4);
          this._aim.z += this._rand(-err, err);
          e.getCastOrigin(this._tmp);
          this._aim.sub(this._tmp).normalize();
          this.combat.tryFire(e, this._aim, {
            damage: this.config.damage,
            speed: this.config.projectileSpeed,
            tint: 0xff5a3c,
          });
          this.shotsFired++;
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
        e.moveIntent.copy(this._dodgeVec).multiplyScalar(1.8);
        if (this.timer <= 0) this.state = STATE.STRAFE;
        break;
    }
  }

  _incomingProjectile(player) {
    const e = this.enemy;
    const alertR = e.hp < 35 ? 6.0 : 4.5;
    for (const p of this.combat.pool) {
      if (!p.active || p.owner !== player) continue;
      const dx = e.position.x - p.group.position.x;
      const dz = e.position.z - p.group.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > alertR * alertR) continue;
      const d = Math.sqrt(d2) || 1;
      const dot = (p.velocity.x * dx + p.velocity.z * dz) / (p.velocity.length() * d);
      if (dot > 0.85) return true;
    }
    return false;
  }

  _rand(a, b) { return a + Math.random() * (b - a); }
}
