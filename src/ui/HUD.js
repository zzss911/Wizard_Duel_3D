import * as THREE from 'three';

/**
 * HUD —— 血条 / 准星 / 伤害飘字 / 横幅 / 受击红边 / 胜负结算
 * 只读取状态并更新表现，不含任何战斗逻辑。
 */
export class HUD {
  constructor() {
    this.playerFill = document.getElementById('hp-player-fill');
    this.targetFill = document.getElementById('hp-target-fill');
    this.enemyFill = document.getElementById('hp-enemy-fill');
    this.damageLayer = document.getElementById('damage-layer');
    this.banner = document.getElementById('banner');
    this.flash = document.getElementById('screen-flash');
    this.vignette = document.getElementById('hit-vignette');
    this.endPanel = document.getElementById('end-panel');
    this.endText = document.getElementById('end-text');
    this.restartBtn = document.getElementById('btn-restart');

    // 技能冷却 UI
    this.skillBtns = {
      dodge:  { el: document.getElementById('btn-dodge'),  cd: document.querySelector('#btn-dodge  .skill-cd') },
      skill1: { el: document.getElementById('btn-skill1'), cd: document.querySelector('#btn-skill1 .skill-cd') },
      skill2: { el: document.getElementById('btn-skill2'), cd: document.querySelector('#btn-skill2 .skill-cd') },
    };

    this._bannerTimer = null;
    this._v = new THREE.Vector3();
  }

  update(player, target, enemy) {
    this.playerFill.style.width = (player.hp / player.maxHp * 100) + '%';
    this.targetFill.style.width = (target.hp / target.maxHp * 100) + '%';
    if (this.enemyFill && enemy) {
      this.enemyFill.style.width = (enemy.hp / enemy.maxHp * 100) + '%';
    }
    this._updateSkillCd('dodge',  player.dodgeCd,  player.dodgeCooldownMax);
    this._updateSkillCd('skill1', player.skill1Cd, player.skill1CdMax);
    this._updateSkillCd('skill2', player.skill2Cd, player.skill2CdMax);
  }

  /** 更新技能冷却遮罩：cd>0 时从底部覆盖到顶部比例 */
  _updateSkillCd(name, cd, cdMax) {
    const s = this.skillBtns[name];
    if (!s || !s.cd) return;
    if (cd > 0 && cdMax > 0) {
      s.cd.style.transform = `scaleY(${cd / cdMax})`;
      s.el.classList.remove('ready');
    } else {
      s.cd.style.transform = 'scaleY(0)';
      s.el.classList.add('ready');
    }
  }

  /** 世界坐标 -> 屏幕飘字 */
  spawnDamageNumber(worldPos, amount, camera) {
    this._v.copy(worldPos).project(camera);
    if (this._v.z > 1) return; // 在摄像机背后
    const x = (this._v.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-this._v.y * 0.5 + 0.5) * window.innerHeight;

    const el = document.createElement('div');
    el.className = 'dmg-num';
    el.textContent = '-' + amount;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    this.damageLayer.appendChild(el);
    setTimeout(() => el.remove(), 750);
  }

  /** 全屏短闪光：50~100ms 快速淡出 */
  screenFlash() {
    if (!this.flash) return;
    this.flash.classList.remove('active');
    void this.flash.offsetWidth; // 重启动画
    this.flash.classList.add('active');
  }

  /** 玩家受击：屏幕边缘泛红 */
  playerHitFlash() {
    if (!this.vignette) return;
    this.vignette.classList.remove('active');
    void this.vignette.offsetWidth;
    this.vignette.classList.add('active');
  }

  showBanner(text, seconds = 1.5) {
    this.banner.textContent = text;
    this.banner.classList.add('show');
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => this.banner.classList.remove('show'), seconds * 1000);
  }

  /** 胜负结算：win=true 胜利 / false 失败；onRestart 绑定重开按钮 */
  showEnd(win, onRestart) {
    this.endText.textContent = win ? '胜  利' : '失  败';
    this.endText.classList.toggle('lose', !win);
    this.endPanel.classList.add('show');
    this.restartBtn.onclick = () => {
      this.hideEnd();
      onRestart && onRestart();
    };
  }

  hideEnd() {
    this.endPanel.classList.remove('show');
  }
}
