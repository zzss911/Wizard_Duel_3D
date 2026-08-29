import * as THREE from 'three';
import { EffectComposer } from '../../vendor/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../../vendor/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../../vendor/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../../vendor/addons/postprocessing/OutputPass.js';
import { Arena } from '../scene/Arena.js';
import { ArenaProps } from '../scene/ArenaProps.js';
import { TrapSystem } from '../scene/TrapSystem.js';
import { Input } from './Input.js';
import { Player } from '../entities/Player.js';
import { Target } from '../entities/Target.js';
import { Enemy } from '../entities/Enemy.js';
import { EnemyAI } from '../ai/EnemyAI.js';
import { CombatSystem } from '../combat/CombatSystem.js';
import { Effects } from '../fx/Effects.js';
import { TargetImpactExplosion } from '../fx/TargetImpactExplosion.js';
import { MagicAudio } from '../fx/MagicAudio.js';
import { CameraShake } from '../systems/CameraShake.js';
import { HUD } from '../ui/HUD.js';
import { MainMenu } from '../ui/MainMenu.js';
import { SettingsPanel } from '../ui/SettingsPanel.js';
import { BossSelectPanel } from '../ui/BossSelectPanel.js';
import { BossHealthBar } from '../ui/BossHealthBar.js';
import { BossResultPanel } from '../ui/BossResultPanel.js';
import { BossBattleController } from '../boss/BossBattleController.js';

const GAME_PHASE = {
  MAIN_MENU: 'main_menu',
  READY: 'ready',
  TUTORIAL: 'tutorial',
  COUNTDOWN: 'countdown',
  GRACE: 'grace',
  PLAYING: 'playing',
  GAMEOVER: 'gameover',
  BOSS_SELECT: 'boss_select',
  BOSS_BATTLE: 'boss_battle',
};

export class Game {
  constructor(container) {
    // ---------- 渲染器 ----------
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    // ---------- 场景 ----------
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0e1a);
    this.scene.fog = new THREE.Fog(0x0a0e1a, 30, 90);

    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);

    // ---------- 模块 ----------
    this.arena = new Arena(this.scene);
    this.props = new ArenaProps(this.scene, this.arena);
    this.input = new Input(this.renderer.domElement);
    this.player = new Player(this.scene);
    this.target = new Target(this.scene);
    this.effects = new Effects(this.scene);
    this.explosion = new TargetImpactExplosion(this.scene);
    this.combat = new CombatSystem(this.scene, this.effects, this.explosion);
    this.enemy = new Enemy(this.scene);
    this.enemyAI = new EnemyAI(this.enemy, this.combat);
    this.hud = new HUD();
    this.mainMenu = new MainMenu();
    this.settingsPanel = new SettingsPanel();
    this.bossSelectPanel = new BossSelectPanel();
    this.bossHealthBar = new BossHealthBar();
    this.bossResultPanel = new BossResultPanel();
    this.audio = new MagicAudio();
    this.isMobile = this.input.isTouch;
    this.gameOver = false;
    this.combatants = [this.player, this.target, this.enemy];
    this.bossController = null;
    this.selectedBossId = null;

    // 防回归：确保 Target 类携带身份标识
    console.assert(this.target.isTarget === true, 'Target.isTarget must be true');

    // ---------- 游戏阶段 ----------
    this.phase = GAME_PHASE.MAIN_MENU;
    this.countdownTimer = 0;
    this.graceTimer = 0;
    this.difficulty = 'rookie';
    this.winStreak = 0;

    // ---------- 新手训练 ----------
    this.tutorialStep = 0;
    this.tutorialHits = 0;
    this.tutorialMoved = false;
    this.tutorialLooked = false;
    this.tutorialDodged = false;
    this._prevLookDx = 0;
    this._prevLookDy = 0;

    // ---------- 后处理：Bloom（仅桌面端） ----------
    this.composer = null;
    if (!this.isMobile) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        0.55, 0.45, 0.78
      );
      this.composer.addPass(this.bloomPass);
      this.composer.addPass(new OutputPass());
    }

    // 首次用户交互后解锁 AudioContext
    const unlockAudio = () => {
      this.audio.unlock();
      // 首次解锁后，如果仍在主菜单/选择页，开始播放菜单氛围
      if (this.phase === GAME_PHASE.MAIN_MENU || this.phase === GAME_PHASE.BOSS_SELECT) {
        this.audio.playMenuAmbience();
      }
    };
    window.addEventListener('pointerdown', unlockAudio, { once: true });
    window.addEventListener('touchstart', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });

    // 命中回调
    this.combat.onDamage = (worldPos, amount, target, skillType) => {
      this.hud.spawnDamageNumber(worldPos, amount, this.camera, skillType);
      // 普攻命中敌人时微震（不叠加 explosion 的强震）
      if (skillType === 'basic' && !target?.isPlayer && !target?.isTarget) {
        this.addShake(0.15);
      }
      if (
        this.phase === GAME_PHASE.TUTORIAL &&
        this.tutorialStep === 2 &&
        target?.isTarget
      ) {
        this.tutorialHits++;
        if (this.tutorialHits >= 3) {
          this.tutorialStep++;
          this._advanceTutorial();
        }
      }
    };
    this.combat.onImpact = (worldPos, power, target, skillType) => {
      this.addShake(power);
      this.hud.screenFlash();
      const flashColor = skillType === 'q' ? 0xffa03c : 0xffd76a;
      this.effects.impactFlash(worldPos, flashColor, 2.5 + power);
      this.audio.playExplosion(power, this.camera.position.distanceTo(worldPos));
    };
    this.combat.onPlayerHit = () => {
      this.hud.playerHitFlash();
      this.addShake(0.45);
      this.audio.playHit();
      if (this.player.dead && !this.gameOver && this.phase !== GAME_PHASE.BOSS_BATTLE) this.endGame(false);
    };
    this.enemy.onDeath = () => {
      this.explosion.playMagicExplosion(this.enemy.headPosition, 1.5);
      this.addShake(1.2);
      this.audio.playExplosion(1.5, this.camera.position.distanceTo(this.enemy.position));
      if (!this.gameOver) this.endGame(true);
    };
    this.target.onDeath = () => this.hud.showBanner('目标已击败！', 1.6);

    // ---------- 陷阱系统 ----------
    this.traps = new TrapSystem(this.scene, this.explosion, (center, radius, damage) => {
      for (const c of this.combatants) {
        if (c.dead) continue;
        const d = Math.hypot(c.position.x - center.x, c.position.z - center.z);
        if (d > radius) continue;
        c.takeDamage(damage);
        this._aimDir.set(c.position.x - center.x, 0, c.position.z - center.z).normalize();
        if (c.applyImpact) c.applyImpact(this._aimDir, 1.2);
        if (c.isPlayer) {
          this.hud.playerHitFlash();
          this.addShake(1.0);
          this.audio.playHit();
          if (this.player.dead && !this.gameOver) this.endGame(false);
        }
      }
      this.audio.playExplosion(0.9, this.camera.position.distanceTo(center));
    });

    // R 键重开
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyR' && this.phase === GAME_PHASE.GAMEOVER) this.restart();
    });

    // ---------- 摄像机状态 ----------
    this.cameraYaw = 0;
    this.cameraPitch = 0.34;
    this.cameraDist = 7;
    this.camPos = new THREE.Vector3();

    // ---------- 镜头震动 ----------
    this.shake = new CameraShake();
    this._shakeOffset = new THREE.Vector3();

    // ---------- 循环 ----------
    this.clock = new THREE.Clock();
    this.paused = false;
    this._aimDir = new THREE.Vector3();

    // ---------- Debug 性能监控 (?debug=1) ----------
    this._debugMode = new URLSearchParams(window.location.search).has('debug');
    if (this._debugMode) {
      this._debugEl = document.createElement('div');
      this._debugEl.id = 'debug-overlay';
      this._debugEl.style.cssText = 'position:fixed;top:4px;left:4px;background:rgba(0,0,0,0.8);color:#0f0;font:11px monospace;padding:6px 10px;border-radius:4px;z-index:99999;pointer-events:none;white-space:pre;line-height:1.5';
      document.body.appendChild(this._debugEl);
      this._debugFrames = 0;
      this._debugFps = 0;
      this._debugFpsTimer = 0;
    }

    window.addEventListener('resize', () => this.onResize());
    document.addEventListener('visibilitychange', () => {
      this.paused = document.hidden;
      if (this.paused) {
        if (this.audio.ctx && this.audio.ctx.state === 'running') this.audio.ctx.suspend();
      } else {
        if (this.audio.ctx && this.audio.ctx.state === 'suspended') this.audio.ctx.resume();
        this.clock.getDelta();
      }
    });

    // ---------- 启动流程 ----------
    this.input.setGameplayEnabled(false);
    this.enemy.group.visible = false;

    // 主菜单摄像机初始化
    this._menuTime = 0;
    this._menuCamPos = new THREE.Vector3();

    // 音频设置
    const savedSettings = this.settingsPanel.getSettings();
    this.audio.setVolume(savedSettings.volume);
    this.audio.setEnabled(savedSettings.soundOn);

    // 设置面板回调
    this.settingsPanel.setCallbacks({
      onBack: () => this.mainMenu.show(),
      onVolumeChange: ({ soundOn, volume }) => {
        this.audio.setVolume(volume);
        this.audio.setEnabled(soundOn);
      },
      onQualityChange: (quality) => this._applyQuality(quality),
    });

    // 主菜单按钮回调
    this.mainMenu.setCallbacks({
      onDuel: () => this._handleStartDuel(),
      onContinue: () => {
        // 检查是否有可继续的游戏状态
        const inProgress = this.phase === GAME_PHASE.GAMEOVER || this.phase === GAME_PHASE.PLAYING;
        if (inProgress) {
          this.mainMenu.hide();
          this.hud.hideEnd();
          this.gameOver = false;
          this.restart();
        } else {
          this.mainMenu.showContinueToast();
        }
      },
      onSettings: () => this.settingsPanel.show(),
      onBoss: () => this._enterBossSelect(),
    });

    // Boss 选择页回调
    this.bossSelectPanel.setCallbacks({
      onStart: () => this._startBossBattle(),
      onBack: () => {
        this.bossSelectPanel.hide();
        this.mainMenu.show();
      },
    });

    // 应用已保存的设置
    this._applyQuality(savedSettings.quality);

    this.mainMenu.show();
  }

  _applyQuality(quality) {
    this._qualityLevel = quality;
    if (quality === 'low') {
      this.renderer.setPixelRatio(1);
      if (this.composer) { this.composer.enabled = false; }
      this.renderer.shadowMap.enabled = false;
      this._particleScale = 0.4;
    } else if (quality === 'medium') {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
      if (this.composer) { this.composer.enabled = true; }
      if (this.bloomPass) { this.bloomPass.strength = 0.35; }
      this.renderer.shadowMap.enabled = true;
      this._particleScale = 0.7;
    } else {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      if (this.composer) { this.composer.enabled = true; }
      if (this.bloomPass) { this.bloomPass.strength = 0.55; }
      this.renderer.shadowMap.enabled = true;
      this._particleScale = 1.0;
    }
    // Apply particle scale to Effects
    if (this.effects && this.effects.setParticleScale) {
      this.effects.setParticleScale(this._particleScale);
    }
  }

  _handleStartDuel() {
    const tutorialDone = localStorage.getItem('wizard_duel_tutorial_done') === '1';
    if (!tutorialDone) {
      this._beginTutorial();
    } else {
      this.hud.showRetryTutorial(() => this._beginTutorial());
      this.hud.showStart((difficulty) => this.startDuel(difficulty));
    }
  }

  /* ==================== 新手训练 ==================== */

  _beginTutorial() {
    // 完整重置所有状态
    this.phase = GAME_PHASE.TUTORIAL;
    this.tutorialStep = 0;
    this.tutorialHits = 0;
    this.tutorialMoved = false;
    this.tutorialLooked = false;
    this.tutorialDodged = false;

    // 玩家满血回出生点
    this.player.reset();
    // 训练靶满血回原位
    this.target._revive();
    // AI 隐藏
    this.enemy.group.visible = false;
    this.enemy.moveIntent.set(0, 0, 0);
    this.enemy.setCastGlow(0);
    // 清空弹道
    for (const p of this.combat.pool) p.despawn();
    // 隐藏陷阱
    for (const t of this.traps.traps) t.hide();
    this.traps.cooldown = 4.5;

    this.gameOver = false;
    this.input.setGameplayEnabled(true);
    this.hud.hideStart();
    this.mainMenu.hide();
    this._advanceTutorial();
  }

  _getTutorialSteps() {
    if (this.input.isTouch) {
      return [
        '拖动左侧区域移动',
        '在右侧滑动控制视角',
        '点击"攻击"按钮命中训练靶 3 次',
        '点击"闪避"按钮',
      ];
    }
    return [
      '使用 WASD 移动',
      '移动鼠标瞄准',
      '左键攻击训练靶（击中 3 次）',
      '按 Space 闪避',
    ];
  }

  _advanceTutorial() {
    const steps = this._getTutorialSteps();

    if (this.tutorialStep >= steps.length) {
      this.hud.hideTutorial();
      localStorage.setItem('wizard_duel_tutorial_done', '1');
      this.phase = GAME_PHASE.MAIN_MENU;
      this.input.setGameplayEnabled(false);
      this.enemy.group.visible = false;
      this.mainMenu.show();
      return;
    }

    this.hud.showTutorial(steps[this.tutorialStep]);
  }

  _checkTutorialProgress(lookDx, lookDy) {
    if (this.phase !== GAME_PHASE.TUTORIAL) return;
    const mv = this.input.getMoveVector();
    switch (this.tutorialStep) {
      case 0:
        if (Math.abs(mv.x) > 0.1 || Math.abs(mv.y) > 0.1) {
          this.tutorialMoved = true;
          this.tutorialStep++;
          this._advanceTutorial();
        }
        break;
      case 1:
        if (Math.abs(lookDx) > 2 || Math.abs(lookDy) > 2) {
          this.tutorialLooked = true;
          this.tutorialStep++;
          this._advanceTutorial();
        }
        break;
      case 2:
        // 命中计数在 onDamage 回调中处理
        break;
      case 3:
        if (this.input.consumeAction('dodge')) {
          if (this.player.tryDodge(mv, this.cameraYaw)) {
            this.tutorialDodged = true;
            this.tutorialStep++;
            this.audio.playDodge();
            this._advanceTutorial();
          }
        }
        break;
    }
  }

  /* ==================== 开始决斗 ==================== */

  startDuel(difficulty = 'rookie') {
    this.difficulty = difficulty;
    this.gameOver = false;

    this.player.reset();
    this.enemy.reset();
    this.enemyAI.reset();
    this.enemyAI.setDifficulty(difficulty);
    this.enemy.group.visible = true;
    this.target._revive();

    // 清空残余弹道与陷阱
    for (const p of this.combat.pool) p.despawn();
    for (const t of this.traps.traps) t.hide();
    this.traps.cooldown = 4.5;

    this.phase = GAME_PHASE.COUNTDOWN;
    this.countdownTimer = 3.2;

    this.hud.hideStart();
    this.mainMenu.hide();
    this.input.setGameplayEnabled(false);
    this.audio.playDuelAmbience();
  }

  /* ==================== 倒计时 & 保护期 ==================== */

  updatePreFight(dt) {
    if (this.phase === GAME_PHASE.COUNTDOWN) {
      this.countdownTimer -= dt;

      if (this.countdownTimer > 2.4) {
        this.hud.showCountdown('3');
      } else if (this.countdownTimer > 1.6) {
        this.hud.showCountdown('2');
      } else if (this.countdownTimer > 0.8) {
        this.hud.showCountdown('1');
      } else if (this.countdownTimer > 0) {
        this.hud.showCountdown('DUEL!');
      } else {
        this.phase = GAME_PHASE.GRACE;
        this.graceTimer = 1.5;
        this.input.setGameplayEnabled(true);
        this.hud.hideCountdown();
        this.hud.showBanner('准备战斗！', 1);
      }
    } else if (this.phase === GAME_PHASE.GRACE) {
      this.graceTimer -= dt;
      // AI 面向玩家但不攻击不追击
      this.enemy.faceTowards(this.player.position, dt);
      this.enemy.moveIntent.set(0, 0, 0);
      this.enemy.setCastGlow(0);

      if (this.graceTimer <= 0) {
        this.phase = GAME_PHASE.PLAYING;
        this.enemyAI.reset();
        this.enemyAI.setDifficulty(this.difficulty);
      }
    }
  }

  /* ==================== 主循环 ==================== */

  start() {
    this.clock.start();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  /** 统一渲染入口：Low quality 时直出，不运行 composer */
  _renderScene() {
    if (this.composer && this.composer.enabled !== false) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  tick() {
    if (this.paused) return;
    const dt = Math.min(this.clock.getDelta(), 0.05);

    // Debug overlay
    if (this._debugMode) {
      this._debugFrames++;
      this._debugFpsTimer += dt;
      if (this._debugFpsTimer >= 0.5) {
        this._debugFps = Math.round(this._debugFrames / this._debugFpsTimer);
        this._debugFrames = 0;
        this._debugFpsTimer = 0;
      }
    }

    // ---- 主菜单状态：仅渲染背景 + 菜单摄像机 ----
    if (this.phase === GAME_PHASE.MAIN_MENU) {
      this._menuTime += dt;
      this.player.update(dt, this.input, this.cameraYaw, this.arena.radius);
      this.target.update(dt);
      this.arena.update(dt);
      this.props.update(dt);
      this.effects.update(dt);
      this.updateMenuCamera(dt);
      this._renderScene();
      this._updateDebug(dt);
      return;
    }

    // ---- Boss 选择页：同主菜单渲染 ----
    if (this.phase === GAME_PHASE.BOSS_SELECT) {
      this._menuTime += dt;
      this.arena.update(dt);
      this.props.update(dt);
      this.effects.update(dt);
      this.updateMenuCamera(dt);
      this._renderScene();
      this._updateDebug(dt);
      return;
    }

    // ---- Boss 战 ----
    if (this.phase === GAME_PHASE.BOSS_BATTLE) {
      this._tickBossBattle(dt);
      return;
    }

    // ---- 镜头旋转 ----
    const look = this.input.consumeLook();
    const sens = this.input.isTouch ? 0.005 : 0.0028;
    this.cameraYaw -= look.dx * sens;
    this.cameraPitch = THREE.MathUtils.clamp(this.cameraPitch + look.dy * sens, 0.08, 1.05);

    // ---- 新手训练检测 ----
    if (this.phase === GAME_PHASE.TUTORIAL) {
      this._checkTutorialProgress(look.dx, look.dy);
    }

    // ---- 倒计时 & 保护期 ----
    if (this.phase === GAME_PHASE.COUNTDOWN || this.phase === GAME_PHASE.GRACE) {
      this.updatePreFight(dt);
    }

    // ---- 玩家移动 ----
    this.player.update(dt, this.input, this.cameraYaw, this.arena.radius);
    this.target.update(dt);

    // ---- AI 决策（仅在 PLAYING 阶段） ----
    if (this.phase === GAME_PHASE.PLAYING) {
      this.enemyAI.update(dt, this.player, this.arena);
    } else {
      this.enemy.moveIntent.set(0, 0, 0);
      if (this.phase !== GAME_PHASE.COUNTDOWN && this.phase !== GAME_PHASE.GRACE) {
        this.enemy.setCastGlow(0);
      }
    }
    this.enemy.update(dt, this.arena.radius);

    // ---- 玩家攻击 / 闪避 / 技能（TUTORIAL 和 PLAYING 和 GRACE 允许操作） ----
    const canAct = (this.phase === GAME_PHASE.PLAYING || this.phase === GAME_PHASE.TUTORIAL || this.phase === GAME_PHASE.GRACE)
      && !this.player.dead && !this.gameOver;

    if (this.input.isAttackHeld() && canAct) {
      const cp = Math.cos(this.cameraPitch), sp = Math.sin(this.cameraPitch);
      this._aimDir.set(-Math.sin(this.cameraYaw) * cp, -sp * 0.6, -Math.cos(this.cameraYaw) * cp).normalize();
      if (this.combat.canFire(this.player) && !this.player.isCasting()) {
        const dir = this._aimDir.clone();
        this.player.requestCast('basic', () => {
          if (this.combat.commitFire(this.player, dir)) {
            this.audio.playCast(2);
          }
        });
      }
    }

    if (this.input.consumeAction('dodge') && canAct) {
      const mv = this.input.getMoveVector();
      if (this.player.tryDodge(mv, this.cameraYaw)) {
        this.audio.playDodge();
      }
    }

    if (this.input.consumeAction('skill1') && canAct) {
      const cp2 = Math.cos(this.cameraPitch), sp2 = Math.sin(this.cameraPitch);
      this._aimDir.set(-Math.sin(this.cameraYaw) * cp2, -sp2 * 0.6, -Math.cos(this.cameraYaw) * cp2).normalize();
      if (this.combat.canCastSkill(this.player, 1)) {
        const dir = this._aimDir.clone();
        this.player.requestCast('q', () => {
          if (this.combat.commitCastSkill(this.player, 1, dir)) {
            this.audio.playCast(4);
          }
        });
      }
    }

    if (this.input.consumeAction('skill2') && canAct) {
      const cp3 = Math.cos(this.cameraPitch), sp3 = Math.sin(this.cameraPitch);
      this._aimDir.set(-Math.sin(this.cameraYaw) * cp3, -sp3 * 0.6, -Math.cos(this.cameraYaw) * cp3).normalize();
      if (this.combat.canCastSkill(this.player, 2)) {
        const dir = this._aimDir.clone();
        this.player.requestCast('e', () => {
          if (this.combat.commitCastSkill(this.player, 2, dir)) {
            this.audio.playCast(3);
          }
        });
      }
    }

    // ---- 战斗与特效 ----
    const activeCombatants =
      this.phase === GAME_PHASE.TUTORIAL
        ? [this.player, this.target]
        : [this.player, this.target, this.enemy];

    if (
      this.phase === GAME_PHASE.TUTORIAL ||
      this.phase === GAME_PHASE.GRACE ||
      this.phase === GAME_PHASE.PLAYING
    ) {
      this.combat.update(dt, activeCombatants, this.arena);
    }
    this.effects.update(dt);
    this.explosion.update(dt, this.camera);
    this.arena.update(dt);
    this.props.update(dt);

    // ---- 陷阱（仅 PLAYING 阶段运行） ----
    if (this.phase === GAME_PHASE.PLAYING && !this.gameOver) {
      this.traps.update(dt, this.arena.radius);
    }

    // ---- 摄像机 ----
    this.updateCamera(dt);

    // ---- HUD ----
    this.hud.update(this.player, this.target, this.enemy);
    this.hud.updateDmgNumbers(dt);

    this._renderScene();
    this._updateDebug(dt);
  }

  _updateDebug(dt) {
    if (!this._debugMode || !this._debugEl) return;
    const info = this.renderer.info;
    const bc = this.bossController;
    const bossState = bc ? bc.state : '-';
    const bossAnim = bc && bc.boss ? (bc.boss._currentAnim || '-') : '-';
    const animTime = bc && bc.boss && bc.boss._mixer ? bc.boss._mixer.time.toFixed(2) : '-';
    this._debugEl.textContent =
      `FPS: ${this._debugFps}\n` +
      `Draw: ${info.render.calls}\n` +
      `Tris: ${info.render.triangles}\n` +
      `Geos: ${info.memory.geometries} Tex: ${info.memory.textures}\n` +
      `Phase: ${this.phase}\n` +
      `Boss: ${bossState}\n` +
      `Anim: ${bossAnim} (${animTime}s)`;
  }

  updateCamera(dt) {
    const head = this.player.headPosition;
    const cp = Math.cos(this.cameraPitch), sp = Math.sin(this.cameraPitch);
    const desired = new THREE.Vector3(
      head.x + Math.sin(this.cameraYaw) * cp * this.cameraDist,
      head.y + sp * this.cameraDist,
      head.z + Math.cos(this.cameraYaw) * cp * this.cameraDist
    );
    const flat = Math.hypot(desired.x, desired.z);
    const maxR = this.arena.radius + 2.5;
    if (flat > maxR) {
      desired.x *= maxR / flat;
      desired.z *= maxR / flat;
    }
    desired.y = Math.max(desired.y, 0.6);

    const k = 1 - Math.pow(0.88, dt * 60);
    this.camPos.lerp(desired, k);
    this.camera.position.copy(this.camPos);

    this.shake.update(dt, this._shakeOffset);
    this.camera.position.add(this._shakeOffset);

    this.camera.lookAt(head.x, head.y + 0.3, head.z);
  }

  updateMenuCamera(dt) {
    // 缓慢漂移的菜单摄像机
    const t = this._menuTime;
    const angle = 0.35 + Math.sin(t * 0.12) * 0.15;
    const dist = 12;
    const height = 5.5 + Math.sin(t * 0.18) * 0.6;

    const desired = new THREE.Vector3(
      Math.sin(angle) * dist,
      height,
      Math.cos(angle) * dist
    );

    const k = 1 - Math.pow(0.95, dt * 60);
    this._menuCamPos.lerp(desired, k);
    this.camera.position.copy(this._menuCamPos);

    // 看向竞技场中央偏上
    this.camera.lookAt(0, 2, 0);
  }

  /* ==================== Boss 战主循环 ==================== */

  _tickBossBattle(dt) {
    // 镜头旋转（始终允许）
    const look = this.input.consumeLook();
    const sens = this.input.isTouch ? 0.005 : 0.0028;
    this.cameraYaw -= look.dx * sens;
    this.cameraPitch = THREE.MathUtils.clamp(this.cameraPitch + look.dy * sens, 0.08, 1.05);

    // Boss 控制器更新
    this.bossController.update(dt, this.player, this.arena);

    // 玩家操作门控：只有 PHASE1 / PHASE2 允许移动/攻击/闪避/技能
    const canAct = this.bossController.canPlayerAct() && !this.player.dead && !this.gameOver;

    // 同步 input 开关：非战斗阶段彻底禁止移动输入
    this.input.setGameplayEnabled(canAct);

    if (canAct) {
      // 玩家移动
      this.player.update(dt, this.input, this.cameraYaw, this.arena.radius);

      // 玩家攻击
      if (this.input.isAttackHeld()) {
        const cp = Math.cos(this.cameraPitch), sp = Math.sin(this.cameraPitch);
        this._aimDir.set(-Math.sin(this.cameraYaw) * cp, -sp * 0.6, -Math.cos(this.cameraYaw) * cp).normalize();
        if (this.combat.canFire(this.player) && !this.player.isCasting()) {
          const dir = this._aimDir.clone();
          this.player.requestCast('basic', () => {
            if (this.combat.commitFire(this.player, dir)) {
              this.audio.playCast(2);
            }
          });
        }
      }

      // 闪避
      if (this.input.consumeAction('dodge')) {
        const mv = this.input.getMoveVector();
        if (this.player.tryDodge(mv, this.cameraYaw)) {
          this.audio.playDodge();
        }
      }

      // 技能1
      if (this.input.consumeAction('skill1')) {
        const cp2 = Math.cos(this.cameraPitch), sp2 = Math.sin(this.cameraPitch);
        this._aimDir.set(-Math.sin(this.cameraYaw) * cp2, -sp2 * 0.6, -Math.cos(this.cameraYaw) * cp2).normalize();
        if (this.combat.canCastSkill(this.player, 1)) {
          const dir = this._aimDir.clone();
          this.player.requestCast('q', () => {
            if (this.combat.commitCastSkill(this.player, 1, dir)) {
              this.audio.playCast(4);
            }
          });
        }
      }

      // 技能2
      if (this.input.consumeAction('skill2')) {
        const cp3 = Math.cos(this.cameraPitch), sp3 = Math.sin(this.cameraPitch);
        this._aimDir.set(-Math.sin(this.cameraYaw) * cp3, -sp3 * 0.6, -Math.cos(this.cameraYaw) * cp3).normalize();
        if (this.combat.canCastSkill(this.player, 2)) {
          const dir = this._aimDir.clone();
          this.player.requestCast('e', () => {
            if (this.combat.commitCastSkill(this.player, 2, dir)) {
              this.audio.playCast(3);
            }
          });
        }
      }
    } else {
      // 非战斗阶段：清空输入，玩家不移动
      this.input.getMoveVector();
      this.input.consumeAction('dodge');
      this.input.consumeAction('skill1');
      this.input.consumeAction('skill2');
      this.input.isAttackHeld();
      // 玩家仍需更新（冷却/光效），但 input disabled 所以不移动
      this.player.update(dt, this.input, this.cameraYaw, this.arena.radius);
    }

    // 战斗系统：只在玩家可操作时运行碰撞
    if (canAct || this.bossController.state === 'phase1' || this.bossController.state === 'phase2') {
      const bossCombatants = this.bossController.getCombatants();
      this.combat.update(dt, bossCombatants, this.arena);
    }

    // 特效
    this.effects.update(dt);
    this.explosion.update(dt, this.camera);
    this.arena.update(dt);
    this.props.update(dt);

    // 摄像机：cinematic 期间由 CameraDirector 控制 + shake 叠加，否则正常更新
    const cinematicActive = this.bossController.cameraDirector.update(dt);
    if (!cinematicActive) {
      this.updateCamera(dt);
    } else {
      // Cinematic mode: CameraDirector already set camera.position,
      // but we still need to apply shake on top
      this.shake.update(dt, this._shakeOffset);
      this.camera.position.add(this._shakeOffset);
    }

    // HUD：只显示玩家血条和技能冷却
    this.hud.update(this.player, this.player, null);
    this.hud.updateDmgNumbers(dt);

    this._renderScene();
  }

  addShake(power = 1) {
    this.shake.trigger(power, this.isMobile);
  }

  endGame(win) {
    this.gameOver = true;
    this.phase = GAME_PHASE.GAMEOVER;
    this.input.setGameplayEnabled(false);
    this.enemy.moveIntent.set(0, 0, 0);
    this.enemy.setCastGlow(0);
    // 清空所有残余弹道，防止死后继续造成伤害
    for (const p of this.combat.pool) p.despawn();
    this.audio.fadeOutMusic(1.0);

    // 连胜计数
    if (win) {
      this.winStreak++;
    } else {
      this.winStreak = 0;
    }

    // 释放鼠标，让玩家点击结算按钮
    if (document.pointerLockElement) {
      document.exitPointerLock?.();
    }

    this.hud.showEnd({
      win,
      difficulty: this.difficulty,
      winStreak: this.winStreak,
      onRestart: () => this.restart(),
      onNextDifficulty: () => this.nextDifficulty(),
      onMainMenu: () => this.returnToMainMenu(),
    });
  }

  /** 挑战更高难度：rookie→normal, normal→hard */
  nextDifficulty() {
    if (this.difficulty === 'rookie') {
      this.difficulty = 'normal';
    } else if (this.difficulty === 'normal') {
      this.difficulty = 'hard';
    }
    this.restart();
  }

  /* ==================== Boss 模式 ==================== */

  _enterBossSelect() {
    this.phase = GAME_PHASE.BOSS_SELECT;
    // 不无条件 reset selectedBossId — 保留上次选择
    // 只有 selectedBossId 失效（null / locked）才 fallback 到默认
    this.bossSelectPanel.show();
  }

  _startBossBattle() {
    this.phase = GAME_PHASE.BOSS_BATTLE;
    this.gameOver = false;

    // 获取选中的 Boss ID
    this.selectedBossId = this.bossSelectPanel.getSelectedBossId();

    // 隐藏普通敌人和训练靶
    this.enemy.group.visible = false;
    this.enemy.moveIntent.set(0, 0, 0);
    this.enemy.setCastGlow(0);
    this.target.group.visible = false;

    // 清空残余弹道与陷阱
    for (const p of this.combat.pool) p.despawn();
    for (const t of this.traps.traps) t.hide();
    this.traps.cooldown = 999; // Boss 战不触发普通陷阱

    // 玩家重置
    this.player.reset();

    // 创建 Boss 控制器
    if (this.bossController) {
      this.bossController.destroy();
    }
    this.bossController = new BossBattleController(
      this.scene, this.combat, this.effects, this.explosion,
      this.audio, this.hud, this.bossHealthBar, this.bossResultPanel
    );

    this.bossController.onComplete = (action) => this._onBossComplete(action);
    this.bossController.onShake = (power) => this.addShake(power);
    this.bossController.setCamera(this.camera);

    const ok = this.bossController.start(this.player, this.arena, this.selectedBossId);
    if (!ok) {
      // Boss 创建失败 — 不进入战斗，回退到 Boss 选择
      this.bossController.destroy();
      this.bossController = null;
      this._enterBossSelect();
      return;
    }

    this.input.setGameplayEnabled(true);
    this.audio.playBossAmbience();
  }

  _onBossComplete(action) {
    if (action === 'retry') {
      this._startBossBattle();
    } else if (action === 'select') {
      this._exitBossBattle();
      this._enterBossSelect();
    } else if (action === 'menu') {
      this._exitBossBattle();
      this.returnToMainMenu();
    }
  }

  _exitBossBattle() {
    if (this.bossController) {
      this.bossController.destroy();
      this.bossController = null;
    }
    // 恢复训练靶和敌人可见性
    this.target.group.visible = true;
    this.target._revive();
    this.traps.cooldown = 4.5;
  }

  /* ==================== 返回主菜单 ==================== */

  /** 返回主菜单：重置一切，显示主界面 */
  returnToMainMenu() {
    // 清理 Boss 战
    if (this.bossController) {
      this.bossController.destroy();
      this.bossController = null;
    }
    this.bossHealthBar.hide();
    this.bossResultPanel.hide();
    this.bossSelectPanel.hide();
    this.target.group.visible = true;

    this.gameOver = false;
    this.phase = GAME_PHASE.MAIN_MENU;
    this.winStreak = 0;
    this.player.reset();
    this.enemy.reset();
    this.enemyAI.reset();
    this.target._revive();
    this.enemy.group.visible = false;
    for (const p of this.combat.pool) p.despawn();
    for (const t of this.traps.traps) t.hide();
    this.traps.cooldown = 4.5;
    this.input.setGameplayEnabled(false);
    this.hud.hideEnd();
    this.mainMenu.show();
    this.audio.playMenuAmbience();
  }

  restart() {
    this.gameOver = false;

    this.player.reset();
    this.enemy.reset();
    this.enemyAI.reset();
    this.target._revive();

    for (const p of this.combat.pool) p.despawn();
    for (const t of this.traps.traps) t.hide();
    this.traps.cooldown = 4.5;

    this.phase = GAME_PHASE.COUNTDOWN;
    this.countdownTimer = 3.2;

    this.input.setGameplayEnabled(false);
    this.enemyAI.setDifficulty(this.difficulty);
    this.audio.playDuelAmbience();
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    if (this.composer) this.composer.setSize(window.innerWidth, window.innerHeight);
  }
}
