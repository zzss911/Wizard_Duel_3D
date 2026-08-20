import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/GLTFLoader.js';

const IS_MOBILE = window.matchMedia('(pointer: coarse)').matches;

// Shared loader instance + cached promise to avoid duplicate loads
let _loader = null;
let _loadPromise = null;

// Animation name constants
const ANIM_NAMES = ['Idle', 'Cast', 'Slam', 'Hit', 'Death', 'PhaseChange'];

// State → animation mapping
const STATE_ANIM_MAP = {
  IDLE: 'Idle',
  RECOVER: 'Idle',
  TELEGRAPH: 'Cast',
  MAGIC_BOLT: 'Cast',
  CHAIN: 'Cast',
  QUAKE: 'Slam',
  PHASE_CHANGE: 'PhaseChange',
  DEAD: 'Death',
};

function loadWardenGLB() {
  if (_loadPromise) return _loadPromise;
  if (!_loader) _loader = new GLTFLoader();
  _loadPromise = new Promise((resolve, reject) => {
    // Try rigged version first, fall back to original
    const tryLoad = (url, isFallback) => {
      _loader.load(
        url,
        (gltf) => resolve({ scene: gltf.scene, animations: gltf.animations || [], hasAnims: (gltf.animations || []).length > 0 }),
        undefined,
        (err) => {
          if (!isFallback) {
            console.warn('[WardenBoss] warden_rigged.glb not found, trying warden.glb...');
            tryLoad('./assets/models/warden.glb', true);
          } else {
            reject(err);
          }
        }
      );
    };
    tryLoad('./assets/models/warden_rigged.glb', false);
  });
  return _loadPromise;
}

export class WardenBoss {
  constructor(scene) {
    this.scene = scene;
    this.isBoss = true;
    this.isEnemy = true;

    this.maxHp = 600;
    this.hp = this.maxHp;
    this.radius = 1.2;
    this.speed = 1.8;
    this.dead = false;

    this.spawnPosition = new THREE.Vector3(0, 0, -10);
    this.position = this.spawnPosition.clone();
    this._facing = 0;

    this.moveIntent = new THREE.Vector3();
    this.stagger = 0;
    this._flash = 0;
    this._castGlow = 0;
    this._deathT = 0;

    this.speedMult = 1;
    this._slowT = 0;
    this.cooldown = 0;
    this.attackCooldown = 1.5;

    this.skill1Cd = 0;
    this.skill1CdMax = 6;
    this.skill2Cd = 0;
    this.skill2CdMax = 10;

    this._invulnT = 0;
    this.phase2 = false;
    this.onDeath = null;

    // Animation system
    this._mixer = null; // THREE.AnimationMixer
    this._animations = {}; // name → THREE.AnimationClip
    this._currentAction = null; // currently playing AnimationAction
    this._currentAnimName = null;
    this._hasAnims = false; // true if GLB has skeletal animations
    this._animFadeTime = 0.3; // fade duration in seconds
    this._bossState = 'IDLE'; // current boss logic state (for anim mapping)

    // Model loading state
    this._modelLoaded = false;
    this._modelLoading = false;
    this._usingFallback = false;
    this._modelHeight = 3.0; // Will be updated from bounding box

    // Materials for effects (shared between GLB and fallback)
    this._initMaterials();
    this._buildGroup();
    this._buildEffects();

    this.group.position.copy(this.position);
    this.group.visible = false;
    this.scene.add(this.group);
  }

  _initMaterials() {
    this.runeMat = new THREE.MeshStandardMaterial({
      color: 0x8a1a1a, roughness: 0.3, metalness: 0.4,
      emissive: 0xc82020, emissiveIntensity: 1.2,
    });
    this.eyeMat = new THREE.MeshStandardMaterial({
      color: 0xff2020, roughness: 0.1, metalness: 0.2,
      emissive: 0xff0000, emissiveIntensity: 3.0,
    });
    this._flashMaterials = []; // materials to flash on hit
  }

  _buildGroup() {
    this.group = new THREE.Group();
    this.visualRoot = new THREE.Group();
    this.group.add(this.visualRoot);

    // Effect anchors (positioned after model loads or with defaults)
    this.eyeAnchor = new THREE.Group();
    this.chestAnchor = new THREE.Group();
    this.castAnchor = new THREE.Group();
    this.visualRoot.add(this.eyeAnchor, this.chestAnchor, this.castAnchor);

    // Start loading GLB immediately
    this._loadModel();
  }

  _loadModel() {
    if (this._modelLoading || this._modelLoaded) return;
    this._modelLoading = true;

    loadWardenGLB()
      .then((result) => {
        this._setupGLBModel(result.scene, result.animations);
        this._hasAnims = result.hasAnims;
        if (this._hasAnims) {
          this._initAnimationSystem(result.animations);
        }
        this._modelLoaded = true;
        this._modelLoading = false;
      })
      .catch((err) => {
        console.warn('[WardenBoss] GLB load failed, using procedural fallback:', err);
        this._buildFallbackMesh();
        this._usingFallback = true;
        this._modelLoaded = true;
        this._modelLoading = false;
      });
  }

  _setupGLBModel(gltfScene, animations) {
    // Scale model: original ~1.15 units high, target ~3.0-3.2
    gltfScene.scale.setScalar(2.7);

    // Compute bounding box to position anchors
    const box = new THREE.Box3().setFromObject(gltfScene);
    const size = box.getSize(new THREE.Vector3());
    this._modelHeight = size.y;

    // Enable shadows on all meshes and collect materials for hit flash
    gltfScene.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        if (child.material && !this._flashMaterials.includes(child.material)) {
          this._flashMaterials.push(child.material);
          if (child.material.emissive) {
            child.material._origEmissive = child.material.emissive.getHex();
            child.material._origEmissiveIntensity = child.material.emissiveIntensity || 0;
          }
        }
      }
    });

    this.visualRoot.add(gltfScene);
    this._gltfScene = gltfScene;

    // Position effect anchors relative to model height
    const h = this._modelHeight;
    this.eyeAnchor.position.set(0, h * 0.88, 0);
    this.chestAnchor.position.set(0, h * 0.65, 0);
    this.castAnchor.position.set(0, h * 0.72, 0);

    // Add eye glow sprites
    this._addEyeGlow();
    // Add chest energy core
    this._addChestCore();
  }

  _addEyeGlow() {
    const eyeGeo = new THREE.SphereGeometry(0.05, 8, 8);
    const eyeL = new THREE.Mesh(eyeGeo, this.eyeMat);
    eyeL.position.set(-0.12, 0, 0.08);
    const eyeR = new THREE.Mesh(eyeGeo, this.eyeMat);
    eyeR.position.set(0.12, 0, 0.08);
    this.eyeAnchor.add(eyeL, eyeR);
    this._eyeMeshes = [eyeL, eyeR];

    // Point light for eye glow
    this._eyeLight = new THREE.PointLight(0xff1010, 2, 4, 2);
    this._eyeLight.position.set(0, 0, 0.1);
    this.eyeAnchor.add(this._eyeLight);
  }

  _addChestCore() {
    // Dark red energy core in chest
    const coreGeo = new THREE.SphereGeometry(0.12, 12, 12);
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xff2010, transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._chestCore = new THREE.Mesh(coreGeo, coreMat);
    this._chestCoreMat = coreMat;
    this.chestAnchor.add(this._chestCore);

    // Point light for chest glow
    this._chestLight = new THREE.PointLight(0xff2010, 3, 5, 2);
    this.chestAnchor.add(this._chestLight);
  }

  // ---- Animation system ----

  _initAnimationSystem(animations) {
    if (!animations || animations.length === 0) return;
    this._mixer = new THREE.AnimationMixer(this._gltfScene);
    // Map clips by name
    for (const clip of animations) {
      const name = clip.name;
      if (ANIM_NAMES.includes(name)) {
        const action = this._mixer.clipAction(clip);
        // Set loop properties
        if (name === 'Idle' || name === 'PhaseChange') {
          action.setLoop(THREE.LoopRepeat, Infinity);
        } else {
          action.setLoop(THREE.LoopOnce, 1);
          action.clampWhenFinished = true;
        }
        this._animations[name] = action;
      }
    }
    console.log('[WardenBoss] Animations loaded:', Object.keys(this._animations).join(', '));
  }

  /**
   * Play an animation by name with fade in/out.
   * @param {string} animName - one of ANIM_NAMES
   * @param {number} [fadeTime] - override fade duration
   * @param {boolean} [force] - force restart even if same anim
   */
  playAnim(animName, fadeTime, force) {
    if (!this._hasAnims || !this._mixer) return;
    const action = this._animations[animName];
    if (!action) return;

    fadeTime = fadeTime !== undefined ? fadeTime : this._animFadeTime;

    // Don't restart same animation unless forced
    if (this._currentAnimName === animName && !force) return;

    // Fade out current
    if (this._currentAction && this._currentAction !== action) {
      this._currentAction.fadeOut(fadeTime);
    }

    // Fade in new
    action.reset();
    action.setEffectiveWeight(1);
    action.setEffectiveTimeScale(1);
    action.fadeIn(fadeTime);
    action.play();

    this._currentAction = action;
    this._currentAnimName = animName;
  }

  /**
   * Set boss state and auto-map to animation.
   * Called by WardenAI / BossBattleController.
   * @param {string} state - boss logic state (IDLE, TELEGRAPH, MAGIC_BOLT, etc.)
   */
  setBossState(state) {
    this._bossState = state;
    const animName = STATE_ANIM_MAP[state];
    if (animName) {
      if (state === 'DEAD') {
        this.playAnim('Death', 0.2, true);
      } else if (state === 'PHASE_CHANGE') {
        this.playAnim('PhaseChange', 0.3, true);
      } else {
        this.playAnim(animName, this._animFadeTime);
      }
    }
  }

  // ---- Procedural fallback (original model) ----

  _buildFallbackMesh() {
    const armorMat = new THREE.MeshStandardMaterial({
      color: 0x2a2530, roughness: 0.45, metalness: 0.7,
    });
    const armorDarkMat = new THREE.MeshStandardMaterial({
      color: 0x1a1620, roughness: 0.55, metalness: 0.6,
    });

    const add = (mesh, x, y, z) => {
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      this.visualRoot.add(mesh);
      return mesh;
    };

    add(new THREE.Mesh(new THREE.ConeGeometry(1.0, 1.6, 12, 1, true), armorDarkMat), 0, 0.8, 0);
    add(new THREE.Mesh(new THREE.CapsuleGeometry(0.65, 1.0, 8, 16), armorMat), 0, 2.0, 0);
    add(new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 12), armorMat), -0.72, 2.55, 0);
    add(new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 12), armorMat), 0.72, 2.55, 0);

    const chestRune = add(new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.6), this.runeMat), 0, 2.1, 0.62);
    chestRune.rotation.x = -0.1;

    add(new THREE.Mesh(new THREE.SphereGeometry(0.38, 14, 14, 0, Math.PI * 2, 0, Math.PI * 0.7), armorDarkMat), 0, 2.95, 0);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.3, 0.12), armorMat), 0, 2.82, 0.34);
    const eyeL = add(new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), this.eyeMat), -0.13, 2.86, 0.36);
    const eyeR = add(new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), this.eyeMat), 0.13, 2.86, 0.36);

    // Staff
    const staff = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.08, 2.8, 8),
      new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.8 })
    );
    pole.castShadow = true;
    staff.add(pole);
    const hammer = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.35), armorMat);
    hammer.position.y = 1.55;
    hammer.castShadow = true;
    staff.add(hammer);
    const hammerRune = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.06, 0.37), this.runeMat);
    hammerRune.position.y = 1.4;
    staff.add(hammerRune);
    staff.position.set(0.85, 1.0, 0.15);
    staff.rotation.z = -0.08;
    this.visualRoot.add(staff);
    this.hammerRune = hammerRune;

    this._flashMaterials = [armorMat, armorDarkMat];
    this._modelHeight = 3.1;

    // Position anchors for fallback
    this.eyeAnchor.position.set(0, 2.86, 0);
    this.chestAnchor.position.set(0, 2.1, 0);
    this.castAnchor.position.set(0, 2.2, 0);

    this._addEyeGlow();
    this._addChestCore();
  }

  // ---- Effects (shared) ----

  _buildEffects() {
    this._buildFog();
    this._buildGroundRune();
  }

  _buildFog() {
    const n = IS_MOBILE ? 20 : 40;
    const geo = new THREE.BufferGeometry();
    this._fogPos = new Float32Array(n * 3);
    this._fogVel = new Float32Array(n * 3);
    this._fogPhase = new Float32Array(n);
    this._fogSize = new Float32Array(n);
    geo.setAttribute('position', new THREE.BufferAttribute(this._fogPos, 3));

    this.fogMat = new THREE.PointsMaterial({
      color: 0x8a2020, size: 0.5, transparent: true, opacity: 0.3,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    this.fog = new THREE.Points(geo, this.fogMat);
    this.fog.frustumCulled = false;
    this.fog.visible = false;
    this.scene.add(this.fog);
    this._fogN = n;

    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.8 + Math.random() * 0.8;
      this._fogPos[i * 3] = Math.cos(a) * r;
      this._fogPos[i * 3 + 1] = 0.2 + Math.random() * 2.5;
      this._fogPos[i * 3 + 2] = Math.sin(a) * r;
      this._fogVel[i * 3] = (Math.random() - 0.5) * 0.3;
      this._fogVel[i * 3 + 1] = 0.2 + Math.random() * 0.3;
      this._fogVel[i * 3 + 2] = (Math.random() - 0.5) * 0.3;
      this._fogPhase[i] = Math.random() * Math.PI * 2;
      this._fogSize[i] = 0.3 + Math.random() * 0.4;
    }
  }

  _buildGroundRune() {
    this.groundRuneMat = new THREE.MeshBasicMaterial({
      color: 0xc82020, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.groundRune = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.2, 32),
      this.groundRuneMat
    );
    this.groundRune.rotation.x = -Math.PI / 2;
    this.groundRune.visible = false;
    this.scene.add(this.groundRune);
  }

  showIntroRune() {
    this.groundRune.visible = true;
    this.groundRuneMat.opacity = 0;
  }

  // ---- Public API (unchanged interface) ----

  get isModelReady() {
    return this._modelLoaded;
  }

  get isInvincible() {
    return this._invulnT > 0;
  }

  get headPosition() {
    return new THREE.Vector3(this.position.x, this.position.y + this._modelHeight * 0.88, this.position.z);
  }

  getCastOrigin(out) {
    return out.set(
      this.position.x + Math.sin(this._facing) * 1.0,
      this.position.y + this._modelHeight * 0.72,
      this.position.z + Math.cos(this._facing) * 1.0
    );
  }

  setCastGlow(v) {
    this._castGlow = v;
  }

  setInvulnerable(t) {
    this._invulnT = Math.max(this._invulnT, t);
  }

  faceTowards(point, dt) {
    const targetYaw = Math.atan2(point.x - this.position.x, point.z - this.position.z);
    let diff = targetYaw - this._facing;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this._facing += diff * Math.min(1, dt * 4);
  }

  update(dt, arenaRadius) {
    // Update animation mixer
    if (this._mixer) {
      this._mixer.update(dt);
    }

    // Chest core pulsing
    if (this._chestCoreMat) {
      const pulse = 0.6 + Math.sin(performance.now() * 0.004) * 0.2 + this._castGlow * 0.4;
      this._chestCoreMat.opacity = pulse;
    }
    if (this._chestLight) {
      this._chestLight.intensity = 2 + this._castGlow * 4;
    }
    if (this._eyeLight) {
      this._eyeLight.intensity = 1.5 + this._castGlow * 3;
    }

    // Rune glow
    this.runeMat.emissiveIntensity = 0.8 + this._castGlow * 2.5;

    // Eye glow
    this.eyeMat.emissiveIntensity = 2.5 + Math.sin(performance.now() * 0.005) * 0.5 + this._castGlow * 2;

    if (this.dead) {
      this._deathT += dt;
      const dp = Math.min(1, this._deathT / 2.0);
      // If no skeletal Death anim, use procedural death
      if (!this._hasAnims || !this._animations['Death']) {
        this.group.rotation.x = -dp * 0.6;
        this.group.position.y = -dp * 1.2;
      }
      // Flickering runes
      this.runeMat.emissiveIntensity = 0.5 + Math.sin(this._deathT * 20) * 2;
      this.eyeMat.emissiveIntensity = Math.max(0, 3 - this._deathT * 1.5);
      if (this._chestCoreMat) this._chestCoreMat.opacity = Math.max(0, 0.8 - this._deathT * 0.4);
      return;
    }

    this.cooldown = Math.max(0, this.cooldown - dt);
    this.stagger = Math.max(0, this.stagger - dt);
    this._invulnT = Math.max(0, this._invulnT - dt);
    this.skill1Cd = Math.max(0, this.skill1Cd - dt);
    this.skill2Cd = Math.max(0, this.skill2Cd - dt);

    if (this._slowT > 0) {
      this._slowT -= dt;
      if (this._slowT <= 0) this.speedMult = 1;
    }

    // Hit flash on all materials
    if (this._flash > 0) {
      this._flash -= dt;
      const flashAmount = Math.max(0, this._flash) / 0.15;
      for (const mat of this._flashMaterials) {
        if (mat.emissive) {
          mat.emissive.setHex(0xff3030);
          mat.emissiveIntensity = flashAmount * 1.5;
        }
      }
    } else {
      for (const mat of this._flashMaterials) {
        if (mat.emissive && mat._origEmissive !== undefined) {
          mat.emissive.setHex(mat._origEmissive);
          mat.emissiveIntensity = mat._origEmissiveIntensity;
        } else if (mat.emissive) {
          mat.emissiveIntensity = 0;
        }
      }
    }

    // Movement
    if (this.stagger <= 0 && this.moveIntent.lengthSq() > 0.001) {
      this.position.addScaledVector(this.moveIntent, this.speed * this.speedMult * dt);
    }

    // Arena bounds
    const flat = Math.hypot(this.position.x, this.position.z);
    const maxR = arenaRadius - this.radius;
    if (flat > maxR) {
      this.position.x *= maxR / flat;
      this.position.z *= maxR / flat;
    }

    this.group.position.copy(this.position);
    this.group.rotation.y = this._facing;

    // Ground rune follows
    this.groundRune.position.set(this.position.x, 0.05, this.position.z);
    if (this.groundRune.visible) {
      this.groundRuneMat.opacity = 0.4 + Math.sin(performance.now() * 0.003) * 0.2;
    }

    // Fog
    if (this.fog.visible) {
      this._updateFog(dt);
    }

    // Procedural idle breathing — only if no skeletal animations
    if (this.visualRoot && !this._hasAnims) {
      const breath = Math.sin(performance.now() * 0.0015) * 0.02;
      this.visualRoot.position.y = breath;
    }
  }

  _updateFog(dt) {
    const n = this._fogN;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      this._fogPhase[i] += dt;
      this._fogPos[i3] += this._fogVel[i3] * dt + Math.sin(this._fogPhase[i] * 1.3) * 0.01;
      this._fogPos[i3 + 1] += this._fogVel[i3 + 1] * dt;
      this._fogPos[i3 + 2] += this._fogVel[i3 + 2] * dt + Math.cos(this._fogPhase[i] * 1.1) * 0.01;
      if (this._fogPos[i3 + 1] > 3.5) {
        const a = Math.random() * Math.PI * 2;
        const r = 0.8 + Math.random() * 0.8;
        this._fogPos[i3] = Math.cos(a) * r;
        this._fogPos[i3 + 1] = 0.2;
        this._fogPos[i3 + 2] = Math.sin(a) * r;
      }
    }
    const bx = this.position.x, bz = this.position.z;
    const worldPos = this.fog.geometry.attributes.position.array;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      worldPos[i3] = bx + this._fogPos[i3];
      worldPos[i3 + 1] = this._fogPos[i3 + 1];
      worldPos[i3 + 2] = bz + this._fogPos[i3 + 2];
    }
    this.fog.geometry.attributes.position.needsUpdate = true;
  }

  takeDamage(amount) {
    if (this.dead || this._invulnT > 0) return;
    this.hp = Math.max(0, this.hp - amount);
    this._flash = 0.15;
    // Trigger Hit animation (only if not currently in Death/PhaseChange)
    if (this._hasAnims && this._currentAnimName !== 'Death' && this._currentAnimName !== 'PhaseChange') {
      this.playAnim('Hit', 0.1, true);
    }
    if (this.hp <= 0) {
      this.dead = true;
      this._deathT = 0;
      this.setBossState('DEAD');
      this.onDeath && this.onDeath(this);
    }
  }

  applyImpact(dir, power = 1) {}

  applySlow(mult, duration) {
    this.speedMult = mult;
    this._slowT = duration;
  }

  onCast() {
    // Trigger Cast animation when boss attacks
    if (this._hasAnims && this._currentAnimName !== 'Death') {
      this.playAnim('Cast', 0.1, true);
    }
  }

  setPhase2() {
    this.phase2 = true;
    this.runeMat.emissive.setHex(0xff3030);
    this.runeMat.emissiveIntensity = 2.0;
    this.fogMat.opacity = 0.5;
    if (this._chestCoreMat) this._chestCoreMat.opacity = 1.0;
    if (this._chestLight) this._chestLight.intensity = 4;
    // PhaseChange animation handled by BossBattleController via setBossState('PHASE_CHANGE')
  }

  show() {
    this.group.visible = true;
    this.fog.visible = true;
  }

  hide() {
    this.group.visible = false;
    this.fog.visible = false;
    this.groundRune.visible = false;
  }

  reset() {
    this.dead = false;
    this.hp = this.maxHp;
    this.phase2 = false;
    this._deathT = 0;
    this._flash = 0;
    this._castGlow = 0;
    this._invulnT = 0;
    this.cooldown = 0;
    this.stagger = 0;
    this.skill1Cd = 0;
    this.skill2Cd = 0;
    this.speedMult = 1;
    this._slowT = 0;
    this.moveIntent.set(0, 0, 0);
    this.position.copy(this.spawnPosition);
    this.group.rotation.set(0, 0, 0);
    this.group.position.copy(this.position);
    this.runeMat.emissive.setHex(0xc82020);
    this.runeMat.emissiveIntensity = 1.2;
    this.fogMat.opacity = 0.3;
    if (this._chestCoreMat) this._chestCoreMat.opacity = 0.8;
    if (this._chestLight) this._chestLight.intensity = 3;

    // Reset flash materials
    for (const mat of this._flashMaterials) {
      if (mat.emissive && mat._origEmissive !== undefined) {
        mat.emissive.setHex(mat._origEmissive);
        mat.emissiveIntensity = mat._origEmissiveIntensity;
      }
    }

    // Reset animations — stop all, return to Idle
    if (this._mixer) {
      for (const name of Object.keys(this._animations)) {
        this._animations[name].stop();
      }
      this._currentAction = null;
      this._currentAnimName = null;
      this._bossState = 'IDLE';
      this.playAnim('Idle', 0.1, true);
    }
  }
}
