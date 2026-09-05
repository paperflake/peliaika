'use strict';
/* ==========================================================================
   Vaihtokoppi — vaihtojen hallinta juniorijalkapallossa
   Yksi tiedosto, ei ulkoisia riippuvuuksia (paitsi Google Fonts).
   Tila tallennetaan selaimen localStorageen + JSON-vienti/tuonti varmuuskopioksi.
   ========================================================================== */

const STORAGE_KEY = 'vaihtokoppi_state_v1';

function uid(prefix){
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function defaultState(){
  return {
    version: 1,
    tournamentName: 'Turnaus',
    settings: {
      outfieldSlots: 4,
      subGroupSize: 3,
      toleranceMinutes: 3
    },
    roster: [],
    matches: [],
    activeMatchId: null
  };
}

let state = loadState();
let currentTab = 'peli';

// transient (not persisted) UI selection for the substitution panel
let pendingOff = new Set();
let pendingOn = new Set();
let onManuallyEdited = false;
let lastSuggestionKey = '';

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaultState();
    // shallow-merge with defaults so older saves still work if fields were added later
    const d = defaultState();
    return {
      ...d,
      ...parsed,
      settings: { ...d.settings, ...(parsed.settings || {}) }
    };
  }catch(e){
    console.warn('Tilan lataus epäonnistui, aloitetaan tyhjästä.', e);
    return defaultState();
  }
}

function saveState(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }catch(e){
    console.warn('Tilan tallennus epäonnistui (localStorage ei käytettävissä tässä näkymässä).', e);
  }
}

/* ============================== helpers ============================== */

function getPlayer(id){
  return state.roster.find(p => p.id === id) || null;
}

function playerLabel(id){
  const p = getPlayer(id);
  if (!p) return '?';
  return (p.number !== null && p.number !== undefined && p.number !== '') ? ('#' + p.number + ' ' + p.name) : p.name;
}

function getActiveMatch(){
  return state.matches.find(m => m.id === state.activeMatchId) || null;
}

function fmtClock(totalSeconds){
  const s = Math.max(0, Math.round(totalSeconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}

function fmtMinutesShort(totalSeconds){
  const mins = totalSeconds / 60;
  return (Math.round(mins * 10) / 10).toString().replace('.', ',') + ' min';
}

function ensureStat(match, pid){
  if (!match.stats[pid]){
    match.stats[pid] = { actualSeconds: 0, idealSeconds: 0, gkSeconds: 0 };
  }
  return match.stats[pid];
}

/* ============================== fairness calc ==============================
   Pool = mukana olevat pelaajat pl. sen hetkinen maalivahti.
   K = kentällä olevien kenttäpelaajien paikkojen määrä (asetus).
   Jokainen poolissa oleva pelaaja kerryttää "ideal"-aikaa nopeudella K/N,
   missä N = poolin koko juuri sillä hetkellä (huomioi automaattisesti
   maalivahdin vaihtumisen, koska pool päivittyy joka tick).
   ============================================================================ */

function applyElapsed(match, dtSeconds){
  if (dtSeconds <= 0) return;
  match.timer.elapsedSeconds += dtSeconds;
  match.timer.totalElapsedSeconds += dtSeconds;

  const gk = match.goalkeeperId;
  const pool = match.participantIds.filter(id => id !== gk);
  const N = pool.length;
  const K = Math.min(state.settings.outfieldSlots, N || 1);

  if (gk){
    ensureStat(match, gk).gkSeconds += dtSeconds;
  }
  if (N > 0){
    const share = K / N;
    for (const pid of pool){
      ensureStat(match, pid).idealSeconds += share * dtSeconds;
    }
  }
  for (const pid of match.onFieldIds){
    ensureStat(match, pid).actualSeconds += dtSeconds;
  }
}

function diffMinutes(match, pid){
  const s = match.stats[pid];
  if (!s) return 0;
  return (s.actualSeconds - s.idealSeconds) / 60;
}

// bar-status pelaajalle joka EI ole juuri nyt maalivahti
function colorStatus(match, pid){
  const s = match.stats[pid];
  if (!s || s.actualSeconds < 1){
    return 'gray';
  }
  const diff = diffMinutes(match, pid);
  const tol = state.settings.toleranceMinutes;
  if (diff > tol * 2) return 'red';
  if (diff > tol) return 'orange';
  if (diff < -tol) return 'under';
  return 'green';
}

function benchIds(match){
  const gk = match.goalkeeperId;
  return match.participantIds.filter(id => id !== gk && !match.onFieldIds.includes(id));
}

function computeSuggestion(match){
  const onField = match.onFieldIds.slice();
  const bench = benchIds(match);
  const byMostOver = [...onField].sort((a, b) => diffMinutes(match, b) - diffMinutes(match, a));
  const byMostUnder = [...bench].sort((a, b) => diffMinutes(match, a) - diffMinutes(match, b));
  const n = Math.max(0, Math.min(state.settings.subGroupSize, onField.length, bench.length));
  const suggestedOff = byMostOver.slice(0, n);
  const dueNow = onField.length > 0 && diffMinutes(match, byMostOver[0]) > state.settings.toleranceMinutes;
  return {
    onField, bench,
    suggestedOff,
    suggestedOn: byMostUnder.slice(0, n),
    rankedOn: byMostUnder,
    dueNow
  };
}

/* ============================== timer loop ============================== */

setInterval(() => {
  const m = getActiveMatch();
  if (!m || m.timer.running !== true) return;
  const now = Date.now();
  const dt = (now - m.timer.lastTickTs) / 1000;
  m.timer.lastTickTs = now;
  applyElapsed(m, dt);

  const periodSeconds = m.periodMinutes * 60;
  if (m.timer.elapsedSeconds >= periodSeconds){
    m.timer.elapsedSeconds = periodSeconds;
    m.timer.running = false;
    if (m.currentPeriod >= m.periodsCount){
      m.status = 'finished';
    } else {
      m.status = 'period_break';
    }
  }
  saveState();
  if (currentTab === 'peli') renderPeli();
}, 500);

function startPause(match){
  if (match.status === 'finished') return;
  if (match.timer.running){
    match.timer.running = false;
  } else {
    match.status = 'in_progress';
    match.timer.running = true;
    match.timer.lastTickTs = Date.now();
  }
  saveState();
  renderPeli();
}

function nextPeriod(match){
  if (match.currentPeriod >= match.periodsCount) return;
  match.currentPeriod += 1;
  match.timer.elapsedSeconds = 0;
  match.timer.running = false;
  match.status = 'in_progress';
  saveState();
  renderPeli();
}

function finishMatch(match){
  if (!confirm('Päätetäänkö ottelu? Kelloa ei voi enää jatkaa tämän jälkeen.')) return;
  match.timer.running = false;
  match.status = 'finished';
  saveState();
  renderPeli();
}

function setGoalkeeper(match, newGkId){
  const oldGk = match.goalkeeperId;
  if (newGkId === oldGk) return;
  match.goalkeeperId = newGkId || null;

  // vanha maalivahti palaa penkille (poistetaan kentältä-listalta jos oli siellä ennen mv:ksi ryhtymistä)
  match.onFieldIds = match.onFieldIds.filter(id => id !== match.goalkeeperId);
  if (oldGk && !match.onFieldIds.includes(oldGk) && oldGk !== match.goalkeeperId){
    // vanha mv menee penkille automaattisesti (ei lisätä onFieldIds:iin) — pysyy poolissa benchIds():n kautta
  }
  // jos uusi mv oli penkillä/kentällä, hän on nyt pois kenttäkiertoluokittelusta automaattisesti
  // (poolIds/benchIds lasketaan goalkeeperId:n perusteella joka kerta)

  // jos kentällä on nyt liian vähän pelaajia (koska uusi mv otettiin kentältä), täytä aukko parhaalla penkkiehdokkaalla
  const K = Math.min(state.settings.outfieldSlots, match.participantIds.filter(id => id !== match.goalkeeperId).length || 1);
  while (match.onFieldIds.length < K){
    const bench = benchIds(match).filter(id => !match.onFieldIds.includes(id));
    if (bench.length === 0) break;
    const best = [...bench].sort((a, b) => diffMinutes(match, a) - diffMinutes(match, b))[0];
    match.onFieldIds.push(best);
  }
  resetPendingSelection();
  saveState();
  renderPeli();
}

function resetPendingSelection(){
  pendingOff = new Set();
  pendingOn = new Set();
  onManuallyEdited = false;
  lastSuggestionKey = '';
}

function toggleOff(match, pid){
  if (pendingOff.has(pid)) pendingOff.delete(pid); else pendingOff.add(pid);
  onManuallyEdited = false; // off-valinnan muutos laskee "on"-ehdotuksen uudelleen
  renderSubpanel(match);
}

function toggleOn(match, pid){
  if (pendingOn.has(pid)) pendingOn.delete(pid);
  else {
    pendingOn.add(pid);
    // pidä valittujen määrä yhtä suurena kuin pendingOff — pudota heikoin ehdokas pois jos ylimäärä
    if (pendingOn.size > pendingOff.size && pendingOff.size > 0){
      const sug = computeSuggestion(match);
      const ranked = sug.rankedOn.filter(id => pendingOn.has(id));
      const toDrop = ranked[ranked.length - 1];
      if (toDrop && toDrop !== pid) pendingOn.delete(toDrop);
    }
  }
  onManuallyEdited = true;
  renderSubpanel(match);
}

function executeSub(match){
  const off = [...pendingOff];
  const on = [...pendingOn];
  if (off.length === 0 || off.length !== on.length) return;
  match.onFieldIds = match.onFieldIds.filter(id => !off.includes(id)).concat(on);
  match.subLog.push({
    totalSeconds: match.timer.totalElapsedSeconds,
    period: match.currentPeriod,
    outIds: off,
    inIds: on
  });
  resetPendingSelection();
  saveState();
  renderPeli();
}

/* ============================== match factory ============================== */

function newMatch(){
  return {
    id: uid('match'),
    opponent: '',
    kickoff: '',
    periodsCount: 1,
    periodMinutes: 20,
    participantIds: [],
    goalkeeperId: null,
    onFieldIds: [],
    currentPeriod: 1,
    status: 'not_started', // not_started | in_progress | period_break | finished
    timer: { running: false, elapsedSeconds: 0, totalElapsedSeconds: 0, lastTickTs: null },
    stats: {},
    subLog: []
  };
}

/* ============================== rendering ============================== */

function render(){
  document.querySelectorAll('.tab-panel').forEach(el => {
    el.hidden = el.dataset.panel !== currentTab;
  });
  document.querySelectorAll('.tabbar__tab').forEach(el => {
    el.setAttribute('aria-selected', el.dataset.tab === currentTab ? 'true' : 'false');
  });
  if (currentTab === 'peli') renderPeli();
  else if (currentTab === 'ottelut') renderOttelut();
  else if (currentTab === 'joukkue') renderJoukkue();
  else if (currentTab === 'tilastot') renderTilastot();
}

/* -------- Peli -------- */

function renderPeli(){
  const select = document.getElementById('activeMatchSelect');
  select.innerHTML = '';
  state.matches.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = (m.opponent || 'Nimetön ottelu') + (m.kickoff ? (' · ' + m.kickoff) : '');
    select.appendChild(opt);
  });

  const match = getActiveMatch();
  const empty = document.getElementById('peliEmpty');
  const content = document.getElementById('peliContent');

  if (!match){
    empty.hidden = false;
    content.hidden = true;
    return;
  }
  empty.hidden = true;
  content.hidden = false;
  select.value = match.id;

  renderTimerbar(match);
  renderSubpanel(match);
  renderGkSelect(match);
  renderRosterLive(match);
  renderSublog(match);
}

function renderTimerbar(match){
  const periodsWrap = document.getElementById('timerbarPeriods');
  periodsWrap.innerHTML = '';
  for (let i = 1; i <= match.periodsCount; i++){
    const dot = document.createElement('div');
    dot.className = 'timerbar__period-dot' +
      (i < match.currentPeriod ? ' is-done' : (i === match.currentPeriod ? ' is-current' : ''));
    periodsWrap.appendChild(dot);
  }
  document.getElementById('timerElapsed').textContent = fmtClock(match.timer.elapsedSeconds);
  document.getElementById('timerOf').textContent = '/ ' + fmtClock(match.periodMinutes * 60);
  document.getElementById('timerTotal').textContent = fmtClock(match.timer.totalElapsedSeconds);
  document.getElementById('timerTotalOf').textContent = fmtClock(match.periodMinutes * 60 * match.periodsCount);

  const btnStartPause = document.getElementById('btnStartPause');
  const btnNextPeriod = document.getElementById('btnNextPeriod');
  const btnFinish = document.getElementById('btnFinishMatch');

  if (match.status === 'finished'){
    btnStartPause.textContent = 'Ottelu päättynyt';
    btnStartPause.disabled = true;
    btnNextPeriod.hidden = true;
    btnFinish.hidden = true;
  } else if (match.status === 'period_break'){
    btnStartPause.disabled = true;
    btnStartPause.textContent = 'Jakso päättyi';
    btnNextPeriod.hidden = false;
    btnFinish.hidden = false;
  } else {
    btnStartPause.disabled = false;
    btnStartPause.textContent = match.timer.running ? 'Tauko' : (match.timer.totalElapsedSeconds > 0 ? 'Jatka' : 'Aloita');
    btnNextPeriod.hidden = true;
    btnFinish.hidden = false;
  }
}

function suggestionKey(match){
  const sug = computeSuggestion(match);
  return sug.suggestedOff.join(',') + '|' + sug.suggestedOn.join(',');
}

function renderSubpanel(match){
  const panel = document.getElementById('subpanel');
  const sug = computeSuggestion(match);
  const key = sug.suggestedOff.join(',') + '|' + sug.suggestedOn.join(',');

  // alusta ehdotus valituksi kun ehdotus muuttuu merkittävästi eikä valmentaja ole juuri muokannut
  if (key !== lastSuggestionKey && pendingOff.size === 0 && pendingOn.size === 0){
    pendingOff = new Set(sug.suggestedOff);
    pendingOn = new Set(sug.suggestedOn);
    onManuallyEdited = false;
  }
  lastSuggestionKey = key;

  // jos off-valinta muutettu manuaalisesti eikä on-puolta ole vielä käsin muokattu, päivitä on-ehdotus vastaamaan määrää
  if (!onManuallyEdited){
    const n = pendingOff.size;
    const ranked = sug.rankedOn.slice(0, n);
    pendingOn = new Set(ranked);
  }

  panel.classList.toggle('is-due', sug.dueNow);
  document.getElementById('subDueBadge').hidden = !sug.dueNow;

  const offWrap = document.getElementById('offChips');
  const onWrap = document.getElementById('onChips');
  offWrap.innerHTML = '';
  onWrap.innerHTML = '';

  if (sug.onField.length === 0){
    offWrap.innerHTML = '<span class="rosterrow__tag">Ei pelaajia kentällä</span>';
  }
  sug.onField.forEach(pid => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (pendingOff.has(pid) ? ' is-selected' : '');
    chip.textContent = playerLabel(pid);
    chip.addEventListener('click', () => toggleOff(match, pid));
    offWrap.appendChild(chip);
  });

  if (sug.bench.length === 0){
    onWrap.innerHTML = '<span class="rosterrow__tag">Penkki tyhjä</span>';
  }
  sug.bench.forEach(pid => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (pendingOn.has(pid) ? ' is-selected' : '');
    chip.textContent = playerLabel(pid);
    chip.addEventListener('click', () => toggleOn(match, pid));
    onWrap.appendChild(chip);
  });

  const hint = document.getElementById('subHint');
  const btn = document.getElementById('btnDoSub');
  if (pendingOff.size !== pendingOn.size){
    hint.textContent = 'Valitse yhtä monta pelaajaa molempiin: pois ' + pendingOff.size + ', tilalle ' + pendingOn.size + '.';
    btn.disabled = true;
  } else if (pendingOff.size === 0){
    hint.textContent = sug.onField.length === 0 ? '' : 'Valitse ainakin yksi pelaaja vaihdettavaksi.';
    btn.disabled = true;
  } else {
    hint.textContent = '';
    btn.disabled = false;
  }
}

function renderGkSelect(match){
  const sel = document.getElementById('gkSelect');
  sel.innerHTML = '<option value="">— ei valittu —</option>';
  match.participantIds.forEach(pid => {
    const opt = document.createElement('option');
    opt.value = pid;
    opt.textContent = playerLabel(pid);
    if (pid === match.goalkeeperId) opt.selected = true;
    sel.appendChild(opt);
  });
}

function renderRosterLive(match){
  const ul = document.getElementById('rosterLive');
  ul.innerHTML = '';
  if (match.participantIds.length === 0){
    ul.innerHTML = '<li class="empty-state">Ottelulle ei ole valittu pelaajia. Muokkaa ottelua Ottelut-välilehdellä.</li>';
    return;
  }

  const tol = state.settings.toleranceMinutes;
  // skaalaa palkin leveys automaattisesti pahimman poikkeaman mukaan, väri pysyy asetuksen mukaisena
  let maxAbs = tol * 1.4;
  match.participantIds.forEach(pid => {
    if (pid === match.goalkeeperId) return;
    maxAbs = Math.max(maxAbs, Math.abs(diffMinutes(match, pid)));
  });
  const halfRange = maxAbs * 1.15;

  const ordered = [...match.participantIds].sort((a, b) => {
    if (a === match.goalkeeperId) return -1;
    if (b === match.goalkeeperId) return 1;
    const aOn = match.onFieldIds.includes(a), bOn = match.onFieldIds.includes(b);
    if (aOn !== bOn) return aOn ? -1 : 1;
    return diffMinutes(match, b) - diffMinutes(match, a);
  });

  ordered.forEach(pid => {
    const p = getPlayer(pid);
    if (!p) return;
    const li = document.createElement('li');
    const isGk = pid === match.goalkeeperId;
    const isOn = match.onFieldIds.includes(pid);
    li.className = 'rosterrow' + (isGk ? ' is-gk' : '');

    const num = document.createElement('div');
    num.className = 'rosterrow__num';
    num.textContent = (p.number !== null && p.number !== undefined && p.number !== '') ? p.number : '–';
    li.appendChild(num);

    const name = document.createElement('div');
    name.className = 'rosterrow__name';
    name.textContent = p.name;
    li.appendChild(name);

    const tag = document.createElement('div');
    tag.className = 'rosterrow__tag' + (isGk ? ' rosterrow__tag--gk' : (isOn ? ' rosterrow__tag--field' : ''));
    tag.textContent = isGk ? 'MAALIVAHTI' : (isOn ? 'Kentällä' : 'Penkillä');
    li.appendChild(tag);

    if (isGk){
      const gkTime = document.createElement('div');
      gkTime.className = 'rosterrow__gktime';
      const s = match.stats[pid];
      gkTime.textContent = 'Maalivahtina ' + fmtMinutesShort(s ? s.gkSeconds : 0);
      li.appendChild(gkTime);
    } else {
      const meta = document.createElement('div');
      meta.className = 'rosterrow__meta';

      const bar = document.createElement('div');
      bar.className = 'balancebar';
      const center = document.createElement('div');
      center.className = 'balancebar__center';
      center.style.left = '50%';
      bar.appendChild(center);
      [-tol, tol].forEach(t => {
        const tick = document.createElement('div');
        tick.className = 'balancebar__tick';
        const pct = 50 + (t / halfRange) * 50;
        tick.style.left = Math.min(97, Math.max(3, pct)) + '%';
        bar.appendChild(tick);
      });
      const diff = diffMinutes(match, pid);
      const status = colorStatus(match, pid);
      const fill = document.createElement('div');
      fill.className = 'balancebar__fill balancebar__fill--' + status;
      const clamped = Math.max(-halfRange, Math.min(halfRange, diff));
      const centerPct = 50, valPct = 50 + (clamped / halfRange) * 50;
      const left = Math.min(centerPct, valPct);
      const width = Math.max(1.5, Math.abs(valPct - centerPct));
      fill.style.left = left + '%';
      fill.style.width = width + '%';
      bar.appendChild(fill);
      meta.appendChild(bar);

      const timeLabel = document.createElement('div');
      timeLabel.className = 'rosterrow__time';
      const s = match.stats[pid];
      timeLabel.textContent = fmtMinutesShort(s ? s.actualSeconds : 0);
      meta.appendChild(timeLabel);

      li.appendChild(meta);
    }

    li.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
    });
    ul.appendChild(li);
  });
}

function renderSublog(match){
  const wrap = document.getElementById('sublog');
  if (match.subLog.length === 0){ wrap.innerHTML = ''; return; }
  wrap.innerHTML = '<h2 style="font-size:14px;color:var(--ink-soft);margin:0 0 6px;">Vaihtohistoria</h2>';
  [...match.subLog].reverse().forEach(entry => {
    const div = document.createElement('div');
    div.className = 'sublog__entry';
    div.textContent = 'J' + entry.period + ' · ' + fmtClock(entry.totalSeconds) + ' — pois: ' +
      entry.outIds.map(playerLabel).join(', ') + ' · tilalle: ' + entry.inIds.map(playerLabel).join(', ');
    wrap.appendChild(div);
  });
}

/* -------- Ottelut -------- */

function renderOttelut(){
  const ul = document.getElementById('matchList');
  ul.innerHTML = '';
  if (state.matches.length === 0){
    ul.innerHTML = '<li class="empty-state"><p class="empty-state__title">Ei otteluita vielä</p><p class="empty-state__body">Lisää ensimmäinen ottelu.</p></li>';
    return;
  }
  state.matches.forEach(m => {
    const li = document.createElement('li');
    li.className = 'matchcard';
    const statusLabel = m.status === 'finished' ? 'Päättynyt' : (m.status === 'not_started' ? 'Ei alkanut' : 'Käynnissä');
    const statusClass = m.status === 'finished' ? ' matchcard__status--done' : (m.status === 'not_started' ? '' : ' matchcard__status--live');
    li.innerHTML = `
      <div>
        <p class="matchcard__title">${escapeHtml(m.opponent || 'Nimetön ottelu')}</p>
        <p class="matchcard__meta">${m.kickoff ? escapeHtml(m.kickoff) + ' · ' : ''}${m.periodsCount}×${m.periodMinutes} min · ${m.participantIds.length} pelaajaa</p>
      </div>
      <span class="matchcard__status${statusClass}">${statusLabel}</span>
    `;
    li.addEventListener('click', () => {
      state.activeMatchId = m.id;
      saveState();
      currentTab = 'peli';
      switchTabButtons();
      render();
    });
    // pitkä paina / kakkosklikkaus muokkaukseen — yksinkertaisuuden vuoksi lisätään pieni muokkausnappi
    const editBtn = document.createElement('button');
    editBtn.className = 'btn--icon';
    editBtn.textContent = '✎';
    editBtn.title = 'Muokkaa ottelua';
    editBtn.addEventListener('click', (e) => { e.stopPropagation(); openMatchModal(m); });
    li.appendChild(editBtn);
    ul.appendChild(li);
  });
}

function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

/* -------- match modal (luo / muokkaa) -------- */

function openMatchModal(existing){
  const isNew = !existing;
  const match = existing || newMatch();
  const lockRoster = !isNew && match.status !== 'not_started';

  const backdrop = document.getElementById('modalBackdrop');
  const root = document.getElementById('modalRoot');

  function fieldChecklistHtml(){
    if (state.roster.length === 0){
      return '<p class="modal__error">Lisää ensin pelaajia Joukkue-välilehdellä.</p>';
    }
    return '<div class="modal__checklist" id="participantChecklist">' +
      state.roster.map(p => `
        <label class="modal__checkrow">
          <input type="checkbox" value="${p.id}" ${match.participantIds.includes(p.id) ? 'checked' : ''} ${lockRoster ? 'disabled' : ''}>
          ${escapeHtml(playerLabel(p.id))}
        </label>
      `).join('') + '</div>';
  }

  root.innerHTML = `
    <h2>${isNew ? 'Uusi ottelu' : 'Muokkaa ottelua'}</h2>
    <div class="field">
      <label for="mOpponent">Vastustaja</label>
      <input id="mOpponent" type="text" value="${escapeHtml(match.opponent)}" placeholder="esim. FC Esimerkki">
    </div>
    <div class="fieldrow">
      <div class="field">
        <label for="mKickoff">Alkaa klo</label>
        <input id="mKickoff" type="time" value="${escapeHtml(match.kickoff)}">
      </div>
      <div class="field">
        <label for="mPeriods">Jaksoja</label>
        <input id="mPeriods" type="number" min="1" max="8" value="${match.periodsCount}">
      </div>
      <div class="field">
        <label for="mPeriodMin">Jakson pituus (min)</label>
        <input id="mPeriodMin" type="number" min="1" max="90" value="${match.periodMinutes}">
      </div>
    </div>

    <div class="field">
      <label>Pelaajat mukana tässä ottelussa ${lockRoster ? '(ottelu on jo alkanut, kokoonpanoa ei voi enää muuttaa täältä)' : ''}</label>
      ${fieldChecklistHtml()}
    </div>

    ${!lockRoster ? `
    <div class="field">
      <label for="mGk">Maalivahti</label>
      <select id="mGk"><option value="">— valitse osallistujat ensin —</option></select>
    </div>
    <div class="field">
      <label id="onfieldLabel">Aloittava kokoonpano kentällä</label>
      <div class="modal__checklist" id="onfieldChecklist"></div>
      <button type="button" class="btn btn--ghost" id="btnAutoFillField" style="margin-top:6px;">Täytä automaattisesti</button>
    </div>
    ` : ''}

    <p class="modal__error" id="modalError" hidden></p>
    <div class="modal__actions">
      ${!isNew ? '<button type="button" class="btn btn--danger" id="btnDeleteMatch">Poista ottelu</button>' : '<span></span>'}
      <button type="button" class="btn btn--ghost" id="btnCancelMatch">Peruuta</button>
      <button type="button" class="btn btn--accent" id="btnSaveMatch">Tallenna</button>
    </div>
  `;
  backdrop.hidden = false;

  function currentCheckedParticipants(){
    return Array.from(root.querySelectorAll('#participantChecklist input:checked')).map(i => i.value);
  }

  function refreshGkAndField(){
    if (lockRoster) return;
    const participants = currentCheckedParticipants();
    const gkSel = root.querySelector('#mGk');
    const prevGk = gkSel.value;
    gkSel.innerHTML = '<option value="">— ei valittu —</option>' +
      participants.map(pid => `<option value="${pid}">${escapeHtml(playerLabel(pid))}</option>`).join('');
    if (participants.includes(prevGk)) gkSel.value = prevGk;
    else if (participants.includes(match.goalkeeperId)) gkSel.value = match.goalkeeperId;

    renderOnfieldChecklist();
  }

  function renderOnfieldChecklist(){
    const participants = currentCheckedParticipants();
    const gk = root.querySelector('#mGk').value;
    const eligible = participants.filter(pid => pid !== gk);
    const wrap = root.querySelector('#onfieldChecklist');
    const K = state.settings.outfieldSlots;
    const prevChecked = new Set(Array.from(wrap.querySelectorAll('input:checked')).map(i => i.value));
    const preselect = prevChecked.size > 0 ? prevChecked : new Set(match.onFieldIds.filter(id => eligible.includes(id)));
    wrap.innerHTML = eligible.map(pid => `
      <label class="modal__checkrow">
        <input type="checkbox" value="${pid}" ${preselect.has(pid) ? 'checked' : ''}>
        ${escapeHtml(playerLabel(pid))}
      </label>
    `).join('') || '<p style="font-size:12.5px;color:var(--ink-faint);margin:0;">Ei valittavissa olevia pelaajia (tarkista osallistujat ja maalivahti).</p>';
    document.getElementById('onfieldLabel').textContent = `Aloittava kokoonpano kentällä (valitse ${K})`;
  }

  if (!lockRoster){
    root.querySelectorAll('#participantChecklist input').forEach(cb => {
      cb.addEventListener('change', refreshGkAndField);
    });
    root.querySelector('#mGk').addEventListener('change', renderOnfieldChecklist);
    root.querySelector('#btnAutoFillField').addEventListener('click', () => {
      const participants = currentCheckedParticipants();
      const gk = root.querySelector('#mGk').value;
      const eligible = participants.filter(pid => pid !== gk);
      const K = state.settings.outfieldSlots;
      const wrap = root.querySelector('#onfieldChecklist');
      wrap.querySelectorAll('input').forEach((cb, idx) => { cb.checked = idx < K; });
    });
    refreshGkAndField();
  }

  root.querySelector('#btnCancelMatch').addEventListener('click', closeModal);
  const delBtn = root.querySelector('#btnDeleteMatch');
  if (delBtn){
    delBtn.addEventListener('click', () => {
      if (!confirm('Poistetaanko ottelu "' + (match.opponent || 'Nimetön ottelu') + '" pysyvästi?')) return;
      state.matches = state.matches.filter(m2 => m2.id !== match.id);
      if (state.activeMatchId === match.id) state.activeMatchId = state.matches[0] ? state.matches[0].id : null;
      saveState();
      closeModal();
      render();
    });
  }

  root.querySelector('#btnSaveMatch').addEventListener('click', () => {
    const opponent = root.querySelector('#mOpponent').value.trim();
    const kickoff = root.querySelector('#mKickoff').value;
    const periodsCount = Math.max(1, parseInt(root.querySelector('#mPeriods').value, 10) || 1);
    const periodMinutes = Math.max(1, parseInt(root.querySelector('#mPeriodMin').value, 10) || 20);
    const errEl = root.querySelector('#modalError');

    if (!opponent){
      errEl.textContent = 'Anna vastustajan nimi.';
      errEl.hidden = false;
      return;
    }

    match.opponent = opponent;
    match.kickoff = kickoff;
    match.periodsCount = periodsCount;
    match.periodMinutes = periodMinutes;

    if (!lockRoster){
      const participants = currentCheckedParticipants();
      const gk = root.querySelector('#mGk').value || null;
      const onField = Array.from(root.querySelectorAll('#onfieldChecklist input:checked')).map(i => i.value);

      if (participants.length === 0){
        errEl.textContent = 'Valitse ainakin yksi pelaaja mukaan otteluun.';
        errEl.hidden = false;
        return;
      }
      const K = Math.min(state.settings.outfieldSlots, participants.filter(id => id !== gk).length);
      if (K > 0 && onField.length !== K){
        errEl.textContent = 'Valitse tasan ' + K + ' pelaajaa aloittavaan kokoonpanoon (nyt valittu ' + onField.length + ').';
        errEl.hidden = false;
        return;
      }
      match.participantIds = participants;
      match.goalkeeperId = gk;
      match.onFieldIds = onField;
      participants.forEach(pid => ensureStat(match, pid));
    }

    if (isNew) state.matches.push(match);
    if (!state.activeMatchId) state.activeMatchId = match.id;
    saveState();
    closeModal();
    render();
  });
}

function closeModal(){
  document.getElementById('modalBackdrop').hidden = true;
  document.getElementById('modalRoot').innerHTML = '';
}

/* -------- Joukkue -------- */

function renderJoukkue(){
  const ul = document.getElementById('playerList');
  ul.innerHTML = '';
  if (state.roster.length === 0){
    ul.innerHTML = '<li class="empty-state">Ei pelaajia vielä — lisää joukkueen pelaajat yllä.</li>';
  }
  state.roster.forEach(p => {
    const li = document.createElement('li');
    li.className = 'playerrow';
    li.innerHTML = `
      <div class="playerrow__num">${p.number !== null && p.number !== undefined && p.number !== '' ? escapeHtml(String(p.number)) : '–'}</div>
      <div class="playerrow__name">${escapeHtml(p.name)}</div>
      <button class="btn--icon" title="Poista">✕</button>
    `;
    li.querySelector('button').addEventListener('click', () => {
      if (!confirm('Poistetaanko ' + p.name + ' joukkueesta? (Aiempien otteluiden tilastot säilyvät.)')) return;
      state.roster = state.roster.filter(p2 => p2.id !== p.id);
      saveState();
      renderJoukkue();
    });
    ul.appendChild(li);
  });

  document.getElementById('setOutfieldSlots').value = state.settings.outfieldSlots;
  document.getElementById('setSubGroupSize').value = state.settings.subGroupSize;
  document.getElementById('setTolerance').value = state.settings.toleranceMinutes;
}

/* -------- Tilastot -------- */

function renderTilastot(){
  const wrap = document.getElementById('statsContent');
  if (state.roster.length === 0 || state.matches.length === 0){
    wrap.innerHTML = '<p class="empty-state__body">Tilastot ilmestyvät kun joukkueessa on pelaajia ja vähintään yksi ottelu.</p>';
    return;
  }

  const totals = {};
  state.roster.forEach(p => { totals[p.id] = { field: 0, gk: 0, matches: 0 }; });
  state.matches.forEach(m => {
    const touched = new Set();
    Object.keys(m.stats).forEach(pid => {
      if (!totals[pid]) return;
      totals[pid].field += m.stats[pid].actualSeconds;
      totals[pid].gk += m.stats[pid].gkSeconds;
      if (m.stats[pid].actualSeconds > 0 || m.stats[pid].gkSeconds > 0) touched.add(pid);
    });
    touched.forEach(pid => totals[pid].matches += 1);
  });

  const maxTotal = Math.max(1, ...state.roster.map(p => totals[p.id].field + totals[p.id].gk));
  const avgTotal = state.roster.reduce((sum, p) => sum + totals[p.id].field + totals[p.id].gk, 0) / state.roster.length;

  const rows = [...state.roster].sort((a, b) => (totals[b.id].field + totals[b.id].gk) - (totals[a.id].field + totals[a.id].gk));

  let html = '<div class="statsblock"><h3>Yhteensä pelattu turnauksessa (kenttä + maalivahti)</h3>';
  rows.forEach(p => {
    const t = totals[p.id];
    const total = t.field + t.gk;
    const pct = (total / maxTotal) * 100;
    html += `
      <div class="statsrow">
        <div class="statsrow__num">${p.number !== null && p.number !== undefined && p.number !== '' ? escapeHtml(String(p.number)) : '–'}</div>
        <div>
          <div>${escapeHtml(p.name)}</div>
          <div class="statsrow__bar"><div class="statsrow__bar-fill" style="width:${pct}%"></div></div>
        </div>
        <div class="statsrow__val">${fmtMinutesShort(total)}${t.gk > 0 ? ' (mv ' + fmtMinutesShort(t.gk) + ')' : ''}</div>
      </div>
    `;
  });
  html += `<p class="statsavg">Keskiarvo: ${fmtMinutesShort(avgTotal)} · ${state.matches.length} ottelu(a) tallennettu</p></div>`;

  html += '<div class="statsblock"><h3>Ottelukohtainen erittely</h3>';
  state.matches.forEach(m => {
    html += `<details class="matchstat"><summary>${escapeHtml(m.opponent || 'Nimetön ottelu')} — ${fmtClock(m.timer.totalElapsedSeconds)}</summary><table>`;
    m.participantIds.forEach(pid => {
      const p = getPlayer(pid);
      if (!p) return;
      const s = m.stats[pid] || { actualSeconds: 0, gkSeconds: 0 };
      const roleNote = pid === m.goalkeeperId ? ' (mv)' : '';
      html += `<tr><td>${escapeHtml(p.name)}${roleNote}</td><td>${fmtMinutesShort(s.actualSeconds + s.gkSeconds)}</td></tr>`;
    });
    html += '</table></details>';
  });
  html += '</div>';

  wrap.innerHTML = html;
}

/* ============================== events / init ============================== */

function switchTabButtons(){
  document.querySelectorAll('.tabbar__tab').forEach(el => {
    el.setAttribute('aria-selected', el.dataset.tab === currentTab ? 'true' : 'false');
  });
}

function initEvents(){
  document.querySelectorAll('.tabbar__tab').forEach(btn => {
    btn.addEventListener('click', () => {
      currentTab = btn.dataset.tab;
      render();
    });
  });

  document.getElementById('tournamentNameInput').value = state.tournamentName;
  document.getElementById('tournamentNameInput').addEventListener('input', (e) => {
    state.tournamentName = e.target.value;
    saveState();
  });

  document.querySelector('[data-action="go-ottelut"]').addEventListener('click', () => {
    currentTab = 'ottelut'; switchTabButtons(); render();
  });

  document.getElementById('activeMatchSelect').addEventListener('change', (e) => {
    state.activeMatchId = e.target.value;
    resetPendingSelection();
    saveState();
    renderPeli();
  });

  document.getElementById('btnStartPause').addEventListener('click', () => {
    const m = getActiveMatch(); if (m) startPause(m);
  });
  document.getElementById('btnNextPeriod').addEventListener('click', () => {
    const m = getActiveMatch(); if (m) nextPeriod(m);
  });
  document.getElementById('btnFinishMatch').addEventListener('click', () => {
    const m = getActiveMatch(); if (m) finishMatch(m);
  });
  document.getElementById('btnDoSub').addEventListener('click', () => {
    const m = getActiveMatch(); if (m) executeSub(m);
  });
  document.getElementById('gkSelect').addEventListener('change', (e) => {
    const m = getActiveMatch(); if (m) setGoalkeeper(m, e.target.value || null);
  });

  document.getElementById('btnNewMatch').addEventListener('click', () => openMatchModal(null));

  document.getElementById('addPlayerForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const numInput = document.getElementById('newPlayerNumber');
    const nameInput = document.getElementById('newPlayerName');
    const name = nameInput.value.trim();
    if (!name) return;
    state.roster.push({ id: uid('p'), number: numInput.value === '' ? null : parseInt(numInput.value, 10), name });
    saveState();
    numInput.value = ''; nameInput.value = '';
    renderJoukkue();
  });

  ['setOutfieldSlots', 'setSubGroupSize', 'setTolerance'].forEach(id => {
    document.getElementById(id).addEventListener('change', (e) => {
      const val = parseFloat(e.target.value);
      if (isNaN(val) || val <= 0) return;
      if (id === 'setOutfieldSlots') state.settings.outfieldSlots = Math.round(val);
      if (id === 'setSubGroupSize') state.settings.subGroupSize = Math.round(val);
      if (id === 'setTolerance') state.settings.toleranceMinutes = val;
      saveState();
      renderPeli();
    });
  });

  document.getElementById('btnExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = 'vaihtokoppi-varmuuskopio-' + stamp + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  document.getElementById('btnImport').addEventListener('click', () => {
    document.getElementById('importFile').click();
  });
  document.getElementById('importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try{
        const parsed = JSON.parse(reader.result);
        if (!parsed || !Array.isArray(parsed.roster) || !Array.isArray(parsed.matches)){
          alert('Tiedosto ei näytä olevan Vaihtokopin varmuuskopio.');
          return;
        }
        if (!confirm('Tuonti korvaa kaikki nykyiset tiedot. Jatketaanko?')) return;
        state = { ...defaultState(), ...parsed, settings: { ...defaultState().settings, ...(parsed.settings || {}) } };
        resetPendingSelection();
        saveState();
        render();
        alert('Tuonti onnistui.');
      }catch(err){
        alert('Tiedoston lukeminen epäonnistui: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  document.getElementById('btnReset').addEventListener('click', () => {
    if (!confirm('Nollataanko kaikki tiedot (joukkue, ottelut, tilastot)? Tätä ei voi perua.')) return;
    if (!confirm('Varmista vielä: kaikki poistuu pysyvästi. Jatketaanko?')) return;
    state = defaultState();
    resetPendingSelection();
    saveState();
    render();
  });
}

function init(){
  // ohjaa uusi käyttäjä luontevaan aloitusjärjestykseen: joukkue -> ottelut -> peli
  if (state.roster.length === 0){
    currentTab = 'joukkue';
  } else if (state.matches.length === 0){
    currentTab = 'ottelut';
  }
  switchTabButtons();
  initEvents();
  render();
}

document.addEventListener('DOMContentLoaded', init);
