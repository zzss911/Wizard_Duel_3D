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

/**
 * Game —— 总控制器
 * 负责：渲染器 / 场景 / 摄像机 / 主循环 / 暂停与重开。
 * 所有速度与冷却一律基于 deltaTime，保证帧率无关。
 */
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

    // ---------- 后处理：Bloom（仅桌面端，移动端保持轻量） ----------
    this.composer = null;
    if (!this.isMobile) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        0.55,  // 强度
        0.45,  // 半径
        0.78   // 阈值：只有魔法高光泛光，画面不糊
      );
      this.composer.addPass(this.bloomPass);
      this.composer.addPass(new OutputPass());
    }

    // 首次用户交互后解锁 AudioContext（浏览器自动播放限制）
    const unlockAudio = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlockAudio, { once: true });
    window.addEventListener('touchstart', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });

    // 命中回调：HUD 飘伤害数字
    this.combat.onDamage = (worldPos, amount) => this.hud.spawnDamageNumber(worldPos, amount, this.camera);
    // 训练靶大爆炸编排：震屏 + 屏幕闪光 + 音效
    this.combat.onImpact = (worldPos, power) => {
      this.addShake(power);
      this.hud.screenFlash();
      this.audio.playExplosion(power, this.camera.position.distanceTo(worldPos));
    };
    // 玩家受击编排：红边 + 轻震 + 受击音
    this.combat.onPlayerHit = () => {
      this.hud.playerHitFlash();
      this.addShake(0.45);
      this.audio.playHit();
      if (this.player.dead && !this.gameOver) this.endGame(false);
    };
    // 敌人被击败：爆炸 + 胜利结算
    this.enemy.onDeath = () => {
      this.explosion.playMagicExplosion(this.enemy.headPosition, 1.5);
      this.addShake(1.2);
      this.audio.playExplosion(1.5, this.camera.position.distanceTo(this.enemy.position));
      if (!this.gameOver) this.endGame(true);
    };
    this.target.onDeath = () => this.hud.showBanner('目标已击败！', 1.6);

    // ---------- 陷阱系统：对玩家 / 敌人 / 训练靶均生效 ----------
    this.traps = new TrapSystem(this.scene, this.explosion, (center, radius, damage) => {
      for (const c of this.combatants) {
        if (c.dead) continue;
        const d = Math.hypot(c.position.x - center.x, c.position.z - center.z);
        if (d > radius) continue;
        c.takeDamage(damage);
        // 向外击退
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
      if (e.code === 'KeyR' && this.gameOver) this.restart();
    });

    // ---------- 摄像机状态 ----------
    this.cameraYaw = 0;                // 玩家在 +Z 侧，初始面向场地中心的训练靶
    this.cameraPitch = 0.34;
    this.cameraDist = 7;
    this.camPos = new THREE.Vector3();

    // ---------- 镜头震动（多段脉冲） ----------
    this.shake = new CameraShake();
    this._shakeOffset = new THREE.Vector3();

    // ---------- 循环 ----------
    this.clock = new THREE.Clock();
    this.paused = false;
    this._aimDir = new THREE.Vector3();

    window.addEventListener('resize', () => this.onResize());
    document.addEventListener('visibilitychange', () => {
      this.paused = document.hidden;
      if (!this.paused) this.clock.getDelta(); // 丢弃后台累积时间
    });
  }

  start() {
    this.clock.start();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  tick() {
    if (this.paused) return;
    const dt = Math.min(this.clock.getDelta(), 0.05); // 钳制，防切后台后跳变

    // ---- 镜头旋转（输入 -> 偏航/俯仰）----
    const look = this.input.consumeLook();
    const sens = this.input.isTouch ? 0.005 : 0.0028;
    this.cameraYaw -= look.dx * sens;
    this.cameraPitch = THREE.MathUtils.clamp(this.cameraPitch + look.dy * sens, 0.08, 1.05);

    // ---- 玩家移动 ----
    this.player.update(dt, this.input, this.cameraYaw, this.arena.radius);
    this.target.update(dt);
    this.enemyAI.update(dt, this.player, this.arena);
    this.enemy.update(dt, this.arena.radius);

    // ---- 攻击：沿准星方向发射 ----
    if (this.input.isAttackHeld() && !this.player.dead && !this.gameOver) {
      const cp = Math.cos(this.cameraPitch), sp = Math.sin(this.cameraPitch);
      this._aimDir.set(-Math.sin(this.cameraYaw) * cp, -sp * 0.6, -Math.cos(this.cameraYaw) * cp).normalize();
      if (this.combat.tryFire(this.player, this._aimDir)) {
        this.player.onCast();
        this.audio.playCast(2);
      }
    }

    // ---- 闪避 ----
    if (this.input.consumeAction('dodge') && !this.player.dead && !this.gameOver) {
      const mv = this.input.getMoveVector();
      if (this.player.tryDodge(mv, this.cameraYaw)) {
        this.audio.playDodge();
      }
    }

    // ---- 技能 1：爆裂咒 ----
    if (this.input.consumeAction('skill1') && !this.player.dead && !this.gameOver) {
      const cp2 = Math.cos(this.cameraPitch), sp2 = Math.sin(this.cameraPitch);
      this._aimDir.set(-Math.sin(this.cameraYaw) * cp2, -sp2 * 0.6, -Math.cos(this.cameraYaw) * cp2).normalize();
      if (this.combat.castSkill(this.player, 1, this._aimDir)) {
        this.player.onCast();
        this.audio.playCast(4);
      }
    }

    // ---- 技能 2：束缚咒 ----
    if (this.input.consumeAction('skill2') && !this.player.dead && !this.gameOver) {
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
    if (!this.gameOver) this.traps.update(dt, this.arena.radius);

    // ---- 摄像机跟随（插值，避免硬跟随抖动）----
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
    // 不越出场地太多，减少穿柱观感
    const flat = Math.hypot(desired.x, desired.z);
    const maxR = this.arena.radius + 2.5;
    if (flat > maxR) {
      desired.x *= maxR / flat;
      desired.z *= maxR / flat;
    }
    desired.y = Math.max(desired.y, 0.6);

    // dt 归一化插值：60fps 下约 0.12 的平滑系数
    const k = 1 - Math.pow(0.88, dt * 60);
    this.camPos.lerp(desired, k);
    this.camera.position.copy(this.camPos);

    // ---- 镜头震动：多段脉冲（强→弱→更弱，共 ~0.7s） ----
    this.shake.update(dt, this._shakeOffset);
    this.camera.position.add(this._shakeOffset);

    this.camera.lookAt(head.x, head.y + 0.3, head.z);
  }

  /**
   * 触发一次多段镜头震动。
   * @param {number} power 爆炸威力（1 普攻 / 1.5 重击 / 2.5 终极）
   */
  addShake(power = 1) {
    this.shake.trigger(power, this.isMobile);
  }

  /** 胜负结算 */
  endGame(win) {
    this.gameOver = true;
    this.hud.showEnd(win, () => this.restart());
  }

  /** 再来一局：重置双方状态，无残留 */
  restart() {
    this.gameOver = false;
    this.player.reset();
    this.enemy.reset();
    this.enemyAI.reset();
    this.target._revive();
    // 清空残余弹道与陷阱
    for (const p of this.combat.pool) p.despawn();
    for (const t of this.traps.traps) t.hide();
    this.traps.cooldown = 4.5;
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    if (this.composer) this.composer.setSize(window.innerWidth, window.innerHeight);
  }
}
