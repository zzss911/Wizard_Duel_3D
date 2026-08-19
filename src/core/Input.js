/**
 * Input —— 键鼠 / 触控统一输入层
 * 对外只暴露抽象动作：
 *   getMoveVector() -> {x, y}   x: 右移+, y: 前进+（已归一化）
 *   consumeLook()   -> {dx, dy} 本帧累计的镜头增量（像素）
 *   isAttackHeld()  -> boolean
 *   consumeAction(name) -> boolean   'dodge' / 'skill1' / 'skill2'（边沿触发）
 * 上层（Player / Game）完全不感知设备差异。
 */
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.isTouch = window.matchMedia('(pointer: coarse)').matches;

    this.keys = Object.create(null);
    this._lookDX = 0;
    this._lookDY = 0;
    this._attackHeld = false;
    this._dragging = false;
    this._lastMouse = { x: 0, y: 0 };
    this._actions = { dodge: false, skill1: false, skill2: false };
    this.gameplayEnabled = false;

    // 虚拟摇杆状态
    this.joy = { active: false, id: -1, ox: 0, oy: 0, dx: 0, dy: 0 };
    this.lookTouch = { active: false, id: -1, lx: 0, ly: 0 };

    this._bindKeyboard();
    this._bindMouse();
    this._bindTouch();
    if (this.isTouch) this._buildTouchUI();
    else this._bindSkillButtons(); // 桌面端也可点击技能按钮
  }

  /* ---------------- 键盘 ---------------- */
  _bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      this.keys[e.code] = true;
      if (e.code === 'KeyJ') this._attackHeld = true;
      if (!e.repeat) {
        if (e.code === 'Space') this._actions.dodge = true;
        if (e.code === 'KeyQ') this._actions.skill1 = true;
        if (e.code === 'KeyE') this._actions.skill2 = true;
      }
      if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      this.keys[e.code] = false;
      if (e.code === 'KeyJ') this._attackHeld = false;
    });
    window.addEventListener('blur', () => {
      this.keys = Object.create(null);
      this._attackHeld = false;
    });
  }

  /* ---------------- 鼠标（指针锁定 + 拖拽兜底） ---------------- */
  _bindMouse() {
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (document.pointerLockElement !== this.canvas) {
        this.canvas.requestPointerLock?.();
        this._dragging = true;
        this._lastMouse.x = e.clientX;
        this._lastMouse.y = e.clientY;
      } else {
        this._attackHeld = true;
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) {
        this._attackHeld = false;
        this._dragging = false;
      }
    });
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === this.canvas) {
        this._lookDX += e.movementX;
        this._lookDY += e.movementY;
      } else if (this._dragging) {
        this._lookDX += e.clientX - this._lastMouse.x;
        this._lookDY += e.clientY - this._lastMouse.y;
        this._lastMouse.x = e.clientX;
        this._lastMouse.y = e.clientY;
      }
    });
  }

  /* ---------------- 触控 ---------------- */
  _bindTouch() {
    const opts = { passive: false };
    window.addEventListener('touchstart', (e) => this._onTouchStart(e), opts);
    window.addEventListener('touchmove', (e) => this._onTouchMove(e), opts);
    window.addEventListener('touchend', (e) => this._onTouchEnd(e), opts);
    window.addEventListener('touchcancel', (e) => this._onTouchEnd(e), opts);
  }

  _onTouchStart(e) {
    for (const t of e.changedTouches) {
      const el = document.elementFromPoint(t.clientX, t.clientY);
      if (el && el.closest('#btn-fire')) continue; // 攻击按钮自行处理

      if (t.clientX < window.innerWidth * 0.45 && !this.joy.active) {
        // 左半屏：动态原点摇杆
        this.joy.active = true;
        this.joy.id = t.identifier;
        this.joy.ox = t.clientX;
        this.joy.oy = t.clientY;
        this.joy.dx = 0;
        this.joy.dy = 0;
        this._placeJoystick(t.clientX, t.clientY, 0, 0);
        e.preventDefault();
      } else if (!this.lookTouch.active) {
        // 其余区域：镜头滑动
        this.lookTouch.active = true;
        this.lookTouch.id = t.identifier;
        this.lookTouch.lx = t.clientX;
        this.lookTouch.ly = t.clientY;
        e.preventDefault();
      }
    }
  }

  _onTouchMove(e) {
    for (const t of e.changedTouches) {
      if (this.joy.active && t.identifier === this.joy.id) {
        const R = 55; // 摇杆半径（px）
        let dx = t.clientX - this.joy.ox;
        let dy = t.clientY - this.joy.oy;
        const len = Math.hypot(dx, dy);
        if (len > R) { dx = dx / len * R; dy = dy / len * R; }
        this.joy.dx = dx / R;
        this.joy.dy = dy / R;
        this._placeJoystick(this.joy.ox, this.joy.oy, dx, dy);
        e.preventDefault();
      } else if (this.lookTouch.active && t.identifier === this.lookTouch.id) {
        this._lookDX += t.clientX - this.lookTouch.lx;
        this._lookDY += t.clientY - this.lookTouch.ly;
        this.lookTouch.lx = t.clientX;
        this.lookTouch.ly = t.clientY;
        e.preventDefault();
      }
    }
  }

  _onTouchEnd(e) {
    for (const t of e.changedTouches) {
      if (this.joy.active && t.identifier === this.joy.id) {
        this.joy.active = false;
        this.joy.dx = 0;
        this.joy.dy = 0;
        this._hideJoystick();
      }
      if (this.lookTouch.active && t.identifier === this.lookTouch.id) {
        this.lookTouch.active = false;
      }
    }
  }

  /* ---------------- 触控 UI ---------------- */
  _buildTouchUI() {
    this.joyEl = document.createElement('div');
    this.joyEl.id = 'joystick';
    this.joyEl.className = 'touch-ui';
    this.joyEl.style.display = 'none';
    this.joyEl.innerHTML = '<div class="knob"></div>';
    document.body.appendChild(this.joyEl);
    this.knobEl = this.joyEl.querySelector('.knob');

    this.fireBtn = document.createElement('div');
    this.fireBtn.id = 'btn-fire';
    this.fireBtn.textContent = '攻击';
    document.body.appendChild(this.fireBtn);

    this.fireBtn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._attackHeld = true;
      this.fireBtn.classList.add('pressed');
    }, { passive: false });
    const release = (e) => {
      e.preventDefault();
      this._attackHeld = false;
      this.fireBtn.classList.remove('pressed');
    };
    this.fireBtn.addEventListener('touchend', release, { passive: false });
    this.fireBtn.addEventListener('touchcancel', release, { passive: false });

    this._bindSkillButtons();
  }

  /* ---------------- 技能按钮（触控 + 鼠标点击都可用） ---------------- */
  _bindSkillButtons() {
    const bind = (id, action) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._actions[action] = true;
        el.classList.add('pressed');
      }, { passive: false });
      const up = () => el.classList.remove('pressed');
      el.addEventListener('touchend', up);
      el.addEventListener('touchcancel', up);
      // 桌面鼠标点击也可触发
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this._actions[action] = true;
      });
    };
    bind('btn-dodge', 'dodge');
    bind('btn-skill1', 'skill1');
    bind('btn-skill2', 'skill2');
  }

  _placeJoystick(x, y, kdx, kdy) {
    if (!this.joyEl) return;
    this.joyEl.style.display = 'block';
    this.joyEl.style.left = x + 'px';
    this.joyEl.style.top = y + 'px';
    this.knobEl.style.transform = `translate(calc(-50% + ${kdx}px), calc(-50% + ${kdy}px))`;
  }

  _hideJoystick() {
    if (this.joyEl) this.joyEl.style.display = 'none';
  }

  /* ---------------- 对外抽象接口 ---------------- */

  setGameplayEnabled(enabled) {
    this.gameplayEnabled = enabled;
    if (!enabled) {
      this._attackHeld = false;
      this._actions.dodge = false;
      this._actions.skill1 = false;
      this._actions.skill2 = false;
      this.keys = Object.create(null);
      this.joy.dx = 0;
      this.joy.dy = 0;
    }
  }

  getMoveVector() {
    if (!this.gameplayEnabled) return { x: 0, y: 0 };
    let x = 0, y = 0;
    if (this.keys['KeyW'] || this.keys['ArrowUp']) y += 1;
    if (this.keys['KeyS'] || this.keys['ArrowDown']) y -= 1;
    if (this.keys['KeyA'] || this.keys['ArrowLeft']) x -= 1;
    if (this.keys['KeyD'] || this.keys['ArrowRight']) x += 1;

    if (this.joy.active) {
      x += this.joy.dx;
      y += -this.joy.dy; // 屏幕上方 = 前进
    }

    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    return { x, y };
  }

  consumeLook() {
    const d = { dx: this._lookDX, dy: this._lookDY };
    this._lookDX = 0;
    this._lookDY = 0;
    return d;
  }

  isAttackHeld() {
    return this.gameplayEnabled && this._attackHeld;
  }

  /** 边沿触发动作：'dodge' / 'skill1' / 'skill2'，读取后自动清除 */
  consumeAction(name) {
    if (!this.gameplayEnabled) {
      this._actions[name] = false;
      return false;
    }
    const v = this._actions[name];
    this._actions[name] = false;
    return v;
  }
}
