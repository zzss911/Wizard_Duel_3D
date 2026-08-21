import * as THREE from 'three';
import { WardenBoss } from './WardenBoss.js';
import { WardenAI } from './WardenAI.js';

/**
 * BossBattleController —— Boss 战控制器
 *
 * 管理内部状态机：
 *   INTRO → PHASE1 → PHASE_CHANGE → PHASE2 → BOSS_DEAD / PLAYER_DEAD → RESULT
 *
 * Game 只需调用：
 *   start(player, arena) — 开始 Boss 战
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

    // 临时光源（Boss 模式暗色环境）
    this._bossLight = null;
    this._introCamera = null;
  }

  start(player, arena) {
    this.player = player;
    this.arena = arena;

    // 创建 Boss
    if (!this.boss) {
      this.boss = new WardenBoss(this.scene);
    }
    this.boss.reset();
    this.boss.hide();

    if (!this.ai) {
      this.ai = new WardenAI(this.boss, this.combat, this.scene, this.effects, this.explosion);
      this.ai.audio = this.audio;
      this.ai.hud = this.hud;
      this.ai.onShake = (power) => this.onShake?.(power);
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

  _showLoadingText() {
    const el = document.getElementById('boss-loading-text');
    if (el) el.style.display = 'block';
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
    // 0~1.0s: 画面变暗 + 镜头看向 Boss 位置
    // 1.0~2.0s: 地面红色法阵亮起
    // 2.0~3.0s: 黑雾出现 + Boss 出现
    // 3.0~3.5s: Boss 砸地 + 镜头震动
    // 3.5~4.5s: 显示名字 + 血条出现
    // 4.5s: FIGHT!

    if (t >= 2.0 && !this.boss.group.visible) {
      this.boss.show();
      this.boss.fog.visible = true;
    }

    if (t >= 3.0 && t < 3.1) {
      // Boss 砸地
      this.boss.setCastGlow(1);
      this.explosion.playMagicExplosion(
        new THREE.Vector3(this.boss.position.x, 0.5, this.boss.position.z),
        1.5
      );
      this.audio.playExplosion(1.5, 10);
    }

    if (t >= 3.5 && t < 3.6) {
      this.boss.setCastGlow(0);
    }

    if (t >= 3.5 && !this._showedName) {
      this._showedName = true;
      this.bossHealthBar.show('典狱长', 'THE WARDEN', 'PHASE I');
    }

    if (t >= 4.5 && !this._fightStarted) {
      this._fightStarted = true;
      this.hud.showBanner('FIGHT!', 1.2);
      this.state = BOSS_STATE.PHASE1;
      this.timer = 0;
      this.startTime = performance.now();
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
      return;
    }

    // 更新 Boss AI
    this.ai.update(dt, player, arena);

    // 更新血条
    this.bossHealthBar.updateHP(this.boss.hp, this.boss.maxHp);
  }

  _updatePhaseChange(dt, player, arena) {
    // 2.5s 转场
    if (this.timer >= 2.5) {
      this.ai.setPhase2();
      this.state = BOSS_STATE.PHASE2;
      this.timer = 0;
      this.bossHealthBar.setPhase('PHASE II');
      this.hud.showBanner('封锁解除', 1.5);
    }
    // Boss 不攻击但仍然面向玩家
    this.boss.faceTowards(player.position, dt);
  }

  _showPhaseChangeEffect() {
    // Initial red flash on phase change start (mid-point burst handled by WardenAI)
    this.explosion.playMagicExplosion(
      this.boss.headPosition,
      1.5
    );
    this.audio.playExplosion(1.5, 8);
    this.hud.screenFlash();
    if (this.onShake) this.onShake(1.0);
  }

  _onBossDeath() {
    this.state = BOSS_STATE.BOSS_DEAD;
    this.endTime = performance.now();
    this.timer = 0;
    // 清空弹道
    for (const p of this.combat.pool) p.despawn();
  }

  _updateBossDeath(dt, player, arena) {
    // 3~4s 死亡序列
    const t = this.timer;

    // 1.0s: 大爆炸
    if (t > 1.0 && !this._deathExploded) {
      this._deathExploded = true;
      this.explosion.playMagicExplosion(this.boss.headPosition, 2.5);
      this.audio.playExplosion(2.5, 6);
      this.hud.screenFlash();
    }

    // 2.0s: 第二波爆炸
    if (t > 2.0 && !this._deathExploded2) {
      this._deathExploded2 = true;
      this.explosion.playMagicExplosion(
        new THREE.Vector3(this.boss.position.x, 1.0, this.boss.position.z),
        2.0
      );
      this.audio.playExplosion(2.0, 5);
    }

    // 3.5s: 显示结算
    if (t > 3.5 && !this._resultShown) {
      this._resultShown = true;
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
      bossName: '典狱长',
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
    this._fightStarted = false;
    this._deathExploded = false;
    this._deathExploded2 = false;
    this._resultShown = false;
    this.phase2Triggered = false;
    this._hideLoadingText();
    this.bossResultPanel.hide();
    this._restoreArena();
    if (this._bossLight) {
      this.scene.remove(this._bossLight);
      this._bossLight = null;
    }
    if (this.boss) this.boss.hide();
  }

  _darkenArena() {
    // 保存原始环境颜色，切换到暗红
    this._origBg = this.scene.background.clone();
    this._origFogColor = this.scene.fog.color.clone();
    this._origFogNear = this.scene.fog.near;
    this._origFogFar = this.scene.fog.far;

    this.scene.background.setHex(0x0a0608);
    this.scene.fog.color.setHex(0x0a0608);
    this.scene.fog.near = 22;
    this.scene.fog.far = 70;

    // Boss 红色光源
    this._bossLight = new THREE.PointLight(0xff2010, 25, 30, 2);
    this._bossLight.position.set(0, 6, -8);
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
    if (this.ai) this.ai._clearZones();
    if (this.ai) this.ai._clearQuakeWave();
    if (this.boss) {
      this.scene.remove(this.boss.group);
      this.scene.remove(this.boss.fog);
      this.scene.remove(this.boss.groundRune);
      this.boss = null;
    }
    this.ai = null;
  }
}

export { BOSS_STATE };
