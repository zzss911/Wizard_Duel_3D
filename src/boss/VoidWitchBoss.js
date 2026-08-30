import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

/**
 * VoidWitchBoss —— 虚空女巫 Boss
 *
 * 高速、悬浮、远程施法、空间魔法。
 * 黑紫 / 深蓝 / 冷白 主视觉。
 *
 * GLB 尝试加载 → 失败 → procedural fallback。
 * Loader cache 与 Warden 独立，只一次受控 console.warn。
 *
 * GLB ownership:
 *   - Module caches the GLB *source* asset (scene + animations).
 *   - Each VoidWitchBoss instance gets its own scene clone via
 *     SkeletonUtils.clone() — never shares the same Object3D.
 *   - Materials are per-instance (cloned after skeletonClone so each
 *     boss can independently modify emissive).
 *   - Geometry is shared (source-owned) and NOT disposed by instances.
 *   - Procedural fallback meshes own their geometry + material.
 */

// ---- Module-level GLB loader cache (independent from Warden) ----
// Future path constant — kept for when the GLB asset becomes available.
// Currently disabled to avoid 404 network errors; procedural fallback is used directly.
const VOID_WITCH_GLB_PATH = './assets/models/void_witch_rigged.glb';
const VOID_WITCH_GLB_ENABLED = false;

let _vwLoader = null;
let _vwLoadPromise = null;

function loadVoidWitchGLB() {
  if (_vwLoadPromise) return _vwLoadPromise;

  if (!VOID_WITCH_GLB_ENABLED) {
    // GLB not available — reject immediately without network request.
    // Procedural fallback in _loadModel handles this gracefully.
    _vwLoadPromise = Promise.reject(new Error('GLB disabled — using procedural fallback'));
    return _vwLoadPromise;
  }

  if (!_vwLoader) _vwLoader = new GLTFLoader();
  _vwLoadPromise = new Promise((resolve, reject) => {
    _vwLoader.load(
      VOID_WITCH_GLB_PATH,
      (gltf) => resolve({ scene: gltf.scene, animations: gltf.animations || [] }),
      undefined,
      (err) => reject(err)
    );
  });
  return _vwLoadPromise;
}

// ---- Color palette ----
const COL = {
  robe: 0x1a0e2e,
  robeLight: 0x2a1840,
  skin: 0xc8b8e0,
  eye: 0xe0d8ff,
  voidCore: 0x8a4adf,
  voidGlow: 0x6f3cff,
  orb: 0x4a6fff,
  ring: 0x7a3adf,
  fog: 0x6a3acf,
  rune: 0x8a4adf,
  flash: 0xc0a0ff,
};

const FLOAT_Y = 0.4;

export class VoidWitchBoss {
  constructor(scene) {
    this.scene = scene;
    this.isBoss = true;
    this.isEnemy = true;

    this.maxHp = 560;
    this.hp = this.maxHp;
    this.radius = 0.8;
    this.speed = 3.2;
    this.FLOAT_Y = FLOAT_Y;
    this.dead = false;

    this.spawnPosition = new THREE.Vector3(0, 0, -10);
    this.position = this.spawnPosition.clone();
    this._facing = 0;

    this.moveIntent = new THREE.Vector3();
    this._flash = 0;
    this._castGlow = 0;
    this._deathT = 0;

    this.speedMult = 1;
    this._slowT = 0;
    this._invulnT = 0;
    this.phase2 = false;
    this.onDeath = null;

    // Model loading state
    this._modelLoaded = false;
    this._modelLoading = false;
    this._usingFallback = false;
    this._usingGLB = false;
    this._destroyed = false;
    this._modelHeight = 2.4;

    // Ownership tracking — only resources this instance created
    this._ownedGeometries = new Set();
    this._ownedMaterials = new Set();

    // Procedural animation state
    this._vwState = 'IDLE';
    this._idleTime = 0;
    this._floatPhase = 0;
    this._ringRotation = 0;
    this._phaseChangeT = 0;
    this._hitFlashT = 0;

    // Debug compatibility (Game.js _updateDebug accesses these)
    this._currentAnim = null;
    this._mixer = null;

    // Flash materials (for hit flash)
    this._flashMaterials = [];

    // Blink state
    this._blinkActive = false;
    this._blinkMarker = null;
    this._blinkMarkerMat = null;

    // Mirror real tell state
    this._mirrorTellActive = false;

    // Cinematic hook state
    this._cinematicKind = null;
    this._cinematicT = 0;
    this._cinematicCtx = null;
    this._vwIntroShown = false;
    this._vwIntroSlam = false;
    this._vwIntroShake = false;
    this._vwPhaseChangeBurst = false;
    this._vwDeathStage = 0;

    // Build everything
    this._buildGroup();
    this._buildEffects();

    this.group.position.copy(this.position);
    this.group.visible = false;
    this.scene.add(this.group);

    // Start loading GLB
    this._loadModel();
  }

  // ==================== Group / Model ====================

  _buildGroup() {
    this.group = new THREE.Group();
    this.visualRoot = new THREE.Group();
    this.group.add(this.visualRoot);
  }

  _loadModel() {
    if (this._modelLoading || this._modelLoaded) return;
    this._modelLoading = true;

    loadVoidWitchGLB()
      .then((result) => {
        if (this._destroyed) return;
        // Clone the cached source scene so each instance owns its own Object3D.
        const instanceScene = skeletonClone(result.scene);
        this._setupGLBModel(instanceScene, result.animations);
        this._modelLoaded = true;
        this._modelLoading = false;
      })
      .catch(() => {
        if (this._destroyed) return;
        // GLB intentionally disabled — use procedural fallback directly.
        // No console.warn needed since this is expected behavior.
        this._buildFallbackMesh();
        this._modelLoaded = true;
        this._modelLoading = false;
      });
  }

  _setupGLBModel(gltfScene, animations) {
    // Scale model to target height
    const box = new THREE.Box3().setFromObject(gltfScene);
    const size = box.getSize(new THREE.Vector3());
    const scale = 2.4 / Math.max(0.1, size.y);
    gltfScene.scale.setScalar(scale);

    // Recompute bounding box after scaling
    const box2 = new THREE.Box3().setFromObject(gltfScene);
    const size2 = box2.getSize(new THREE.Vector3());
    this._modelHeight = size2.y;

    // Enable shadows, clone materials per-instance so each boss can
    // independently modify emissive. Geometry stays shared (source-owned)
    // and is NOT added to _ownedGeometries.
    gltfScene.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;

        const clonedMats = [];
        if (Array.isArray(child.material)) {
          for (const m of child.material) {
            const cloned = m.clone();
            this._ownedMaterials.add(cloned);
            if (cloned.emissive) {
              cloned._origEmissive = cloned.emissive.getHex();
              cloned._origEmissiveIntensity = cloned.emissiveIntensity || 0;
            }
            clonedMats.push(cloned);
          }
          child.material = clonedMats;
        } else {
          const cloned = child.material.clone();
          this._ownedMaterials.add(cloned);
          if (cloned.emissive) {
            cloned._origEmissive = cloned.emissive.getHex();
            cloned._origEmissiveIntensity = cloned.emissiveIntensity || 0;
          }
          child.material = cloned;
          clonedMats.push(cloned);
        }

        for (const cm of clonedMats) {
          if (!this._flashMaterials.includes(cm)) {
            this._flashMaterials.push(cm);
          }
        }
      }
    });

    this._usingGLB = true;
    this._gltfScene = gltfScene;
    this.visualRoot.add(gltfScene);

    // Add Void Witch specific effects
    this._addVoidCore();
    this._addArcaneRings();
    this._addFloatingOrb();
  }

  _buildFallbackMesh() {
    // Female humanoid mage silhouette — slender, floating, dark purple
    const robeMat = new THREE.MeshStandardMaterial({
      color: COL.robe, roughness: 0.6, metalness: 0.3,
    });
    const torsoMat = new THREE.MeshStandardMaterial({
      color: COL.robeLight, roughness: 0.5, metalness: 0.4,
    });
    const skinMat = new THREE.MeshStandardMaterial({
      color: COL.skin, roughness: 0.3, metalness: 0.1,
    });

    // Track procedural material ownership
    this._ownedMaterials.add(robeMat);
    this._ownedMaterials.add(torsoMat);
    this._ownedMaterials.add(skinMat);

    // Robe — inverted cone for flowing robe (not too long)
    const robeGeo = new THREE.ConeGeometry(0.55, 1.4, 10, 1, true);
    this._ownedGeometries.add(robeGeo);
    const robe = new THREE.Mesh(robeGeo, robeMat);
    robe.position.y = 0.7;
    robe.castShadow = true;

    // Torso upper — slender capsule
    const torsoGeo = new THREE.CapsuleGeometry(0.22, 0.5, 8, 12);
    this._ownedGeometries.add(torsoGeo);
    const torso = new THREE.Mesh(torsoGeo, torsoMat);
    torso.position.y = 1.4;
    torso.castShadow = true;

    // Head — sphere
    const headGeo = new THREE.SphereGeometry(0.18, 12, 12);
    this._ownedGeometries.add(headGeo);
    const head = new THREE.Mesh(headGeo, skinMat);
    head.position.y = 1.85;
    head.castShadow = true;

    // Hood — cone over head
    const hoodGeo = new THREE.ConeGeometry(0.25, 0.4, 8);
    this._ownedGeometries.add(hoodGeo);
    const hood = new THREE.Mesh(hoodGeo, robeMat);
    hood.position.y = 2.0;
    hood.castShadow = true;

    // Arms — thin capsules
    const armLGeo = new THREE.CapsuleGeometry(0.08, 0.5, 6, 8);
    this._ownedGeometries.add(armLGeo);
    const armL = new THREE.Mesh(armLGeo, robeMat);
    armL.position.set(-0.28, 1.4, 0);
    armL.rotation.z = 0.3;
    armL.castShadow = true;

    const armRGeo = new THREE.CapsuleGeometry(0.08, 0.5, 6, 8);
    this._ownedGeometries.add(armRGeo);
    const armR = new THREE.Mesh(armRGeo, robeMat);
    armR.position.set(0.28, 1.4, 0);
    armR.rotation.z = -0.3;
    armR.castShadow = true;

    // Add all to visual root
    this.visualRoot.add(robe, torso, head, hood, armL, armR);

    // Set flash materials
    this._flashMaterials = [robeMat, torsoMat, skinMat];

    // Set model height
    this._modelHeight = 2.4;

    // Add Void Witch specific effects
    this._addVoidCore();
    this._addArcaneRings();
    this._addFloatingOrb();
  }

  // ==================== Void Core (chest) ====================

  _addVoidCore() {
    const coreGeo = new THREE.SphereGeometry(0.1, 12, 12);
    this._ownedGeometries.add(coreGeo);
    const coreMat = new THREE.MeshBasicMaterial({
      color: COL.voidCore, transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._ownedMaterials.add(coreMat);
    this._voidCore = new THREE.Mesh(coreGeo, coreMat);
    this._voidCore.position.set(0, 1.5, 0.15);
    this._voidCoreMat = coreMat;
    this.visualRoot.add(this._voidCore);

    // Point light for void core glow
    this._coreLight = new THREE.PointLight(COL.voidGlow, 3.5, 4, 2);
    this._coreLight.position.set(0, 1.5, 0.2);
    this.visualRoot.add(this._coreLight);
  }

  // ==================== Arcane Rings ====================

  _addArcaneRings() {
    // Ring 1 — horizontal, around waist
    const ring1Geo = new THREE.TorusGeometry(0.5, 0.02, 8, 32);
    this._ownedGeometries.add(ring1Geo);
    const ring1Mat = new THREE.MeshBasicMaterial({
      color: COL.ring, transparent: true, opacity: 0.6,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._ownedMaterials.add(ring1Mat);
    this._arcaneRing1 = new THREE.Mesh(ring1Geo, ring1Mat);
    this._arcaneRing1.position.set(0, 1.3, 0);
    this._arcaneRing1.rotation.x = Math.PI / 2;
    this._arcaneRing1Mat = ring1Mat;
    this.visualRoot.add(this._arcaneRing1);

    // Ring 2 — tilted, around upper body
    const ring2Geo = new THREE.TorusGeometry(0.35, 0.015, 8, 32);
    this._ownedGeometries.add(ring2Geo);
    const ring2Mat = new THREE.MeshBasicMaterial({
      color: COL.ring, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._ownedMaterials.add(ring2Mat);
    this._arcaneRing2 = new THREE.Mesh(ring2Geo, ring2Mat);
    this._arcaneRing2.position.set(0, 1.6, 0);
    this._arcaneRing2.rotation.x = Math.PI / 2 + 0.3;
    this._arcaneRing2.rotation.z = 0.2;
    this._arcaneRing2Mat = ring2Mat;
    this.visualRoot.add(this._arcaneRing2);
  }

  // ==================== Floating Orb ====================

  _addFloatingOrb() {
    const orbGeo = new THREE.SphereGeometry(0.08, 12, 12);
    this._ownedGeometries.add(orbGeo);
    const orbMat = new THREE.MeshBasicMaterial({
      color: COL.orb, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._ownedMaterials.add(orbMat);
    this._floatingOrb = new THREE.Mesh(orbGeo, orbMat);
    this._floatingOrb.position.set(0.35, 1.5, 0.2);
    this._floatingOrbMat = orbMat;
    this.visualRoot.add(this._floatingOrb);

    // Point light for orb glow
    this._orbLight = new THREE.PointLight(COL.orb, 1.5, 3, 2);
    this._orbLight.position.copy(this._floatingOrb.position);
    this.visualRoot.add(this._orbLight);
  }

  // ==================== Effects (fog + ground rune) ====================

  _buildEffects() {
    this._buildFog();
    this._buildGroundRune();
  }

  _buildFog() {
    const n = 40;
    const geo = new THREE.BufferGeometry();
    this._ownedGeometries.add(geo);
    this._fogPos = new Float32Array(n * 3);
    this._fogVel = new Float32Array(n * 3);
    this._fogPhase = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.6 + Math.random() * 0.8;
      this._fogPos[i * 3] = Math.cos(a) * r;
      this._fogPos[i * 3 + 1] = 0.2 + Math.random() * 2.0;
      this._fogPos[i * 3 + 2] = Math.sin(a) * r;
      this._fogVel[i * 3] = (Math.random() - 0.5) * 0.2;
      this._fogVel[i * 3 + 1] = 0.15 + Math.random() * 0.2;
      this._fogVel[i * 3 + 2] = (Math.random() - 0.5) * 0.2;
      this._fogPhase[i] = Math.random() * Math.PI * 2;
    }

    this.fogMat = new THREE.PointsMaterial({
      color: COL.fog, size: 0.4, transparent: true, opacity: 0.25,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    this._ownedMaterials.add(this.fogMat);

    // Set position attribute on geometry BEFORE creating Points
    geo.setAttribute('position', new THREE.BufferAttribute(this._fogPos, 3));

    this.fog = new THREE.Points(geo, this.fogMat);
    this.fog.frustumCulled = false;
    this.fog.visible = false;

    // Positions already set in _fogPos array above
    this._fogN = n;

    this.scene.add(this.fog);
  }

  _buildGroundRune() {
    this.groundRuneMat = new THREE.MeshBasicMaterial({
      color: COL.rune, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this._ownedMaterials.add(this.groundRuneMat);

    const runeGeo = new THREE.RingGeometry(0.7, 1.0, 32);
    this._ownedGeometries.add(runeGeo);
    this.groundRune = new THREE.Mesh(runeGeo, this.groundRuneMat);
    this.groundRune.rotation.x = -Math.PI / 2;
    this.groundRune.visible = false;
    this.scene.add(this.groundRune);
  }

  // ==================== Public API ====================

  get isModelReady() {
    return this._modelLoaded;
  }

  get isInvincible() {
    return this._invulnT > 0;
  }

  get headPosition() {
    return new THREE.Vector3(
      this.position.x,
      FLOAT_Y + this._modelHeight * 0.85,
      this.position.z
    );
  }

  getCastOrigin(out) {
    return out.set(
      this.position.x + Math.sin(this._facing) * 0.6,
      FLOAT_Y + this._modelHeight * 0.6,
      this.position.z + Math.cos(this._facing) * 0.6
    );
  }

  setCastGlow(v) {
    this._castGlow = v;
  }

  setInvulnerable(t) {
    this._invulnT = Math.max(this._invulnT, t);
  }

  /** Clear all invulnerability (used by blink cleanup / cancel) */
  clearInvulnerability() {
    this._invulnT = 0;
  }

  faceTowards(point, dt) {
    const targetYaw = Math.atan2(point.x - this.position.x, point.z - this.position.z);
    let diff = targetYaw - this._facing;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    // Void Witch turns faster — more agile
    this._facing += diff * Math.min(1, dt * 6);
  }

  showIntroRune() {
    this.groundRune.visible = true;
    this.groundRuneMat.opacity = 0;
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
    this.speedMult = 1;
    this._slowT = 0;
    this._vwState = 'IDLE';
    this._idleTime = 0;
    this._floatPhase = 0;
    this._ringRotation = 0;
    this._phaseChangeT = 0;
    this._hitFlashT = 0;
    this._mirrorTellActive = false;
    this._currentAnim = 'Idle';
    this.moveIntent.set(0, 0, 0);
    // Cancel any in-progress blink
    this._blinkActive = false;
    if (this.visualRoot) {
      this.visualRoot.scale.setScalar(1);
    }
    this.hideBlinkMarker();
    this.position.copy(this.spawnPosition);
    this.group.rotation.set(0, 0, 0);
    this.group.position.copy(this.position);

    // Reset visual root
    if (this.visualRoot) {
      this.visualRoot.scale.setScalar(1);
      this.visualRoot.position.y = FLOAT_Y;
    }

    // Reset flash materials
    for (const mat of this._flashMaterials) {
      if (mat.emissive && mat._origEmissive !== undefined) {
        mat.emissive.setHex(mat._origEmissive);
        mat.emissiveIntensity = mat._origEmissiveIntensity;
      }
    }
  }

  takeDamage(amount) {
    if (this.dead || this._invulnT > 0) return;
    this.hp = Math.max(0, this.hp - amount);
    this._flash = 0.15;
    this._hitFlashT = 0.15;

    if (this.hp <= 0) {
      // Clear temporary visual states
      this._slowT = 0;
      this._hitFlashT = 0;
      this.speedMult = 1;
      this._flash = 0;
      for (const mat of this._flashMaterials) {
        if (mat.emissive && mat._origEmissive !== undefined) {
          mat.emissive.setHex(mat._origEmissive);
          mat.emissiveIntensity = mat._origEmissiveIntensity;
        }
      }

      this.dead = true;
      this._deathT = 0;
      this._vwState = 'DEAD';
      this._currentAnim = 'Death';
      this.onDeath && this.onDeath(this);
    }
  }

  applyImpact(dir, power = 1) {
    // Void Witch is light — impact affects her more
  }

  applySlow(mult, duration) {
    this.speedMult = mult;
    this._slowT = duration;
  }

  setPhase2() {
    this.phase2 = true;
    // Enhance void core and rings
    if (this._voidCoreMat) this._voidCoreMat.opacity = 1.0;
    if (this._coreLight) this._coreLight.intensity = 4;
    if (this._arcaneRing1Mat) this._arcaneRing1Mat.opacity = 0.8;
    if (this._arcaneRing2Mat) this._arcaneRing2Mat.opacity = 0.7;
  }

  /**
   * Subtle "real tell" for Mirror Domain.
   * When active, the real boss is slightly brighter (core light + ring opacity)
   * so observant players can distinguish it from clones.
   * Uses independent multipliers that don't interfere with Hit > Slow > Original
   * emissive priority — only affects core light intensity and ring material opacity.
   * @param {boolean} active
   */
  setMirrorRealTell(active) {
    this._mirrorTellActive = active;
    if (!active) {
      // Restore to phase baseline
      if (this._coreLight) {
        this._coreLight.intensity = this.phase2 ? 4 : 3.5;
      }
      if (this._arcaneRing1Mat) {
        this._arcaneRing1Mat.opacity = this.phase2 ? 0.8 : 0.6;
      }
      if (this._arcaneRing2Mat) {
        this._arcaneRing2Mat.opacity = this.phase2 ? 0.7 : 0.5;
      }
    }
    // When active, the update() loop applies the boosted values
  }

  // ==================== Blink Visual API ====================
  // AI = behavior/timing, Boss = visual.
  // All blink visual mutations live here so cancelBlink can fully restore.

  /** Called by AI when blink sequence begins. */
  beginBlink() {
    this._blinkActive = true;
    this._ensureBlinkMarker();
  }

  /**
   * Fade out boss body during vanish phase.
   * @param {number} progress 0→1 (0 = visible, 1 = fully vanished)
   */
  setBlinkVanish(progress) {
    if (!this._blinkActive) return;
    const p = Math.max(0, Math.min(1, progress));
    if (this.visualRoot) {
      this.visualRoot.scale.setScalar(Math.max(0.01, 1 - p * 0.99));
    }
    if (this._voidCoreMat) {
      this._voidCoreMat.opacity = (1 - p) * 0.8;
    }
  }

  /**
   * Reappear animation: scale from small → full, fade core opacity back.
   * @param {number} progress 0→1
   */
  setBlinkReappear(progress) {
    if (!this._blinkActive) return;
    const p = Math.max(0, Math.min(1, progress));
    if (this.visualRoot) {
      this.visualRoot.scale.setScalar(Math.max(0.01, p));
    }
    if (this._voidCoreMat) {
      this._voidCoreMat.opacity = p * 0.8;
    }
  }

  /**
   * Instantly relocate the boss to a new position during blink.
   * @param {THREE.Vector3} position — new world position
   */
  teleportTo(position) {
    this.position.copy(position);
    this.position.y = 0;
    this.group.position.copy(this.position);
  }

  /**
   * End the blink sequence — fully restore visuals to phase baseline.
   */
  endBlink() {
    this._blinkActive = false;
    this._restoreBlinkVisuals();
    this.hideBlinkMarker();
  }

  /**
   * Cancel any in-progress blink (for interrupts).
   * Fully restores visuals to phase baseline.
   */
  cancelBlink() {
    if (!this._blinkActive) return;
    this._blinkActive = false;
    this._restoreBlinkVisuals();
    this.hideBlinkMarker();
  }

  /**
   * Restore all visuals that blink may have mutated.
   * - visualRoot scale → 1
   * - void core opacity → phase baseline (0.8 P1, 1.0 P2)
   *   (the normal update() pulse will take over next frame)
   */
  _restoreBlinkVisuals() {
    if (this.visualRoot) {
      this.visualRoot.scale.setScalar(1);
    }
    if (this._voidCoreMat) {
      this._voidCoreMat.opacity = this.phase2 ? 1.0 : 0.8;
    }
  }

  /**
   * Show the reusable blink destination marker at a position.
   * @param {THREE.Vector3} pos
   */
  showBlinkMarker(pos) {
    this._ensureBlinkMarker();
    this._blinkMarker.position.set(pos.x, 0.06, pos.z);
    this._blinkMarker.visible = true;
    if (this._blinkMarkerMat) {
      this._blinkMarkerMat.opacity = 0.6;
    }
  }

  /** Update blink marker opacity for telegraph ramp */
  setBlinkMarkerOpacity(opacity) {
    if (this._blinkMarkerMat && this._blinkMarker.visible) {
      this._blinkMarkerMat.opacity = Math.max(0, Math.min(1, opacity));
    }
  }

  /** Hide the blink marker */
  hideBlinkMarker() {
    if (this._blinkMarker) {
      this._blinkMarker.visible = false;
    }
  }

  /** Lazily create the reusable blink marker mesh */
  _ensureBlinkMarker() {
    if (this._blinkMarker) return;
    const geo = new THREE.RingGeometry(0.7, 1.0, 32);
    this._ownedGeometries.add(geo);
    const mat = new THREE.MeshBasicMaterial({
      color: COL.voidGlow, transparent: true, opacity: 0,
      side: THREE.DoubleSide, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this._ownedMaterials.add(mat);
    this._blinkMarker = new THREE.Mesh(geo, mat);
    this._blinkMarker.rotation.x = -Math.PI / 2;
    this._blinkMarker.visible = false;
    this.scene.add(this._blinkMarker);
    this._blinkMarkerMat = mat;
  }

  setBossState(state) {
    switch (state) {
      case 'IDLE':
        this._vwState = 'IDLE';
        this._currentAnim = 'Idle';
        break;
      case 'PHASE_CHANGE':
        this._vwState = 'PHASE_CHANGE';
        this._phaseChangeT = 0;
        this._currentAnim = 'PhaseChange';
        break;
      case 'DEAD':
        this._vwState = 'DEAD';
        this._currentAnim = 'Death';
        break;
      default:
        break;
    }
  }

  update(dt, arenaRadius) {
    // Update procedural animation timers
    this._idleTime += dt;
    this._floatPhase += dt;

    // --- Floating idle animation ---
    const floatY = FLOAT_Y + Math.sin(this._floatPhase * 1.5) * 0.08;

    // --- Arcane ring rotation ---
    this._ringRotation += dt * (this.phase2 ? 2.0 : 1.2);
    if (this._arcaneRing1) {
      this._arcaneRing1.rotation.z = this._ringRotation;
    }
    if (this._arcaneRing2) {
      this._arcaneRing2.rotation.y = this._ringRotation * 0.7;
    }

    // --- Mirror real tell: slightly brighter secondary ring ---
    if (this._mirrorTellActive) {
      if (this._arcaneRing2Mat) {
        this._arcaneRing2Mat.opacity = (this.phase2 ? 0.7 : 0.5) + 0.08;
      }
    }

    // --- Void core pulsing ---
    if (this._voidCoreMat) {
      const pulse = 0.5 + Math.sin(this._idleTime * 3) * 0.2 + this._castGlow * 0.3;
      this._voidCoreMat.opacity = pulse;
    }
    if (this._coreLight) {
      // Mirror real tell: ~5% brighter core light (subtle, not obvious)
      const tellBoost = this._mirrorTellActive ? 0.2 : 0;
      this._coreLight.intensity = (this.phase2 ? 4 : 3.5) + this._castGlow * 3 + tellBoost;
    }

    // --- Floating orb bobbing ---
    if (this._floatingOrb) {
      this._floatingOrb.position.y = 1.5 + Math.sin(this._floatPhase * 2) * 0.1;
      this._floatingOrb.position.x = 0.35 + Math.cos(this._floatPhase * 2) * 0.05;
    }
    if (this._orbLight && this._floatingOrb) {
      this._orbLight.position.copy(this._floatingOrb.position);
    }

    // --- Death animation ---
    // Skip if death cinematic hook is active (handles its own death visuals)
    if (this._vwState === 'DEAD' && this._cinematicKind !== 'death') {
      this._deathT += dt;
      const dp = Math.min(1, this._deathT / 2.5);

      // Stagger at start
      if (this._deathT < 0.3) {
        this.group.rotation.z = Math.sin(this._deathT * 30) * 0.05;
      } else {
        this.group.rotation.z = 0;
      }

      // Core brightness destabilizes — flickering
      if (this._voidCoreMat) {
        this._voidCoreMat.opacity = Math.max(0,
          0.8 - this._deathT * 0.3 + Math.sin(this._deathT * 15) * 0.2
        );
      }
      if (this._coreLight) {
        this._coreLight.intensity = Math.max(0,
          2 - this._deathT * 0.8 + Math.sin(this._deathT * 15) * 0.5
        );
      }

      // Scale/opacity fade — dissolve-like
      const fadeScale = 1 - dp * 0.5;
      this.visualRoot.scale.setScalar(fadeScale);

      // Rings accelerate and fade
      this._ringRotation += dt * 5;
      if (this._arcaneRing1Mat) this._arcaneRing1Mat.opacity = Math.max(0, 0.6 - dp * 0.6);
      if (this._arcaneRing2Mat) this._arcaneRing2Mat.opacity = Math.max(0, 0.5 - dp * 0.5);

      // Collapse toward center (sink down)
      this.group.position.y = -dp * 0.5;

      // Slowly fade out visual root
      if (dp > 0.5 && this.visualRoot) {
        this.visualRoot.scale.setScalar(fadeScale * (1 - (dp - 0.5) * 0.8));
      }

      return;
    }

    // --- Phase change animation ---
    // Skip if phase change cinematic hook is active
    if (this._vwState === 'PHASE_CHANGE' && this._cinematicKind !== 'phase_change') {
      this._phaseChangeT += dt;
      // Rise up
      const riseOffset = Math.sin(Math.min(1, this._phaseChangeT / 1.5) * Math.PI) * 0.3;
      this.visualRoot.position.y = floatY + riseOffset;
      // Ring acceleration
      this._ringRotation += dt * 4;
      // Core brightens
      if (this._voidCoreMat) {
        this._voidCoreMat.opacity = 0.8 + Math.sin(this._phaseChangeT * 5) * 0.2;
      }
    } else {
      // Normal idle position
      this.visualRoot.position.y = floatY;
    }

    // --- Emissive visual state priority: Hit > Slow > Original ---
    if (this._hitFlashT > 0) {
      this._hitFlashT -= dt;
      const flashAmount = Math.max(0, this._hitFlashT) / 0.15;
      for (const mat of this._flashMaterials) {
        if (mat.emissive) {
          mat.emissive.setHex(COL.flash);
          mat.emissiveIntensity = flashAmount * 1.5;
        }
      }
    } else if (this._slowT > 0 && this._flashMaterials.length > 0) {
      // Slow visual: purple-blue pulse
      const pulse = 0.3 + Math.sin(this._slowT * 8) * 0.2;
      for (const mat of this._flashMaterials) {
        if (mat.emissive) {
          mat.emissive.setHex(COL.voidGlow);
          mat.emissiveIntensity = pulse;
        }
      }
    } else {
      // Restore original emissive
      for (const mat of this._flashMaterials) {
        if (mat.emissive && mat._origEmissive !== undefined) {
          mat.emissive.setHex(mat._origEmissive);
          mat.emissiveIntensity = mat._origEmissiveIntensity;
        } else if (mat.emissive) {
          mat.emissiveIntensity = 0;
        }
      }
    }

    // --- Slow timer ---
    if (this._slowT > 0) {
      this._slowT = Math.max(0, this._slowT - dt);
      if (this._slowT <= 0) this.speedMult = 1;
    }

    // --- Invulnerability timer ---
    this._invulnT = Math.max(0, this._invulnT - dt);

    // --- Movement ---
    if (this.moveIntent.lengthSq() > 0.001) {
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
      this.groundRuneMat.opacity = 0.3 + Math.sin(this._idleTime * 2) * 0.1;
    }

    // Fog update
    if (this.fog.visible) {
      this._updateFog(dt);
    }
  }

  _updateFog(dt) {
    const n = this._fogN;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      this._fogPhase[i] += dt;
      this._fogPos[i3] += this._fogVel[i3] * dt;
      this._fogPos[i3 + 1] += this._fogVel[i3 + 1] * dt;
      this._fogPos[i3 + 2] += this._fogVel[i3 + 2] * dt;
      if (this._fogPos[i3 + 1] > 2.5) {
        const a = Math.random() * Math.PI * 2;
        const r = 0.6 + Math.random() * 0.8;
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

  /* ==================== Capability-based Cinematic Hooks ==================== */

  /**
   * Called by BossBattleController when a cinematic sequence starts.
   * Returns true if this boss handles its own cinematic visuals, false/undefined
   * to fall back to the legacy Warden-style cinematic.
   * @param {string} kind - 'intro' | 'phase_change' | 'death'
   * @param {object} context - { bossPos, playerPos, config, camera, explosion, audio, hud, onShake }
   * @returns {boolean}
   */
  onCinematicStart(kind, context) {
    if (kind === 'intro') {
      this._cinematicKind = 'intro';
      this._cinematicT = 0;
      this._cinematicCtx = context;
      // Reset intro flags
      this._vwIntroShown = false;
      this._vwIntroSlam = false;
      this._vwIntroShake = false;
      // Dark arena + fog + runes
      if (this.groundRuneMat) this.groundRuneMat.opacity = 0;
      if (this.fog) this.fog.visible = true;
      this.group.visible = false;
      return true;
    }

    if (kind === 'phase_change') {
      this._cinematicKind = 'phase_change';
      this._cinematicT = 0;
      this._cinematicCtx = context;
      this._vwPhaseChangeBurst = false;
      return true;
    }

    if (kind === 'death') {
      this._cinematicKind = 'death';
      this._cinematicT = 0;
      this._cinematicCtx = context;
      this._vwDeathStage = 0;
      return true;
    }

    return false;
  }

  /**
   * Called every frame during a cinematic sequence.
   * Returns true while the cinematic is still active, false when done.
   * @param {string} kind
   * @param {number} t - elapsed time
   * @param {number} dt - frame delta
   * @param {object} context
   * @returns {boolean}
   */
  onCinematicUpdate(kind, t, dt, context) {
    if (kind === 'intro') return this._updateIntroCinematic(t, dt, context);
    if (kind === 'phase_change') return this._updatePhaseChangeCinematic(t, dt, context);
    if (kind === 'death') return this._updateDeathCinematic(t, dt, context);
    return false;
  }

  /**
   * Called when a cinematic sequence ends.
   * @param {string} kind
   * @param {object} context
   */
  onCinematicEnd(kind, context) {
    this._cinematicKind = null;
    this._cinematicT = 0;
    this._cinematicCtx = null;
    // Ensure boss is visible and at full scale after any cinematic
    if (kind === 'intro' || kind === 'phase_change') {
      this.group.visible = true;
      this.visualRoot.scale.setScalar(1);
      this.visualRoot.position.y = this.FLOAT_Y;
      this.setCastGlow(0);
    }
  }

  _updateIntroCinematic(t, dt, ctx) {
    const cfg = ctx.config;
    const cam = ctx.camera;
    const duration = cfg.introDuration;

    // Phase 1 (0~0.7s): Arena dark, runes light up, fog gathers
    if (t < 0.7) {
      const tp = t / 0.7;
      if (this.groundRuneMat) this.groundRuneMat.opacity = tp * 0.7;
      if (this.fog) {
        this.fog.visible = true;
        // Fog density ramps up
        if (this.fog.material) this.fog.material.opacity = tp * 0.4;
      }
    }

    // Phase 2 (0.7~1.5s): Boss emerges from void — scale 0.35→1
    if (t >= 0.7 && t < 1.5) {
      if (!this._vwIntroShown) {
        this._vwIntroShown = true;
        this.group.visible = true;
        this.fog.visible = true;
        this.visualRoot.scale.setScalar(0.35);
      }
      const tp = (t - 0.7) / 0.8;
      const ease = tp < 0.5 ? 2 * tp * tp : -1 + (4 - 2 * tp) * tp;
      const scale = 0.35 + (1 - 0.35) * ease;
      this.visualRoot.scale.setScalar(scale);
      if (this.groundRuneMat) this.groundRuneMat.opacity = 0.7 + tp * 0.3;
      // First emergence shake
      if (t >= 0.7 && t < 0.75 && !this._vwIntroShake) {
        this._vwIntroShake = true;
        ctx.onShake?.(0.3);
        ctx.audio?.playExplosion(0.5, 12);
      }
    }

    // Phase 3 (1.5~2.2s): Rise, rings activate, floating orb, light shake
    if (t >= 1.5 && t < 2.2) {
      const tp = (t - 1.5) / 0.7;
      this.visualRoot.scale.setScalar(1);
      // Rings and orb activate
      this.setCastGlow(tp * 0.6);
      // Slight rise
      const riseOffset = Math.sin(tp * Math.PI) * 0.15;
      this.visualRoot.position.y = this.FLOAT_Y + riseOffset;
      // Ring rotation accelerates
      this._ringRotation += dt * (1.2 + tp * 2);
    }

    // Phase 4 (2.2s+): Hold — title/HP/FIGHT handled by controller timeline
    if (t >= 2.2) {
      this.setCastGlow(0.5);
      this.visualRoot.position.y = this.FLOAT_Y;
    }

    // Cinematic camera: slow orbit around boss
    if (cam) {
      const bossPos = ctx.bossPos;
      if (t < 0.7) {
        // Slow push from player side
        const tp = t / 0.7;
        const ease = tp < 0.5 ? 2 * tp * tp : -1 + (4 - 2 * tp) * tp;
        const startX = ctx.playerPos.x * 0.4;
        const startZ = ctx.playerPos.z * 0.5;
        const endX = bossPos.x;
        const endZ = bossPos.z + 6;
        cam.position.lerp(new THREE.Vector3(
          THREE.MathUtils.lerp(startX, endX, ease),
          THREE.MathUtils.lerp(4, 2.5, ease),
          THREE.MathUtils.lerp(startZ, endZ, ease)
        ), 0.12);
        cam.lookAt(bossPos.x, 1.5, bossPos.z);
      } else if (t < 2.2) {
        // Low angle hero shot with slight orbit
        const tp = (t - 0.7) / 1.5;
        const angle = tp * Math.PI * 0.15;
        const radius = 6.0 - tp * 0.5;
        const height = 1.8 + Math.sin(tp * Math.PI) * 0.4;
        const target = new THREE.Vector3(
          bossPos.x + Math.sin(angle) * radius,
          height,
          bossPos.z + Math.cos(angle) * radius
        );
        cam.position.lerp(target, 0.08);
        cam.lookAt(bossPos.x, 2.5, bossPos.z);
      } else {
        // Hold
        const target = new THREE.Vector3(bossPos.x, 2.5, bossPos.z + 5.5);
        cam.position.lerp(target, 0.05);
        cam.lookAt(bossPos.x, 2.5, bossPos.z);
      }
    }

    return t < duration;
  }

  _updatePhaseChangeCinematic(t, dt, ctx) {
    const cfg = ctx.config;
    const cam = ctx.camera;
    const duration = cfg.phaseChangeDuration;
    const bossPos = ctx.bossPos;

    // Void Witch phase change: ring acceleration, core surge, fog burst
    this._ringRotation += dt * 4;
    if (this._voidCoreMat) {
      this._voidCoreMat.opacity = 0.8 + Math.sin(t * 6) * 0.2;
    }
    // Rise slightly
    const riseOffset = Math.sin(Math.min(1, t / duration) * Math.PI) * 0.3;
    this.visualRoot.position.y = this.FLOAT_Y + riseOffset;

    // Burst at 0.3s
    if (t >= 0.3 && !this._vwPhaseChangeBurst) {
      this._vwPhaseChangeBurst = true;
      ctx.explosion?.playMagicExplosion(
        new THREE.Vector3(bossPos.x, 1.2, bossPos.z), 2.0
      );
      ctx.audio?.playExplosion(2.0, 6);
      ctx.hud?.screenFlash();
      ctx.onShake?.(1.0);
    }

    // Camera: push close then hold
    if (cam) {
      if (t < duration * 0.4) {
        const tp = t / (duration * 0.4);
        const target = new THREE.Vector3(bossPos.x, 2.5, bossPos.z + 4.5);
        cam.position.lerp(target, 0.08 * tp);
        cam.lookAt(bossPos.x, 2.5, bossPos.z);
      } else {
        // Slight orbit
        const tp = (t - duration * 0.4) / (duration * 0.6);
        const angle = tp * 0.4;
        const target = new THREE.Vector3(
          bossPos.x + Math.sin(angle) * 4.5,
          2.3 + Math.sin(tp * Math.PI) * 0.3,
          bossPos.z + Math.cos(angle) * 4.5
        );
        cam.position.lerp(target, 0.05);
        cam.lookAt(bossPos.x, 2.5, bossPos.z);
      }
    }

    return t < duration;
  }

  _updateDeathCinematic(t, dt, ctx) {
    const cfg = ctx.config;
    const cam = ctx.camera;
    const duration = cfg.deathDuration;
    const bossPos = ctx.bossPos;
    const explosion = ctx.explosion;
    const audio = ctx.audio;
    const hud = ctx.hud;
    const onShake = ctx.onShake;

    // Void Witch death: no 5-explosion Warden style.
    // 0~0.5s: Stagger (handled by boss.update death animation)
    // 0.5~1.4s: Cracks + collapse — core destabilizes
    // 1.4~2.3s: Dissolve — scale down, opacity fade
    // 2.4~2.7s: Core collapse + flash + shake

    if (t < 0.5) {
      // Stagger — boss.update() handles the wobble
    } else if (t < 1.4) {
      // Cracks + collapse
      if (this._vwDeathStage < 1) {
        this._vwDeathStage = 1;
        // Small crack burst
        explosion?.playMagicExplosion(
          new THREE.Vector3(bossPos.x, 1.0, bossPos.z), 0.8
        );
        audio?.playExplosion(0.8, 8);
        onShake?.(0.4);
      }
      // Core flickers more violently
      if (this._voidCoreMat) {
        this._voidCoreMat.opacity = Math.max(0,
          0.6 - (t - 0.5) * 0.3 + Math.sin(t * 20) * 0.25
        );
      }
    } else if (t < 2.3) {
      // Dissolve
      if (this._vwDeathStage < 2) {
        this._vwDeathStage = 2;
        explosion?.playMagicExplosion(
          new THREE.Vector3(bossPos.x, 1.2, bossPos.z), 1.2
        );
        audio?.playExplosion(1.2, 7);
        onShake?.(0.5);
      }
      const dp = (t - 1.4) / 0.9;
      // Accelerate ring spin
      this._ringRotation += dt * (5 + dp * 10);
      // Scale down
      this.visualRoot.scale.setScalar(Math.max(0.01, 1 - dp * 0.6));
      // Rings fade
      if (this._arcaneRing1Mat) this._arcaneRing1Mat.opacity = Math.max(0, 0.6 - dp * 0.6);
      if (this._arcaneRing2Mat) this._arcaneRing2Mat.opacity = Math.max(0, 0.5 - dp * 0.5);
    } else if (t < 2.7) {
      // Core collapse + flash + shake
      if (this._vwDeathStage < 3) {
        this._vwDeathStage = 3;
        explosion?.playMagicExplosion(
          new THREE.Vector3(bossPos.x, 1.0, bossPos.z), 2.5
        );
        audio?.playExplosion(2.5, 4);
        hud?.screenFlash();
        onShake?.(1.0);
        // Final visual collapse
        if (this._voidCoreMat) this._voidCoreMat.opacity = 0;
        if (this._coreLight) this._coreLight.intensity = 0;
        this.visualRoot.scale.setScalar(0.01);
      }
    }

    // Camera: slow push towards boss
    if (cam) {
      const tp = Math.min(1, t / duration);
      const startZ = bossPos.z + 7;
      const endZ = bossPos.z + 4.5;
      const z = THREE.MathUtils.lerp(startZ, endZ, tp < 0.5 ? 2 * tp * tp : -1 + (4 - 2 * tp) * tp);
      const y = 2.5 + Math.sin(tp * Math.PI) * 0.5;
      const target = new THREE.Vector3(bossPos.x, y, z);
      cam.position.lerp(target, 0.05);
      const lookY = THREE.MathUtils.lerp(2.5, 1.0, tp);
      cam.lookAt(bossPos.x, lookY, bossPos.z);
    }

    return t < duration;
  }

  /**
   * Remove all scene objects created by this Boss.
   * Safe to call after async GLB load — sets _destroyed guard
   * so the pending Promise will not add objects back.
   * Idempotent: calling twice is a no-op.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    // Remove scene objects
    if (this.group) this.scene.remove(this.group);
    if (this.fog) this.scene.remove(this.fog);
    if (this.groundRune) this.scene.remove(this.groundRune);
    if (this._blinkMarker) this.scene.remove(this._blinkMarker);

    // Dispose only instance-owned geometries and materials.
    // GLB geometry is shared (source-owned) and is NOT in these Sets.
    for (const g of this._ownedGeometries) g.dispose();
    for (const m of this._ownedMaterials) m.dispose();
  }
}
