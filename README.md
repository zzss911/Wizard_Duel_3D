# 魔法战斗 · Wizard Duel 3D

> Demo / Preview Build — v0.3.0

一个基于 Three.js + WebGL 的 3D 魔法决斗游戏。在竞技场中与 AI 法师对战，或挑战强大的 Boss 典狱长。

## 在线游玩

[https://zzss911.github.io/Wizard_Duel_3D/](https://zzss911.github.io/Wizard_Duel_3D/)

## 功能

- **普通决斗** — 与 AI 法师 1v1 对战，支持三档难度（新手 / 普通 / 高手）
- **教程模式** — 新手引导，学习移动、瞄准、攻击、闪避
- **Boss 典狱长** — 两阶段 Boss 战，4 种技能，完整 cinematic 演出
- **连胜系统** — 连续胜利累计连胜数
- **移动端支持** — 触屏摇杆 + 技能按钮，横竖屏自适应
- **画质设置** — 低 / 中 / 高三档，含粒子缩放、Bloom、阴影控制
- **程序化音效** — Web Audio API 合成，无外部音频文件
- **程序化 BGM** — 菜单 / 决斗 / Boss 三种氛围，Boss Phase II 升级
- **玩家角色模型** — v0.3.0 骨骼动画角色（GLB 17 骨骼），8 种动画（Idle/Run/CastBasic/CastQ/CastE/Dodge/Hit/Death），AnimationMixer + impact frame 同步，cast 优先级抢占系统，Hand_R 杖尖弹道锚点，程序化模型作为 fallback

## 操作

### Desktop

| 按键 | 功能 |
|------|------|
| WASD | 移动 |
| 鼠标 | 观察 / 瞄准 |
| 左键 / J | 普通魔法弹 |
| Space | 闪避 |
| Q | 爆裂咒（技能1） |
| E | 束缚咒（技能2） |

### Mobile

| 操作 | 功能 |
|------|------|
| 左侧拖动 | 移动摇杆 |
| 右侧滑动 | 观察视角 |
| 攻击按钮 | 普通魔法弹 |
| 闪避按钮 | 快速躲避 |
| 技能按钮 | 爆裂 / 束缚 |

## Boss · The Warden / 典狱长

被锁链封印在竞技场深处的黑暗守卫。

### 技能

| 技能 | 描述 |
|------|------|
| 锁链禁锢 (Chain) | 召唤锁链束缚玩家 |
| 重型魔法弹 (Magic Bolt) | 蓄力发射高伤害弹丸 |
| 典狱震荡 (Quake) | 地面冲击波，范围伤害 |
| 死亡牢笼 (Death Cage) | Phase II 专属，危险区域封锁 |

### 两阶段战斗

- **Phase I** (100%–50% HP)：使用锁链、魔法弹、震荡
- **Phase II** (50%–0% HP)：新增死亡牢笼，攻击更凶猛

## Tech

- **Three.js 0.160.0** — WebGL 渲染，ES Modules + importmap，无构建步骤
- **GLTF** — Boss 模型使用 warden_rigged.glb，22 关节骨骼 + 6 个动画；玩家模型使用 player_rigged.glb，17 骨骼 + 8 动画
- **Web Audio API** — 程序化合成所有音效与 BGM
- **GitHub Pages** — 通过 GitHub Actions 自动部署

## Performance

- warden_rigged.glb: ~2.31 MB (从 23.48 MB 优化，90.2% 压缩)
- player_rigged.glb: ~3.11 MB (17 骨骼, 8 动画, 2K WebP 贴图)
- 2K WebP 贴图 (EXT_texture_webp 扩展)
- 对象池：射弹 (24)、爆炸效果 (3)、粒子爆发 (8×14)
- Bloom 仅桌面端启用，移动端自动降级

## Development Tools

- `tools/rig_warden.py` — Blender 骨骼绑定 + 动画烘焙脚本
- `tools/optimize_warden.py` — GLB 贴图压缩优化脚本 (4K→2K + WebP)
- `tools/rig_player.py` — 玩家模型骨骼绑定 + 权重分配脚本
- `tools/animate_player.py` — 玩家 CastBasic/CastQ/CastE 动画生成脚本

## Development

```bash
# 本地开发服务器
python -m http.server 8000

# 打开浏览器访问
# http://localhost:8000/

# Debug 模式 (?debug=1) 显示 FPS / draw calls / triangles / boss state
# http://localhost:8000/?debug=1
```

## License

MIT
