// main.ts — bootstrap.

import './fonts.css';
import './style.css';
import { Game } from './app/game';

const stage = document.getElementById('stage')!;
const ui = document.getElementById('ui')!;

const game = new Game(stage, ui);

// Expose for quick debugging in the console.
(window as unknown as { game: Game }).game = game;
