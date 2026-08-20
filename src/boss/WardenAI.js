import * as THREE from 'three';

/**
 * WardenAI —— 典狱长 Boss 状态机
 *
 * 状态：IDLE → CHOOSE_ATTACK → TELEGRAPH → ATTACK → RECOVER → PHASE_CHANGE → DEAD
 *
 * 技能：
 *   1. 锁链禁锢 — 玩家脚下红阵 → 延迟伤害+减速/禁锢
 *   2. 重型魔法弹 — 蓄力大弹丸
 *   3. 典狱震荡 — 武器砸地 → 扩散冲击波
 *   4. 死亡牢笼（Phase2 专属）— 多个红阵依次爆炸
 *
 * 技能选择规则：
 *   - 不连续3次同技能
 *   - 玩家远→优先魔法弹/锁链；玩家近→优先震荡
 *   - Phase2 增加死亡牢笼
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

export class WardenAI {
  constructor(boss, combat, scene, effects, explosion) {
    this.boss = boss;
    this.combat = combat;
    this.scene = scene;
    this.effects = effects;
    this.explosion = explosion;
    this.state = STATE.IDLE;
    this.timer = 2.0; // 初始空闲时间
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

    // 更新活动区域和冲击波
    this._updateZones(dt, player);
    this._updateQuakeWave(dt, player);

    // Phase2 魔法弹连发计时
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
        // 缓慢逼近玩家
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
        // 技能前摇准备
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

        // 持续更新预警位置（锁链跟踪玩家）
        this._updateTelegraph(this._currentSkill, player, dt);

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
        // 恢复期间缓慢移动
        if (dist > 10) {
          this._tmp.subVectors(player.position, b.position).setY(0).normalize();
          b.moveIntent.copy(this._tmp).multiplyScalar(0.3);
        }
        if (this.timer <= 0) {
          this.state = STATE.IDLE;
          this.timer = 0.8 + Math.random() * 0.8; // 0.8~1.6s 空闲
        }
        break;

      case STATE.PHASE_CHANGE:
        b.setCastGlow(0);
        // 不移动、不攻击，等待转场结束
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
    // 清理残留区域
    this._clearZones();
    this._clearQuakeWave();
    this._boltCount = 0;
  }

  _chooseSkill(dist) {
    const phase = this.phase;
    const available = [SKILLS.CHAIN, SKILLS.MAGIC_BOLT, SKILLS.QUAKE];
    if (phase === 2) available.push(SKILLS.DEATH_CAGE);

    // 过滤连续3次相同技能
    const last3 = this.attackHistory.slice(-3);
    const filtered = available.filter(s => {
      if (last3.length < 3) return true;
      return !(last3[0] === s && last3[1] === s && last3[2] === s);
    });

    // 根据距离加权
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

    // Phase2 时已有技能强化，降低基础技能权重
    if (phase === 2) {
      weights[SKILLS.DEATH_CAGE] = (weights[SKILLS.DEATH_CAGE] || 0) * 1.3;
    }

    // 加权随机
    let total = 0;
    for (const s of filtered) total += weights[s] || 1;
    let r = Math.random() * total;
    for (const s of filtered) {
      r -= (weights[s] || 1);
      if (r <= 0) return s;
    }
    return filtered[0];
  }

  _beginTelegraph(skill, player) {
    if (skill === SKILLS.CHAIN) {
      // 在玩家脚下生成红色锁链法阵
      this._spawnChainZone(player.position);
    } else if (skill === SKILLS.DEATH_CAGE) {
      // 在场地内生成多个危险区域
      const count = SKILLS[SKILLS.DEATH_CAGE].zoneCount;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + Math.random() * 0.5;
        const r = 4 + Math.random() * 8;
        this._spawnChainZone(new THREE.Vector3(
          Math.cos(a) * r, 0, Math.sin(a) * r
        ), true, i * 0.3);
      }
    }
  }

  _updateTelegraph(skill, player, dt) {
    // 锁链禁锢法阵跟随玩家（但锁定时有减速效果，所以不完全跟踪）
    if (skill === SKILLS.CHAIN && this._spawnedZones.length > 0) {
      const zone = this._spawnedZones[0];
      if (zone.type === 'chain' && !zone.locked) {
        // 50% 追踪
        zone.target.copy(player.position);
      }
    }
  }

  _spawnChainZone(pos, isDeathCage = false, delay = 0) {
    const radius = isDeathCage ? SKILLS[SKILLS.DEATH_CAGE].zoneRadius : SKILLS[SKILLS.CHAIN].radius;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius - 0.2, radius, 40),
      new THREE.MeshBasicMaterial({
        color: 0xff2a1a, transparent: true, opacity: 0,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pos.x, 0.06, pos.z);
    ring.visible = false;
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
    disc.visible = false;
    this.scene.add(disc);

    // 锁链视觉
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
      chain.visible = false;
      chainGroup.add(chain);
    }
    chainGroup.visible = false;
    this.scene.add(chainGroup);

    const zone = {
      type: 'chain',
      ring, disc, chainGroup,
      radius,
      target: pos.clone(),
      pos: pos.clone(),
      t: 0,
      warnTime: SKILLS[SKILLS.CHAIN].telegraph,
      delay,
      damage: isDeathCage ? SKILLS[SKILLS.DEATH_CAGE].damage : SKILLS[SKILLS.CHAIN].damage,
      slowMult: isDeathCage ? 0 : SKILLS[SKILLS.CHAIN].slowMult,
      slowDur: SKILLS[SKILLS.CHAIN].slowDur,
      active: false,
      triggered: false,
      isDeathCage,
    };
    this._spawnedZones.push(zone);
  }

  _executeAttack(skill, player, arena) {
    const cfg = SKILLS[skill];

    if (skill === SKILLS.CHAIN) {
      // 锁链升起并触发伤害
      for (const zone of this._spawnedZones) {
        if (zone.type === 'chain' && !zone.triggered) {
          zone.triggered = true;
          zone.active = true;
        }
      }
    } else if (skill === SKILLS.MAGIC_BOLT) {
      // 发射魔法弹
      this._fireBolt(player);
      // Phase2 连发
      if (this.phase === 2) {
        this._boltCount = 1;
        this._boltTimer = 0.35;
      }
    } else if (skill === SKILLS.QUAKE) {
      // 砸地冲击波
      this._spawnQuakeWave(arena);
    } else if (skill === SKILLS.DEATH_CAGE) {
      // 死亡牢笼：依次触发各区域
      for (const zone of this._spawnedZones) {
        if (zone.type === 'chain' && !zone.triggered) {
          zone.triggered = true;
          zone.active = true;
        }
      }
    }
  }

  _fireBolt(player) {
    const cfg = SKILLS[SKILLS.MAGIC_BOLT];
    this.boss.getCastOrigin(this._tmp);
    this._aim.copy(player.headPosition).sub(this._tmp).normalize();
    // 轻微瞄准误差
    this._aim.x += (Math.random() - 0.5) * 0.15;
    this._aim.y += (Math.random() - 0.5) * 0.08;
    this._aim.z += (Math.random() - 0.5) * 0.15;
    this._aim.normalize();

    // 使用 combat._spawn 绕过冷却
    const p = this.combat._spawn(this.boss, this._aim, {
      speed: cfg.projectileSpeed,
      damage: cfg.damage,
      tint: cfg.projectileTint,
      scale: cfg.projectileScale,
      power: 1.5,
    });
    return p !== null;
  }

  _spawnQuakeWave(arena) {
    // 冲击波：从 Boss 位置向外扩散
    const wave = {
      center: this.boss.position.clone(),
      radius: 0,
      maxRadius: this.phase === 2 ? SKILLS[SKILLS.QUAKE].waveRadius * 1.3 : SKILLS[SKILLS.QUAKE].waveRadius,
      speed: SKILLS[SKILLS.QUAKE].waveSpeed,
      damage: SKILLS[SKILLS.QUAKE].damage,
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
    ring.visible = true;
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

    // 命中检测：玩家在环上
    if (!w.hit) {
      const d = Math.hypot(player.position.x - w.center.x, player.position.z - w.center.z);
      if (d > w.radius - 1.5 && d < w.radius + 1.5) {
        player.takeDamage(w.damage);
        w.hit = true;
        this.effects.burst(player.headPosition, 0xff3a20, 14);
      }
    }

    if (w.radius >= w.maxRadius) {
      this.scene.remove(w.ring);
      w.ring.geometry.dispose();
      w.ring.material.dispose();
      this._quakeWave = null;
    }
  }

  _updateZones(dt, player) {
    for (let i = this._spawnedZones.length - 1; i >= 0; i--) {
      const z = this._spawnedZones[i];
      if (z.delay > 0) {
        z.delay -= dt;
        continue;
      }

      z.t += dt;

      if (!z.active) continue;

      const p = Math.min(1, z.t / z.warnTime);

      // 预警动画
      if (p < 1) {
        z.ring.visible = true;
        z.disc.visible = true;
        const blink = 0.55 + Math.sin(z.t * (6 + p * 14)) * 0.35;
        z.ring.material.opacity = blink;
        z.disc.material.opacity = 0.1 + p * 0.32;
        z.disc.scale.setScalar(Math.max(0.05, p));
        // 锁链逐渐升起
        if (p > 0.5 && z.chainGroup) {
          z.chainGroup.visible = true;
          const chainH = (p - 0.5) * 2;
          for (const chain of z.chainGroup.children) {
            chain.scale.y = chainH;
          }
        }
        // 跟踪玩家（锁链禁锢）
        if (z.type === 'chain' && !z.triggered && !z.isDeathCage) {
          // 不跟踪，锁在触发位置
        }
      } else if (!z.triggered) {
        // 爆炸
        z.triggered = true;
        const center = new THREE.Vector3(z.pos.x, 0.6, z.pos.z);
        if (z.isDeathCage) {
          this.explosion.playMagicExplosion(center, 1.0);
        } else {
          this.effects.burst(center, 0xff2a1a, 14);
        }
        // 伤害检测
        const d = Math.hypot(player.position.x - z.pos.x, player.position.z - z.pos.z);
        if (d < z.radius && !player.isInvincible) {
          player.takeDamage(z.damage);
          if (z.slowMult > 0 && player.applySlow) {
            player.applySlow(z.slowMult, z.slowDur);
          }
          this.effects.burst(player.headPosition, 0xff2a1a, 10);
        }
        // 锁链收回
        if (z.chainGroup) z.chainGroup.visible = false;
        z.ring.visible = false;
        z.disc.visible = false;
      }

      // 清理已触发且超过时间的区域
      if (z.triggered && z.t > z.warnTime + 0.5) {
        this.scene.remove(z.ring);
        this.scene.remove(z.disc);
        if (z.chainGroup) this.scene.remove(z.chainGroup);
        z.ring.geometry.dispose();
        z.ring.material.dispose();
        z.disc.geometry.dispose();
        z.disc.material.dispose();
        this._spawnedZones.splice(i, 1);
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
