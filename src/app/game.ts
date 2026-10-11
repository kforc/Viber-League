// app/game.ts — wires sim <-> renderer <-> UI, and owns the pre-match flow.
// The only place the three layers meet.

import { MatchRenderer } from '../render/renderer';
import type { ShowcaseOptions } from '../render/showcase';
import {
  autoBench,
  autoOpponent,
  createWorld,
  drainEvents,
  flushCommands,
  overallOf,
  PITCH_HALF_L,
  queue,
  ROSTER,
  ROSTER_BY_ID,
  step,
  teamOverall,
  TICK,
  type DiveDirection,
  type Mentality,
  type OpponentSelection,
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
  renderLeague,
  renderMinutes,
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
  clearCareer,
  currentSeasonSummary,
  defaultCareer,
  loadCareer,
  saveCareer,
  startNextSeason,
  withLineup,
  withResult,
  withSettings,
  type CareerSettings,
  type CareerState,
} from './career';

type AppState =
  | 'onboarding'
  | 'signin'
  | 'account'
  | 'title'
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
  private selected: string[] = [];
  private weather: WeatherKind = 'sun';
  private halfSeconds = LENGTH_OPTIONS[1].halfSeconds;
  private opponent: OpponentSelection | null = null;
  /**
   * The bench that covers the current five. Recomputed whenever the five change
   * (the squad screen, AUTO PICK, adopting a saved career), so it can never
   * hold a Viber who has since been picked to start.
   */
  private bench: string[] = [];
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
   * A returning player goes straight to the menu — the whole point of keeping a
   * profile is that they are *not* asked again. Only a genuinely new player is
   * sent to onboarding, and only when the browser can actually hold a profile:
   * a sign-up form whose answers evaporate on reload is worse than no form, so
   * a browser that blocks storage plays as a guest instead.
   */
  private bootstrap(): void {
    if (this.profile || !storageAvailable()) {
      this.showTitle();
      return;
    }
    this.showOnboarding();
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
    if (career.lineup.length === 5) {
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

  private showLeague(): void {
    this.state = 'league';
    clear(this.uiRoot);
    // The CPU half of the season is simulated on demand rather than stored, so
    // the table is always complete and always matches the season seed.
    const results = completeResults(this.career.results, {
      seed: this.career.seed,
      playerStrength: teamOverall(this.selected),
    });
    renderLeague(this.uiRoot, {
      season: this.career.season,
      results,
      lineup: this.selected,
      tab: this.leagueTab,
      onTab: (t) => {
        this.leagueTab = t;
        this.showLeague();
      },
      onPlayNext: () => this.playNextFixture(),
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
   * Start the next fixture through the normal pre-match flow.
   *
   * The season drives the opponent, but the player still picks the five, the
   * venue and the length — a fixture is a match, not a shortcut past one.
   */
  private playNextFixture(): void {
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
      lineup: this.selected,
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
      lineup: this.selected,
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
      manager: this.profile?.manager ?? 'Guest',
      club: this.profile?.club ?? 'Your club',
      season: this.career.season,
      current: this.career.results,
      history: this.career.history,
      lineup: this.selected,
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
      systemReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
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
    switch (section) {
      case 'league':
        this.nav('league');
        break;
      case 'squad':
        this.nav('squadview');
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
    renderTitle(this.uiRoot, () => this.playNextFixture(), {
      // A guest has no name to show, so the chip is absent rather than showing
      // a placeholder — but every tile still opens its screen.
      manager: profile?.manager,
      // The club line under the wordmark wears the crest the player chose. A
      // guest has no club, so the line is simply absent.
      club: profile ? { name: profile.club, icon: profile.icon } : undefined,
      onAccount: profile ? () => this.nav('account') : undefined,
      onSection: (section) => this.openSection(section),
    });
    // The logo and the PLAY button leave an empty band in the middle; the hero
    // is framed into exactly that band.
    this.presentInBand(ROSTER[0], '.menu-spacer', FRAMING.menu, { maxFill: 0.46 });
  }

  private showSquad(): void {
    this.state = 'squad';
    clear(this.uiRoot);
    renderSquadSelect(this.uiRoot, {
      selected: this.selected,
      focus: this.focus(),
      filter: this.filter,
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
        this.selected = [];
        this.commitLineup();
        this.showSquad();
      },
      onNext: () => {
        this.commitLineup();
        this.nav('weather');
      },
      onBack: () => this.goBack(),
    });
    // The hero band above the card grid.
    this.presentInBand(this.focus(), '.hero-stage', FRAMING.squad, { maxFill: 0.44 });
  }

  /** The five are a career fact, not a per-match choice, so they are saved. */
  private commitLineup(): void {
    this.commitCareer(withLineup(this.career, this.selected));
    this.refreshBench();
  }

  /**
   * Rebuild the bench to cover the current five.
   *
   * Called from every path that can change the five. It has to be a rebuild and
   * not a patch: a Viber who has just been promoted to the starting lineup must
   * leave the bench, or the same player would be available to come on for
   * themselves.
   */
  private refreshBench(): void {
    this.bench = autoBench(this.selected);
  }

  private togglePick(id: string): void {
    if (this.selected.includes(id)) {
      this.selected = this.selected.filter((x) => x !== id);
    } else if (this.selected.length < 5) {
      this.selected = [...this.selected, id];
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
    renderViberDetail(this.uiRoot, v, {
      selected: this.selected.includes(id),
      canAdd: this.selected.length < 5,
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
    const clubId = this.fixture ? opponentOf(this.fixture) : undefined;
    // The bench is rebuilt here too, so the opponent is drawn against the five
    // AND the bench actually carried into this match.
    this.refreshBench();
    this.opponent = autoOpponent(this.selected, this.seed, clubId, this.bench);
    clear(this.uiRoot);
    this.present(this.focus(), FRAMING.opponent);
    this.renderer.applyWeather(this.weather);
    renderOpponent(this.uiRoot, {
      playerIds: this.selected,
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

  /** A sensible default five: best available per role, with light variation. */
  private autoPick(): void {
    const topOf = (role: string, n: number) =>
      ROSTER.filter((v) => v.role === role)
        .sort((a, b) => overallOf(b) - overallOf(a))
        .slice(0, n);
    const pool = [
      ...topOf('GK', 2).slice(0, 1),
      ...topOf('DEF', 3),
      ...topOf('MID', 3),
      ...topOf('FWD', 3),
    ];
    // Pick one GK + one DEF + two MID + one FWD, shuffled within the pool.
    const shuffled = pool.sort(() => Math.random() - 0.5);
    const ids: string[] = [];
    const take = (role: string, count: number) => {
      let taken = 0;
      for (const v of shuffled) {
        if (taken >= count) break;
        if (v.role === role && !ids.includes(v.id)) {
          ids.push(v.id);
          taken++;
        }
      }
    };
    take('GK', 1);
    take('DEF', 1);
    take('MID', 2);
    take('FWD', 1);
    // Backfill if the roster ever lacks a role.
    for (const v of shuffled) {
      if (ids.length >= 5) break;
      if (!ids.includes(v.id)) ids.push(v.id);
    }
    this.selected = ids.slice(0, 5);
    this.focusId = this.selected[0] ?? this.focusId;
  }

  /* --------------------------- match --------------------------- */

  private startMatch(): void {
    if (!this.opponent) return;
    this.world = createWorld({
      seed: this.seed,
      homeIds: this.selected,
      awayIds: this.opponent.ids,
      awayClubId: this.opponent.club.id,
      weather: this.weather,
      halfSeconds: this.halfSeconds,
      benchIds: this.bench.length ? this.bench : autoBench(this.selected),
    });
    this.halfTwoStarted = false;

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
        // Abandon the match: no result is recorded against the fixture. Hand
        // control back to the league hub the same way the full-time screen does.
        clear(this.overlay);
        this.hud = null;
        this.nav('league', false);
      },
      onCancel: () => this.enterPauseMenu(),
    });
  }

  private handleEvents(): void {
    const w = this.world;
    if (!w) return;
    for (const ev of drainEvents(w)) {
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
    renderPenaltyDive(this.overlay, w, (direction: DiveDirection) => {
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
    renderPenaltyShoot(this.overlay, w, (aim: DiveDirection) => {
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

    // File the result against the fixture. Scores are stored from the HOME
    // club's point of view, and the player is not always the home side.
    let note = '';
    if (this.fixture) {
      const playerGoals = w.teams[0].score;
      const cpuGoals = w.teams[1].score;
      const home = isHomeFixture(this.fixture);
      this.commitCareer(
        withResult(
          this.career,
          this.fixture.id,
          home ? playerGoals : cpuGoals,
          home ? cpuGoals : playerGoals,
        ),
      );
      this.fixture = null;

      const table = buildTable(
        completeResults(this.career.results, {
          seed: this.career.seed,
          playerStrength: teamOverall(this.selected),
        }),
      );
      const pos = playerPosition(table);
      if (pos) note = `${ordinal(pos)} in the league · ${playerRow(table)?.points ?? 0} points`;
    }

    renderResult(
      this.overlay,
      w,
      () => {
        clear(this.overlay);
        this.hud = null;
        this.nav('league', false);
      },
      () => {
        clear(this.overlay);
        this.hud = null;
        this.nav('squadview', false);
      },
      { againLabel: 'Back to the League', changeLabel: 'Squad', note },
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
