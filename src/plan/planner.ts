/**
 * The festival planner (portal.md section 2b): assigns competitions to sessions
 * and sessions to tracks (stages), and sets the running order inside them.
 * Pure functions, no database, deterministic: the same input always gives the
 * same plan, so applying a plan recomputes exactly what was previewed.
 *
 * Rules, in order of priority:
 * 1. Nobody performs on two stages at once: a person's performances on
 *    different stages are at least `gapMinutes` apart. A judge is never needed
 *    on two stages in the same time slot.
 * 2. Judges move as little as possible. Competitions that share a judge are
 *    linked; each linked group stays on one stage, so no judge ever changes
 *    stage. Inside a session, competitions with the same judges run together.
 * 3. Sessions are of similar length, and stages carry similar totals.
 * 4. The current running order of entries is kept unless moving an entry (or
 *    a competition inside its session) avoids a clash.
 *
 * Stages run their sessions in parallel time slots, with a break after each
 * slot. An entry takes its music's length plus an allowance (announcing,
 * scoring, entry and exit); its estimated time follows from the order.
 */

export interface PlanEntry {
  id: number;
  /** Length of its music, in seconds (cached when the music was normalised). */
  seconds: number;
  /** Everyone performing in it (user ids): the soloist, partners, team members. */
  people: number[];
}

export interface PlanCompetition {
  id: number;
  name: string;
  /** Judges who score this competition (from its rubric). */
  judges: number[];
  /** In the current running order. */
  entries: PlanEntry[];
}

export interface PlanSettings {
  tracks: number;
  sessionsPerTrack: number;
  /** Per entry, on top of its music: announcing, scoring, entry and exit. */
  allowanceSeconds: number;
  /** Between consecutive sessions on a stage. */
  breakMinutes: number;
  /** The least time between one person's performances on different stages. */
  gapMinutes: number;
  /** Start of the first time slot. */
  startsAt: Date;
}

export interface PlannedCompetition {
  id: number;
  /** Estimated start. */
  startsAt: Date;
  /** Entries in running order. */
  entryIds: number[];
}

export interface PlannedSession {
  /** 0-based stage and time slot. */
  track: number;
  slot: number;
  /** In running order. */
  competitions: PlannedCompetition[];
  seconds: number;
  judges: number[];
  startsAt: Date;
}

/** Someone with two performances on different stages too close together. */
export interface PlanClash {
  person: number;
  competitions: [number, number];
  at: [Date, Date];
}

export interface PlanScore {
  /** A judge needed on two stages in one slot. Must be 0. */
  judgeClashes: number;
  /** A person's performances on two stages less than the gap apart. Must be 0. */
  peopleClashes: number;
  /** Judges joining or leaving between consecutive competitions in a session. */
  judgeChanges: number;
  /** Judges changing stage between slots. */
  judgeMoves: number;
  /** Entries not in their current running position. */
  entriesMoved: number;
  longestSeconds: number;
  shortestSeconds: number;
  emptySessions: number;
  endsAt: Date;
  /** Lower is better; used to rank variants. */
  cost: number;
}

export interface Plan {
  settings: PlanSettings;
  /** Only sessions with competitions; ordered by slot, then track. */
  sessions: PlannedSession[];
  score: PlanScore;
  clashes: PlanClash[];
  problems: string[];
}

const W_CLASH = 1_000_000;
const W_BALANCE = 1000;
const W_CHANGE = 10;
const W_MOVE = 20;
/** Per person shared by parallel sessions: a gentle nudge, not a rule. */
const W_SHARE = 5;
/** Per place an entry or competition is moved from where it was. */
const W_ORDER = 1;
const MAX_SWEEPS = 50;
const MAX_ORDER_ROUNDS = 500;

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const keyOf = (judges: number[]) =>
  [...new Set(judges)].sort((a, b) => a - b).join(",");
const judgesOfKey = (k: string) => (k === "" ? [] : k.split(",").map(Number));

export const entrySeconds = (e: PlanEntry, allowance: number) =>
  e.seconds + allowance;
export const competitionSeconds = (c: PlanCompetition, allowance: number) =>
  sum(c.entries.map((e) => entrySeconds(e, allowance)));
const peopleOf = (
  c: PlanCompetition,
) => [...new Set(c.entries.flatMap((e) => e.people))];

function symDiff(a: number[], b: number[]): number {
  const x = new Set(a), y = new Set(b);
  let n = 0;
  for (const j of x) if (!y.has(j)) n++;
  for (const j of y) if (!x.has(j)) n++;
  return n;
}

/**
 * Competitions linked by shared judges (directly or through others). A group
 * stays on one stage. Groups are lists of indices into `comps`, each in index
 * order, ordered by their first index.
 */
export function judgeGroups(comps: PlanCompetition[]): number[][] {
  const parent = comps.map((_, i) => i);
  const find = (i: number): number =>
    parent[i] === i ? i : (parent[i] = find(parent[i]));
  const byJudge = new Map<number, number>();
  comps.forEach((c, i) => {
    for (const j of c.judges) {
      const first = byJudge.get(j);
      if (first === undefined) byJudge.set(j, i);
      else parent[find(i)] = find(first);
    }
  });
  const groups = new Map<number, number[]>();
  comps.forEach((_, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  });
  return [...groups.values()].sort((a, b) => a[0] - b[0]);
}

/**
 * The order of a session's panels: the panel used most first, then each next
 * panel as close as possible to the last (fewest judges joining or leaving).
 * `panels` are [judge-set key, competitions using it]; returns keys in order.
 */
function chainPanels(panels: [string, number][]): string[] {
  const left = [...panels].sort((a, b) =>
    b[1] - a[1] || (a[0] < b[0] ? -1 : 1)
  );
  const out: string[] = [];
  let last: number[] | null = null;
  while (left.length) {
    let best = 0;
    if (last) {
      let bestD = symDiff(last, judgesOfKey(left[0][0]));
      for (let i = 1; i < left.length; i++) {
        const d = symDiff(last, judgesOfKey(left[i][0]));
        if (d < bestD) {
          best = i;
          bestD = d;
        }
      }
    }
    const [k] = left.splice(best, 1)[0];
    out.push(k);
    last = judgesOfKey(k);
  }
  return out;
}

/** Judge changes in a session with these panels, run in `chainPanels` order. */
function panelChanges(panels: [string, number][]): number {
  const order = chainPanels(panels);
  let n = 0;
  for (let i = 1; i < order.length; i++) {
    n += symDiff(judgesOfKey(order[i - 1]), judgesOfKey(order[i]));
  }
  return n;
}

/**
 * A session's running order: competitions with the same judges together, and
 * each next panel as close as possible to the last (fewest judges changing).
 */
export function orderForJudges(comps: PlanCompetition[]): PlanCompetition[] {
  const sets = new Map<string, PlanCompetition[]>();
  for (const c of [...comps].sort((a, b) => a.id - b.id)) {
    const k = keyOf(c.judges);
    sets.set(k, [...(sets.get(k) ?? []), c]);
  }
  return chainPanels([...sets].map(([k, cs]) => [k, cs.length]))
    .flatMap((k) => sets.get(k)!);
}

/** Judges joining or leaving between consecutive competitions. */
export function judgeChanges(ordered: PlanCompetition[]): number {
  let n = 0;
  for (let i = 1; i < ordered.length; i++) {
    n += symDiff(ordered[i - 1].judges, ordered[i].judges);
  }
  return n;
}

/**
 * Split one stage's competitions into `count` sessions, one per time slot:
 * similar lengths and few judge changes inside each. People already on another
 * stage in a slot (`busy[k]`) cost `shareWeight` each there: a gentle nudge
 * normally, a hard rule in the strict fallback. A greedy start, then moves and
 * swaps while they help. A session's cost depends only on its length, its
 * panels and its shared people, so each try is cheap. Deterministic.
 */
function splitTrack(
  comps: PlanCompetition[],
  count: number,
  allowance: number,
  busy: Set<number>[],
  shareWeight: number,
): PlanCompetition[][] {
  if (comps.length === 0) return Array.from({ length: count }, () => []);
  const len = new Map(comps.map((c) => [c, competitionSeconds(c, allowance)]));
  const key = new Map(comps.map((c) => [c, keyOf(c.judges)]));
  const ppl = new Map(comps.map((c) => [c, peopleOf(c)]));
  const mean = sum([...len.values()]) / count;

  const total = new Array<number>(count).fill(0);
  const panels = Array.from({ length: count }, () => new Map<string, number>());
  const people = Array.from({ length: count }, () => new Map<number, number>());
  const shared = new Array<number>(count).fill(0);
  const binOf = new Map<PlanCompetition, number>();
  const cost = (seconds: number, p: Map<string, number>, share: number) => {
    const dev = mean > 0 ? (seconds - mean) / mean : 0;
    return shareWeight * share + W_BALANCE * dev * dev +
      W_CHANGE * panelChanges([...p].filter(([, n]) => n > 0));
  };
  const withPanel = (p: Map<string, number>, k: string, d: number) => {
    const q = new Map(p);
    q.set(k, (q.get(k) ?? 0) + d);
    return q;
  };
  /** People shared with other stages in session `b` if `out` leaves and `inn` joins. */
  const sharedAfter = (
    b: number,
    out: PlanCompetition | null,
    inn: PlanCompetition | null,
  ) => {
    let n = shared[b];
    const outP = out ? ppl.get(out)! : [], inP = inn ? ppl.get(inn)! : [];
    for (const p of new Set([...outP, ...inP])) {
      if (!busy[b]?.has(p)) continue;
      const before = people[b].get(p) ?? 0;
      const after = before - (outP.includes(p) ? 1 : 0) +
        (inP.includes(p) ? 1 : 0);
      n += (after > 0 ? 1 : 0) - (before > 0 ? 1 : 0);
    }
    return n;
  };
  const costs = new Array<number>(count).fill(cost(0, new Map(), 0));
  const put = (c: PlanCompetition, b: number) => {
    shared[b] = sharedAfter(b, null, c);
    binOf.set(c, b);
    total[b] += len.get(c)!;
    panels[b].set(key.get(c)!, (panels[b].get(key.get(c)!) ?? 0) + 1);
    for (const p of ppl.get(c)!) people[b].set(p, (people[b].get(p) ?? 0) + 1);
    costs[b] = cost(total[b], panels[b], shared[b]);
  };
  const take = (c: PlanCompetition) => {
    const b = binOf.get(c)!;
    shared[b] = sharedAfter(b, c, null);
    total[b] -= len.get(c)!;
    panels[b].set(key.get(c)!, panels[b].get(key.get(c)!)! - 1);
    for (const p of ppl.get(c)!) people[b].set(p, people[b].get(p)! - 1);
    costs[b] = cost(total[b], panels[b], shared[b]);
  };

  // Greedy: same judges together, longest first, each to its cheapest session.
  const items = [...comps].sort((a, b) =>
    (key.get(a)! < key.get(b)! ? -1 : key.get(a)! > key.get(b)! ? 1 : 0) ||
    len.get(b)! - len.get(a)! || a.id - b.id
  );
  for (const c of items) {
    let best = 0, bestDelta = Infinity;
    for (let b = 0; b < count; b++) {
      const delta = cost(
        total[b] + len.get(c)!,
        withPanel(panels[b], key.get(c)!, 1),
        sharedAfter(b, null, c),
      ) - costs[b];
      if (delta < bestDelta - 1e-9) {
        best = b;
        bestDelta = delta;
      }
    }
    put(c, best);
  }

  // Improve: move one competition, or swap two, while the total cost falls.
  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    let improved = false;
    for (const c of items) {
      const from = binOf.get(c)!, l = len.get(c)!, k = key.get(c)!;
      const fromCost = cost(
        total[from] - l,
        withPanel(panels[from], k, -1),
        sharedAfter(from, c, null),
      );
      for (let to = 0; to < count; to++) {
        if (to === from) continue;
        const toCost = cost(
          total[to] + l,
          withPanel(panels[to], k, 1),
          sharedAfter(to, null, c),
        );
        if (fromCost + toCost < costs[from] + costs[to] - 1e-9) {
          take(c);
          put(c, to);
          improved = true;
          break;
        }
      }
    }
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const x = items[i], y = items[j];
        const bx = binOf.get(x)!, by = binOf.get(y)!;
        if (bx === by) continue;
        const kx = key.get(x)!, ky = key.get(y)!, d = len.get(y)! - len.get(x)!;
        const cx = cost(
          total[bx] + d,
          withPanel(withPanel(panels[bx], kx, -1), ky, 1),
          sharedAfter(bx, x, y),
        );
        const cy = cost(
          total[by] - d,
          withPanel(withPanel(panels[by], ky, -1), kx, 1),
          sharedAfter(by, y, x),
        );
        if (cx + cy < costs[bx] + costs[by] - 1e-9) {
          take(x);
          take(y);
          put(x, by);
          put(y, bx);
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  const bins: PlanCompetition[][] = Array.from({ length: count }, () => []);
  for (const c of comps) bins[binOf.get(c)!].push(c);
  return bins.map(orderForJudges);
}

// --- Running order and estimated times ----------------------------------------

interface Window {
  person: number;
  track: number;
  start: number;
  end: number;
  entry: PlanEntry;
  comp: PlanCompetition;
}

/**
 * The running order of every session (`grid[t][k]`, competitions in order) and
 * of every competition's entries, with the estimated time of each entry.
 */
class Timetable {
  readonly entryOrder = new Map<PlanCompetition, PlanEntry[]>();
  private readonly baseEntry = new Map<PlanEntry, number>();
  private readonly baseComp = new Map<PlanCompetition, number>();

  constructor(
    readonly grid: PlanCompetition[][][],
    readonly slotStarts: number[],
    private readonly allowance: number,
    private readonly gapMs: number,
  ) {
    for (const track of grid) {
      for (const session of track) {
        session.forEach((c, i) => {
          this.baseComp.set(c, i);
          this.entryOrder.set(c, [...c.entries]);
          c.entries.forEach((e, j) => this.baseEntry.set(e, j));
        });
      }
    }
  }

  windows(): Window[] {
    const out: Window[] = [];
    this.grid.forEach((track, t) =>
      track.forEach((session, k) => {
        let at = this.slotStarts[k];
        for (const comp of session) {
          for (const entry of this.entryOrder.get(comp)!) {
            const end = at + entrySeconds(entry, this.allowance) * 1000;
            for (const person of entry.people) {
              out.push({ person, track: t, start: at, end, entry, comp });
            }
            at = end;
          }
        }
      })
    );
    return out;
  }

  /** Pairs of one person's windows on different stages less than the gap apart. */
  clashes(): [Window, Window][] {
    const byPerson = new Map<number, Window[]>();
    for (const w of this.windows()) {
      byPerson.set(w.person, [...(byPerson.get(w.person) ?? []), w]);
    }
    const out: [Window, Window][] = [];
    for (const ws of byPerson.values()) {
      ws.sort((a, b) => a.start - b.start || a.track - b.track);
      for (let i = 0; i < ws.length; i++) {
        for (
          let j = i + 1;
          j < ws.length && ws[j].start < ws[i].end + this.gapMs;
          j++
        ) {
          if (ws[i].track !== ws[j].track) out.push([ws[i], ws[j]]);
        }
      }
    }
    return out;
  }

  /** Entries and competitions not where they started (places moved). */
  displacement(): { entries: number; places: number } {
    let entries = 0, places = 0;
    for (const order of this.entryOrder.values()) {
      order.forEach((e, i) => {
        const d = Math.abs(i - this.baseEntry.get(e)!);
        if (d) entries++;
        places += d;
      });
    }
    for (const track of this.grid) {
      for (const session of track) {
        session.forEach((
          c,
          i,
        ) => (places += Math.abs(i - this.baseComp.get(c)!)));
      }
    }
    return { entries, places };
  }

  cost(): number {
    const changes = sum(this.grid.flat().map(judgeChanges));
    return W_CLASH * this.clashes().length + W_CHANGE * changes +
      W_ORDER * this.displacement().places;
  }

  /**
   * Remove clashes by changing order only: first an entry's place within its
   * competition, then a competition's place within its session. Accepts any
   * change that lowers the cost; stops when none does. Deterministic.
   */
  resolve(): void {
    let current = this.cost();
    for (let round = 0; round < MAX_ORDER_ROUNDS; round++) {
      const clashes = this.clashes();
      if (clashes.length === 0) return;
      let improved = false;
      search: for (const [a, b] of clashes) {
        for (const w of [a, b]) {
          const order = this.entryOrder.get(w.comp)!;
          const from = order.indexOf(w.entry);
          for (let to = 0; to < order.length; to++) {
            if (to === from) continue;
            this.moveWithin(order, from, to);
            const c = this.cost();
            if (c < current) {
              current = c;
              improved = true;
              break search;
            }
            this.moveWithin(order, to, from);
          }
        }
        for (const w of [a, b]) {
          const session = this.grid[w.track].find((s) => s.includes(w.comp))!;
          const from = session.indexOf(w.comp);
          for (let to = 0; to < session.length; to++) {
            if (to === from) continue;
            this.moveWithin(session, from, to);
            const c = this.cost();
            if (c < current) {
              current = c;
              improved = true;
              break search;
            }
            this.moveWithin(session, to, from);
          }
        }
      }
      if (!improved) return;
    }
  }

  private moveWithin<T>(list: T[], from: number, to: number) {
    const [x] = list.splice(from, 1);
    list.splice(to, 0, x);
  }
}

const roundUpTo5Minutes = (ms: number) => Math.ceil(ms / 300_000) * 300_000;

/** Stages, sessions, order and times for one way of splitting (strict or not). */
function build(
  onTrack: PlanCompetition[][],
  settings: PlanSettings,
  shareWeight: number,
): { timetable: Timetable; grid: PlanCompetition[][][] } {
  const { tracks: T, sessionsPerTrack: S, allowanceSeconds: A } = settings;
  const grid: PlanCompetition[][][] = [];
  for (let t = 0; t < T; t++) {
    const busy = Array.from(
      { length: S },
      (_, k) => new Set(grid.flatMap((track) => track[k].flatMap(peopleOf))),
    );
    grid.push(splitTrack(onTrack[t], S, A, busy, shareWeight));
  }
  // Each slot starts after the longest session of the one before, plus the break.
  const slotStarts: number[] = [];
  let at = settings.startsAt.getTime();
  for (let k = 0; k < S; k++) {
    slotStarts.push(at);
    const longest = Math.max(
      ...grid.map((track) =>
        sum(track[k].map((c) => competitionSeconds(c, A)))
      ),
    );
    at = roundUpTo5Minutes(
      at + longest * 1000 + settings.breakMinutes * 60_000,
    );
  }
  const timetable = new Timetable(
    grid,
    slotStarts,
    A,
    settings.gapMinutes * 60_000,
  );
  timetable.resolve();
  return { timetable, grid };
}

export function makePlan(
  comps: PlanCompetition[],
  settings: PlanSettings,
): Plan {
  const { tracks: T, sessionsPerTrack: S, allowanceSeconds: A } = settings;
  if (!Number.isInteger(T) || T < 1 || !Number.isInteger(S) || S < 1) {
    throw new Error(
      "tracks and sessions per track must be whole numbers from 1",
    );
  }
  const len = (c: PlanCompetition) => competitionSeconds(c, A);
  const problems: string[] = [];

  // 1. Stages: linked groups, longest first, each to the lightest stage.
  const groups = judgeGroups(comps)
    .map((g) => g.map((i) => comps[i]))
    .sort((a, b) => sum(b.map(len)) - sum(a.map(len)) || a[0].id - b[0].id);
  const load = new Array<number>(T).fill(0);
  const onTrack: PlanCompetition[][] = Array.from({ length: T }, () => []);
  for (const g of groups) {
    const t = load.indexOf(Math.min(...load));
    onTrack[t].push(...g);
    load[t] += sum(g.map(len));
  }
  if (comps.length > 0 && groups.length < T) {
    problems.push(
      `Only ${groups.length} stage(s) can run at the same time: the competitions' judges form ` +
        `${groups.length} group(s) that share judges. Give rubrics different judges, or plan fewer stages.`,
    );
  }

  // 2 and 3. Sessions, running order and times. If changing the order cannot
  // separate someone's performances, try again keeping people with entries on
  // two stages in different slots altogether, and keep the better plan.
  let built = build(onTrack, settings, W_SHARE);
  if (built.timetable.clashes().length > 0) {
    const strict = build(onTrack, settings, W_CLASH);
    const clashes = (b: typeof built) => b.timetable.clashes().length;
    if (
      clashes(strict) < clashes(built) ||
      (clashes(strict) === clashes(built) &&
        strict.timetable.cost() < built.timetable.cost())
    ) {
      built = strict;
    }
  }
  const { timetable, grid } = built;

  const sessions: PlannedSession[] = [];
  for (let k = 0; k < S; k++) {
    for (let t = 0; t < T; t++) {
      const bin = grid[t][k];
      if (bin.length === 0) continue;
      let at = timetable.slotStarts[k];
      const planned: PlannedCompetition[] = bin.map((c) => {
        const startsAt = new Date(at);
        const order = timetable.entryOrder.get(c)!;
        at += competitionSeconds(c, A) * 1000;
        return { id: c.id, startsAt, entryIds: order.map((e) => e.id) };
      });
      sessions.push({
        track: t,
        slot: k,
        competitions: planned,
        seconds: sum(bin.map(len)),
        judges: [...new Set(bin.flatMap((c) => c.judges))].sort((a, b) =>
          a - b
        ),
        startsAt: new Date(timetable.slotStarts[k]),
      });
    }
  }

  const clashes: PlanClash[] = timetable.clashes().map(([a, b]) => ({
    person: a.person,
    competitions: [a.comp.id, b.comp.id],
    at: [new Date(a.start), new Date(b.start)],
  }));
  const score = scorePlan(grid, timetable, settings, comps.length > 0);
  if (score.peopleClashes > 0) {
    problems.push(
      `${score.peopleClashes} time(s) someone performs on two stages less than ` +
        `${settings.gapMinutes} minutes apart. Try another number of stages or sessions.`,
    );
  }
  if (score.judgeClashes > 0) {
    problems.push(
      `${score.judgeClashes} time(s) a judge is needed on two stages at once.`,
    );
  }
  return { settings, sessions, score, clashes, problems };
}

function scorePlan(
  grid: PlanCompetition[][][],
  timetable: Timetable,
  settings: PlanSettings,
  anything: boolean,
): PlanScore {
  const A = settings.allowanceSeconds;
  const T = grid.length, S = grid[0]?.length ?? 0;
  const len = (bin: PlanCompetition[]) =>
    sum(bin.map((c) => competitionSeconds(c, A)));
  const all = grid.flat();
  const mean = sum(all.map(len)) / Math.max(1, all.length);

  let judgeClashes = 0;
  const judgeTrack = new Map<number, number[]>(); // judge -> track per slot (-1 = free)
  for (let k = 0; k < S; k++) {
    const judgeUse = new Map<number, number>();
    for (let t = 0; t < T; t++) {
      for (const j of new Set(grid[t][k].flatMap((c) => c.judges))) {
        judgeUse.set(j, (judgeUse.get(j) ?? 0) + 1);
        const seen = judgeTrack.get(j) ?? new Array(S).fill(-1);
        if (seen[k] < 0) seen[k] = t;
        judgeTrack.set(j, seen);
      }
    }
    for (const n of judgeUse.values()) judgeClashes += Math.max(0, n - 1);
  }
  let judgeMoves = 0;
  for (const slots of judgeTrack.values()) {
    const used = slots.filter((t) => t >= 0);
    for (let i = 1; i < used.length; i++) {
      if (used[i] !== used[i - 1]) judgeMoves++;
    }
  }
  const peopleClashes = timetable.clashes().length;
  const moved = timetable.displacement();
  const lengths = all.filter((b) => b.length > 0).map(len);
  const changes = sum(all.map((b) => judgeChanges(b)));
  const balance = anything
    ? sum(all.map((b) => mean > 0 ? ((len(b) - mean) / mean) ** 2 : 0))
    : 0;
  const lastSlot = S - 1;
  const endsAt = new Date(
    S === 0 ? settings.startsAt.getTime() : timetable.slotStarts[lastSlot] +
      Math.max(0, ...grid.map((track) => len(track[lastSlot]))) * 1000,
  );
  return {
    judgeClashes,
    peopleClashes,
    judgeChanges: changes,
    judgeMoves,
    entriesMoved: moved.entries,
    longestSeconds: lengths.length ? Math.max(...lengths) : 0,
    shortestSeconds: lengths.length ? Math.min(...lengths) : 0,
    emptySessions: anything ? all.filter((b) => b.length === 0).length : 0,
    endsAt,
    cost: W_CLASH * (judgeClashes + peopleClashes) + W_CHANGE * changes +
      W_MOVE * judgeMoves + W_BALANCE * balance + W_ORDER * moved.places,
  };
}

/**
 * Every combination of 1..maxTracks stages and minSessions..maxSessions
 * sessions per stage, best first: no clashes, then fewest empty sessions,
 * then lowest cost, then the earliest finish.
 */
export function compareVariants(
  comps: PlanCompetition[],
  base: Omit<PlanSettings, "tracks" | "sessionsPerTrack">,
  maxTracks: number,
  minSessions: number,
  maxSessions: number,
): Plan[] {
  const plans: Plan[] = [];
  for (let t = 1; t <= maxTracks; t++) {
    for (let s = minSessions; s <= maxSessions; s++) {
      plans.push(makePlan(comps, { ...base, tracks: t, sessionsPerTrack: s }));
    }
  }
  const clashes = (p: Plan) => p.score.judgeClashes + p.score.peopleClashes;
  return plans.sort((a, b) =>
    clashes(a) - clashes(b) || a.score.emptySessions - b.score.emptySessions ||
    a.score.cost - b.score.cost ||
    a.score.endsAt.getTime() - b.score.endsAt.getTime()
  );
}
