/**
 * BossRegistry —— Boss 注册表
 *
 * 为 Boss 扩展提供统一的数据源，供 BossSelectPanel / Game / BossBattleController 使用。
 *
 * 每个 entry 结构：
 *   id          — 唯一标识
 *   name        — 中文名
 *   subtitle    — 英文名
 *   description — 简短描述
 *   tags        — 特性标签数组
 *   difficulty  — 难度星级 1~5
 *   portrait    — 占位图标（emoji / unicode 字符）
 *   themeColor  — 主题色 (CSS hex string)
 *   model       — 模型路径
 *   factory     — (scene) => boss 实例
 *   aiFactory   — (boss, combat, scene, effects, explosion) => AI 实例
 *   cinematicConfig — {
 *       titleZh, titleEn, titleSub,
 *       phase2Zh, phase2En,
 *       defeatedZh, defeatedName,
 *       skillNames: { skillId: { zh, en } },
 *       dangerousSkills: string[],
 *       introDuration, phaseChangeDuration, deathDuration,
 *       arenaColor: { bg, fog, fogNear, fogFar, light, lightPos },
 *       loadingText,
 *   }
 */

import { WardenBoss } from './WardenBoss.js';
import { WardenAI } from './WardenAI.js';
import { VoidWitchBoss } from './VoidWitchBoss.js';
import { VoidWitchAI } from './VoidWitchAI.js';

const WARDEN_REGISTRY = {
  id: 'warden',
  name: '典狱长',
  subtitle: 'The Warden',
  description: '擅长锁链、震荡与牢笼控制的重型守卫者。',
  tags: ['重型控制', '场地压制'],
  difficulty: 3,
  portrait: '⚔',
  themeColor: '#c82020',
  model: './assets/models/warden_rigged.glb',

  factory: (scene) => new WardenBoss(scene),
  aiFactory: (boss, combat, scene, effects, explosion) =>
    new WardenAI(boss, combat, scene, effects, explosion),

  cinematicConfig: {
    titleZh: '典 狱 长',
    titleEn: 'THE WARDEN',
    titleSub: '「罪人，不得越狱。」',
    phase2Zh: '封 锁 解 除',
    phase2En: 'PHASE II',
    defeatedZh: 'BOSS 击破',
    defeatedName: '典 狱 长',
    skillNames: {
      chain: { zh: '锁链禁锢', en: 'CHAIN' },
      magic_bolt: { zh: '重型魔法弹', en: 'MAGIC BOLT' },
      quake: { zh: '典狱震荡', en: 'QUAKE' },
      death_cage: { zh: '死亡牢笼', en: 'DEATH CAGE' },
    },
    dangerousSkills: ['death_cage'],
    introDuration: 4.5,
    phaseChangeDuration: 2.5,
    deathDuration: 4.0,
    arenaColor: {
      bg: 0x0a0608,
      fog: 0x0a0608,
      fogNear: 22,
      fogFar: 70,
      light: 0xff2010,
      lightPos: [0, 6, -8],
    },
    loadingText: '典狱长正在苏醒……',
  },
};

const VOID_WITCH_REGISTRY = {
  id: 'void_witch',
  name: '虚空女巫',
  subtitle: 'The Void Witch',
  description: '利用瞬移、裂隙与幻象操纵战场的高机动施法者。',
  tags: ['高速施法', '瞬移幻象'],
  difficulty: 4,
  portrait: '🔮',
  themeColor: '#8a4adf',
  model: './assets/models/void_witch_rigged.glb',

  // Phase B: procedural model + basic AI skeleton
  factory: (scene) => new VoidWitchBoss(scene),
  aiFactory: (boss, combat, scene, effects, explosion) =>
    new VoidWitchAI(boss, combat, scene, effects, explosion),

  cinematicConfig: {
    titleZh: '虚 空 女 巫',
    titleEn: 'THE VOID WITCH',
    titleSub: '「虚空……终将吞噬一切。」',
    phase2Zh: '镜 像 领 域',
    phase2En: 'PHASE II',
    defeatedZh: 'BOSS 击破',
    defeatedName: '虚 空 女 巫',
    skillNames: {
      void_barrage: { zh: '虚空箭雨', en: 'VOID BARRAGE' },
      void_blink: { zh: '瞬影', en: 'VOID BLINK' },
      void_rift: { zh: '虚空裂隙', en: 'VOID RIFT' },
      mirror_domain: { zh: '镜像领域', en: 'MIRROR DOMAIN' },
    },
    dangerousSkills: ['mirror_domain'],
    introDuration: 4.0,
    phaseChangeDuration: 3.0,
    deathDuration: 4.0,
    arenaColor: {
      bg: 0x06040f,
      fog: 0x06040f,
      fogNear: 20,
      fogFar: 65,
      light: 0x6f3cff,
      lightPos: [0, 6, -8],
    },
    loadingText: '虚空裂隙正在打开……',
  },
};

const _registry = {};

function _register(entry) {
  _registry[entry.id] = entry;
}

_register(WARDEN_REGISTRY);
_register(VOID_WITCH_REGISTRY);

export const BossRegistry = {
  /**
   * 获取所有已注册 Boss（按注册顺序）
   * @returns {Array} registry entries
   */
  list() {
    return Object.values(_registry);
  },

  /**
   * 按 ID 获取 Boss entry
   * @param {string} id
   * @returns {object|null}
   */
  get(id) {
    return _registry[id] || null;
  },

  /**
   * 获取第一个 available Boss 的 ID。
   * available = factory + aiFactory 均为 function。
   * @returns {string|null} — null 表示没有任何 available boss
   */
  getDefaultId() {
    for (const entry of Object.values(_registry)) {
      if (this.isAvailable(entry.id)) return entry.id;
    }
    return null;
  },

  /**
   * 判断某个 Boss 是否可用。
   * 最低标准：factory + aiFactory 均为 function。
   * @param {string} id
   * @returns {boolean}
   */
  isAvailable(id) {
    const entry = _registry[id];
    return !!(
      entry &&
      typeof entry.factory === 'function' &&
      typeof entry.aiFactory === 'function'
    );
  },

  /**
   * 原子化解析：如果 requested id 可用则返回它，
   * 否则完整 fallback 到第一个 available boss。
   * @param {string} id
   * @returns {object|null} — null 表示没有任何 available boss
   */
  resolveAvailable(id) {
    const entry = this.get(id);
    if (entry && this.isAvailable(id)) return entry;
    const defaultId = this.getDefaultId();
    return defaultId ? this.get(defaultId) : null;
  },

  /**
   * 创建 Boss 实例。
   * 不做内部 fallback — factory 缺失时返回 null。
   * @param {string} id
   * @param {THREE.Scene} scene
   * @returns {object|null}
   */
  createBoss(id, scene) {
    const entry = _registry[id];
    if (!entry || typeof entry.factory !== 'function') return null;
    return entry.factory(scene);
  },

  /**
   * 创建 AI 实例。
   * 不做内部 fallback — aiFactory 缺失时返回 null。
   * @param {string} id
   * @param {object} boss
   * @param {object} combat
   * @param {THREE.Scene} scene
   * @param {object} effects
   * @param {object} explosion
   * @returns {object|null}
   */
  createAI(id, boss, combat, scene, effects, explosion) {
    const entry = _registry[id];
    if (!entry || typeof entry.aiFactory !== 'function') return null;
    return entry.aiFactory(boss, combat, scene, effects, explosion);
  },
};
