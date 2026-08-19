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

const GAME_PHASE = {
  READY: 'ready',
  TUTORIAL: 'tutorial',
  COUNTDOWN: 'countdown',
  GRACE: 'grace',
  PLAYING: 'playing',
  GAMEOVER: 'gameover',
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
    this.audio = new MagicAudio();
    this.isMobile = this.input.isTouch;
    this.gameOver = false;
    this.combatants = [this.player, this.target, this.enemy];

    // ---------- 游戏阶段 ----------
    this.phase = GAME_PHASE.READY;
    this.countdownTimer = 0;
    this.graceTimer = 0;
    this.difficulty = 'rookie';

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
    const unlockAudio = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlockAudio, { once: true });
    window.addEventListener('touchstart', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });

    // 命中回调
    this.combat.onDamage = (worldPos, amount, target) => {
      this.hud.spawnDamageNumber(worldPos, amount, this.camera);
      if (this.phase === GAME_PHASE.TUTORIAL && target?.isTarget) {
        this.tutorialHits++;
        this._advanceTutorial();
      }
    };
    this.combat.onImpact = (worldPos, power) => {
      this.addShake(power);
      this.hud.screenFlash();
      this.audio.playExplosion(power, this.camera.position.distanceTo(worldPos));
    };
    this.combat.onPlayerHit = () => {
      this.hud.playerHitFlash();
      this.addShake(0.45);
      this.audio.playHit();
      if (this.player.dead && !this.gameOver) this.endGame(false);
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

    window.addEventListener('resize', () => this.onResize());
    document.addEventListener('visibilitychange', () => {
      this.paused = document.hidden;
      if (!this.paused) this.clock.getDelta();
    });

    // ---------- 启动流程 ----------
    this.input.setGameplayEnabled(false);
    this.enemy.group.visible = false; // 初始隐藏敌人

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
    this.phase = GAME_PHASE.TUTORIAL;
    this.tutorialStep = 0;
    this.tutorialHits = 0;
    this.tutorialMoved = false;
    this.tutorialLooked = false;
    this.tutorialDodged = false;
    this.enemy.group.visible = false;
    this.input.setGameplayEnabled(true);
    this._advanceTutorial();
  }

  _advanceTutorial() {
    const steps = [
      { text: '使用 WASD 移动', check: () => this.tutorialMoved },
      { text: '移动鼠标进行瞄准', check: () => this.tutorialLooked },
      { text: '左键攻击训练靶（击中 3 次）', check: () => this.tutorialHits >= 3 },
      { text: '按 Space 进行闪避', check: () => this.tutorialDodged },
    ];

    if (this.tutorialStep >= steps.length) {
      // 训练完成
      this.hud.hideTutorial();
      localStorage.setItem('wizard_duel_tutorial_done', '1');
      this.phase = GAME_PHASE.READY;
      this.input.setGameplayEnabled(false);
      this.hud.showStart((difficulty) => this.startDuel(difficulty));
      this.hud.showRetryTutorial(() => this._beginTutorial());
      return;
    }

    const step = steps[this.tutorialStep];
    this.hud.showTutorial(step.text);
  }

  _checkTutorialProgress(lookDx, lookDy) {
    if (this.phase !== GAME_PHASE.TUTORIAL) return;

    const mv = this.input.getMoveVector();
    if (!this.tutorialMoved && (Math.abs(mv.x) > 0.1 || Math.abs(mv.y) > 0.1)) {
      this.tutorialMoved = true;
      this._advanceTutorial();
      return;
    }

    if (!this.tutorialLooked && (Math.abs(lookDx) > 2 || Math.abs(lookDy) > 2)) {
      this.tutorialLooked = true;
      this._advanceTutorial();
      return;
    }

    if (this.input.consumeAction('dodge') && !this.tutorialDodged) {
      this.tutorialDodged = true;
      this.player.tryDodge(mv, this.cameraYaw);
      this.audio.playDodge();
      this._advanceTutorial();
      return;
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
    this.input.setGameplayEnabled(false);
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

  tick() {
    if (this.paused) return;
    const dt = Math.min(this.clock.getDelta(), 0.05);

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
      if (this.combat.tryFire(this.player, this._aimDir)) {
        this.player.onCast();
        this.audio.playCast(2);
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
      if (this.combat.castSkill(this.player, 1, this._aimDir)) {
        this.player.onCast();
        this.audio.playCast(4);
      }
    }

    if (this.input.consumeAction('skill2') && canAct) {
      const cp3 = Math.cos(this.cameraPitch), sp3 = Math.sin(this.cameraPitch);
      this._aimDir.set(-Math.sin(this.cameraYaw) * cp3, -sp3 * 0.6, -Math.cos(this.cameraYaw) * cp3).normalize();
      if (this.combat.castSkill(this.player, 2, this._aimDir)) {
        this.player.onCast();
        this.audio.playCast(3);
      }
    }

    // ---- 战斗与特效 ----
    this.combat.update(dt, this.combatants, this.arena);
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

    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
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

  addShake(power = 1) {
    this.shake.trigger(power, this.isMobile);
  }

  endGame(win) {
    this.gameOver = true;
    this.phase = GAME_PHASE.GAMEOVER;
    this.input.setGameplayEnabled(false);
    this.enemy.moveIntent.set(0, 0, 0);
    this.enemy.setCastGlow(0);
    this.hud.showEnd(win, () => this.restart());
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
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    if (this.composer) this.composer.setSize(window.innerWidth, window.innerHeight);
  }
}
