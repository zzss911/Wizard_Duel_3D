import * as THREE from 'three';

/**
 * WardenAI —— 典狱长 Boss 状态机
 *
 * 状态：IDLE → CHOOSE → TELEGRAPH → ATTACK → RECOVER → PHASE_CHANGE → DEAD
 *
 * 技能：
 *   1. 锁链禁锢 — 玩家脚下红阵 → 延迟伤害+减速/禁锢
 *   2. 重型魔法弹 — 蓄力大弹丸
 *   3. 典狱震荡 — 武器砸地 → 扩散冲击波
 *   4. 死亡牢笼（Phase2 专属）— 多个红阵依次爆炸
 */

const STATE = {
  IDLE: 'idle',
  CHOOSE: 'choose',
  TELEGRAPH: 'telegraph',
  ATTACK: 'attack',
  RECOVER: 'recover',
  PHASE_CHANGE: 'phase_change',
  DEAD: 'dead',
};

const SKILLS = {
  CHAIN: 'chain',
  MAGIC_BOLT: 'magic_bolt',
  QUAKE: 'quake',
  DEATH_CAGE: 'death_cage',
};

const SKILL_CONFIG = {
  [SKILLS.CHAIN]: {
    telegraph: 1.0,
    recover: 1.4,
    damage: 14,
    slowMult: 0.5,
    slowDur: 0.7,
    radius: 2.5,
  },
  [SKILLS.MAGIC_BOLT]: {
    telegraph: 0.9,
    recover: 1.2,
    damage: 20,
    projectileSpeed: 16,
    projectileScale: 3.0,
    projectileTint: 0xff3a20,
  },
  [SKILLS.QUAKE]: {
    telegraph: 1.3,
    recover: 1.6,
    damage: 22,
    waveSpeed: 12,
    waveRadius: 10,
  },
  [SKILLS.DEATH_CAGE]: {
    telegraph: 1.0,
    recover: 1.8,
    damage: 18,
    zoneCount: 4,
    zoneRadius: 3.0,
    zoneDelay: 0.3,
  },
};

// 区域阶段
const ZONE_PHASE = {
  WARNING: 'warning',
  TRIGGER: 'trigger',
  DAMAGE: 'damage',
  CLEANUP: 'cleanup',
};

export class WardenAI {
  constructor(boss, combat, scene, effects, explosion) {
    this.boss = boss;
    this.combat = combat;
    this.scene = scene;
    this.effects = effects;
    this.explosion = explosion;
    this.state = STATE.IDLE;
    this.timer = 2.0;
    this.lastAttack = null;
    this.attackHistory = [];
    this.phase = 1;
    this._currentSkill = null;
    this._telegraphProgress = 0;
    this._tmp = new THREE.Vector3();
    this._aim = new THREE.Vector3();
    this._spawnedZones = [];
    this._quakeWave = null;
    this._boltCount = 0;
    this._boltTimer = 0;
  }

  reset() {
    this.state = STATE.IDLE;
    this.timer = 2.0;
    this.lastAttack = null;
    this.attackHistory = [];
    this.phase = 1;
    this._currentSkill = null;
    this._telegraphProgress = 0;
    this._spawnedZones = [];
    this._quakeWave = null;
    this._boltCount = 0;
    this._boltTimer = 0;
    this.boss.setCastGlow(0);
  }

  setPhase2() {
    this.phase = 2;
    this.boss.setPhase2();
  }

  update(dt, player, arena) {
    const b = this.boss;
    b.moveIntent.set(0, 0, 0);

    if (b.dead) {
      this.state = STATE.DEAD;
      b.setCastGlow(0);
      return;
    }
    if (player.dead) {
      b.setCastGlow(0);
      return;
    }

    this.timer -= dt;
    const dist = b.position.distanceTo(player.position);

    this._updateZones(dt, player);
    this._updateQuakeWave(dt, player);

    if (this._boltCount > 0) {
      this._boltTimer -= dt;
      if (this._boltTimer <= 0) {
        this._fireBolt(player);
        this._boltCount--;
        if (this._boltCount > 0) this._boltTimer = 0.35;
      }
    }

    switch (this.state) {
      case STATE.IDLE:
        b.faceTowards(player.position, dt);
        if (dist > 8) {
          this._tmp.subVectors(player.position, b.position).setY(0).normalize();
          b.moveIntent.copy(this._tmp).multiplyScalar(0.5);
        }
        if (this.timer <= 0) this.state = STATE.CHOOSE;
        break;

      case STATE.CHOOSE: {
        const skill = this._chooseSkill(dist);
        this._currentSkill = skill;
        this.state = STATE.TELEGRAPH;
        this.timer = SKILL_CONFIG[skill].telegraph;
        this._telegraphProgress = 0;
        this.attackHistory.push(skill);
        if (this.attackHistory.length > 4) this.attackHistory.shift();
        this._beginTelegraph(skill, player);
        break;
      }

      case STATE.TELEGRAPH: {
        b.faceTowards(player.position, dt);
        const telegraphTime = SKILL_CONFIG[this._currentSkill].telegraph;
        this._telegraphProgress = 1 - Math.max(0, this.timer) / telegraphTime;
        let glow = this._telegraphProgress;
        if (this.timer < 0.25) glow += Math.sin(this.timer * 30) * 0.2;
        b.setCastGlow(Math.min(1, Math.max(0, glow)));

        if (this.timer <= 0) {
          this._executeAttack(this._currentSkill, player, arena);
          b.setCastGlow(0);
          this.state = STATE.RECOVER;
          this.timer = SKILL_CONFIG[this._currentSkill].recover;
        }
        break;
      }

      case STATE.RECOVER:
        b.faceTowards(player.position, dt);
        if (dist > 10) {
          this._tmp.subVectors(player.position, b.position).setY(0).normalize();
          b.moveIntent.copy(this._tmp).multiplyScalar(0.3);
        }
        if (this.timer <= 0) {
          this.state = STATE.IDLE;
          this.timer = 0.8 + Math.random() * 0.8;
        }
        break;

      case STATE.PHASE_CHANGE:
        b.setCastGlow(0);
        if (this.timer <= 0) {
          this.state = STATE.IDLE;
          this.timer = 1.0;
        }
        break;
    }
  }

  triggerPhaseChange() {
    this.state = STATE.PHASE_CHANGE;
    this.timer = 2.5;
    this.boss.setInvulnerable(2.5);
    this.boss.setCastGlow(0);
    this._clearZones();
    this._clearQuakeWave();
    this._boltCount = 0;
  }

  _chooseSkill(dist) {
    const phase = this.phase;
    const available = [SKILLS.CHAIN, SKILLS.MAGIC_BOLT, SKILLS.QUAKE];
    if (phase === 2) available.push(SKILLS.DEATH_CAGE);

    const last3 = this.attackHistory.slice(-3);
    const filtered = available.filter(s => {
      if (last3.length < 3) return true;
      return !(last3[0] === s && last3[1] === s && last3[2] === s);
    });

    const weights = {};
    for (const s of filtered) weights[s] = 1;

    if (dist > 10) {
      weights[SKILLS.MAGIC_BOLT] = 3;
      weights[SKILLS.CHAIN] = 2;
      weights[SKILLS.QUAKE] = 0.5;
      if (phase === 2) weights[SKILLS.DEATH_CAGE] = 1.5;
    } else if (dist < 5) {
      weights[SKILLS.QUAKE] = 3;
      weights[SKILLS.CHAIN] = 1.5;
      weights[SKILLS.MAGIC_BOLT] = 1;
      if (phase === 2) weights[SKILLS.DEATH_CAGE] = 1;
    } else {
      weights[SKILLS.CHAIN] = 2;
      weights[SKILLS.MAGIC_BOLT] = 2;
      weights[SKILLS.QUAKE] = 1.5;
      if (phase === 2) weights[SKILLS.DEATH_CAGE] = 1.5;
    }

    if (phase === 2) {
      weights[SKILLS.DEATH_CAGE] = (weights[SKILLS.DEATH_CAGE] || 0) * 1.3;
    }

    let total = 0;
    for (const s of filtered) total += weights[s] || 1;
    let r = Math.random() * total;
    for (const s of filtered) {
      r -= (weights[s] || 1);
      if (r <= 0) return s;
    }
    return filtered[0];
  }

  /* ==================== 技能前摇 ==================== */

  _beginTelegraph(skill, player) {
    if (skill === SKILLS.CHAIN) {
      this._spawnChainZone(player.position);
    } else if (skill === SKILLS.DEATH_CAGE) {
      const count = SKILL_CONFIG[SKILLS.DEATH_CAGE].zoneCount;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + Math.random() * 0.5;
        const r = 4 + Math.random() * 8;
        this._spawnChainZone(
          new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r),
          true,
          i * SKILL_CONFIG[SKILLS.DEATH_CAGE].zoneDelay
        );
      }
    }
  }

  /* ==================== 锁链区域 ==================== */

  _spawnChainZone(pos, isDeathCage = false, delay = 0) {
    const radius = isDeathCage
      ? SKILL_CONFIG[SKILLS.DEATH_CAGE].zoneRadius
      : SKILL_CONFIG[SKILLS.CHAIN].radius;

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius - 0.2, radius, 40),
      new THREE.MeshBasicMaterial({
        color: 0xff2a1a, transparent: true, opacity: 0,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pos.x, 0.06, pos.z);
    this.scene.add(ring);

    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(radius - 0.25, 40),
      new THREE.MeshBasicMaterial({
        color: 0xd92a1a, transparent: true, opacity: 0,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(pos.x, 0.055, pos.z);
    this.scene.add(disc);

    const chainGroup = new THREE.Group();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const chain = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.05, 2.5, 6),
        new THREE.MeshStandardMaterial({
          color: 0x4a2020, roughness: 0.6, metalness: 0.7,
          emissive: 0x801010, emissiveIntensity: 0.5,
        })
      );
      chain.position.set(Math.cos(a) * (radius - 0.3), 1.2, Math.sin(a) * (radius - 0.3));
      chain.scale.y = 0.01;
      chainGroup.add(chain);
    }
    chainGroup.visible = false;
    this.scene.add(chainGroup);

    const warnTime = isDeathCage
      ? SKILL_CONFIG[SKILLS.DEATH_CAGE].telegraph
      : SKILL_CONFIG[SKILLS.CHAIN].telegraph;

    const zone = {
      type: 'chain',
      ring, disc, chainGroup,
      radius,
      pos: pos.clone(),
      phase: ZONE_PHASE.WARNING,
      elapsed: 0,
      warnTime,
      delay,
      damage: isDeathCage
        ? SKILL_CONFIG[SKILLS.DEATH_CAGE].damage
        : SKILL_CONFIG[SKILLS.CHAIN].damage,
      slowMult: isDeathCage ? 0 : SKILL_CONFIG[SKILLS.CHAIN].slowMult,
      slowDur: SKILL_CONFIG[SKILLS.CHAIN].slowDur,
      damaged: false,
      cleanupT: 0,
      isDeathCage,
    };
    this._spawnedZones.push(zone);
  }

  /* ==================== 执行技能 ==================== */

  _executeAttack(skill, player, arena) {
    const cfg = SKILL_CONFIG[skill];

    if (skill === SKILLS.CHAIN) {
      // 锁链区域已在 _beginTelegraph 时以 WARNING 阶段生成，
      // _updateZones 会自动完成 WARNING→TRIGGER→DAMAGE→CLEANUP，
      // 这里不需要手动触发。
    } else if (skill === SKILLS.MAGIC_BOLT) {
      this._fireBolt(player);
      if (this.phase === 2) {
        this._boltCount = 1;
        this._boltTimer = 0.35;
      }
    } else if (skill === SKILLS.QUAKE) {
      this._spawnQuakeWave(arena);
    } else if (skill === SKILLS.DEATH_CAGE) {
      // 死亡牢笼区域已在 _beginTelegraph 时以带 staggered delay 的 WARNING 阶段生成，
      // 每个 zone 独立执行 delay→WARNING(warnTime)→TRIGGER→DAMAGE→CLEANUP，
      // _updateZones 自动处理依次预警和依次爆炸，这里不做任何手动触发。
    }
  }

  _fireBolt(player) {
    const cfg = SKILL_CONFIG[SKILLS.MAGIC_BOLT];
    this.boss.getCastOrigin(this._tmp);
    this._aim.copy(player.headPosition).sub(this._tmp).normalize();
    this._aim.x += (Math.random() - 0.5) * 0.15;
    this._aim.y += (Math.random() - 0.5) * 0.08;
    this._aim.z += (Math.random() - 0.5) * 0.15;
    this._aim.normalize();

    const p = this.combat._spawn(this.boss, this._aim, {
      speed: cfg.projectileSpeed,
      damage: cfg.damage,
      tint: cfg.projectileTint,
      scale: cfg.projectileScale,
      power: 1.5,
    });
    return p !== null;
  }

  /* ==================== 震荡冲击波 ==================== */

  _spawnQuakeWave(arena) {
    const cfg = SKILL_CONFIG[SKILLS.QUAKE];
    const wave = {
      center: this.boss.position.clone(),
      radius: 0,
      maxRadius: this.phase === 2 ? cfg.waveRadius * 1.3 : cfg.waveRadius,
      speed: cfg.waveSpeed,
      damage: cfg.damage,
      hit: false,
      ring: null,
    };

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.8, 1.0, 64),
      new THREE.MeshBasicMaterial({
        color: 0xff3a20, transparent: true, opacity: 0.8,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(wave.center.x, 0.1, wave.center.z);
    this.scene.add(ring);
    wave.ring = ring;

    this._quakeWave = wave;
  }

  _updateQuakeWave(dt, player) {
    if (!this._quakeWave) return;
    const w = this._quakeWave;
    w.radius += w.speed * dt;
    const scale = Math.max(0.1, w.radius);
    w.ring.scale.setScalar(scale);
    w.ring.material.opacity = Math.max(0, 0.8 * (1 - w.radius / w.maxRadius));

    if (!w.hit) {
      const d = Math.hypot(player.position.x - w.center.x, player.position.z - w.center.z);
      if (d > w.radius - 1.5 && d < w.radius + 1.5) {
        if (!player.isInvincible) {
          player.takeDamage(w.damage);
          w.hit = true;
          this.effects.burst(player.headPosition, 0xff3a20, 14);
        }
      }
    }

    if (w.radius >= w.maxRadius) {
      this.scene.remove(w.ring);
      w.ring.geometry.dispose();
      w.ring.material.dispose();
      this._quakeWave = null;
    }
  }

  /* ==================== 区域更新 ==================== */

  _updateZones(dt, player) {
    for (let i = this._spawnedZones.length - 1; i >= 0; i--) {
      const z = this._spawnedZones[i];

      if (z.delay > 0) {
        z.delay -= dt;
        continue;
      }

      z.elapsed += dt;

      switch (z.phase) {
        case ZONE_PHASE.WARNING: {
          // 红圈 + 地面危险区可见，逐渐变亮
          z.ring.visible = true;
          z.disc.visible = true;
          const p = Math.min(1, z.elapsed / z.warnTime);
          const blink = 0.45 + Math.sin(z.elapsed * (6 + p * 14)) * 0.3 + p * 0.25;
          z.ring.material.opacity = Math.min(1, blink);
          z.disc.material.opacity = 0.08 + p * 0.3;
          z.disc.scale.setScalar(Math.max(0.05, p));
          // 锁链在后半段逐渐升起
          if (p > 0.5 && z.chainGroup) {
            z.chainGroup.visible = true;
            const chainH = (p - 0.5) * 2;
            for (const chain of z.chainGroup.children) {
              chain.scale.y = Math.max(0.01, chainH);
            }
          }
          // 达到 warnTime → 进入 TRIGGER
          if (z.elapsed >= z.warnTime) {
            z.phase = ZONE_PHASE.TRIGGER;
          }
          break;
        }

        case ZONE_PHASE.TRIGGER: {
          // 爆炸视觉 + 伤害检测（只做一次）
          z.phase = ZONE_PHASE.DAMAGE;
          const center = new THREE.Vector3(z.pos.x, 0.6, z.pos.z);
          if (z.isDeathCage) {
            this.explosion.playMagicExplosion(center, 1.0);
          } else {
            this.effects.burst(center, 0xff2a1a, 14);
          }
          break;
        }

        case ZONE_PHASE.DAMAGE: {
          // 只做一次伤害检测
          if (!z.damaged) {
            z.damaged = true;
            const d = Math.hypot(player.position.x - z.pos.x, player.position.z - z.pos.z);
            if (d < z.radius && !player.isInvincible) {
              player.takeDamage(z.damage);
              if (z.slowMult > 0 && player.applySlow) {
                player.applySlow(z.slowMult, z.slowDur);
              }
              this.effects.burst(player.headPosition, 0xff2a1a, 10);
            }
          }
          // 锁链收回
          if (z.chainGroup) z.chainGroup.visible = false;
          z.ring.visible = false;
          z.disc.visible = false;
          z.phase = ZONE_PHASE.CLEANUP;
          z.cleanupT = 0;
          break;
        }

        case ZONE_PHASE.CLEANUP: {
          z.cleanupT += dt;
          if (z.cleanupT > 0.4) {
            this.scene.remove(z.ring);
            this.scene.remove(z.disc);
            if (z.chainGroup) this.scene.remove(z.chainGroup);
            z.ring.geometry.dispose();
            z.ring.material.dispose();
            z.disc.geometry.dispose();
            z.disc.material.dispose();
            this._spawnedZones.splice(i, 1);
          }
          break;
        }
      }
    }
  }

  _clearZones() {
    for (const z of this._spawnedZones) {
      this.scene.remove(z.ring);
      this.scene.remove(z.disc);
      if (z.chainGroup) this.scene.remove(z.chainGroup);
      z.ring.geometry.dispose();
      z.ring.material.dispose();
      z.disc.geometry.dispose();
      z.disc.material.dispose();
    }
    this._spawnedZones = [];
  }

  _clearQuakeWave() {
    if (this._quakeWave) {
      this.scene.remove(this._quakeWave.ring);
      this._quakeWave.ring.geometry.dispose();
      this._quakeWave.ring.material.dispose();
      this._quakeWave = null;
    }
  }

  isAttacking() {
    return this.state === STATE.TELEGRAPH || this.state === STATE.ATTACK;
  }
}
