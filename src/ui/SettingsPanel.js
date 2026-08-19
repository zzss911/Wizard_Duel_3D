/**
 * SettingsPanel —— 设置面板
 * 音效开关 / 音量 / 画质 / 返回
 */
export class SettingsPanel {
  constructor() {
    this.el = document.getElementById('settings-panel');
    this.btnBack = document.getElementById('btn-settings-back');
    this.toggleSound = document.getElementById('toggle-sound');
    this.volumeSlider = document.getElementById('volume-slider');
    this.qualityBtns = document.querySelectorAll('.quality-btn');

    // 从 localStorage 恢复
    this.soundOn = localStorage.getItem('wd_sound_on') !== '0';
    this.volume = parseFloat(localStorage.getItem('wd_volume') || '0.6');
    this.quality = localStorage.getItem('wd_quality') || (window.matchMedia('(pointer: coarse)').matches ? 'low' : 'high');

    this._syncUI();
  }

  _syncUI() {
    if (this.toggleSound) {
      this.toggleSound.textContent = this.soundOn ? '开' : '关';
      this.toggleSound.classList.toggle('off', !this.soundOn);
    }
    if (this.volumeSlider) {
      this.volumeSlider.value = this.volume;
    }
    this.qualityBtns.forEach((b) => {
      b.classList.toggle('selected', b.dataset.quality === this.quality);
    });
  }

  show() {
    this.el.classList.add('show');
  }

  hide() {
    this.el.classList.remove('show');
  }

  setCallbacks({ onBack, onVolumeChange, onQualityChange }) {
    this.btnBack.onclick = () => {
      this.hide();
      onBack && onBack();
    };

    if (this.toggleSound) {
      this.toggleSound.onclick = () => {
        this.soundOn = !this.soundOn;
        localStorage.setItem('wd_sound_on', this.soundOn ? '1' : '0');
        this._syncUI();
        onVolumeChange && onVolumeChange({ soundOn: this.soundOn, volume: this.volume });
      };
    }

    if (this.volumeSlider) {
      this.volumeSlider.oninput = () => {
        this.volume = parseFloat(this.volumeSlider.value);
        localStorage.setItem('wd_volume', String(this.volume));
        onVolumeChange && onVolumeChange({ soundOn: this.soundOn, volume: this.volume });
      };
    }

    this.qualityBtns.forEach((b) => {
      b.onclick = () => {
        this.quality = b.dataset.quality;
        localStorage.setItem('wd_quality', this.quality);
        this._syncUI();
        onQualityChange && onQualityChange(this.quality);
      };
    });
  }

  getSettings() {
    return { soundOn: this.soundOn, volume: this.volume, quality: this.quality };
  }
}
