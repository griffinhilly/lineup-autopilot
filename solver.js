/*
 * solver.js — fills a legal Fantrax daily lineup from a manager's priority ranking, for one day or a whole
 * scoring period under the weekly games cap. Same file runs in the browser (window.LineupSolver) and in Node.
 * inputs:  players [{id, name, elig: ["PG","SG","G","Flx"], rank}], slot layout, game days, cap, pins
 * outputs: per day {slotIndex -> playerId}, plus who sat and why ("no slot", "cap", "out", "pinned bench")
 * method:  greedy in priority order with augmenting paths (Kuhn). Adding players best-first and keeping one only
 *          if every player already kept can still be seated gives the lexicographically best set of starters:
 *          the best player plays whenever any legal lineup lets him, then the next, and so on. The weekly cap is
 *          one more counter on the same greedy (per-day lineups plus a cap form a matroid, so greedy stays exact).
 * last_run: 2026-10-28 (tests: node --test app/)
 */
(function (root) {
  "use strict";

  // Adam Silver Fan Club active slots (Fantrax rosterInfo.positionConstraints, 2026-10-28): 12 active.
  const LEAGUE_SLOTS = ["PG", "SG", "SF", "PF", "C", "G", "G", "F", "F", "Flx", "Flx", "Flx"];

  // Try to seat player p in a lineup. match[s] = player id in slot s or null. Moves already-seated players to
  // other slots they qualify for when that frees a slot (augmenting path). Returns true if p got a slot.
  function tryAugment(p, slots, match, eligOf, seen) {
    const elig = eligOf[p];
    for (let s = 0; s < slots.length; s++) {
      if (!elig.has(slots[s]) || seen[s]) continue;
      seen[s] = true;
      if (match[s] === null || tryAugment(match[s], slots, match, eligOf, seen)) {
        match[s] = p;
        return true;
      }
    }
    return false;
  }

  function eligMap(players) {
    const m = {};
    for (const p of players) m[p.id] = new Set(p.elig);
    return m;
  }

  // Order players for a day: pinned starts first, then by rank (1 = best). Ties broken by id for determinism.
  function byPriority(a, b) {
    return a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  /*
   * planDay: one day's lineup.
   * playing: Set of player ids with a game that day. out: Set of ids ruled out. pins: {id: "start"|"bench"}.
   * Returns {match: [playerId|null per slot], sat: [{id, why}]}.
   */
  function planDay(players, playing, opts) {
    opts = opts || {};
    const slots = opts.slots || LEAGUE_SLOTS;
    const out = opts.out || new Set();
    const pins = opts.pins || {};
    const eligOf = eligMap(players);
    const match = slots.map(() => null);
    const sat = [];
    const cands = players.filter((p) => playing.has(p.id));
    const pinned = cands.filter((p) => pins[p.id] === "start").sort(byPriority);
    const rest = cands.filter((p) => pins[p.id] !== "start").sort(byPriority);
    for (const p of pinned.concat(rest)) {
      if (pins[p.id] === "bench") { sat.push({ id: p.id, why: "pinned bench" }); continue; }
      if (out.has(p.id) && pins[p.id] !== "start") { sat.push({ id: p.id, why: "out" }); continue; }
      if (!tryAugment(p.id, slots, match, eligOf, slots.map(() => false))) sat.push({ id: p.id, why: "no slot" });
    }
    return { match, sat };
  }

  /*
   * planWeek: every day of a scoring period under a games cap.
   * days: [{date, playing: Set ids, out: Set ids}], cap: games allowed for these days (Infinity for none).
   * pins: {date: {id: "start"|"bench"}}.
   * Items are (player, day) pairs taken in order: pinned starts, then rank, then date. Each item is kept if the
   * cap has room and the day's lineup can seat it without unseating anyone already kept.
   * Returns {days: [{date, match, sat}], used, cap}.
   */
  function planWeek(players, days, opts) {
    opts = opts || {};
    const slots = opts.slots || LEAGUE_SLOTS;
    const cap = opts.cap === undefined ? Infinity : opts.cap;
    const pins = opts.pins || {};
    const eligOf = eligMap(players);
    const byId = {};
    for (const p of players) byId[p.id] = p;
    const fixed = opts.fixed || {};
    const state = days.map((d) => ({ date: d.date, match: slots.map(() => null), sat: [] }));
    const items = [];
    let used = 0;
    days.forEach((d, i) => {
      if (fixed[d.date]) { // a lineup the manager set by hand: keep it as is; its starts count toward the cap first
        state[i].match = fixed[d.date].slice();
        state[i].manual = true;
        used += state[i].match.filter((x) => x !== null && d.playing.has(x)).length;
        for (const id of d.playing) if (byId[id] && !state[i].match.includes(id)) state[i].sat.push({ id, why: "manual" });
        return;
      }
      const dp = pins[d.date] || {};
      for (const id of d.playing) {
        if (!byId[id]) continue;
        if (dp[id] === "bench") { state[i].sat.push({ id, why: "pinned bench" }); continue; }
        if (d.out && d.out.has(id) && dp[id] !== "start") { state[i].sat.push({ id, why: "out" }); continue; }
        items.push({ id, i, pinned: dp[id] === "start" ? 0 : 1, rank: byId[id].rank });
      }
    });
    items.sort((a, b) => a.pinned - b.pinned || a.rank - b.rank || a.i - b.i || (a.id < b.id ? -1 : 1));
    for (const it of items) {
      const st = state[it.i];
      if (used >= cap) { st.sat.push({ id: it.id, why: "cap" }); continue; }
      if (tryAugment(it.id, slots, st.match, eligOf, slots.map(() => false))) used++;
      else st.sat.push({ id: it.id, why: "no slot" });
    }
    return { days: state, used, cap };
  }

  // Prorated weekly cap: 48 per 7-day week, rounded up (Griffin 2026-10-24: 6-day week 1 -> 42).
  function proratedCap(nDays, perWeek) {
    return Math.ceil((perWeek || 48) * nDays / 7);
  }

  /*
   * alignSlots: keep the same starters, but seat them so as many as possible keep their current Fantrax slot code.
   * Fewer slot shuffles = fewer moves to send. Exact min-cost assignment (Hungarian method, rows = starters, cols = slots;
   * cost 0 = same slot code as now, 1 = different, ineligible = forbidden).
   * match: [playerId|null per slot] (a legal lineup); fx: {playerId: slotCode}. Returns a new legal match.
   */
  function alignSlots(match, slots, players, fx) {
    const ids = match.filter((x) => x !== null);
    if (!ids.length || !fx) return match.slice();
    const eligOf = eligMap(players);
    const n = ids.length, m = slots.length, BIG = 1e6;
    const cost = (i, j) => (!eligOf[ids[i]].has(slots[j]) ? BIG : fx[ids[i]] === slots[j] ? 0 : 1);
    // e-maxx Hungarian, 1-indexed, n <= m.
    const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0), p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      p[0] = i;
      let j0 = 0;
      const minv = new Array(m + 1).fill(Infinity), used = new Array(m + 1).fill(false);
      do {
        used[j0] = true;
        const i0 = p[j0];
        let delta = Infinity, j1 = 0;
        for (let j = 1; j <= m; j++) {
          if (used[j]) continue;
          const cur = cost(i0 - 1, j - 1) - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
        for (let j = 0; j <= m; j++) {
          if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
        }
        j0 = j1;
      } while (p[j0] !== 0);
      do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
    }
    const out = slots.map(() => null);
    for (let j = 1; j <= m; j++) if (p[j]) out[j - 1] = ids[p[j] - 1];
    // Safety: the input was legal, so a zero-forbidden assignment exists; fall back if anything went wrong.
    const ok = out.every((id, s) => id === null || eligOf[id].has(slots[s])) && out.filter(Boolean).length === n;
    return ok ? out : match.slice();
  }

  /*
   * diffLineup: the moves that turn Fantrax's lineup for a day into ours. Send submits exactly these.
   * match: [playerId|null per slot]; fx: {playerId: slotCode} of Fantrax's ACTIVE players; roster: player ids we manage.
   * Returns [{id, from, to}] with "BN" for bench. Players whose slot code is unchanged are not moves (two G slots are
   * interchangeable in Fantrax).
   */
  function diffLineup(match, slots, fx, roster) {
    const ours = {};
    match.forEach((id, s) => { if (id !== null) ours[id] = slots[s]; });
    const moves = [];
    for (const id of roster) {
      const from = fx[id] || "BN", to = ours[id] || "BN";
      if (from !== to) moves.push({ id, from, to });
    }
    return moves;
  }

  const api = { LEAGUE_SLOTS, planDay, planWeek, proratedCap, alignSlots, diffLineup };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LineupSolver = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
