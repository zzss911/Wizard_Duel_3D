import * as THREE from 'three';

/**
 * HUD —— 血条 / 准星 / 伤害飘字 / 横幅 / 受击红边 / 胜负结算
 * 开始界面 / 倒计时 / 新手训练提示
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
    this.endMeta = document.getElementById('end-meta');
    this.restartBtn = document.getElementById('btn-restart');
    this.nextDiffBtn = document.getElementById('btn-next-difficulty');
    this.mainMenuBtn = document.getElementById('btn-main-menu');

    // 技能冷却 UI
    this.skillBtns = {
      dodge:  { el: document.getElementById('btn-dodge'),  cd: document.querySelector('#btn-dodge  .skill-cd') },
      skill1: { el: document.getElementById('btn-skill1'), cd: document.querySelector('#btn-skill1 .skill-cd') },
      skill2: { el: document.getElementById('btn-skill2'), cd: document.querySelector('#btn-skill2 .skill-cd') },
    };

    // 开始界面
    this.startPanel = document.getElementById('start-panel');
    this.startBtn = document.getElementById('btn-start-duel');
    this.retryTutorialBtn = document.getElementById('btn-retry-tutorial');
    this.countdown = document.getElementById('duel-countdown');

    // 新手训练
    this.tutorialOverlay = document.getElementById('tutorial-overlay');
    this.tutorialText = document.getElementById('tutorial-text');

    // 切换桌面/手机操作说明
    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    const guideDesktop = document.getElementById('control-guide-desktop');
    const guideMobile = document.getElementById('control-guide-mobile');
    if (isTouch && guideDesktop && guideMobile) {
      guideDesktop.style.display = 'none';
      guideMobile.style.display = 'inline-block';
    }

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

  spawnDamageNumber(worldPos, amount, camera) {
    this._v.copy(worldPos).project(camera);
    if (this._v.z > 1) return;
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

  screenFlash() {
    if (!this.flash) return;
    this.flash.classList.remove('active');
    void this.flash.offsetWidth;
    this.flash.classList.add('active');
  }

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

  showEnd({ win, difficulty, winStreak, onRestart, onNextDifficulty, onMainMenu }) {
    const DIFF_LABELS = { rookie: '新手', normal: '普通', hard: '高手' };
    const diffLabel = DIFF_LABELS[difficulty] || difficulty;

    this.endText.textContent = win ? '胜  利' : '失  败';
    this.endText.classList.toggle('lose', !win);

    // 难度 + 连胜信息
    if (win) {
      this.endMeta.textContent = `当前难度：${diffLabel}\n连胜：${winStreak}`;
    } else {
      this.endMeta.textContent = `当前难度：${diffLabel}`;
    }
    this.endMeta.style.whiteSpace = 'pre-line';

    // 挑战更高难度按钮：仅胜利且非 hard 时显示
    if (win && difficulty !== 'hard') {
      const nextLabel = difficulty === 'rookie' ? '挑战普通难度' : '挑战高手难度';
      this.nextDiffBtn.textContent = nextLabel;
      this.nextDiffBtn.style.display = '';
    } else {
      this.nextDiffBtn.style.display = 'none';
    }

    this.endPanel.classList.add('show');

    this.restartBtn.onclick = () => {
      this.hideEnd();
      onRestart && onRestart();
    };
    this.nextDiffBtn.onclick = () => {
      this.hideEnd();
      onNextDifficulty && onNextDifficulty();
    };
    this.mainMenuBtn.onclick = () => {
      this.hideEnd();
      onMainMenu && onMainMenu();
    };
  }

  hideEnd() {
    this.endPanel.classList.remove('show');
  }

  /* ---------- 开始界面 ---------- */

  showStart(onStart) {
    this.startPanel.classList.add('show');

    // 难度选择
    const btns = this.startPanel.querySelectorAll('[data-difficulty]');
    btns.forEach((b) => {
      b.onclick = () => {
        btns.forEach((x) => x.classList.remove('selected'));
        b.classList.add('selected');
      };
    });

    this.startBtn.onclick = () => {
      const selected = this.startPanel.querySelector('[data-difficulty].selected');
      const difficulty = selected?.dataset.difficulty || 'rookie';
      this.hideStart();
      onStart(difficulty);
    };
  }

  hideStart() {
    this.startPanel.classList.remove('show');
  }

  showRetryTutorial(onRetry) {
    if (!this.retryTutorialBtn) return;
    this.retryTutorialBtn.style.display = 'block';
    this.retryTutorialBtn.onclick = () => {
      this.retryTutorialBtn.style.display = 'none';
      this.hideStart();
      onRetry();
    };
  }

  /* ---------- 倒计时 ---------- */

  showCountdown(text) {
    if (
      this.countdown.textContent === text &&
      this.countdown.classList.contains('show')
    ) {
      return;
    }
    this.countdown.textContent = text;
    this.countdown.classList.remove('show');
    void this.countdown.offsetWidth;
    this.countdown.classList.add('show');
  }

  hideCountdown() {
    this.countdown.classList.remove('show');
  }

  /* ---------- 新手训练 ---------- */

  showTutorial(text) {
    this.tutorialText.textContent = text;
    this.tutorialOverlay.classList.add('show');
  }

  hideTutorial() {
    this.tutorialOverlay.classList.remove('show');
  }
}
