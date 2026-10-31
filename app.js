/*
 * app.js — Lineup Autopilot page. Sign in with Fantrax, rank players, Quick Lineup, tap-to-move, Send, autopilot.
 * Data: league.json (public, rebuilt hourly by the jobs repo) + this manager's rows in Supabase (prefs, send_log).
 * Planning: plan.js (shared with the autopilot job, so autopilot sends exactly what this page shows).
 */
"use strict";
const CFG = window.LINEUP_CONFIG || {};
const S = window.LineupSolver, P = window.LineupPlan;
const $ = (id) => document.getElementById(id);
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayLabel = (iso) => { const d = new Date(iso + "T12:00:00"); return [DOW[d.getDay()], d.getDate()]; };
const short = (n) => { const p = n.split(" "); return p.length > 1 ? p[0][0] + ". " + p.slice(1).join(" ") : n; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const local = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };

const pillCls = (s) => s === "BE" ? " be" : " pos " + ({ PG: "pos-g", SG: "pos-g", G: "pos-g", SF: "pos-f", PF: "pos-f", F: "pos-f", C: "pos-c" }[s] || "pos-x");
const TEAM_COLORS = {
  ATL: ["#E03A3E", "#fff"], BOS: ["#007A33", "#fff"], BKN: ["#222", "#fff"], CHA: ["#00788C", "#fff"], CHI: ["#CE1141", "#fff"],
  CLE: ["#860038", "#FDBB30"], DAL: ["#00538C", "#fff"], DEN: ["#0E2240", "#FEC524"], DET: ["#C8102E", "#fff"], GS: ["#1D428A", "#FFC72C"],
  HOU: ["#CE1141", "#fff"], IND: ["#002D62", "#FDBB30"], LAC: ["#C8102E", "#fff"], LAL: ["#552583", "#FDB927"], MEM: ["#5D76A9", "#fff"],
  MIA: ["#98002E", "#F9A01B"], MIL: ["#00471B", "#EEE1C6"], MIN: ["#0C2340", "#78BE20"], NO: ["#0C2340", "#C8A951"], NY: ["#006BB6", "#F58426"],
  OKC: ["#007AC1", "#fff"], ORL: ["#0077C0", "#fff"], PHI: ["#006BB6", "#fff"], PHX: ["#1D1160", "#E56020"], POR: ["#111", "#E03A3E"],
  SAC: ["#5A2D81", "#fff"], SA: ["#8A969C", "#000"], TOR: ["#CE1141", "#fff"], UTAH: ["#3E2680", "#fff"], WSH: ["#002B5C", "#E31837"],
};
const STAT_VIEWS = [[["pts", "PTS"], ["reb", "REB"], ["ast", "AST"]], [["stl", "STL"], ["blk", "BLK"], ["fg3m", "3PM"]],
  [["fg_pct", "FG%"], ["ft_pct", "FT%"], ["tov", "TO"]]];

let sb, DATA, team, member, period, day, view = "day", sel = null, lastDay = null, today;
let state = { order: [], pins: {}, manual: {}, autopilot: null };
let statView = local.get("lineup:statView", 0);

function show(id) { for (const k of ["signin", "connecting", "choose", "app"]) $(k).hidden = k !== id; }
function fatal(msg) { $("fatal").textContent = msg; $("fatal").hidden = false; }

// ---------- boot ----------
async function boot() {
  if (!CFG.supabaseUrl || !window.supabase) { fatal("Lineup Autopilot isn't set up yet."); return; }
  sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
  try {
    DATA = await (await fetch(`${CFG.supabaseUrl}/storage/v1/object/public/league/league.json?t=${Date.now() / 60000 | 0}`)).json();
  } catch (e) { fatal("Couldn't load league data. Try again in a minute."); return; }
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { show("signin"); return; }
  await enterApp(session);
}

async function enterApp(session) {
  const { data: m } = await sb.from("members").select("team_id,fantrax_email").eq("user_id", session.user.id).maybeSingle();
  if (!m) { await sb.auth.signOut(); show("signin"); return; }
  member = m;
  team = DATA.teams.find((t) => t.id === m.team_id);
  if (!team) { fatal("Your team isn't in the league data yet."); return; }
  const { data: pr } = await sb.from("prefs").select("*").eq("team_id", team.id).maybeSingle();
  state = { order: (pr && pr.order_ids) || [], pins: (pr && pr.pins) || {}, manual: (pr && pr.manual) || {}, autopilot: pr ? pr.autopilot : null };
  const { data: st } = await sb.rpc("my_session_status");
  $("reconnect").hidden = st === "ok";
  today = P.todayET();
  $("period").innerHTML = DATA.periods.map((p) => {
    const [, b] = dayLabel(p.days[0]), [, d] = dayLabel(p.days[p.days.length - 1]);
    const mo = new Date(p.days[0] + "T12:00:00").toLocaleString("en-US", { month: "short" });
    return `<option value="${p.number}">Week ${p.number} · ${mo} ${b}–${d}</option>`;
  }).join("");
  selectPeriod((DATA.periods.find((p) => p.days.includes(today)) || DATA.periods[0]).number);
  if (state.autopilot === null || state.autopilot === undefined) show("choose"); else show("app");
  loadRecent();
}

// ---------- prefs ----------
let saveTimer = null;
async function flush() {
  if (!saveTimer) return;
  clearTimeout(saveTimer); saveTimer = null;
  const { error } = await sb.from("prefs").upsert({ team_id: team.id, order_ids: state.order, pins: state.pins, manual: state.manual,
    autopilot: state.autopilot, updated_at: new Date().toISOString() });
  if (error) fatal("Couldn't save your changes: " + error.message);
}
function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 500); }
// Save right away if the page is closed or hidden, so a quick edit isn't lost.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
window.addEventListener("pagehide", flush);

// ---------- sign in with Fantrax ----------
async function encryptCreds(obj) {
  const der = Uint8Array.from(atob(CFG.connectPublicKey), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("spki", der, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, new TextEncoder().encode(JSON.stringify(obj))));
  let s = ""; ct.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s);
}
function randomPassword() {
  const b = crypto.getRandomValues(new Uint8Array(24)); let s = ""; b.forEach((x) => { s += String.fromCharCode(x); });
  return btoa(s).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" }[c]));
}
async function signIn(e) {
  e.preventDefault();
  const email = $("fxEmail").value.trim().toLowerCase(), password = $("fxPassword").value;
  if (!email || !password) return;
  $("signinBtn").disabled = true; $("signinMsg").textContent = "";
  try {
    const id = crypto.randomUUID(), appPassword = randomPassword();
    const ciphertext = await encryptCreds({ email, password, appPassword });
    $("fxPassword").value = "";
    const r = await fetch(`${CFG.supabaseUrl}/functions/v1/connect`, { method: "POST",
      headers: { "Content-Type": "application/json", apikey: CFG.supabaseKey, Authorization: `Bearer ${CFG.supabaseKey}` },
      body: JSON.stringify({ id, ciphertext }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `Sign-in failed (${r.status}).`);
    show("connecting");
    const started = Date.now();
    for (;;) {
      await new Promise((ok) => setTimeout(ok, 3000));
      const { data } = await sb.rpc("connect_status", { rid: id });
      const st = data && data[0];
      if (st && st.status === "ok") break;
      if (st && st.status !== "queued") throw new Error(st.message || "Sign-in failed.");
      if (Date.now() - started > 4 * 60 * 1000) throw new Error("Fantrax sign-in is taking too long. Try again.");
    }
    const { data: auth, error } = await sb.auth.signInWithPassword({ email, password: appPassword });
    if (error) throw new Error("Signed in to Fantrax, but couldn't open your account: " + error.message);
    await enterApp(auth.session);
  } catch (err) {
    show("signin");
    $("signinMsg").textContent = err.message;
  } finally {
    $("signinBtn").disabled = false;
  }
}

// ---------- planning ----------
const byId = () => Object.fromEntries(team.players.map((p) => [p.id, p]));
const plan = () => P.planPeriod(DATA, team, state, period, today);
function lockedIds(date) {
  const out = new Set();
  if (date !== today) return out;
  const now = new Date();
  for (const p of team.players) { const m = (DATA.matchups[date] || {})[p.nba]; if (m && new Date(m.tip) <= now) out.add(p.id); }
  return out;
}

function cellFor(r, i, id) {
  const d = r.res.days[i];
  const s = d.match.indexOf(id);
  if (s >= 0) return { cls: (d.fills || []).includes(id) ? "c-fill" : "c-start", txt: DATA.slots[s] };
  const sat = d.sat.find((x) => x.id === id);
  if (!sat) return null;
  if (sat.why === "out") return { cls: "c-out", txt: "out" };
  if (sat.why === "cap") return { cls: "c-cap", txt: "cap" };
  return { cls: "c-clash", txt: "sit" };
}

function gameText(nba, d) {
  const m = (DATA.matchups[d] || {})[nba];
  if (!m) return `<span>no game</span>`;
  const t = new Date(m.tip).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${m.home ? "" : "@"}${m.opp}<br><span>${t}</span>`;
}

// ---------- render ----------
function render() {
  const r = plan();
  const map = byId();
  const isPast = (d) => d < today;

  // hero
  const opp = DATA.teams.find((t) => t.id === period.opponent[team.id]);
  $("heroTeam").textContent = team.name;
  $("heroSub").textContent = `${team.owner} · Week ${period.number} vs ${opp ? opp.owner : "—"} · ` +
    (period.cap == null ? `${r.res.used} starts planned` : `${r.res.used} of ${period.cap} games`);
  $("legendCap").hidden = period.cap == null;

  // week: score, calls, grid
  const clashes = [], capCut = {};
  r.res.days.forEach((d, i) => { if (d.past) return; d.sat.forEach((x) => {
    if (x.why === "no slot") clashes.push({ i, id: x.id });
    if (x.why === "cap") capCut[x.id] = (capCut[x.id] || 0) + 1;
  }); });
  const capN = Object.values(capCut).reduce((a, b) => a + b, 0);
  $("score").innerHTML =
    (period.cap == null ? `<div><b>${r.res.used}</b><span>starts planned</span></div>`
      : `<div><b>${r.res.used}<small style="font-size:15px;color:var(--muted)"> / ${period.cap}</small></b><span>games planned (cap)</span></div>`) +
    `<div><b>${r.possible}</b><span>games available</span></div><div><b>${clashes.length}</b><span>slot clashes</span></div>`;
  const calls = [], byDay = {};
  for (const c of clashes) (byDay[c.i] = byDay[c.i] || []).push(c.id);
  for (const [i, ids] of Object.entries(byDay)) {
    const [dw, dn] = dayLabel(period.days[i]);
    calls.push(`<li><b>${dw} ${dn}:</b> ${ids.map((id) => esc(map[id].name)).join(", ")} ${ids.length > 1 ? "have games" : "has a game"} but no open slot. Every eligible slot holds a higher-priority player. Tap the cell to force a start.</li>`);
  }
  if (capN) {
    const list = Object.entries(capCut).sort((a, b) => P.orderedIds(team, state.order).indexOf(a[0]) - P.orderedIds(team, state.order).indexOf(b[0]))
      .map(([id, n]) => `${esc(map[id].name)} (${n})`).join(", ");
    calls.push(`<li class="capcall"><b>Cap:</b> ${period.cap} games allowed this week. These games go unused, lowest priority first: ${list}.</li>`);
  }
  $("calls").innerHTML = calls.join("") || `<li>No calls this week. Your order fills every day.</li>`;
  let h = `<thead><tr><th class="name">Player</th>` + period.days.map((d) => {
    const [dw, dn] = dayLabel(d); return `<th class="day${isPast(d) ? " past" : ""}">${dw}<b>${dn}</b>${(DATA.games[d] || []).length / 2} g</th>`;
  }).join("") + `</tr></thead><tbody>`;
  for (const p of r.players) {
    h += `<tr><td class="name"><span class="num" style="font-size:14px;display:inline-block;width:20px">${p.rank}</span> ${esc(short(p.name))} <small>${p.nba}</small></td>`;
    period.days.forEach((date, i) => {
      const c = cellFor(r, i, p.id);
      if (!c) { h += `<td class="${isPast(date) ? "past" : ""}"><span class="chip c-none">·</span></td>`; return; }
      const pin = (state.pins[date] || {})[p.id];
      if (isPast(date)) { h += `<td class="past"><span class="chip ${c.cls}">${c.txt}</span></td>`; return; }
      h += `<td class="tap" tabindex="0" data-d="${date}" data-p="${p.id}" aria-label="${esc(p.name)} ${date}: ${c.txt}${pin ? ", override " + pin : ""}"><span class="chip ${c.cls}${pin ? " pinned" : ""}">${c.txt}</span></td>`;
    });
    h += `</tr>`;
  }
  h += `<tr class="total"><td class="name">Starts</td>` + r.res.days.map((d) => `<td class="${d.past ? "past" : ""}">${d.match.filter(Boolean).length}</td>`).join("") + `</tr></tbody>`;
  $("grid").innerHTML = h;

  // priority list
  $("ranklist").innerHTML = r.players.map((p) => {
    const g = period.days.filter((d) => d >= today && (DATA.games[d] || []).includes(p.nba)).length;
    const tag = p.inj ? (DATA.outCodes.includes(p.inj.status) ? `<span class="tag out">OUT${p.inj.returns ? " to " + p.inj.returns.slice(5) : ""}</span>` : `<span class="tag gtd">${esc(p.inj.status)}</span>`) : "";
    return `<li data-id="${p.id}"><button class="handle" aria-label="Drag ${esc(p.name)}">⠿</button><span class="num">${p.rank}</span>
      <div class="who"><b>${esc(p.name)}</b> ${tag}<div>${p.nba} · ${p.elig.filter((e) => e !== "Flx").join("/")} · ${g} games left this week</div></div>
      <span class="updown"><button data-mv="-1" aria-label="Move ${esc(p.name)} up">▲</button><button data-mv="1" aria-label="Move ${esc(p.name)} down">▼</button></span></li>`;
  }).join("");
  const ir = team.players.filter(P.isIR);
  $("irlist").innerHTML = ir.length ? `<li class="ir" style="grid-template-columns:1fr"><span class="note">On Fantrax IR, not planned</span></li>` +
    ir.map((p) => `<li class="ir"><span></span><div class="who"><b>${esc(p.name)}</b><div>${p.nba}${p.inj ? " · " + esc(p.inj.status) : ""}</div></div><span></span></li>`).join("") : "";

  // lineup for one day
  $("dayStrip").innerHTML = period.days.map((d) => {
    const [dw, dn] = dayLabel(d);
    return `<button data-day="${d}" class="${isPast(d) ? "past" : ""}" aria-pressed="${d === day}">${d === today ? "Today" : dw}<b>${dn}</b><small>${(DATA.games[d] || []).length / 2} games</small></button>`;
  }).join("");
  const di = period.days.indexOf(day);
  const dd = r.res.days[di];
  lastDay = dd;
  const past = isPast(day), locked = lockedIds(day);
  const pins = state.pins[day] || {};
  $("rosterBox").classList.toggle("readonly", past);
  $("quick").disabled = past;
  $("dayState").textContent = past ? "Played" : dd.manual ? "Edited by you" : "Auto lineup";
  $("dayState").className = "state" + (!past && dd.manual ? " edited" : "");
  const why = { "no slot": "no open slot", cap: "over weekly cap", out: "injured", "pinned bench": "your call: sit", manual: past ? "" : "benched by you" };
  const dest = (pos) => sel && !samePos(sel, pos) && canSwap(dd.match, sel, pos, map, locked);
  $("statPick").innerHTML = STAT_VIEWS.map((v, i) => `<button data-sv="${i}" aria-pressed="${i === statView}">${v.map((x) => x[1]).join(" · ")}</button>`).join("");
  const st = (p) => {
    const s = p.stats || {};
    if (!s.gp_season) return `<span class="stats"><span>no games yet</span></span>`;
    const f = (k, v) => v == null ? "–" : k.endsWith("_pct") ? (v * 100).toFixed(0) + "%" : v.toFixed(1);
    return `<span class="stats">` + STAT_VIEWS[statView].map(([k, lab]) => `<span>${f(k, s[k])}<i>${lab}</i></span>`).join("") + `</span>`;
  };
  const row = (pill, p, extra, pos) => {
    const back = p.inj && p.inj.returns ? ` till ${+p.inj.returns.slice(5, 7)}/${+p.inj.returns.slice(8)}` : "";
    const tag = p.inj ? (DATA.outCodes.includes(p.inj.status) ? (P.isOut(p, day, DATA.outCodes) ? `<em class="out">OUT${back}</em>` : `<em class="gtd">back by now?</em>`) : `<em class="gtd">${esc(p.inj.status)}</em>`) : "";
    const elig = p.elig.filter((e) => ["PG", "SG", "SF", "PF", "C"].includes(e)).join(", ");
    const isLocked = locked.has(p.id);
    const cls = (isLocked ? " locked" : "") + (sel ? (samePos(sel, pos) ? " sel" : dest(pos) ? " dest" : " dim") : "");
    const rk = p.stats && p.stats.rank_season ? `<span class="rk">#${p.stats.rank_season}</span>` : "";
    const [tbg, tfg] = TEAM_COLORS[p.nba] || ["#555", "#fff"];
    const face = p.img ? `<img src="${p.img}" alt="" loading="lazy" onerror="this.remove()">` : `<span>${esc(p.name.split(" ").map((w) => w[0]).join("").slice(0, 2))}</span>`;
    const note = [extra, isLocked ? "game started, locked" : ""].filter(Boolean).join(" · ");
    return `<div class="prow${cls}" tabindex="0" ${posAttr(pos)} data-p="${p.id}" aria-label="${esc(p.name)}, ${pill}">
      <span class="pill${pillCls(pill)}${pins[p.id] ? " pinned" : ""}">${dest(pos) ? "HERE" : pill}</span>
      <span class="av" style="background:${tbg};border-color:${tbg}">${face}</span>
      <span class="pname"><b>${esc(short(p.name))}${rk}</b><span><span class="team" style="background:${tbg};color:${tfg}">${p.nba}</span>${elig} ${tag} ${note ? `<em class="why">· ${note}</em>` : ""}</span>${st(p)}</span>
      <span class="game">${gameText(p.nba, day)}</span></div>`;
  };
  $("starters").innerHTML = DATA.slots.map((s, k) => {
    const id = dd.match[k];
    if (id) return row(s, map[id], pins[id] === "start" ? "your call: start" : (dd.fills || []).includes(id) ? "starting in case they play" : "", { s: k });
    const cls = sel ? (samePos(sel, { s: k }) ? " sel" : dest({ s: k }) ? " dest" : " dim") : "";
    return `<div class="prow emptyslot${cls}" tabindex="0" data-s="${k}" aria-label="Empty ${s} slot"><span class="pill${pillCls(s)}">${dest({ s: k }) ? "HERE" : s}</span><span class="av"></span><span class="pname"><b>Empty</b></span><span></span></div>`;
  }).join("");
  const sitting = dd.sat.map((x) => row("BE", map[x.id], why[x.why], { b: x.id }));
  const seatedOrSat = new Set(dd.match.filter(Boolean).concat(dd.sat.map((x) => x.id)));
  const idle = r.players.filter((p) => !seatedOrSat.has(p.id)).map((p) => row("BE", p, "", { b: p.id }));
  $("bench").innerHTML = sitting.concat(idle).join("");
  const toBench = sel && sel.s !== undefined && dd.match[sel.s] !== null;
  $("benchHead").className = "rhead benchhead" + (toBench ? " dest" : "");
  $("benchHead").children[1].textContent = toBench ? "Bench (tap here to bench)" : "Bench";
  $("moveHint").textContent = past ? "Already played. This is the lineup Fantrax had." :
    sel ? "Tap a highlighted HERE to move there, or tap the same player again to cancel." : "Tap a player, then tap HERE to move them.";

  // send bar + sheet: moves that turn Fantrax's lineup into this one, for today and later days
  const name = (id) => esc(map[id].name);
  const movesOf = (d) => d < today ? [] : P.movesFor(DATA, team, r, d).filter((m) => !lockedIds(d).has(m.id));
  const dayMoves = movesOf(day);
  const weekDays = period.days.filter((d) => d >= today);
  const weekMoves = weekDays.reduce((n, d) => n + movesOf(d).length, 0);
  const [dw, dn] = dayLabel(day);
  $("sendbar").hidden = past;
  $("sendSummary").innerHTML = dayMoves.length ? `<b>${dw} ${dn}:</b> ${dayMoves.length} change${dayMoves.length > 1 ? "s" : ""} vs Fantrax` : `<b>${dw} ${dn}:</b> matches Fantrax`;
  $("sendTitle").textContent = `Send ${dw} ${dn} to Fantrax`;
  const verb = (m) => m.from === "BN" ? `Start ${name(m.id)} at ${m.to}` : m.to === "BN" ? `Bench ${name(m.id)} (was ${m.from})` : `Move ${name(m.id)} from ${m.from} to ${m.to}`;
  $("moveList").innerHTML = dayMoves.map((m) => `<li>${verb(m)}</li>`).join("") || "<li>No changes: Fantrax already has this lineup.</li>";
  $("sendDay").textContent = `Send ${dw} ${dn} (${dayMoves.length})`;
  $("sendDay").disabled = !dayMoves.length || sending;
  $("sendWeek").textContent = `Send rest of week (${weekMoves})`;
  $("sendWeek").disabled = !weekMoves || sending;
  $("sendWeek").dataset.days = JSON.stringify(weekDays.filter((d) => movesOf(d).length));

  // footer
  $("apState").textContent = state.autopilot ? "On" : "Off";
  $("apState").className = "state" + (state.autopilot ? " on" : "");
  $("apToggle").textContent = state.autopilot ? "Turn off" : "Turn on";
  $("who").textContent = `Signed in as ${member.fantrax_email || "you"}`;
  $("dataAge").textContent = `Rosters, games and injuries updated ${new Date(DATA.built).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}.`;
}

// ---------- move mode (ESPN style): a position is a slot {s} or a bench player {b}; {b: null} = the bench ----------
const samePos = (x, y) => x && y && x.s === y.s && x.b === y.b;
const posAttr = (pos) => pos.s !== undefined ? `data-s="${pos.s}"` : `data-b="${pos.b}"`;
const occ = (match, pos) => pos.s !== undefined ? match[pos.s] : pos.b;
function canSwap(match, x, y, map, locked) {
  const a = occ(match, x), b = occ(match, y);
  if (x.s === undefined && y.s === undefined) return false;
  if (a === null && b === null) return false;
  if ((a && locked.has(a)) || (b && locked.has(b))) return false;
  if (y.s !== undefined && a && !map[a].elig.includes(DATA.slots[y.s])) return false;
  if (x.s !== undefined && b && !map[b].elig.includes(DATA.slots[x.s])) return false;
  return true;
}
function applySwap(x, y) {
  const m = lastDay.match.slice();
  const a = occ(m, x), b = occ(m, y);
  if (x.s !== undefined) m[x.s] = b || null;
  if (y.s !== undefined) m[y.s] = a || null;
  state.manual[day] = m;
  delete state.pins[day];
  persist();
}
function tapRow(t) {
  if (day < today) return;
  const locked = lockedIds(day);
  const pos = t.id === "benchHead" ? { b: null } : t.dataset.s !== undefined ? { s: +t.dataset.s } : { b: t.dataset.b };
  const map = byId();
  if (sel && samePos(sel, pos)) sel = null;
  else if (sel && canSwap(lastDay.match, sel, pos, map, locked)) { applySwap(sel, pos); sel = null; }
  else if (pos.b !== null && !locked.has(occ(lastDay.match, pos))) sel = pos;
  render();
  const again = pos.b === null ? $("benchHead") : $("day").querySelector(pos.s !== undefined ? `[data-s="${pos.s}"]` : `[data-b="${pos.b}"]`);
  if (again) again.focus();
}

// ---------- send ----------
let sending = false;
async function send(dates) {
  const r = plan();
  const days = dates.map((d) => ({ date: d, match: r.res.days[period.days.indexOf(d)].match }));
  sending = true; render();
  $("sendResult").className = "note result"; $("sendResult").textContent = "Sending to Fantrax…";
  try {
    const { data: { session } } = await sb.auth.getSession();
    const resp = await fetch(`${CFG.supabaseUrl}/functions/v1/send`, { method: "POST",
      headers: { "Content-Type": "application/json", apikey: CFG.supabaseKey, Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ days }) });
    const body = await resp.json().catch(() => ({}));
    if (body.reconnect) { $("reconnect").hidden = false; throw new Error(body.error); }
    if (!resp.ok) throw new Error(body.error || `Send failed (${resp.status}).`);
    const lines = [];
    let allOk = true;
    for (const x of body.results) {
      const [dw, dn] = dayLabel(x.date);
      if (x.fantrax) (DATA.fantrax[x.date] = DATA.fantrax[x.date] || {})[team.id] = x.fantrax;
      if (!x.ok) allOk = false;
      lines.push(`${dw} ${dn}: ${x.ok ? (x.applied ? "sent" : "nothing to change") : "not sent"}. ${x.message || ""}`);
    }
    $("sendResult").className = "note result " + (allOk ? "ok" : "bad");
    $("sendResult").textContent = lines.join(" ");
    loadRecent();
  } catch (e) {
    $("sendResult").className = "note result bad"; $("sendResult").textContent = e.message;
  } finally {
    sending = false; render();
  }
}

async function loadRecent() {
  const { data } = await sb.from("send_log").select("date,source,ok,message,created_at").order("created_at", { ascending: false }).limit(3);
  $("recent").innerHTML = (data || []).length ? "Recent sends: " + data.map((x) => {
    const [dw, dn] = dayLabel(x.date);
    return `${dw} ${dn} (${x.source === "autopilot" ? "autopilot" : "you"}, ${x.ok ? "ok" : "failed"})`;
  }).join(" · ") : "";
}

// ---------- view switching ----------
function setView(v) {
  view = v;
  for (const k of ["week", "rank", "day"]) { $(k).hidden = k !== v; $("v-" + k).setAttribute("aria-pressed", String(k === v)); }
}
function selectPeriod(n) {
  period = DATA.periods.find((p) => p.number === +n) || DATA.periods[0];
  $("period").value = String(period.number);
  day = period.days.includes(today) ? today : period.days.find((d) => d >= today && (DATA.games[d] || []).length) || period.days[0];
  sel = null; render();
}
function cycle(td) {
  const { d, p } = td.dataset;
  delete state.manual[d];
  const pins = (state.pins[d] = state.pins[d] || {});
  pins[p] = pins[p] === undefined ? "start" : pins[p] === "start" ? "bench" : undefined;
  if (pins[p] === undefined) delete pins[p];
  if (!Object.keys(pins).length) delete state.pins[d];
  persist(); render();
  const again = $(view).querySelector(`[data-d="${d}"][data-p="${p}"]`);
  if (again) again.focus();
}

// ---------- events ----------
$("signinForm").addEventListener("submit", signIn);
$("reconnectBtn").addEventListener("click", () => { $("fxEmail").value = member.fantrax_email || ""; show("signin"); });
$("apOn").addEventListener("click", () => { state.autopilot = true; persist(); show("app"); render(); });
$("apOff").addEventListener("click", () => { state.autopilot = false; persist(); show("app"); render(); });
$("apToggle").addEventListener("click", () => { state.autopilot = !state.autopilot; persist(); render(); });
$("signout").addEventListener("click", async () => { await sb.auth.signOut(); location.reload(); });
$("grid").addEventListener("click", (e) => { const t = e.target.closest("td.tap"); if (t) cycle(t); });
$("grid").addEventListener("keydown", (e) => { const t = e.target.closest("td.tap"); if (t && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); cycle(t); } });
$("dayStrip").addEventListener("click", (e) => { const b = e.target.closest("button[data-day]"); if (b) { day = b.dataset.day; sel = null; $("sendSheet").hidden = true; render(); } });
$("day").addEventListener("click", (e) => { const t = e.target.closest(".prow, #benchHead"); if (t && $("rosterBox").contains(t)) tapRow(t); });
$("day").addEventListener("keydown", (e) => { const t = e.target.closest(".prow, #benchHead"); if (t && $("rosterBox").contains(t) && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); tapRow(t); } });
$("statPick").addEventListener("click", (e) => { const b = e.target.closest("button[data-sv]"); if (b) { statView = +b.dataset.sv; local.set("lineup:statView", statView); render(); } });
$("quick").addEventListener("click", () => { delete state.manual[day]; delete state.pins[day]; sel = null; persist(); render(); });
$("openSend").addEventListener("click", () => { $("sendSheet").hidden = false; $("sendResult").textContent = ""; $("sendSheet").scrollIntoView({ block: "nearest" }); });
$("closeSend").addEventListener("click", () => { $("sendSheet").hidden = true; });
$("sendDay").addEventListener("click", () => send([day]));
$("sendWeek").addEventListener("click", () => send(JSON.parse($("sendWeek").dataset.days || "[]")));
$("v-week").onclick = () => setView("week");
$("v-rank").onclick = () => setView("rank");
$("v-day").onclick = () => setView("day");
$("period").onchange = (e) => selectPeriod(e.target.value);

function move(id, to) {
  const o = P.orderedIds(team, state.order).filter((x) => x !== id);
  o.splice(to, 0, id);
  state.order = o; persist(); render();
}
$("ranklist").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mv]"); if (!b) return;
  const id = b.closest("li").dataset.id;
  const order = P.orderedIds(team, state.order);
  const active = order.filter((x) => !P.isIR(byId()[x]));
  const i = active.indexOf(id), j = i + +b.dataset.mv;
  if (j < 0 || j >= active.length) return;
  move(id, order.indexOf(active[j]));
  const btn = document.querySelector(`#ranklist li[data-id="${id}"] button[data-mv="${b.dataset.mv}"]`);
  if (btn) btn.focus();
});
let drag = null;
$("ranklist").addEventListener("pointerdown", (e) => {
  const h = e.target.closest(".handle"); if (!h) return;
  e.preventDefault();
  drag = { li: h.closest("li") };
  drag.li.classList.add("dragging");
});
window.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const list = $("ranklist");
  const before = [...list.children].filter((x) => x !== drag.li).find((x) => { const b = x.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; });
  list.insertBefore(drag.li, before || null);
});
window.addEventListener("pointerup", () => {
  if (!drag) return;
  const ids = [...$("ranklist").children].map((x) => x.dataset.id);
  state.order = ids.concat(team.players.filter(P.isIR).map((p) => p.id));
  drag.li.classList.remove("dragging");
  drag = null; persist(); render();
});
$("reset").addEventListener("click", () => { state.order = []; state.pins = {}; state.manual = {}; persist(); render(); });

boot();
