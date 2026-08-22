import { Game } from './core/Game.js';

const game = new Game(document.getElementById('app'));
game.start();

// Hide loading overlay once game is running
requestAnimationFrame(() => {
  const loading = document.getElementById('game-loading');
  if (loading) {
    loading.classList.add('hidden');
    setTimeout(() => loading.remove(), 600);
  }
});
