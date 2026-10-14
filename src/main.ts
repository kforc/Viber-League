// main.ts — bootstrap.

import './fonts.css';
import './style.css';
import { Game } from './app/game';
import { isWebGLAvailable } from './render/webgl';

const stage = document.getElementById('stage')!;
const ui = document.getElementById('ui')!;

// WebGL is required for the 3D pitch. Probe it BEFORE constructing the renderer,
// so a missing context shows a friendly, on-brand message instead of a blank
// screen and an uncaught THREE.WebGLRenderer exception.
if (!isWebGLAvailable()) {
  renderFatal(ui, null);
} else {
  try {
    const game = new Game(stage, ui);
    // Expose for quick debugging in the console.
    (window as unknown as { game: Game }).game = game;
  } catch (err) {
    // Defensive backstop: if WebGL init throws rather than returning a bad
    // context, we still never leave the player on a blank page.
    console.error('Viber League failed to start:', err);
    renderFatal(ui, err instanceof Error ? err : null);
  }
}

/**
 * On-brand "unsupported environment" screen.
 *
 * Shown when WebGL is unavailable (or startup throws). Replaces the game rather
 * than layering on top of a half-built renderer, so no canvas, listeners, or
 * animation loops are left behind. The diagnostic detail is for developers and
 * is never shown to players.
 */
function renderFatal(root: HTMLElement, err: Error | null): void {
  root.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'fatal';
  wrap.setAttribute('role', 'alert');
  wrap.innerHTML = `
    <div class="fatal-card">
      <div class="fatal-mark" aria-hidden="true">V</div>
      <h1 class="fatal-title">Viber League needs WebGL</h1>
      <p class="fatal-body">This game renders its 3D pitch with WebGL, which your browser or device currently has turned off or unavailable.</p>
      <p class="fatal-hint">Turn on <strong>hardware acceleration</strong> in your browser settings, then reload. Or open this page in the latest Chrome, Firefox, Safari, or Edge.</p>
    </div>
  `;
  root.appendChild(wrap);
  if (err && import.meta.env.DEV) console.warn('Startup failure detail:', err.message);
}
