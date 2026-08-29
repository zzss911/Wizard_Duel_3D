import * as THREE from 'three';
import { BossRegistry } from './BossRegistry.js';
import { BossCinematicUI } from '../ui/BossCinematicUI.js';
import { BossCameraDirector, CINEMATIC } from './BossCameraDirector.js';

/**
 * BossBattleController —— Boss 战控制器
 *
 * 管理内部状态机：
 *   INTRO → PHASE1 → PHASE_CHANGE → PHASE2 → BOSS_DEAD / PLAYER_DEAD → RESULT
 *
 * Game 只需调用：
 *   start(player, arena, bossId) — 开始 Boss 战
 *   update(dt, player, arena) — 每帧更新
 *   destroy() — 清理
 */

const BOSS_STATE = {
  LOADING: 'loading',
  INTRO: 'intro',
  PHASE1: 'phase1',
  PHASE_CHANGE: 'phase_change',
  PHASE2: 'phase2',
  BOSS_DEAD: 'boss_dead',
  PLAYER_DEAD: 'player_dead',
  RESULT: 'result',
};

export class BossBattleController {
  constructor(scene, combat, effects, explosion, audio, hud, bossHealthBar, bossResultPanel) {
    this.scene = scene;
    this.combat = combat;
    this.effects = effects;
    this.explosion = explosion;
    this.audio = audio;
    this.hud = hud;
    this.bossHealthBar = bossHealthBar;
    this.bossResultPanel = bossResultPanel;

    this.boss = null;
    this.ai = null;
    this.state = BOSS_STATE.INTRO;
    this.timer = 0;
    this.startTime = 0;
    this.endTime = 0;
    this.phase2Triggered = false;
    this.onComplete = null; // (win) => void
    this.onExit = null; // () => void
    this.onShake = null; // (power) => void — camera shake callback

    this.bossId = 'warden';
    this._registryEntry = null;
    this._cinematicConfig = null;

    // Cinematic systems
    this.cinematicUI = new BossCinematicUI();
    this.cameraDirector = new BossCameraDirector();

    // 临时光源（Boss 模式暗色环境）
    this._bossLight = null;
    this._introCamera = null;
  }

  start(player, arena, bossId = 'warden') {
    this.player = player;
    this.arena = arena;
    this.bossId = bossId;

    // 从 Registry 获取配置
    this._registryEntry = BossRegistry.get(bossId);
    if (!this._registryEntry) {
      console.warn(`[BossBattleController] Unknown bossId "${bossId}", falling back to warden`);
      this._registryEntry = BossRegistry.get('warden');
      this.bossId = 'warden';
    }
    this._cinematicConfig = this._registryEntry.cinematicConfig;

    // 设置 Cinematic UI 的技能名称映射
    this.cinematicUI.setSkillNames(
      this._cinematicConfig.skillNames,
      this._cinematicConfig.dangerousSkills
    );

    // 创建 Boss
    if (!this.boss) {
      this.boss = BossRegistry.createBoss(this.bossId, this.scene);
    }
    this.boss.reset();
    this.boss.hide();

    if (!this.ai) {
      this.ai = BossRegistry.createAI(this.bossId, this.boss, this.combat, this.scene, this.effects, this.explosion);
      this.ai.audio = this.audio;
      this.ai.hud = this.hud;
      this.ai.onShake = (power) => this.onShake?.(power);
      this.ai.onSkillTelegraph = (skillId) => this._onSkillTelegraph(skillId);
    }
    this.ai.reset();

    // 设置 Boss 死亡回调
    this.boss.onDeath = () => this._onBossDeath();

    // 暗化环境
    this._darkenArena();

    // 隐藏普通敌人/训练靶
    // (Game 层面负责隐藏 enemy/target)

    // 检查模型是否已加载
    if (this.boss.isModelReady) {
      this._beginIntro();
    } else {
      // 等待模型加载
      this.state = BOSS_STATE.LOADING;
      this.timer = 0;
      this._showLoadingText();
    }
  }

  /** Set camera reference for cinematic sequences */
  setCamera(camera) {
    this._camera = camera;
  }

  _showLoadingText() {
    const el = document.getElementById('boss-loading-text');
    if (el) {
      el.style.display = 'block';
      el.textContent = this._cinematicConfig.loadingText;
    }
  }

  _hideLoadingText() {
    const el = document.getElementById('boss-loading-text');
    if (el) el.style.display = 'none';
  }

  _beginIntro() {
    this._hideLoadingText();
    this.state = BOSS_STATE.INTRO;
    this.timer = 0;
    this.phase2Triggered = false;
    this.bossHealthBar.hide();
    this.boss.showIntroRune();
    this.boss.setInvulnerable(5.0);
    this.player.reset();

    // Start cinematic camera
    if (this._camera) {
      this.cameraDirector.startCinematic(this._camera, CINEMATIC.INTRO, {
        bossPos: this.boss.position.clone(),
        playerPos: this.player.position.clone(),
        duration: this._cinematicConfig.introDuration,
      });
    }
    this._introPhase = 0;
  }

  update(dt, player, arena) {
    this.timer += dt;

    switch (this.state) {
      case BOSS_STATE.LOADING:
        this._updateLoading(dt, player, arena);
        break;

      case BOSS_STATE.INTRO:
        this._updateIntro(dt, player, arena);
        break;

      case BOSS_STATE.PHASE1:
        this._updateBattle(dt, player, arena);
        break;

      case BOSS_STATE.PHASE_CHANGE:
        this._updatePhaseChange(dt, player, arena);
        break;

      case BOSS_STATE.PHASE2:
        this._updateBattle(dt, player, arena);
        break;

      case BOSS_STATE.BOSS_DEAD:
        this._updateBossDeath(dt, player, arena);
        break;

      case BOSS_STATE.PLAYER_DEAD:
        // 等待结算
        break;

      case BOSS_STATE.RESULT:
        break;
    }

    // Boss 始终更新（死亡动画也要播放）
    this.boss.update(dt, arena.radius);
  }

  _updateLoading(dt, player, arena) {
    if (this.boss.isModelReady) {
      this._beginIntro();
    }
  }

  _updateIntro(dt, player, arena) {
    const t = this.timer;
    const cfg = this._cinematicConfig;

    // Phase 1 (0~0.8s): Dark, rune lights up, black-red fog gathers
    if (t < 0.8) {
      const tp = t / 0.8;
      // Rune gradually brightens
      if (this.boss.groundRuneMat) {
        this.boss.groundRuneMat.opacity = tp * 0.6;
      }
    }

    // Phase 2 (0.8~1.8s): Boss appears from fog
    if (t >= 0.8 && t < 1.8) {
      const tp = (t - 0.8) / 1.0;
      if (!this.boss.group.visible) {
        this.boss.show();
        this.boss.fog.visible = true;
        // Start with scale 0 for reveal effect
        this.boss.visualRoot.scale.setScalar(0.01);
      }
      // Scale up with ease
      const ease = tp < 0.5 ? 2 * tp * tp : -1 + (4 - 2 * tp) * tp;
      this.boss.visualRoot.scale.setScalar(Math.max(0.01, ease));
      // Rune full bright
      if (this.boss.groundRuneMat) {
        this.boss.groundRuneMat.opacity = 0.6 + tp * 0.4;
      }
    }

    // Phase 3 (1.8~2.6s): Boss eyes/chest light up, slight shake
    if (t >= 1.8 && t < 2.6) {
      const tp = (t - 1.8) / 0.8;
      this.boss.visualRoot.scale.setScalar(1);
      // Increase cast glow for eye/chest activation
      this.boss.setCastGlow(tp * 0.5);
      // First small shake at 1.8s
      if (t >= 1.8 && t < 1.85 && !this._introShake1) {
        this._introShake1 = true;
        if (this.onShake) this.onShake(0.4);
        this.audio.playExplosion(0.5, 12);
      }
    }

    // Phase 4 (2.6~3.6s): Boss slams, title appears
    if (t >= 2.6 && !this._introSlam) {
      this._introSlam = true;
      this.boss.setCastGlow(1);
      this.explosion.playMagicExplosion(
        new THREE.Vector3(this.boss.position.x, 0.5, this.boss.position.z),
        1.5
      );
      this.audio.playExplosion(1.5, 10);
      if (this.onShake) this.onShake(0.8);
    }

    if (t >= 2.8 && t < 2.9) {
      this.boss.setCastGlow(0.3);
    }

    // Show boss title at 2.8s
    if (t >= 2.8 && !this._showedTitle) {
      this._showedTitle = true;
      this.cinematicUI.showBossTitle(cfg.titleZh, cfg.titleEn, cfg.titleSub);
    }

    // Phase 5 (3.6~4.5s): Health bar appears, FIGHT flash
    if (t >= 3.6 && !this._showedName) {
      this._showedName = true;
      this.bossHealthBar.show(this._registryEntry.name, this._registryEntry.subtitle, 'PHASE I');
    }

    if (t >= 4.0 && !this._fightStarted) {
      this._fightStarted = true;
      this.cinematicUI.showFight();
    }

    if (t >= cfg.introDuration) {
      this.state = BOSS_STATE.PHASE1;
      this.timer = 0;
      this.startTime = performance.now();
      this.cameraDirector.cancel();
    }
  }

  _updateBattle(dt, player, arena) {
    // 检查玩家死亡
    if (player.dead && this.state !== BOSS_STATE.PLAYER_DEAD) {
      this.state = BOSS_STATE.PLAYER_DEAD;
      this.endTime = performance.now();
      this.timer = 0;
      this._showResult(false);
      return;
    }

    // 检查 Boss 死亡
    if (this.boss.dead) {
      // _onBossDeath 已经处理状态切换
      return;
    }

    // 检查 Phase2 触发
    if (!this.phase2Triggered && this.boss.hp <= this.boss.maxHp * 0.5) {
      this.phase2Triggered = true;
      this.state = BOSS_STATE.PHASE_CHANGE;
      this.timer = 0;
      this.ai.triggerPhaseChange();
      this._showPhaseChangeEffect();
      this.audio.setBossPhase(2);
      return;
    }

    // 更新 Boss AI
    this.ai.update(dt, player, arena);

    // 更新血条
    this.bossHealthBar.updateHP(this.boss.hp, this.boss.maxHp);
  }

  /** Called when AI enters TELEGRAPH for a skill */
  _onSkillTelegraph(skillId) {
    const isDangerous = (this._cinematicConfig.dangerousSkills || []).includes(skillId);
    this.cinematicUI.showSkillName(skillId, isDangerous);
  }

  _updatePhaseChange(dt, player, arena) {
    const cfg = this._cinematicConfig;
    const t = this.timer;

    // Phase II text at 0.5s
    if (t >= 0.5 && !this._phase2TextShown) {
      this._phase2TextShown = true;
      this.cinematicUI.showPhase2(cfg.phase2Zh, cfg.phase2En);
    }

    if (this.timer >= cfg.phaseChangeDuration) {
      this.ai.setPhase2();
      this.state = BOSS_STATE.PHASE2;
      this.timer = 0;
      this.bossHealthBar.setPhase('PHASE II');
      this.cameraDirector.cancel();
    }
    // Boss 不攻击但仍然面向玩家
    this.boss.faceTowards(player.position, dt);
  }

  _showPhaseChangeEffect() {
    const cfg = this._cinematicConfig;
    // Start cinematic camera for phase change
    if (this._camera) {
      this.cameraDirector.startCinematic(this._camera, CINEMATIC.PHASE_CHANGE, {
        bossPos: this.boss.position.clone(),
        playerPos: this.player.position.clone(),
        duration: cfg.phaseChangeDuration,
      });
    }

    // Initial flash on phase change start
    this.explosion.playMagicExplosion(
      this.boss.headPosition,
      1.5
    );
    this.audio.playExplosion(1.5, 8);
    this.hud.screenFlash();
    if (this.onShake) this.onShake(1.0);
  }

  _onBossDeath() {
    const cfg = this._cinematicConfig;
    this.state = BOSS_STATE.BOSS_DEAD;
    this.endTime = performance.now();
    this.timer = 0;
    // 清空弹道
    for (const p of this.combat.pool) p.despawn();
    // BGM 衰减
    this.audio.fadeOutMusic(2.0);

    // Start death cinematic camera
    if (this._camera) {
      this.cameraDirector.startCinematic(this._camera, CINEMATIC.DEATH, {
        bossPos: this.boss.position.clone(),
        playerPos: this.player.position.clone(),
        duration: cfg.deathDuration,
      });
    }
  }

  _updateBossDeath(dt, player, arena) {
    const cfg = this._cinematicConfig;
    // 3.5s 死亡序列
    const t = this.timer;

    // 0.0~0.5s: Death animation starts, eye flicker, chest unstable
    // (handled by boss.update death logic)

    // 0.5s: First small explosion
    if (t > 0.5 && !this._deathExploded1) {
      this._deathExploded1 = true;
      this.explosion.playMagicExplosion(this.boss.headPosition, 1.0);
      this.audio.playExplosion(1.0, 8);
      if (this.onShake) this.onShake(0.5);
    }

    // 1.0s: Larger explosion
    if (t > 1.0 && !this._deathExploded) {
      this._deathExploded = true;
      this.explosion.playMagicExplosion(this.boss.headPosition, 2.0);
      this.audio.playExplosion(2.0, 6);
      this.hud.screenFlash();
      if (this.onShake) this.onShake(0.8);
    }

    // 1.5s: Chest/core destabilizes - another explosion
    if (t > 1.5 && !this._deathExploded1b) {
      this._deathExploded1b = true;
      this.explosion.playMagicExplosion(
        new THREE.Vector3(this.boss.position.x, 1.5, this.boss.position.z),
        1.5
      );
      this.audio.playExplosion(1.5, 7);
    }

    // 2.0s: Second wave explosion
    if (t > 2.0 && !this._deathExploded2) {
      this._deathExploded2 = true;
      this.explosion.playMagicExplosion(
        new THREE.Vector3(this.boss.position.x, 1.0, this.boss.position.z),
        2.5
      );
      this.audio.playExplosion(2.5, 5);
      this.hud.screenFlash();
      if (this.onShake) this.onShake(1.0);
    }

    // 2.5s: Final big explosion + camera shake
    if (t > 2.5 && !this._deathFinalBoom) {
      this._deathFinalBoom = true;
      this.explosion.playMagicExplosion(
        new THREE.Vector3(this.boss.position.x, 1.2, this.boss.position.z),
        3.0
      );
      this.audio.playExplosion(3.0, 4);
      this.hud.screenFlash();
      if (this.onShake) this.onShake(1.2);
    }

    // 3.0s: Show BOSS DEFEATED cinematic text
    if (t > 3.0 && !this._defeatedTextShown) {
      this._defeatedTextShown = true;
      this.cinematicUI.showBossDefeated(cfg.defeatedZh, cfg.defeatedName);
    }

    // 4.0s: Show result panel (after cinematic text fades)
    if (t > cfg.deathDuration && !this._resultShown) {
      this._resultShown = true;
      this.cameraDirector.cancel();
      this._showResult(true);
    }
  }

  _showResult(win) {
    this.state = BOSS_STATE.RESULT;
    const elapsed = (this.endTime - this.startTime) / 1000;
    const hpPercent = win ? (this.player.hp / this.player.maxHp) * 100 : 0;
    const rank = this._calculateRank(elapsed, hpPercent, win);

    this.bossHealthBar.hide();

    // 释放鼠标锁定，让玩家可以点击结算按钮
    if (document.pointerLockElement) {
      document.exitPointerLock?.();
    }

    this.bossResultPanel.show({
      win,
      bossName: this._registryEntry.name,
      time: elapsed,
      hpPercent,
      rank,
      onRetry: () => { this._reset(); this.onComplete && this.onComplete('retry'); },
      onBossSelect: () => { this._reset(); this.onComplete && this.onComplete('select'); },
      onMainMenu: () => { this._reset(); this.onComplete && this.onComplete('menu'); },
    });
  }

  _calculateRank(time, hp, win) {
    if (!win) return 'C';
    // S: < 60s 且 HP > 80%
    // A: < 90s 且 HP > 50%
    // B: < 120s 且 HP > 25%
    // C: 其他
    if (time < 60 && hp > 80) return 'S';
    if (time < 90 && hp > 50) return 'A';
    if (time < 120 && hp > 25) return 'B';
    return 'C';
  }

  _reset() {
    this._showedName = false;
    this._showedTitle = false;
    this._fightStarted = false;
    this._introShake1 = false;
    this._introSlam = false;
    this._introPhase = 0;
    this._deathExploded = false;
    this._deathExploded1 = false;
    this._deathExploded1b = false;
    this._deathExploded2 = false;
    this._deathFinalBoom = false;
    this._defeatedTextShown = false;
    this._resultShown = false;
    this._phase2TextShown = false;
    this.phase2Triggered = false;
    this._hideLoadingText();
    this.cinematicUI.clear();
    this.cameraDirector.cancel();
    this.bossResultPanel.hide();
    this._restoreArena();
    if (this._bossLight) {
      this.scene.remove(this._bossLight);
      this._bossLight = null;
    }
    if (this.boss) this.boss.hide();
  }

  _darkenArena() {
    const colors = this._cinematicConfig.arenaColor;

    // 保存原始环境颜色，切换到暗色
    this._origBg = this.scene.background.clone();
    this._origFogColor = this.scene.fog.color.clone();
    this._origFogNear = this.scene.fog.near;
    this._origFogFar = this.scene.fog.far;

    this.scene.background.setHex(colors.bg);
    this.scene.fog.color.setHex(colors.fog);
    this.scene.fog.near = colors.fogNear;
    this.scene.fog.far = colors.fogFar;

    // Boss 主题色光源
    this._bossLight = new THREE.PointLight(colors.light, 25, 30, 2);
    this._bossLight.position.set(colors.lightPos[0], colors.lightPos[1], colors.lightPos[2]);
    this.scene.add(this._bossLight);
  }

  _restoreArena() {
    if (this._origBg) this.scene.background.copy(this._origBg);
    if (this._origFogColor) this.scene.fog.color.copy(this._origFogColor);
    if (this._origFogNear) this.scene.fog.near = this._origFogNear;
    if (this._origFogFar) this.scene.fog.far = this._origFogFar;
  }

  getCombatants() {
    return [this.player, this.boss];
  }

  /** 只有 PHASE1 / PHASE2 允许玩家操作 */
  canPlayerAct() {
    return this.state === BOSS_STATE.PHASE1 || this.state === BOSS_STATE.PHASE2;
  }

  /** LOADING / INTRO / PHASE_CHANGE / BOSS_DEAD / PLAYER_DEAD / RESULT → false */

  destroy() {
    this._reset();
    if (this.ai) {
      if (this.ai._clearZones) this.ai._clearZones();
      if (this.ai._clearQuakeWave) this.ai._clearQuakeWave();
    }
    if (this.boss) {
      this.scene.remove(this.boss.group);
      if (this.boss.fog) this.scene.remove(this.boss.fog);
      if (this.boss.groundRune) this.scene.remove(this.boss.groundRune);
      this.boss = null;
    }
    this.ai = null;
    this.cinematicUI.destroy();
    this.cameraDirector.cancel();
  }
}

export { BOSS_STATE };
