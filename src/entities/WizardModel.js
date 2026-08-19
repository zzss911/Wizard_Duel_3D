import * as THREE from 'three';

/**
 * WizardModel —— 精修低模法师构建器（玩家 / 敌人共用）
 *
 * 造型：分层法袍 + 宽檐弯尖法帽 + 银饰 + 宝石法杖。
 * 返回 { group, gemMat, glowSprite }：
 *   gemMat / glowSprite 用于施法蓄力光效（emissive / 透明度脉冲）。
 */

export const PLAYER_PALETTE = {
  robe: 0x2b4aa8,      // 深蓝法袍
  robeDark: 0x1b2f6b,  // 袍摆与兜帽
  trim: 0xc8d4e8,      // 银饰
  gem: 0x66baff,       // 杖头宝石
  glow: 0x9fd8ff,      // 宝石光晕
};

export const ENEMY_PALETTE = {
  robe: 0x6e1d2a,      // 暗红法袍
  robeDark: 0x3d0f1a,  // 袍摆与兜帽
  trim: 0x9a7a52,      // 古铜饰
  gem: 0xff4a3c,       // 杖头宝石
  glow: 0xff8a5a,      // 宝石光晕
};

export function buildWizard(palette) {
  const group = new THREE.Group();

  const robeMat = new THREE.MeshStandardMaterial({ color: palette.robe, roughness: 0.55, metalness: 0.1 });
  const robeDarkMat = new THREE.MeshStandardMaterial({ color: palette.robeDark, roughness: 0.65, metalness: 0.05 });
  const trimMat = new THREE.MeshStandardMaterial({
    color: palette.trim, roughness: 0.3, metalness: 0.85,
    emissive: palette.trim, emissiveIntensity: 0.08,
  });
  const gemMat = new THREE.MeshStandardMaterial({
    color: palette.gem, roughness: 0.15, metalness: 0.2,
    emissive: palette.gem, emissiveIntensity: 0.9,
  });

  const add = (mesh, x, y, z) => {
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    group.add(mesh);
    return mesh;
  };

  // ---- 袍摆（展开的下裙，轮廓更清晰） ----
  add(new THREE.Mesh(new THREE.ConeGeometry(0.62, 1.1, 14, 1, true), robeDarkMat), 0, 0.55, 0);

  // ---- 上身 ----
  add(new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 0.62, 6, 14), robeMat), 0, 1.18, 0);

  // ---- 银腰带 ----
  const belt = add(new THREE.Mesh(new THREE.TorusGeometry(0.43, 0.05, 8, 20), trimMat), 0, 0.98, 0);
  belt.rotation.x = Math.PI / 2;

  // ---- 肩甲 ----
  add(new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 10), trimMat), -0.42, 1.5, 0);
  add(new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 10), trimMat), 0.42, 1.5, 0);

  // ---- 兜帽下的脸（深色，神秘感） ----
  add(new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 12), robeDarkMat), 0, 1.74, 0);

  // ---- 法帽：宽檐 + 弯尖 ----
  const brim = add(new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.09, 10, 24), robeMat), 0, 1.94, 0);
  brim.rotation.x = Math.PI / 2;
  add(new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.85, 14), robeMat), 0, 2.35, 0);
  // 帽尖弯曲段
  const tip = add(new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.42, 10), robeMat), 0.13, 2.85, 0);
  tip.rotation.z = -0.55;
  // 帽带银饰
  const band = add(new THREE.Mesh(new THREE.TorusGeometry(0.31, 0.04, 8, 20), trimMat), 0, 2.02, 0);
  band.rotation.x = Math.PI / 2;

  // ---- 法杖：木柄 + 银箍 + 悬浮宝石 ----
  const staff = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.055, 1.5, 8),
    new THREE.MeshStandardMaterial({ color: 0x5a4028, roughness: 0.8 })
  );
  pole.castShadow = true;
  staff.add(pole);
  const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.028, 8, 14), trimMat);
  cuff.position.y = 0.62;
  cuff.rotation.x = Math.PI / 2;
  staff.add(cuff);
  const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.15), gemMat);
  gem.position.y = 0.88;
  gem.castShadow = true;
  staff.add(gem);
  const glowSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    color: palette.glow, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  glowSprite.scale.set(0.7, 0.7, 1);
  glowSprite.position.y = 0.88;
  staff.add(glowSprite);

  staff.position.set(0.58, 1.1, 0.18);
  staff.rotation.z = -0.12;
  group.add(staff);

  return { group, gemMat, glowSprite, robeMat };
}
