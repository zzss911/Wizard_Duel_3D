import * as THREE from 'three';

/**
 * PlayerModel — 程序化骨骼绑定玩家模型
 *
 * 使用 Bone 层次结构 + 直接子 mesh（非 Skinning）。
 * AnimationMixer 驱动 bone 的旋转/位移，mesh 作为 bone 子节点自动跟随。
 * 这种方式比 SkinnedMesh 更稳定，适合程序化角色。
 *
 * 返回 { group, visualRoot, skeleton, bones, clips, castAnchor, chestAnchor, headAnchor, gemMat, glowSprite, robeMat }
 */

const BONE_NAMES = [
  'hips',
  'spine', 'chest', 'neck', 'head',
  'shoulderL', 'armL', 'forearmL', 'handL',
  'shoulderR', 'armR', 'forearmR', 'handR',
  'thighL', 'shinL', 'footL',
  'thighR', 'shinR', 'footR',
  'wand',
];

export function buildPlayerModel() {
  const group = new THREE.Group();
  const visualRoot = new THREE.Group();
  group.add(visualRoot);

  // ---- 骨骼 ----
  const bones = {};
  for (const name of BONE_NAMES) {
    bones[name] = new THREE.Bone();
    bones[name].name = name;
  }

  // 层次结构
  bones.hips.add(bones.spine);
  bones.spine.add(bones.chest);
  bones.chest.add(bones.neck);
  bones.neck.add(bones.head);
  bones.chest.add(bones.shoulderL, bones.shoulderR);
  bones.shoulderL.add(bones.armL);
  bones.armL.add(bones.forearmL);
  bones.forearmL.add(bones.handL);
  bones.shoulderR.add(bones.armR);
  bones.armR.add(bones.forearmR);
  bones.forearmR.add(bones.handR);
  bones.hips.add(bones.thighL, bones.thighR);
  bones.thighL.add(bones.shinL);
  bones.shinL.add(bones.footL);
  bones.thighR.add(bones.shinR);
  bones.shinR.add(bones.footR);
  bones.handR.add(bones.wand);

  // 骨骼初始姿态
  bones.hips.position.set(0, 0.95, 0);
  bones.spine.position.set(0, 0.05, 0);
  bones.chest.position.set(0, 0.22, 0);
  bones.neck.position.set(0, 0.22, 0);
  bones.head.position.set(0, 0.12, 0);
  bones.shoulderL.position.set(0.18, 0.18, 0);
  bones.shoulderR.position.set(-0.18, 0.18, 0);
  bones.armL.position.set(0, -0.22, 0);
  bones.armR.position.set(0, -0.22, 0);
  bones.forearmL.position.set(0, -0.25, 0);
  bones.forearmR.position.set(0, -0.25, 0);
  bones.handL.position.set(0, -0.22, 0);
  bones.handR.position.set(0, -0.22, 0);
  bones.thighL.position.set(0.11, -0.05, 0);
  bones.thighR.position.set(-0.11, -0.05, 0);
  bones.shinL.position.set(0, -0.42, 0);
  bones.shinR.position.set(0, -0.42, 0);
  bones.footL.position.set(0, -0.40, 0.05);
  bones.footR.position.set(0, -0.40, 0.05);
  bones.wand.position.set(0, -0.05, 0.02);

  // 手臂自然下垂略外旋
  bones.shoulderL.rotation.z = 0.15;
  bones.shoulderR.rotation.z = -0.15;
  bones.armL.rotation.z = 0.10;
  bones.armR.rotation.z = -0.10;

  const skeleton = new THREE.Skeleton(Object.values(bones));

  // ---- 材质 ----
  const robeMat = new THREE.MeshStandardMaterial({ color: 0x1a2a4a, roughness: 0.6, metalness: 0.1 });
  const armorMat = new THREE.MeshStandardMaterial({ color: 0x2a3a5a, roughness: 0.4, metalness: 0.3 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x0f1828, roughness: 0.7, metalness: 0.05 });
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0xa0c4e8, roughness: 0.25, metalness: 0.8,
    emissive: 0x3a6aaa, emissiveIntensity: 0.15,
  });
  const gemMat = new THREE.MeshStandardMaterial({
    color: 0x66baff, roughness: 0.12, metalness: 0.2,
    emissive: 0x66baff, emissiveIntensity: 0.9,
  });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xc8b8a0, roughness: 0.6 });
  const wandMat = new THREE.MeshStandardMaterial({ color: 0x3a2818, roughness: 0.8 });
  const cloakMat = new THREE.MeshStandardMaterial({
    color: 0x152038, roughness: 0.7, metalness: 0.05,
    side: THREE.DoubleSide,
  });

  // ---- 辅助：创建 mesh 挂到 bone 下 ----
  const attachToBone = (geometry, mat, boneName, offset = { x: 0, y: 0, z: 0 }, rot = { x: 0, y: 0, z: 0 }) => {
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.position.set(offset.x, offset.y, offset.z);
    mesh.rotation.set(rot.x, rot.y, rot.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    bones[boneName].add(mesh);
    return mesh;
  };

  // ---- 躯干 ----
  // 上身
  attachToBone(new THREE.CapsuleGeometry(0.22, 0.35, 6, 12), robeMat, 'spine', { x: 0, y: 0.15, z: 0 });
  // 腰带
  attachToBone(new THREE.TorusGeometry(0.23, 0.035, 8, 16), trimMat, 'spine', { x: 0, y: 0.05, z: 0 }, { x: Math.PI / 2, y: 0, z: 0 });
  // 胸甲
  attachToBone(new THREE.SphereGeometry(0.20, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), armorMat, 'chest', { x: 0, y: 0.05, z: 0 }, { x: -Math.PI / 2, y: 0, z: 0 });
  // 胸口宝石
  attachToBone(new THREE.OctahedronGeometry(0.04), gemMat, 'chest', { x: 0, y: 0.12, z: 0.18 });
  // 颈部
  attachToBone(new THREE.CylinderGeometry(0.06, 0.07, 0.06, 8), darkMat, 'neck');
  // 头部
  attachToBone(new THREE.SphereGeometry(0.12, 12, 10), skinMat, 'head', { x: 0, y: 0.06, z: 0 });
  // 兜帽
  attachToBone(new THREE.SphereGeometry(0.14, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.5), darkMat, 'head', { x: 0, y: 0.08, z: 0 }, { x: -0.2, y: 0, z: 0 });

  // ---- 肩甲 ----
  attachToBone(new THREE.SphereGeometry(0.07, 8, 8), trimMat, 'shoulderL');
  attachToBone(new THREE.SphereGeometry(0.07, 8, 8), trimMat, 'shoulderR');

  // ---- 手臂 ----
  for (const side of ['L', 'R']) {
    attachToBone(new THREE.CapsuleGeometry(0.045, 0.14, 4, 8), robeMat, 'arm' + side, { x: 0, y: -0.07, z: 0 });
    attachToBone(new THREE.CapsuleGeometry(0.038, 0.16, 4, 8), robeMat, 'forearm' + side, { x: 0, y: -0.08, z: 0 });
    attachToBone(new THREE.SphereGeometry(0.04, 6, 6), skinMat, 'hand' + side);
  }

  // ---- 腿 ----
  for (const side of ['L', 'R']) {
    attachToBone(new THREE.CapsuleGeometry(0.065, 0.22, 4, 8), darkMat, 'thigh' + side, { x: 0, y: -0.11, z: 0 });
    attachToBone(new THREE.CapsuleGeometry(0.05, 0.20, 4, 8), armorMat, 'shin' + side, { x: 0, y: -0.10, z: 0 });
    attachToBone(new THREE.BoxGeometry(0.08, 0.04, 0.14), darkMat, 'foot' + side, { x: 0, y: 0, z: 0.04 });
  }

  // ---- 披风 ----
  attachToBone(new THREE.PlaneGeometry(0.36, 0.55, 4, 6), cloakMat, 'chest', { x: 0, y: 0.08, z: -0.16 }, { x: 0.15, y: 0, z: 0 });

  // ---- 魔杖 ----
  attachToBone(new THREE.CylinderGeometry(0.012, 0.016, 0.50, 6), wandMat, 'wand', { x: 0, y: 0.22, z: 0 }, { x: Math.PI / 2, y: 0, z: 0 });
  attachToBone(new THREE.OctahedronGeometry(0.035), gemMat, 'wand', { x: 0, y: 0.48, z: 0 });

  // 法杖光晕 sprite
  const glowSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    color: 0x9fd8ff, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  glowSprite.scale.set(0.5, 0.5, 1);
  glowSprite.position.set(0, 0.48, 0);
  bones.wand.add(glowSprite);

  // ---- 将骨骼根添加到 visualRoot ----
  visualRoot.add(bones.hips);

  // ---- 锚点 ----
  const headAnchor = new THREE.Group();
  headAnchor.position.set(0, 1.45, 0);
  const chestAnchor = new THREE.Group();
  chestAnchor.position.set(0, 1.15, 0);
  const castAnchor = new THREE.Group();
  castAnchor.position.set(0, 1.2, 0.3);
  group.add(headAnchor, chestAnchor, castAnchor);

  // ---- 生成 AnimationClips ----
  const clips = _buildAnimationClips();

  return {
    group,
    visualRoot,
    skeleton,
    bones,
    clips,
    castAnchor,
    chestAnchor,
    headAnchor,
    gemMat,
    glowSprite,
    robeMat,
  };
}

// ---- 动画剪辑 ----

function _R(boneName, times, rotations) {
  return new THREE.QuaternionKeyframeTrack(
    `${boneName}.quaternion`,
    times, rotations
  );
}

function _buildAnimationClips() {
  return {
    Idle: _clipIdle(),
    Run: _clipRun(),
    Cast: _clipCast(),
    Dodge: _clipDodge(),
    Hit: _clipHit(),
    Death: _clipDeath(),
  };
}

function _clipIdle() {
  const times = [0, 1, 2];
  const tracks = [];
  tracks.push(_R('spine', times, [
    0, 0, 0, 1,
    0.01, 0, 0, 0.9999,
    0, 0, 0, 1,
  ]));
  tracks.push(_R('head', times, [
    0, 0.02, 0, 1,
    0, 0, 0, 1,
    0, 0.02, 0, 1,
  ]));
  tracks.push(_R('armL', times, [
    0, 0, 0.1, 0.995,
    0, 0, 0.12, 0.992,
    0, 0, 0.1, 0.995,
  ]));
  tracks.push(_R('armR', times, [
    0, 0, -0.1, 0.995,
    0, 0, -0.12, 0.992,
    0, 0, -0.1, 0.995,
  ]));
  return new THREE.AnimationClip('Idle', 2, tracks);
}

function _clipRun() {
  const times = [0, 0.25, 0.5, 0.75, 1];
  const tracks = [];
  tracks.push(_R('thighL', times, [
    0.4, 0, 0, 0.9165,
    -0.4, 0, 0, 0.9165,
    0.4, 0, 0, 0.9165,
    -0.4, 0, 0, 0.9165,
    0.4, 0, 0, 0.9165,
  ]));
  tracks.push(_R('thighR', times, [
    -0.4, 0, 0, 0.9165,
    0.4, 0, 0, 0.9165,
    -0.4, 0, 0, 0.9165,
    0.4, 0, 0, 0.9165,
    -0.4, 0, 0, 0.9165,
  ]));
  tracks.push(_R('shinL', times, [
    -0.6, 0, 0, 0.8000,
    -0.1, 0, 0, 0.9950,
    -0.6, 0, 0, 0.8000,
    -0.1, 0, 0, 0.9950,
    -0.6, 0, 0, 0.8000,
  ]));
  tracks.push(_R('shinR', times, [
    -0.1, 0, 0, 0.9950,
    -0.6, 0, 0, 0.8000,
    -0.1, 0, 0, 0.9950,
    -0.6, 0, 0, 0.8000,
    -0.1, 0, 0, 0.9950,
  ]));
  tracks.push(_R('armL', times, [
    0, 0, -0.3, 0.9539,
    0, 0, 0.3, 0.9539,
    0, 0, -0.3, 0.9539,
    0, 0, 0.3, 0.9539,
    0, 0, -0.3, 0.9539,
  ]));
  tracks.push(_R('armR', times, [
    0, 0, 0.3, 0.9539,
    0, 0, -0.3, 0.9539,
    0, 0, 0.3, 0.9539,
    0, 0, -0.3, 0.9539,
    0, 0, 0.3, 0.9539,
  ]));
  tracks.push(_R('spine', times, [
    0.1, 0, 0, 0.9950,
    0.12, 0, 0, 0.9928,
    0.1, 0, 0, 0.9950,
    0.12, 0, 0, 0.9928,
    0.1, 0, 0, 0.9950,
  ]));
  // hips 上下弹动
  tracks.push(new THREE.VectorKeyframeTrack(
    'hips.position', times,
    [0, 0.95, 0,  0, 0.93, 0,  0, 0.95, 0,  0, 0.93, 0,  0, 0.95, 0]
  ));
  return new THREE.AnimationClip('Run', 1, tracks);
}

function _clipCast() {
  const times = [0, 0.15, 0.3, 0.5];
  const tracks = [];
  tracks.push(_R('shoulderR', times, [
    0, 0, -0.4, 0.9165,
    0, 0, -0.6, 0.8000,
    0, 0, -0.8, 0.6000,
    0, 0, -0.5, 0.8660,
  ]));
  tracks.push(_R('armR', times, [
    0, 0, -0.3, 0.9539,
    0, 0, -0.5, 0.8660,
    0, 0, -0.7, 0.7141,
    0, 0, -0.4, 0.9165,
  ]));
  tracks.push(_R('forearmR', times, [
    0, 0, 0, 1,
    -0.3, 0, 0, 0.9539,
    -0.5, 0, 0, 0.8660,
    -0.2, 0, 0, 0.9800,
  ]));
  tracks.push(_R('armL', times, [
    0, 0, 0.2, 0.9800,
    0, 0, 0.3, 0.9539,
    0, 0, 0.4, 0.9165,
    0, 0, 0.3, 0.9539,
  ]));
  tracks.push(_R('chest', times, [
    0, 0.05, 0, 0.9988,
    0, 0.1, 0, 0.9950,
    0, 0.15, 0, 0.9888,
    0, 0.08, 0, 0.9968,
  ]));
  return new THREE.AnimationClip('Cast', 0.5, tracks);
}

function _clipDodge() {
  const times = [0, 0.08, 0.16, 0.22];
  const tracks = [];
  tracks.push(_R('spine', times, [
    0.2, 0, 0, 0.9798,
    0.4, 0, 0, 0.9165,
    0.5, 0, 0, 0.8660,
    0.3, 0, 0, 0.9539,
  ]));
  tracks.push(_R('thighL', times, [
    0.3, 0, 0, 0.9539,
    0.5, 0, 0, 0.8660,
    0.4, 0, 0, 0.9165,
    0.2, 0, 0, 0.9798,
  ]));
  tracks.push(_R('thighR', times, [
    0.3, 0, 0, 0.9539,
    0.5, 0, 0, 0.8660,
    0.4, 0, 0, 0.9165,
    0.2, 0, 0, 0.9798,
  ]));
  tracks.push(_R('shinL', times, [
    -0.3, 0, 0, 0.9539,
    -0.6, 0, 0, 0.8000,
    -0.5, 0, 0, 0.8660,
    -0.2, 0, 0, 0.9800,
  ]));
  tracks.push(_R('shinR', times, [
    -0.3, 0, 0, 0.9539,
    -0.6, 0, 0, 0.8000,
    -0.5, 0, 0, 0.8660,
    -0.2, 0, 0, 0.9800,
  ]));
  tracks.push(_R('armL', times, [
    0, 0, 0.3, 0.9539,
    0, 0, 0.5, 0.8660,
    0, 0, 0.4, 0.9165,
    0, 0, 0.2, 0.9800,
  ]));
  tracks.push(_R('armR', times, [
    0, 0, -0.3, 0.9539,
    0, 0, -0.5, 0.8660,
    0, 0, -0.4, 0.9165,
    0, 0, -0.2, 0.9800,
  ]));
  return new THREE.AnimationClip('Dodge', 0.22, tracks);
}

function _clipHit() {
  const times = [0, 0.1, 0.25];
  const tracks = [];
  tracks.push(_R('spine', times, [
    -0.15, 0, 0, 0.9888,
    -0.25, 0, 0, 0.9682,
    0, 0, 0, 1,
  ]));
  tracks.push(_R('chest', times, [
    -0.1, 0, 0, 0.9950,
    -0.2, 0, 0, 0.9798,
    0, 0, 0, 1,
  ]));
  tracks.push(_R('armL', times, [
    0, 0, 0.1, 0.9950,
    0, 0, 0.3, 0.9539,
    0, 0, 0.1, 0.9950,
  ]));
  tracks.push(_R('armR', times, [
    0, 0, -0.1, 0.9950,
    0, 0, -0.3, 0.9539,
    0, 0, -0.1, 0.9950,
  ]));
  tracks.push(_R('head', times, [
    -0.1, 0, 0, 0.9950,
    -0.2, 0, 0, 0.9798,
    0, 0, 0, 1,
  ]));
  return new THREE.AnimationClip('Hit', 0.25, tracks);
}

function _clipDeath() {
  const times = [0, 0.3, 0.7, 1.2];
  const tracks = [];
  tracks.push(_R('spine', times, [
    0, 0, 0, 1,
    0.3, 0, 0, 0.9539,
    0.8, 0, 0, 0.6000,
    1.2, 0, 0, 0.3624,
  ]));
  tracks.push(_R('chest', times, [
    0, 0, 0, 1,
    0.2, 0, 0, 0.9798,
    0.5, 0, 0, 0.8660,
    0.7, 0, 0, 0.7141,
  ]));
  tracks.push(_R('thighL', times, [
    0, 0, 0, 1,
    0.3, 0, 0, 0.9539,
    0.6, 0, 0, 0.8000,
    0.8, 0, 0, 0.6000,
  ]));
  tracks.push(_R('thighR', times, [
    0, 0, 0, 1,
    0.3, 0, 0, 0.9539,
    0.6, 0, 0, 0.8000,
    0.8, 0, 0, 0.6000,
  ]));
  tracks.push(_R('shinL', times, [
    0, 0, 0, 1,
    -0.3, 0, 0, 0.9539,
    -0.6, 0, 0, 0.8000,
    -0.8, 0, 0, 0.6000,
  ]));
  tracks.push(_R('shinR', times, [
    0, 0, 0, 1,
    -0.3, 0, 0, 0.9539,
    -0.6, 0, 0, 0.8000,
    -0.8, 0, 0, 0.6000,
  ]));
  tracks.push(_R('armL', times, [
    0, 0, 0.1, 0.9950,
    0, 0, 0.4, 0.9165,
    0, 0, 0.6, 0.8000,
    0, 0, 0.7, 0.7141,
  ]));
  tracks.push(_R('armR', times, [
    0, 0, -0.1, 0.9950,
    0, 0, -0.4, 0.9165,
    0, 0, -0.6, 0.8000,
    0, 0, -0.7, 0.7141,
  ]));
  tracks.push(_R('head', times, [
    0, 0, 0, 1,
    -0.2, 0, 0, 0.9798,
    -0.4, 0, 0, 0.9165,
    -0.5, 0, 0, 0.8660,
  ]));
  return new THREE.AnimationClip('Death', 1.2, tracks);
}
