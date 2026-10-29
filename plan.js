/*
 * plan.js — turns the league data file (league.json) and one team's saved preferences into that team's lineup plan
 * for a scoring period. The page and the autopilot job both call this, so autopilot sends exactly what the manager sees.
 * inputs:  DATA (league.json, built by jobs/refresh.mjs), team (DATA.teams entry), prefs {order, pins, manual},
 *          period (DATA.periods entry), today (YYYY-MM-DD, US Eastern)
 * outputs: {players (ranked, IR excluded), days, res (solver.planWeek result), possible (healthy player-games)}
 * rules:   days before today are fixed to the lineup Fantrax actually had (their starts count toward the weekly cap:
 *          active + team played, so DNPs count too — conservative). Days the manager edited by hand stay as set.
 *          Other days: Quick Lineup from the priority order, seated to keep Fantrax's current slots where possible.
 * last_run: 2026-10-29 (tests: node --test test/)
 */
(function (root) {
  "use strict";
  const S = typeof module !== "undefined" && module.exports ? require("./solver.js") : root.LineupSolver;

  const isIR = (p) => p.fxStatus === "INJURED_RESERVE";
  const isOut = (p, date, outCodes) => !!(p.inj && outCodes.includes(p.inj.status) && (!p.inj.returns || p.inj.returns > date));

  // The manager's order: saved ids first (dropping players no longer on the roster), then anyone new by default rank.
  function orderedIds(team, saved) {
    const ids = new Set(team.players.map((p) => p.id));
    const order = (saved || []).filter((id) => ids.has(id));
    const rest = team.players.filter((p) => !order.includes(p.id)).sort((a, b) => a.defaultRank - b.defaultRank);
    return order.concat(rest.map((p) => p.id));
  }

  // Fantrax's lineup for a day {playerId: slotCode} -> a match array over the league's slots.
  function fxMatch(slots, fx, rosterIds) {
    const match = slots.map(() => null);
    for (const [id, code] of Object.entries(fx || {})) {
      if (rosterIds && !rosterIds.has(id)) continue;
      const s = slots.findIndex((x, i) => x === code && match[i] === null);
      if (s >= 0) match[s] = id;
    }
    return match;
  }

  function planPeriod(DATA, team, prefs, period, today) {
    prefs = prefs || {};
    const byId = Object.fromEntries(team.players.map((p) => [p.id, p]));
    const order = orderedIds(team, prefs.order);
    const players = order.map((id, i) => ({ ...byId[id], rank: i + 1 })).filter((p) => !isIR(p));
    const rosterIds = new Set(players.map((p) => p.id));
    const days = period.days.map((date) => ({
      date,
      playing: new Set(players.filter((p) => (DATA.games[date] || []).includes(p.nba)).map((p) => p.id)),
      out: new Set(players.filter((p) => isOut(p, date, DATA.outCodes)).map((p) => p.id)),
    }));
    const fixed = {};
    for (const date of period.days) {
      const fx = (DATA.fantrax[date] || {})[team.id];
      if (date < today) fixed[date] = fxMatch(DATA.slots, fx, rosterIds);
      else if (prefs.manual && prefs.manual[date]) {
        const m = prefs.manual[date];
        if (m.length === DATA.slots.length && m.every((id) => id === null || rosterIds.has(id))) fixed[date] = m;
      }
    }
    const res = S.planWeek(players, days, { cap: period.cap, pins: prefs.pins || {}, slots: DATA.slots, fixed });
    res.days.forEach((d) => {
      d.past = d.date < today;
      if (!d.manual) d.match = S.alignSlots(d.match, DATA.slots, players, (DATA.fantrax[d.date] || {})[team.id]);
    });
    const possible = days.reduce((n, d) => n + [...d.playing].filter((id) => !d.out.has(id)).length, 0);
    return { players, days, res, possible };
  }

  // Moves that turn Fantrax's lineup for one planned day into ours (what Send submits).
  function movesFor(DATA, team, plan, date) {
    const i = plan.days.findIndex((d) => d.date === date);
    const fx = (DATA.fantrax[date] || {})[team.id] || {};
    return S.diffLineup(plan.res.days[i].match, DATA.slots, fx, plan.players.map((p) => p.id));
  }

  // Today's date in US Eastern time (the NBA's calendar), as YYYY-MM-DD.
  function todayET(now) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now || new Date());
  }

  const api = { planPeriod, movesFor, orderedIds, fxMatch, isOut, isIR, todayET };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LineupPlan = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
