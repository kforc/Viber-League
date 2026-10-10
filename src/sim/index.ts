// sim/index.ts — the public surface of the simulation layer.
// Nothing outside sim/ may reach past this file.

export * from './types';
export * from './constants';
export { v2, dist, clamp, len, norm, sub, add, scale } from './core/math';
export { makeRng } from './core/rng';
export { createWorld, resetPositions } from './world';
export { step, drainEvents, queue, currentMinute } from './engine';
export { opponentGoalPos, ownGoalPos } from './ai';
export {
  beginSetPiece,
  awardFromOutOfPlay,
  awardFoul,
  setPieceTarget,
  runSetPiece,
  inOwnPenaltyArea,
  isSetPiecePhase,
  type OutOfPlay,
} from './setpiece';
export { CLUBS, FORMATIONS, PLAYER_CLUB, OPPONENT_CLUBS } from './content';
export {
  ROSTER,
  ROSTER_BY_ID,
  overallOf,
  teamOverall,
  buildLineup,
  autoOpponent,
  SLOT_ROLES,
  type ViberCharacter,
  type ViberDesign,
  type ViberRole,
  type LineupSlot,
  type OpponentSelection,
} from './roster';
export { WEATHERS, WEATHER_ORDER, weatherMods, type WeatherDef, type WeatherMods } from './weather';
export {
  LEAGUE_CLUB_IDS,
  PLAYER_CLUB_ID,
  clubStrength,
  makeSchedule,
  seasonRounds,
  simulateCpuFixture,
  completeResults,
  buildTable,
  clubName,
  clubShort,
  playerFixtures,
  nextFixture,
  playerRow,
  playerPosition,
  opponentOf,
  isHomeFixture,
  seasonComplete,
  careerTotals,
  recentForm,
  summariseSeason,
  lifetimeTotals,
  fixtureWeather,
  type Fixture,
  type Result,
  type ResultMap,
  type TableRow,
  type FormEntry,
  type CareerTotals,
  type SeasonSummary,
  type ClubDef,
} from './league';
