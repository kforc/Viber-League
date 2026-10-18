// app/game.ts — wires sim <-> renderer <-> UI, and owns the pre-match flow.
// The only place the three layers meet.

import { MatchRenderer } from '../render/renderer';
import type { ShowcaseOptions } from '../render/showcase';
import {
  autoBench,
  autoOpponent,
  benchFromSquad,
  createWorld,
  drainEvents,
  flushCommands,
  overallOf,
  PITCH_HALF_L,
  queue,
  ROSTER,
  ROSTER_BY_ID,
  step,
  TICK,
  type DiveDirection,
  type Mentality,
  type OpponentSelection,
  type SimEvent,
  type WeatherKind,
  type World,
} from '../sim';
import { createSoundEngine, CrowdHeat, type SoundEngine } from '../audio/sound';
import { Hud } from '../ui/hud';
import { clear, el } from '../ui/dom';
import {
  LENGTH_OPTIONS,
  renderAccountSheet,
  renderCareer,
  renderHalftime,
  renderHelp,
  renderLeague,
  renderLeagueGate,
  renderMinutes,
  renderModes,
  renderOnboarding,
  renderOpponent,
  renderPenaltyDive,
  renderPenaltyShoot,
  renderPause,
  renderPauseConfirm,
  renderPlayers,
  renderResult,
  renderSettings,
  renderSignIn,
  renderSquadSelect,
  renderSquadView,
  renderSubs,
  renderTitle,
  renderViberDetail,
  renderWeather,
  ordinal,
  type LeagueTab,
  type MenuSection,
  type PlayerSort,
  type RoleFilter,
} from '../ui/screens';
import { setPlayerClubIdentity } from '../sim/content';
import {
  buildTable,
  completeResults,
  fixtureWeather,
  isHomeFixture,
  nextFixture,
  opponentOf,
  playerFixtures,
  playerPosition,
  playerRow,
  type Fixture,
} from '../sim/league';
import {
  PROFILE_LIMITS,
  canHashPassword,
  clearProfile,
  createProfile,
  loadProfile,
  storageAvailable,
  verifyPassword,
  type LocalProfile,
} from './profile';
import {
  absencesFromEvents,
  clearCareer,
  currentSeasonSummary,
  defaultCareer,
  fitSquad,
  hasStoredLeague,
  isAvailable,
  leagueExists,
  loadCareer,
  loadExistingLeague,
  newLeague,
  saveCareer,
  startNextSeason,
  tickAbsences,
  withAbsences,
  withLineup,
  withResult,
  withSettings,
  LEAGUE_SQUAD_MAX,
  SQUAD_SIZE,
  type Absence,
  type CareerSettings,
  type CareerState,
} from './career';

/**
 * How the player is playing, chosen once on the mode screen.
 *
 * It is a lens over the pre-match flow rather than a second set of screens: the
 * squad picker, the opponent screen and the match are the same either way. What
 * it decides is whether a match is *real* — whether it files a result, costs
 * anyone a game, and picks from the club's twelve or the whole roster.
 */
type Mode = 'quick' | 'league';

type AppState =
  | 'onboarding'
  | 'signin'
  | 'account'
  | 'title'
  | 'modes'
  | 'help'
  | 'league'
  | 'squadview'
  | 'players'
  | 'career'
  | 'settings'
  | 'squad'
  | 'detail'
  | 'weather'
  | 'minutes'
  | 'opponent'
  | 'match'
  | 'penalty'
  | 'paused'
  | 'subs'
  | 'halftime'
  | 'result';

/**
 * Camera framing per screen. `screenFrac` is where the hero's centre lands
 * (0 = top of the viewport) and `fill` is how much of the viewport height the
 * figure takes.
 *
 * These are only the fallbacks. Where a screen reserves a real band for the
 * hero in the DOM, the band is measured and the framing solved from it — so the
 * Viber lands between the logo and the button at every viewport size instead of
 * being buried behind a control on a short landscape phone.
 */
const FRAMING: Record<string, ShowcaseOptions> = {
  menu: { screenFrac: 0.5, fill: 0.34 },
  squad: { screenFrac: 0.3, fill: 0.4 },
  profile: { screenFrac: 0.3, fill: 0.52 },
  venue: { screenFrac: 0.31, fill: 0.36 },
  opponent: { screenFrac: 0.4, fill: 0.28 },
};

export class Game {
  private stage: HTMLElement;
  private uiRoot: HTMLElement;
  private overlay!: HTMLElement;
  private renderer: MatchRenderer;
  private hud: Hud | null = null;
  private world: World | null = null;
  private state: AppState = 'title';
  /**
   * The game's own screen history. BACK walks this stack rather than jumping to
   * a fixed screen, so MAIN MENU → SQUAD → PLAYER DETAILS returns to SQUAD.
   * Every screen re-reads the Game's own fields, so walking back never resets
   * the squad, the venue or the match length.
   */
  private history: AppState[] = [];
  private raf = 0;
  private last = 0;
  private acc = 0;
  private halfTwoStarted = false;

  // --- Pre-match choices ---
  /** Which mode the pre-match flow in progress belongs to. */
  private mode: Mode = 'league';
  private selected: string[] = [];
  /**
   * The five Quick Play is fielding.
   *
   * Kept apart from `selected` on purpose. A friendly must not touch the league
   * — no result filed, no knocks carried, nobody's ban run down — and giving it
   * its own array is what makes that separation structural rather than a set of
   * `if (quick)` guards scattered through the squad screen.
   */
  private quickSelected: string[] = [];
  private weather: WeatherKind = 'sun';
  private halfSeconds = LENGTH_OPTIONS[1].halfSeconds;
  private opponent: OpponentSelection | null = null;
  /**
   * The bench that covers the current five. Recomputed whenever the five change
   * (the squad screen, AUTO PICK, adopting a saved career), so it can never
   * hold a Viber who has since been picked to start.
   */
  private bench: string[] = [];
  /**
   * Everything the referee's notebook needs from the match being played.
   *
   * Kept as the raw event log rather than a running tally of bans, for two
   * reasons. It is the honest input to `absencesFromEvents`, which is pure and
   * unit-tested — a hand-built map here could not be. And it defers the
   * judgement of *what counts* as an absence to one place instead of spreading
   * it through the event switch.
   *
   * Held here rather than written straight to the career so that abandoning a
   * match — quitting from the pause menu, which explicitly does not save —
   * does not saddle the squad with a knock that never happened. The log is read
   * once in `enterResult`, when the fixture itself is filed.
   */
  private matchEvents: SimEvent[] = [];
  private detailId: string | null = null;
  private seed = 0;
  /** Which Viber the 3D hero stage is presenting. */
  private focusId = ROSTER[0].id;
  /** Role filter on the hero-select grid. */
  private filter: RoleFilter = 'ALL';
  /**
   * The player's club, read once at boot and kept for the session. `null` means
   * nobody has created one yet — which is the only case that shows onboarding.
   */
  private profile: LocalProfile | null = null;
  /**
   * The season. Always present: a guest who cannot store a profile still gets a
   * career for the session, it just does not survive the tab closing.
   */
  private career: CareerState = defaultCareer();
  /** The league fixture being played, if the match came from the season. */
  private fixture: Fixture | null = null;
  /** Which tab the league screen is showing. Held here so a re-render keeps it. */
  private leagueTab: LeagueTab = 'table';
  /** The players library's own filter and sort, separate from hero select. */
  private playersFilter: RoleFilter = 'ALL';
  private playersSort: PlayerSort = 'rating';

  /**
   * The match's sound. Built once for the session but silent until the first
   * KICK OFF tap unlocks the audio context — see src/audio/sound.ts.
   */
  private sound: SoundEngine = createSoundEngine();
  /** The crowd's excitement between events. Purely presentational state. */
  private crowd = new CrowdHeat();

  constructor(stage: HTMLElement, uiRoot: HTMLElement) {
    this.stage = stage;
    this.uiRoot = uiRoot;
    this.renderer = new MatchRenderer(stage);
    window.addEventListener('resize', () => this.renderer.resize());

    // A saved club is adopted before anything is drawn, so the crest, the
    // scoreboard and the opponent screen all wear the player's own name from
    // the first frame rather than being corrected a screen later.
    this.profile = loadProfile();
    if (this.profile) this.applyProfile(this.profile);

    // The season comes with it. A guest gets a fresh one for the session.
    this.career = loadCareer() ?? defaultCareer();
    this.applyCareer(this.career);

    // Dev hooks (used by the smoke test and by hand when framing the menus):
    //   ?autostart      jump straight into a match
    //   ?seed=<n>       pin that match, so a probe can reproduce one exact goal
    //   ?hero=<id>      park one Viber on the pitch and hide the UI
    //   ?herofill=<n>   override how much of the viewport the hero fills
    //   ?herofrac=<n>   override where the hero's centre sits (0 = top)
    const params = new URLSearchParams(location.search);
    if (params.has('hero')) {
      const v = ROSTER.find((x) => x.id === params.get('hero')) ?? ROSTER[0];
      this.renderer.enterShowcase(v.design, v.design.accent, {
        screenFrac: Number(params.get('herofrac') ?? 0.42),
        fill: Number(params.get('herofill') ?? 0.5),
      });
    } else if (params.has('autostart')) {
      this.autoPick();
      const pinned = Number(params.get('seed'));
      this.seed = Number.isInteger(pinned) && pinned > 0
        ? pinned
        : Math.floor(Math.random() * 1e9);
      this.bench = autoBench(this.selected);
      this.opponent = autoOpponent(this.selected, this.seed, undefined, this.bench);
      this.startMatch();
    } else {
      this.bootstrap();
    }

    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  /* ----------------------- profile / identity ----------------------- */

  /**
   * The first screen of the session.
   *
   * Everyone lands on the title screen now. A returning player gets their
   * account chip; a brand-new player plays as a guest — PLAY is the primary
   * action and the club-creation form is a secondary, explicit entry they reach
   * from the title screen once they decide they want a saved identity.
   *
   * The old behaviour sent every new player to the "Create Your Club" form
   * first, burying PLAY under five required fields (name, club, crest, password
   * x2). That turned away players who just wanted to try the game. Forcing a
   * sign-up before the first match is the wrong gate; the form is opt-in now.
   * Storage-blocked browsers still play as guests, and the form's own notice
   * explains why it cannot save them.
   */
  private bootstrap(): void {
    this.showTitle();
  }

  /** Push the stored club into the sim so the world and every screen agree. */
  private applyProfile(profile: LocalProfile): void {
    setPlayerClubIdentity(profile.club, profile.short);
  }

  /**
   * Adopt a career's squad and settings.
   *
   * The saved five seeds the pre-match picker, so PLAY starts from the squad the
   * manager chose rather than from an empty grid, and the settings decide the
   * defaults the venue and match-length screens open on.
   */
  private applyCareer(career: CareerState): void {
    this.career = career;
    // Any non-empty squad seeds the picker. It used to insist on exactly five,
    // which would have silently discarded a saved squad the moment it grew.
    if (career.lineup.length > 0) {
      this.selected = [...career.lineup];
      this.focusId = career.lineup[0];
    }
    this.refreshBench();
    this.halfSeconds = career.settings.halfSeconds;
    this.applyReducedMotion(career.settings.reducedMotion);
    // Honour the saved sound setting before a context is ever built, so a muted
    // career never makes a noise even for a frame.
    this.sound.setMuted(!career.settings.sound);
  }

  /**
   * The five the screen in front of the player is actually editing.
   *
   * One accessor rather than a branch at every call site. The squad screen,
   * AUTO PICK, the pick toggle and `starters()` all read and write through
   * here, so there is exactly one place that knows Quick Play is different —
   * and no way to add a fourth screen later that forgets.
   */
  private get activeSelected(): string[] {
    return this.mode === 'quick' ? this.quickSelected : this.selected;
  }

  private set activeSelected(v: string[]) {
    if (this.mode === 'quick') this.quickSelected = v;
    else this.selected = v;
  }

  /**
   * The five who actually take the pitch: the first five FIT members of the
   * squad, in squad order.
   *
   * Filtering on fitness rather than assuming the first five are available is
   * what makes an injury cost something. A manager who loses a starter does not
   * get to field four and a ghost — the next fit player steps up, and it is the
   * *squad* order that decides who.
   */
  private starters(): string[] {
    // Quick Play fields exactly the five that were picked, for one match. It
    // never consults the career — not its lineup and not its absences — which
    // is the whole promise of the mode.
    if (this.mode === 'quick') return this.quickSelected.slice(0, SQUAD_SIZE);
    return fitSquad(this.career).slice(0, SQUAD_SIZE);
  }

  /**
   * The manual reduced-motion switch, on top of the operating system's.
   *
   * `:root[data-motion='reduce']` reuses the same `prefers-reduced-motion`
   * block, so there is one set of rules to keep correct rather than two.
   */
  private applyReducedMotion(reduce: boolean): void {
    document.documentElement.dataset.motion = reduce ? 'reduce' : 'auto';
  }

  /** Persist the career. Failure is not fatal: the session carries on in memory. */
  private commitCareer(next: CareerState): void {
    this.career = next;
    saveCareer(next);
  }

  /* ----------------------- club sections ----------------------- */

  /**
   * The absences that concern the SQUAD.
   *
   * An absence is recorded against the player, not the squad slot, so the
   * career's map can hold entries for roster players the manager does not own —
   * an injury does not heal because a player was dropped, and the picker shows
   * such a player as un-signable. Screens that talk about "your side" want only
   * the squad's share of that, which is what this narrows it to.
   */
  private squadAbsences(): Record<string, Absence> {
    const out: Record<string, Absence> = {};
    for (const id of this.career.lineup) {
      const a = this.career.absences[id];
      if (a) out[id] = a;
    }
    return out;
  }

  private showLeague(): void {
    // No league yet — offer to start one, or to carry on with the one already on
    // the device. Showing the table here would present seven clubs on zero as
    // though a competition had been played and nobody had turned up.
    if (!leagueExists(this.career)) {
      this.showLeagueGate();
      return;
    }
    this.state = 'league';
    clear(this.uiRoot);
    // The CPU half of the season is simulated on demand rather than stored, so
    // the table always matches the season seed. Only the rounds the player has
    // already played are filled in — the rest of the league is on the same
    // matchday they are, so a fresh season opens with all seven clubs on zero.
    const starters = this.starters();
    const results = completeResults(this.career.results, { seed: this.career.seed });
    renderLeague(this.uiRoot, {
      season: this.career.season,
      results,
      lineup: starters,
      // The named squad, not the fit five. `starters` is already filtered down
      // to at most five fit players, so it cannot tell "nobody signed" from
      // "seven injured" — and the screen has to say the right one.
      squadSize: this.career.lineup.length,
      out: this.squadAbsences(),
      tab: this.leagueTab,
      onTab: (t) => {
        this.leagueTab = t;
        this.showLeague();
      },
      onPlayNext: () => this.playNextFixture(),
      onNewLeague: () => this.startNewLeague(),
      onNextSeason: () => {
        this.commitCareer(startNextSeason(this.career));
        this.applyCareer(this.career);
        this.showLeague();
      },
      onBack: () => this.goBack(),
    });
    this.presentInBand(this.focus(), '.league-table, .fixture-list', FRAMING.squad, {
      maxFill: 0.4,
    });
  }

  /**
   * The choice before the table: start a league, or carry on with the one
   * already stored.
   *
   * New League is destructive whenever a season is standing on the device, and
   * the gate says so by arming itself for a second tap in that state. Load
   * Existing League is the no-lost-progress door — it changes nothing about the
   * stored season and only records that a league is live now. That is the whole
   * answer for a save written before this gate existed: it still holds the
   * season the manager was part way through, and this is how they get back into
   * it rather than past it.
   */
  private showLeagueGate(): void {
    this.state = 'league';
    clear(this.uiRoot);
    const stored = hasStoredLeague(this.career);
    renderLeagueGate(this.uiRoot, {
      canLoad: stored,
      hasStored: stored,
      onNewLeague: () => {
        this.commitCareer(newLeague(this.career));
        this.applyCareer(this.career);
        this.showLeague();
      },
      onLoadExisting: () => {
        this.commitCareer(loadExistingLeague(this.career));
        this.applyCareer(this.career);
        this.showLeague();
      },
      onBack: () => this.goBack(),
    });
    this.presentInBand(ROSTER[0], '.modes-spacer', FRAMING.menu, { maxFill: 0.46 });
  }

  /**
   * Opt into a new league: the table, the fixtures and the injury list start
   * from nothing. The club and the squad stay — that is the difference between
   * starting a new *league* and starting a new *club* (Settings → Erase career).
   */
  private startNewLeague(): void {
    this.commitCareer(newLeague(this.career));
    this.applyCareer(this.career);
    this.showLeague();
  }

  /**
   * Start the next fixture through the normal pre-match flow.
   *
   * The season drives the opponent, but the player still picks the five, the
   * venue and the length — a fixture is a match, not a shortcut past one.
   */
  private playNextFixture(): void {
    // Every route into the season declares the mode, so a Quick Play session
    // can never leak its five or its (absent) bench into a league fixture.
    this.mode = 'league';
    // A club is not a season. Without a league there is no next fixture — there
    // is nothing to play — so the choice that creates one comes first.
    if (!leagueExists(this.career)) {
      this.nav('league');
      return;
    }
    const fixture = nextFixture(this.career.results);
    if (!fixture) {
      // The season is finished. The league screen is where the next one starts,
      // so send the player there rather than leaving PLAY doing nothing.
      this.nav('league');
      return;
    }
    this.fixture = fixture;
    // Settings decide the defaults; the venue screen can still override them.
    const preferred = this.career.settings.weather;
    this.weather = preferred === 'random' ? fixtureWeather(this.career.seed, fixture.id) : preferred;
    this.nav('squad');
  }

  private showSquadView(): void {
    this.state = 'squadview';
    clear(this.uiRoot);
    renderSquadView(this.uiRoot, {
      // The five on the pitch are the first five FIT players, not the first five
      // names — an injured starter is covered by whoever is next in line, and
      // this screen has to show the side that would actually walk out.
      lineup: this.starters(),
      squad: this.career.lineup,
      out: this.career.absences,
      // Changing the five is the first step of a match, not a side door into
      // one: it goes through the fixture so the opponent is the real one.
      onChange: () => this.playNextFixture(),
      onOpen: (id) => {
        this.detailId = id;
        this.nav('detail');
      },
      onBack: () => this.goBack(),
    });
    this.present(this.focus(), FRAMING.squad);
  }

  private showPlayers(): void {
    this.state = 'players';
    clear(this.uiRoot);
    renderPlayers(this.uiRoot, {
      filter: this.playersFilter,
      sort: this.playersSort,
      lineup: this.activeSelected,
      max: LEAGUE_SQUAD_MAX,
      out: this.career.absences,
      onFilter: (f) => {
        this.playersFilter = f;
        this.showPlayers();
      },
      onSort: (s) => {
        this.playersSort = s;
        this.showPlayers();
      },
      onCard: (id) => {
        this.detailId = id;
        this.nav('detail');
      },
      onToggle: (id) => this.togglePick(id),
      onBack: () => this.goBack(),
    });
    this.presentInBand(this.focus(), '.hero-stage', FRAMING.squad, { maxFill: 0.4 });
  }

  private showCareerScreen(): void {
    this.state = 'career';
    clear(this.uiRoot);
    renderCareer(this.uiRoot, {
      season: this.career.season,
      current: this.career.results,
      history: this.career.history,
      onBack: () => this.goBack(),
    });
  }

  private showSettings(): void {
    this.state = 'settings';
    clear(this.uiRoot);
    renderSettings(this.uiRoot, {
      halfSeconds: this.career.settings.halfSeconds,
      weather: this.career.settings.weather,
      reducedMotion: this.career.settings.reducedMotion,
      sound: this.career.settings.sound,
      season: this.career.season,
      manager: this.profile?.manager ?? 'Guest',
      club: this.profile?.club ?? 'Your club',
      onHalfSeconds: (s) => this.patchSettings({ halfSeconds: s }),
      onWeather: (w) => this.patchSettings({ weather: w }),
      onReducedMotion: (v) => this.patchSettings({ reducedMotion: v }),
      onSound: (v) => this.patchSettings({ sound: v }),
      onResetSquad: () => {
        this.selected = [];
        this.commitCareer(withLineup(this.career, []));
        this.showSettings();
      },
      onResetCareer: () => {
        clearCareer();
        this.commitCareer(defaultCareer());
        this.applyCareer(this.career);
        this.showSettings();
      },
      onBack: () => this.goBack(),
    });
  }

  private patchSettings(patch: Partial<CareerSettings>): void {
    const next = withSettings(this.career, patch);
    this.commitCareer(next);
    // Match length is a live default; reduced motion has to be applied now.
    if (patch.halfSeconds !== undefined) this.halfSeconds = patch.halfSeconds;
    if (patch.reducedMotion !== undefined) this.applyReducedMotion(patch.reducedMotion);
    if (patch.sound !== undefined) this.applySound(patch.sound);
    this.showSettings();
  }

  /**
   * Apply the sound setting to the audio engine and the HUD.
   *
   * One function because there are two ways in — the Settings screen and the
   * in-match button — and the graph, the HUD and the stored career must never be
   * able to disagree about whether the game is muted.
   *
   * Switching sound ON is also the moment the audio context may start: the tap
   * is a real user gesture, and a muted game never built a context to begin with.
   */
  private applySound(on: boolean): void {
    this.sound.setMuted(!on);
    if (on) this.sound.unlock();
    this.hud?.setMuted(!on);
  }

  /** Route a main-menu tile to its screen. */
  private openSection(section: MenuSection): void {
    // Every tile on the title screen belongs to the club and the season — the
    // League, the player library, the career and the settings. Claiming league
    // mode here means a screen that reads `starters()` can never be left showing
    // the five from a friendly the player played earlier.
    this.mode = 'league';
    switch (section) {
      case 'league':
        this.nav('league');
        break;
      case 'players':
        this.nav('players');
        break;
      case 'career':
        this.nav('career');
        break;
      case 'settings':
        this.nav('settings');
        break;
      default:
        break;
    }
  }

  private showOnboarding(): void {
    this.state = 'onboarding';
    clear(this.uiRoot);
    renderOnboarding(this.uiRoot, {
      limits: PROFILE_LIMITS,
      canHash: canHashPassword(),
      storageOk: storageAvailable(),
      onGuest: () => this.showTitle(),
      onCreate: async (input) => {
        const profile = await createProfile(input);
        this.profile = profile;
        this.applyProfile(profile);
        // A brand new club starts a brand new season.
        clearCareer();
        this.commitCareer(defaultCareer());
        this.applyCareer(this.career);
        this.showTitle();
      },
    });
    // The card owns the middle of the screen; the hero stands behind it.
    this.present(ROSTER[0], FRAMING.profile);
  }

  /**
   * Sign back in to the club already on this device. Only reachable after a
   * sign-out, because a profile that is present needs no unlocking to play.
   */
  private showSignIn(): void {
    const profile = this.profile;
    if (!profile) {
      this.showOnboarding();
      return;
    }
    this.state = 'signin';
    clear(this.uiRoot);
    renderSignIn(this.uiRoot, {
      manager: profile.manager,
      club: profile.club,
      short: profile.short,
      icon: profile.icon,
      hasPassword: Boolean(profile.hash),
      onSignIn: async (password) => {
        const ok = await verifyPassword(profile, password);
        if (ok) {
          this.applyProfile(profile);
          this.showTitle();
        }
        return ok;
      },
      onStartOver: () => {
        clearProfile();
        clearCareer();
        this.profile = null;
        this.commitCareer(defaultCareer());
        this.applyCareer(this.career);
        this.showOnboarding();
      },
    });
    this.present(ROSTER[0], FRAMING.profile);
  }

  private showAccount(): void {
    const profile = this.profile;
    if (!profile) {
      this.showTitle();
      return;
    }
    this.state = 'account';
    clear(this.uiRoot);
    renderAccountSheet(this.uiRoot, {
      manager: profile.manager,
      club: profile.club,
      short: profile.short,
      icon: profile.icon,
      hasPassword: Boolean(profile.hash),
      onClose: () => this.goBack(),
      onSignOut: () => this.showSignIn(),
    });
  }

  /* ----------------------- hero showcase helpers ----------------------- */

  private focus(): (typeof ROSTER)[number] {
    return ROSTER.find((v) => v.id === this.focusId) ?? ROSTER[0];
  }

  /** Present one Viber on the pitch behind the current screen. */
  private present(which: (typeof ROSTER)[number], framing: ShowcaseOptions): void {
    this.renderer.enterShowcase(which.design, which.design.accent, framing);
  }

  /**
   * Present the hero inside a band the DOM has actually reserved for it.
   *
   * `selector` is the empty band (the menu spacer, the hero stage). With
   * `aboveSelector` the band runs from the top of the viewport down to that
   * element instead — which is how the profile hero sits above its sheet.
   */
  private presentInBand(
    which: (typeof ROSTER)[number],
    selector: string,
    fallback: ShowcaseOptions,
    opts: { aboveSelector?: string; maxFill?: number } = {},
  ): void {
    const maxFill = opts.maxFill ?? 0.52;
    const vh = window.innerHeight || 1;

    const node = this.uiRoot.querySelector(selector) as HTMLElement | null;
    let top = 0;
    let height = 0;

    if (opts.aboveSelector) {
      const below = this.uiRoot.querySelector(opts.aboveSelector) as HTMLElement | null;
      top = 0;
      height = below ? below.getBoundingClientRect().top : vh;
    } else if (node) {
      const r = node.getBoundingClientRect();
      top = r.top;
      height = r.height;
    }

    if (height < 40) {
      this.present(which, fallback);
      return;
    }

    const screenFrac = (top + height / 2) / vh;
    // Fill the band, but never so much that the figure spills over the logo or
    // the buttons above and below it.
    const fill = Math.max(0.16, Math.min(maxFill, (height / vh) * 1.04));
    this.present(which, { screenFrac, fill });
  }

  /* ----------------------- pre-match flow ----------------------- */

  /**
   * Move to a screen, remembering where we came from. Pass `record = false`
   * for a re-render of the current screen (a filter tap, a squad toggle) so
   * BACK does not have to be pressed twice.
   */
  private nav(to: AppState, record = true): void {
    if (record && to !== this.state) this.history.push(this.state);
    switch (to) {
      case 'onboarding':
        this.showOnboarding();
        break;
      case 'signin':
        this.showSignIn();
        break;
      case 'account':
        this.showAccount();
        break;
      case 'modes':
        this.showModes();
        break;
      case 'help':
        this.showHelp();
        break;
      case 'league':
        this.showLeague();
        break;
      case 'squadview':
        this.showSquadView();
        break;
      case 'players':
        this.showPlayers();
        break;
      case 'career':
        this.showCareerScreen();
        break;
      case 'settings':
        this.showSettings();
        break;
      case 'title':
        this.showTitle();
        break;
      case 'squad':
        this.showSquad();
        break;
      case 'detail':
        if (this.detailId) this.showDetail(this.detailId);
        break;
      case 'weather':
        this.showWeather();
        break;
      case 'minutes':
        this.showMinutes();
        break;
      case 'opponent':
        this.showOpponentScreen();
        break;
      default:
        break;
    }
  }

  /** The one BACK action. Pops the screen history. */
  private goBack(): void {
    const prev = this.history.pop();
    if (!prev) {
      this.showTitle();
      return;
    }
    this.nav(prev, false);
  }

  private showTitle(): void {
    this.state = 'title';
    clear(this.uiRoot);
    const profile = this.profile;
    // PLAY opens the mode screen rather than diving into the season, so the
    // first decision is how to play and not which fixture is next.
    renderTitle(this.uiRoot, () => this.nav('modes'), {
      // A guest has no name to show, so the chip is absent rather than showing
      // a placeholder — but every tile still opens its screen.
      manager: profile?.manager,
      // The club line under the wordmark wears the crest the player chose. A
      // guest has no club, so the line is simply absent.
      club: profile ? { name: profile.club, icon: profile.icon } : undefined,
      onAccount: profile ? () => this.nav('account') : undefined,
      // A signed-out player gets a "Create Club" entry in the account slot
      // instead of the account chip — secondary to PLAY, but reachable.
      onCreateClub: profile ? undefined : () => this.showOnboarding(),
      onSection: (section) => this.openSection(section),
    });
    // The logo and the PLAY button leave an empty band in the middle; the hero
    // is framed into exactly that band.
    this.presentInBand(ROSTER[0], '.menu-spacer', FRAMING.menu, { maxFill: 0.46 });
  }

  /**
   * How the player wants to play, chosen once.
   *
   * Two tiles, not three. Player-versus-player is a networking layer rather
   * than a mode — it needs a relay, a join flow, and a simulation that is
   * bit-identical on two different devices, which this one is not yet — so it
   * is deliberately absent until that is proven. A tile that leads nowhere is
   * worse than no tile.
   */
  private showModes(): void {
    this.state = 'modes';
    clear(this.uiRoot);
    const fixtures = playerFixtures();
    renderModes(this.uiRoot, {
      started: leagueExists(this.career),
      season: this.career.season,
      // Only the player's own fixtures are ever persisted, so a stored result
      // is a game played. This is the same count the League screen shows.
      played: fixtures.filter((f) => this.career.results[f.id]).length,
      total: fixtures.length,
      onQuick: () => this.enterQuickPlay(),
      onLeague: () => this.playNextFixture(),
      onHelp: () => this.nav('help'),
      onBack: () => this.goBack(),
    });
    this.presentInBand(ROSTER[0], '.modes-spacer', FRAMING.menu, { maxFill: 0.46 });
  }

  /**
   * The game guide. The reason every other screen is quiet: the words that used
   * to be their subtitles are written down once, here, where a player who wants
   * them can read them at length.
   */
  private showHelp(): void {
    this.state = 'help';
    clear(this.uiRoot);
    renderHelp(this.uiRoot, { onBack: () => this.goBack() });
    // A document, not a stage: no hero is framed into it, and the one behind the
    // Play screen must not show through the guide.
    this.renderer.hideShowcase();
  }

  /**
   * Start a friendly.
   *
   * Nothing about the league is read or written. The picker opens on whatever
   * five was last fielded in Quick Play — empty the first time — and draws from
   * the whole roster rather than the club's twelve.
   */
  private enterQuickPlay(): void {
    this.mode = 'quick';
    // A friendly is never a fixture, so the result screen has nothing to file
    // even if it tried to.
    this.fixture = null;
    this.nav('squad');
  }

  private showSquad(): void {
    this.state = 'squad';
    clear(this.uiRoot);
    const quick = this.mode === 'quick';
    renderSquadSelect(this.uiRoot, {
      selected: this.activeSelected,
      focus: this.focus(),
      filter: this.filter,
      quick,
      // Five and no more in Quick Play: a friendly fields no bench, so there is
      // nothing for a sixth pick to be cover for.
      max: quick ? SQUAD_SIZE : LEAGUE_SQUAD_MAX,
      // A friendly has no absentees. Nobody is injured or banned going into one,
      // so the OUT badges are absent rather than empty.
      out: quick ? {} : this.career.absences,
      onCard: (id) => {
        this.detailId = id;
        this.nav('detail');
      },
      onToggle: (id) => this.togglePick(id),
      onFilter: (f) => {
        this.filter = f;
        this.showSquad();
      },
      onAuto: () => {
        this.autoPick();
        this.commitLineup();
        this.showSquad();
      },
      onClear: () => {
        this.activeSelected = [];
        this.commitLineup();
        this.showSquad();
      },
      onNext: () => {
        this.commitLineup();
        // Quick Play goes straight to the pitch. The venue and match-length
        // screens are season ceremony — a friendly takes what it is given.
        this.nav(quick ? 'opponent' : 'weather');
      },
      onBack: () => this.goBack(),
    });
    // The hero band above the card grid.
    this.presentInBand(this.focus(), '.hero-stage', FRAMING.squad, { maxFill: 0.44 });
  }

  /**
   * The five are a career fact, not a per-match choice, so they are saved.
   *
   * In Quick Play they are neither. The mode sits deliberately outside the
   * career, so nothing is written — the picker stays fully usable and the
   * league squad the player built is still there when they go back to it.
   */
  private commitLineup(): void {
    if (this.mode === 'league') this.commitCareer(withLineup(this.career, this.selected));
    this.refreshBench();
  }

  /**
   * Rebuild the bench to cover the current starting five.
   *
   * Called from every path that can change the squad. It has to be a rebuild and
   * not a patch: a Viber who has just been promoted to the starting lineup must
   * leave the bench, or the same player would be available to come on for
   * themselves.
   *
   * The pool is the club's own fit squad, NOT the whole roster — see
   * `benchFromSquad`. A league side can only field players it has, and it is
   * that limit which gives a 12-player squad any point.
   */
  private refreshBench(): void {
    // Quick Play fields five and no more. There is no squad to draw cover from,
    // and manufacturing one would quietly hand a friendly the depth that the
    // twelve-man squad exists to ration — so the bench is empty, and the pause
    // menu disables Subs on its own when it is.
    if (this.mode === 'quick') {
      this.bench = [];
      return;
    }
    const starters = this.starters();
    this.bench = benchFromSquad(fitSquad(this.career), starters);
  }

  private togglePick(id: string): void {
    const picked = this.activeSelected;
    const cap = this.mode === 'quick' ? SQUAD_SIZE : LEAGUE_SQUAD_MAX;
    if (picked.includes(id)) {
      this.activeSelected = picked.filter((x) => x !== id);
    } else if (this.mode !== 'quick' && !isAvailable(this.career, id)) {
      // Injured or suspended: not selectable at all. The card says why.
      // Quick Play carries no absences, so nothing is ever ruled out there.
      return;
    } else if (picked.length < cap) {
      this.activeSelected = [...picked, id];
    }
    this.focusId = id;
    this.commitLineup();
    // A re-render of whichever screen asked, not a navigation.
    if (this.state === 'detail') this.showDetail(id);
    else if (this.state === 'players') this.showPlayers();
    else if (this.state === 'squadview') this.showSquadView();
    else this.showSquad();
  }

  private showDetail(id: string): void {
    const v = ROSTER.find((x) => x.id === id);
    if (!v) return;
    this.state = 'detail';
    this.detailId = id;
    this.focusId = id;
    clear(this.uiRoot);
    const quick = this.mode === 'quick';
    const picked = this.activeSelected;
    renderViberDetail(this.uiRoot, v, {
      selected: picked.includes(id),
      canAdd: picked.length < (quick ? SQUAD_SIZE : LEAGUE_SQUAD_MAX),
      // A friendly carries no absences, so nobody wears an OUT badge in one.
      out: quick ? null : this.career.absences[id] ?? null,
      onToggle: () => this.togglePick(id),
      onClose: () => this.goBack(),
    });
    // The sheet owns the bottom of the screen; the hero stands above it.
    this.presentInBand(v, '.sheet', FRAMING.profile, {
      aboveSelector: '.sheet',
      maxFill: 0.5,
    });
  }

  private showWeather(): void {
    this.state = 'weather';
    clear(this.uiRoot);
    this.present(this.focus(), FRAMING.venue);
    // Show the ground before they commit: the whole world re-tints live.
    this.renderer.applyWeather(this.weather);
    renderWeather(this.uiRoot, {
      value: this.weather,
      onPick: (k) => {
        this.weather = k;
        this.showWeather();
      },
      onNext: () => this.nav('minutes'),
      onBack: () => this.goBack(),
    });
  }

  private showMinutes(): void {
    this.state = 'minutes';
    clear(this.uiRoot);
    this.present(this.focus(), FRAMING.venue);
    this.renderer.applyWeather(this.weather);
    renderMinutes(this.uiRoot, {
      value: this.halfSeconds,
      onPick: (s) => {
        this.halfSeconds = s;
        this.showMinutes();
      },
      onNext: () => this.nav('opponent'),
      onBack: () => this.goBack(),
    });
  }

  private showOpponentScreen(): void {
    this.state = 'opponent';
    // The seed varies per attempt so the opponent's five is not identical every
    // time a fixture is re-entered, but the *club* is the one on the schedule.
    this.seed = Math.floor(Math.random() * 1e9);
    // Quick Play has no venue screen to walk through, so the conditions come
    // from the match seed instead. Varied match to match, and never a decision
    // standing between the player and a friendly.
    if (this.mode === 'quick') this.weather = fixtureWeather(this.seed, 'quick-play');
    const clubId = this.fixture ? opponentOf(this.fixture) : undefined;
    // The bench is rebuilt here too, so the opponent is drawn against the five
    // AND the bench actually carried into this match.
    this.refreshBench();
    // The whole squad is excluded from the CPU's side, so no Viber ever lines up
    // against the manager who signed them.
    this.opponent = autoOpponent(this.selected, this.seed, clubId, this.bench);
    clear(this.uiRoot);
    this.present(this.focus(), FRAMING.opponent);
    this.renderer.applyWeather(this.weather);
    renderOpponent(this.uiRoot, {
      playerIds: this.starters(),
      opponent: this.opponent,
      weather: this.weather,
      halfSeconds: this.halfSeconds,
      fixture: this.fixture
        ? {
            round: this.fixture.round + 1,
            home: isHomeFixture(this.fixture),
            season: this.career.season,
          }
        : null,
      onKickoff: () => this.startMatch(),
      onBack: () => this.goBack(),
    });
  }

  /**
   * A sensible default squad: a balanced five first, then depth.
   *
   * Two rules make this safe to tap at any time.
   *
   * It PREFERS players the manager already has. Auto Pick fills the squad up to
   * twelve, but it never releases anyone to do it — so on a full squad it only
   * reorders, putting the best available five on the pitch. That matters
   * because an absence is recorded against the player, not the squad slot: a
   * tap that quietly dropped an injured player would look like a free cure for
   * the very mechanic the twelve-man squad exists for.
   *
   * And it only ever picks players who are fit. Anyone unavailable is skipped
   * outright, which also makes this the quickest way out of "three of my
   * players are injured and I cannot field a five".
   */
  private autoPick(): void {
    const keep = [...this.activeSelected];
    // Quick Play picks from the whole roster and nobody is ever unavailable;
    // the league picks from the club's own fit players.
    const quick = this.mode === 'quick';
    const cap = quick ? SQUAD_SIZE : LEAGUE_SQUAD_MAX;
    const fit = quick ? [...ROSTER] : ROSTER.filter((v) => isAvailable(this.career, v.id));

    /** The best `n` fit players in a line, squad members first. */
    const pick = (role: string, n: number) => {
      const pool = fit
        .filter((v) => v.role === role)
        .sort((a, b) => overallOf(b) - overallOf(a));
      return [...pool.filter((v) => keep.includes(v.id)), ...pool.filter((v) => !keep.includes(v.id))].slice(0, n);
    };

    const ids: string[] = [];
    const add = (id?: string) => {
      if (id && !ids.includes(id) && ids.length < cap) ids.push(id);
    };

    // The five who take the pitch, in the order the formation fills them, so
    // the shape is always playable.
    for (const v of [...pick('GK', 1), ...pick('DEF', 1), ...pick('MID', 2), ...pick('FWD', 1)]) add(v?.id);

    // Then everyone the manager already has — including anyone who is out.
    for (const id of keep) add(id);

    // Then depth, line by line, so a knock to any starter has a like-for-like
    // answer already in the squad.
    for (const v of [
      ...pick('DEF', 2).slice(1),
      ...pick('MID', 3).slice(2),
      ...pick('FWD', 2).slice(1),
      ...pick('GK', 2).slice(1),
    ]) {
      add(v?.id);
    }
    // Backfill if the roster is ever short in a line.
    for (const v of [...fit].sort((a, b) => overallOf(b) - overallOf(a))) add(v.id);

    this.activeSelected = ids.slice(0, cap);
    this.focusId = this.activeSelected[0] ?? this.focusId;
  }

  /* --------------------------- match --------------------------- */

  private startMatch(): void {
    if (!this.opponent) return;
    // The first five fit players of the squad take the pitch; the bench covers
    // them from what is left. Both are drawn only from the club's own squad.
    const starters = this.starters();
    // Quick Play carries no bench at all. Falling through to the career squad
    // here — which is what the league does when its own bench is empty — would
    // quietly put the league's reserves on the pitch for a friendly.
    const bench = this.mode === 'quick'
      ? []
      : this.bench.length
        ? this.bench
        : benchFromSquad(fitSquad(this.career), starters);
    this.world = createWorld({
      seed: this.seed,
      homeIds: starters,
      awayIds: this.opponent.ids,
      awayClubId: this.opponent.club.id,
      weather: this.weather,
      halfSeconds: this.halfSeconds,
      benchIds: bench,
    });
    this.halfTwoStarted = false;
    // A new match starts with a clean slate; anything from the last one was
    // either committed with its result or abandoned with the match.
    this.matchEvents = [];

    /*
     * This runs inside the KICK OFF click handler, which makes it the one
     * gesture that may start the audio context. Unlocking here rather than at
     * boot is not a workaround — a context created before the player has touched
     * the page is suspended by the browser and every sound on it is dropped.
     */
    this.sound.unlock();
    this.crowd.reset();

    // bindWorld hands the pitch back from the hero stage to the match.
    this.renderer.bindWorld(this.world);
    this.renderer.resize();

    clear(this.uiRoot);
    this.overlay = el('div', 'overlay-layer');
    this.hud = new Hud(this.uiRoot, {
      onMentality: (m: Mentality) => this.command({ type: 'mentality', team: 0, value: m }),
      onSpecial: () => this.command({ type: 'special', team: 0 }),
      onAction: (a) => this.command({ type: 'action', team: 0, value: a }),
      onPause: () => this.togglePause(),
      // Muting from the HUD is a career change like any other: it is written to
      // the season so the next match starts the way this one was left.
      onSound: (on) => {
        this.commitCareer(withSettings(this.career, { sound: on }));
        this.applySound(on);
      },
    });
    this.uiRoot.append(this.overlay);
    this.hud.setVisible(true);
    this.hud.setMuted(!this.career.settings.sound);
    this.state = 'match';
    this.hud.showBanner('KICK OFF');
  }

  private command(c: Parameters<typeof queue>[1]): void {
    if (this.world) queue(this.world, c);
  }

  private togglePause(): void {
    const w = this.world;
    if (!w || this.state !== 'match' || w.paused) return;
    this.enterPauseMenu();
  }

  private enterPauseMenu(): void {
    const w = this.world;
    if (!w) return;
    // Freeze the world and take the match state out of the loop's step set, so
    // no tick can land while the menu is up. The HUD is hidden; the only way
    // back into the match is Resume (or Quit, which abandons it).
    w.paused = true;
    this.state = 'paused';
    this.hud?.setVisible(false);
    renderPause(this.overlay, {
      onResume: () => {
        clear(this.overlay);
        this.hud?.setVisible(true);
        w.paused = false;
        this.state = 'match';
      },
      onSubs: () => this.enterSubs(),
      subsLeft: w.bench[0].length,
      onQuit: () => this.confirmQuit(),
    });
  }

  /**
   * The substitution screen.
   *
   * The world stays frozen throughout — a substitution is a squad change made
   * while the ball is dead, not a play input. The command is queued and then
   * drained immediately (`flushCommands`), so the bench and the five on the
   * pitch update in front of the manager the moment a swap is made, without the
   * match clock moving a tick.
   */
  private enterSubs(): void {
    const w = this.world;
    if (!w) return;
    this.state = 'subs';
    renderSubs(this.overlay, w, {
      onSub: (outId: number, inViber: string) => {
        queue(w, { type: 'sub', team: 0, out: outId, in: inViber });
        flushCommands(w);
        // Re-render from the world that just changed.
        this.enterSubs();
      },
      onBack: () => this.enterPauseMenu(),
    });
  }

  private confirmQuit(): void {
    const w = this.world;
    if (!w) return;
    renderPauseConfirm(this.overlay, {
      onConfirm: () => {
        // Abandon the match: no result is recorded against the fixture, and the
        // season is left exactly where it was. Quit always returns to the title
        // — the first page — rather than to whichever hub the match came from,
        // so the one control means the same thing in every mode.
        clear(this.overlay);
        this.hud = null;
        this.nav('title', false);
      },
      onCancel: () => this.enterPauseMenu(),
    });
  }

  private handleEvents(): void {
    const w = this.world;
    if (!w) return;
    for (const ev of drainEvents(w)) {
      // Logged before the switch, not inside it: `fulltime` files the match
      // from `enterResult` in the same pass, and it must see the whole half —
      // including a card shown in the very last tick before the whistle.
      this.matchEvents.push(ev);
      switch (ev.type) {
        case 'kickoff':
          // Only the first kickoff of the second half is a "SECOND HALF" moment;
          // every other kickoff (including after a goal) is just a restart.
          if (w.half === 2 && !this.halfTwoStarted) {
            this.halfTwoStarted = true;
            this.hud?.showBanner('SECOND HALF');
          } else {
            this.hud?.showBanner('KICK OFF');
          }
          break;
        case 'goal': {
          const t = w.teams[ev.team];
          this.hud?.showBanner(`GOAL!  ${t.short}`, 'goal');
          const dir = ev.team === 0 ? 1 : -1;
          this.renderer.burst(0, dir * 19, t.color);
          // The crowd erupts. `goal()` is the roar; this is the bed it sits on.
          this.crowd.excite(1);
          this.sound.goal();
          break;
        }
        case 'shot':
          // A shot is a boot on the ball. Off target it is still struck as hard,
          // so the difference is the crowd's reaction, not the thump.
          this.sound.kick();
          this.crowd.excite(ev.onTarget ? 0.4 : 0.16);
          break;
        case 'save':
          this.sound.save();
          this.crowd.excite(0.45);
          break;
        case 'special':
          this.hud?.showBanner('SPECIAL!', 'special');
          this.crowd.excite(0.3);
          break;
        case 'setpiece': {
          // A corner, throw-in, goal kick, free kick or penalty has been given.
          const t = w.teams[ev.team];
          const label =
            ev.kind === 'corner'
              ? 'CORNER'
              : ev.kind === 'throwin'
                ? 'THROW-IN'
                : ev.kind === 'goalkick'
                  ? 'GOAL KICK'
                  : ev.kind === 'freekick'
                    ? 'FREE KICK'
                    : 'PENALTY!';
          this.hud?.showBanner(
            ev.kind === 'penalty' ? label : `${label}  ·  ${t.short}`,
            ev.kind === 'penalty' ? 'special' : 'setpiece',
          );
          // Only the ones near a goal lift the crowd. Nobody rises for a throw-in
          // on the halfway line.
          if (ev.kind === 'corner' || ev.kind === 'penalty') this.crowd.excite(0.3);
          if (ev.kind === 'penalty' && this.state === 'match') {
            // The human always plays team 0: a team-1 penalty means the CPU
            // shoots and we defend (pick the dive); a team-0 penalty means we
            // shoot and we pick the placement.
            if (ev.team === 1) this.enterPenaltyDive();
            else this.enterPenaltyShoot();
          }
          break;
        }
        case 'whistle':
          // The referee. The sim says which blast it is; the engine knows the
          // pattern for each.
          this.sound.whistle(ev.kind);
          break;
        case 'sub': {
          // A substitution made while paused sits in the event queue until play
          // resumes, so this lands as the manager returns to the pitch — which
          // is exactly when the confirmation is useful.
          const v = ROSTER_BY_ID[ev.in];
          if (v) this.hud?.showBanner(`${v.name} ON`, 'special');
          break;
        }
        case 'foul':
          // The restart banner that follows carries the message.
          break;
        case 'card': {
          /*
           * The referee's notebook — the BANNER half of it.
           *
           * Nothing is written to the career here. The card is already in
           * `matchEvents`, and `absencesFromEvents` reads the bans off it when
           * the fixture is filed. Keeping the two apart is what lets the
           * conversion be unit-tested: a rule buried in this switch can only be
           * exercised by playing a match in a real browser.
           *
           * The banner is shown for either side, because a red card is the
           * moment the match changes shape and the player should see who went
           * off. A yellow carries no ban in this game — there is no
           * accumulation rule, and inventing one would punish a player for
           * something the referee's own notebook never mentions.
           */
          const p = w.players.find((x) => x.id === ev.player);
          if (!p) break;
          if (ev.card === 'red') this.hud?.showBanner(`RED CARD · ${p.name}`, 'special');
          else this.hud?.showBanner(`YELLOW · ${p.name}`);
          break;
        }
        case 'injury': {
          const p = w.players.find((x) => x.id === ev.player);
          if (!p) break;
          this.hud?.showBanner(`INJURY · ${p.name}`, 'special');
          break;
        }
        case 'halftime':
          this.enterHalftime();
          break;
        case 'fulltime':
          this.enterResult();
          break;
        default:
          break;
      }
    }
  }

  private enterPenaltyDive(): void {
    const w = this.world;
    if (!w || w.setPiece?.kind !== 'penalty' || w.setPiece.team !== 1) return;
    // Pausing stops ticks before they drain commands — exactly the half-time
    // pattern. The choice is queued and the world is unpaused together.
    w.paused = true;
    this.state = 'penalty';
    renderPenaltyDive(this.overlay, (direction: DiveDirection) => {
      if (this.state !== 'penalty') return; // one choice per penalty
      queue(w, { type: 'dive', team: 0, value: direction });
      clear(this.overlay);
      w.paused = false;
      this.state = 'match';
      this.hud?.showBanner(`DIVE ${direction.toUpperCase()}`, 'special');
    });
  }

  private enterPenaltyShoot(): void {
    const w = this.world;
    if (!w || w.setPiece?.kind !== 'penalty' || w.setPiece.team !== 0) return;
    // Same pattern as the dive: the world pauses so the queued `shot` command
    // lands before runSetPiece() strikes the ball. The CPU keeper then reads it.
    w.paused = true;
    this.state = 'penalty';
    renderPenaltyShoot(this.overlay, (aim: DiveDirection) => {
      if (this.state !== 'penalty') return; // one choice per penalty
      queue(w, { type: 'shot', team: 0, value: aim });
      clear(this.overlay);
      w.paused = false;
      this.state = 'match';
      this.hud?.showBanner(`SHOOT ${aim.toUpperCase()}`, 'special');
    });
  }

  private enterHalftime(): void {
    const w = this.world;
    if (!w) return;
    w.paused = true;
    this.state = 'halftime';
    renderHalftime(this.overlay, w, (m: Mentality) => {
      queue(w, { type: 'mentality', team: 0, value: m });
      queue(w, { type: 'resume' });
      clear(this.overlay);
      w.paused = false;
      this.state = 'match';
    });
  }

  private enterResult(): void {
    const w = this.world;
    if (!w) return;
    w.paused = true;
    this.state = 'result';
    this.hud?.setVisible(false);
    // A finished match ends the flow: the next screen starts a fresh one.
    this.history = [];

    /*
     * A Quick Play match is over the moment the whistle goes.
     *
     * The mode sits deliberately outside the career: no result is filed, nobody
     * picks up a knock, no ban is served and the calendar does not move. So
     * there is nothing to commit and nothing to read back. Getting this wrong is
     * invisible on the day — it surfaces later as a league player who is
     * mysteriously out for two games after a friendly.
     */
    const quick = this.mode === 'quick';

    // File the result against the fixture. Scores are stored from the HOME
    // club's point of view, and the player is not always the home side.
    let note = '';
    let next = this.career;
    if (!quick && this.fixture) {
      const playerGoals = w.teams[0].score;
      const cpuGoals = w.teams[1].score;
      const home = isHomeFixture(this.fixture);
      next = withResult(
        next,
        this.fixture.id,
        home ? playerGoals : cpuGoals,
        home ? cpuGoals : playerGoals,
      );
      this.fixture = null;

      const table = buildTable(completeResults(next.results, { seed: next.seed }));
      const pos = playerPosition(table);
      if (pos) {
        const points = playerRow(table)?.points ?? 0;
        // "1 points" is the sort of thing that makes a screen feel unfinished.
        note = `${ordinal(pos)} in the league · ${points} point${points === 1 ? '' : 's'}`;
      }
    }

    /*
     * Move the calendar on, then file what this match cost.
     *
     * The order matters and is not interchangeable. `tickAbsences` serves the
     * ban or layoff for the fixture just played, so it has to run BEFORE the
     * new absences are added — otherwise a player hurt in this match would
     * immediately lose a fixture of their own recovery and come back a game
     * early. Committed in a single write so the two can never disagree on disk.
     *
     * `viberOf` reads the world's own player table. A card the sim cannot map
     * back to a Viber is dropped by the helper rather than guessed at, so a
     * mismatch degrades to "no ban" — never to the wrong player banned.
     */
    const picked = quick
      ? {}
      : absencesFromEvents(
          (id) => w.players.find((p) => p.id === id)?.viber,
          this.matchEvents,
        );
    if (!quick) {
      next = withAbsences(tickAbsences(next), picked);
      this.commitCareer(next);
      // New absences change who is fit, and the bench is drawn from the fit
      // squad. Rebuilding here means the next match never offers a substitute
      // who is already ruled out.
      this.refreshBench();
    }

    // What the player needs to read off the full-time screen: who this match
    // took out, and for how long. Names, because the ids mean nothing here.
    // A friendly takes nobody out, so there is nothing to list.
    const absences = quick
      ? []
      : Object.entries(picked)
          .filter(([id, a]) => a.matches > 0 && this.career.lineup.includes(id))
          .map(([id, a]) => ({
            name: ROSTER_BY_ID[id]?.name ?? id,
            kind: a.kind === 'suspension' ? ('suspension' as const) : ('injury' as const),
            matches: a.matches,
          }))
          .sort((a, b) => b.matches - a.matches);
    this.matchEvents = [];

    renderResult(
      this.overlay,
      w,
      () => {
        clear(this.overlay);
        this.hud = null;
        // A friendly ends back at the title, not in the league hub it never
        // belonged to.
        this.nav(quick ? 'title' : 'league', false);
      },
      () => {
        clear(this.overlay);
        this.hud = null;
        // In the league this is the read-only squad view, because changing the
        // five goes through the fixture so the opponent is the real one. Quick
        // Play has no fixture to protect, so it reopens the picker itself.
        this.nav(quick ? 'squad' : 'squadview', false);
      },
      quick
        ? { againLabel: 'Main menu', changeLabel: 'Change five', note: 'Friendly · no league impact', absences }
        : { againLabel: 'Back to the League', changeLabel: 'Squad', note, absences },
    );
  }

  private loop = (now: number): void => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (now - this.last) / 1000 || 0);
    this.last = now;

    const w = this.world;
    if (w && (this.state === 'match' || this.state === 'penalty' || this.state === 'halftime' || this.state === 'result')) {
      this.acc += dt;
      let guard = 0;
      while (this.acc >= TICK && guard < 6) {
        step(w, TICK);
        this.acc -= TICK;
        guard++;
      }
      this.handleEvents();
      this.hud?.update(w, dt);
      this.renderer.sync(w, this.acc / TICK);

      /*
       * The crowd follows the ball, not the clock: it rises as the ball travels
       * up the pitch and settles when play drops back. `CrowdHeat` owns the
       * model — the event jolts come from handleEvents, the slow drift from here.
       *
       * Paused, the heat is frozen (dt 0) and the bed drops to a murmur rather
       * than stopping dead: a stadium does not fall silent for a stoppage.
       */
      const advance = (Math.abs(w.ball.pos.x) / PITCH_HALF_L - 0.3) / 0.7;
      const level = this.crowd.step(w.paused ? 0 : dt, advance);
      this.sound.crowd(w.paused ? level * 0.3 : level);
    } else {
      // Anywhere but the pitch the ground empties. Doing it here rather than in
      // each exit path means every way out of a match is covered, including the
      // ones added later.
      this.sound.crowd(0);
    }
    // Menus get the world too: the crowd breathes and the hero idles.
    this.renderer.render(dt);
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.sound.dispose();
    this.renderer.dispose();
  }
}
