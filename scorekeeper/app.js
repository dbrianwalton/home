(function () {
  'use strict';

  var STORAGE_KEY = 'scorekeeper_data_v1';
  var PALETTE = ['#e63946','#f4a261','#2a9d8f','#264653','#e76f51','#457b9d','#8338ec','#3a86ff','#fb5607','#ff006e','#06a77d','#6a4c93','#c1121f','#118ab2','#ef476f','#06d6a0'];

  // ---------------- storage ----------------
  function defaultData() {
    return { version: 1, players: [], gameNames: [], gameHistory: [], activeGame: null };
  }

  function loadData() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultData();
      var parsed = JSON.parse(raw);
      var d = defaultData();
      d.players = Array.isArray(parsed.players) ? parsed.players : [];
      d.gameNames = Array.isArray(parsed.gameNames) ? parsed.gameNames : [];
      d.gameHistory = Array.isArray(parsed.gameHistory) ? parsed.gameHistory : [];
      d.activeGame = parsed.activeGame || null;
      d.players.forEach(function (p) {
        if (!p.stats) p.stats = {};
        if (typeof p.gamesPlayed !== 'number') p.gamesPlayed = 0;
        if (typeof p.archived !== 'boolean') p.archived = false;
        if (!p.color) p.color = PALETTE[0];
      });
      return d;
    } catch (e) {
      return defaultData();
    }
  }

  function saveData() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  var data = loadData();

  // ---------------- transient ui state ----------------
  var ui = {
    view: 'roster',
    rosterSort: { col: 'name', dir: 'asc' },
    showArchived: false,
    newGame: null,
    newGameSort: { col: 'name', dir: 'asc' },
    modal: null,
    lastResults: null,
    toast: null,
    scoreEditor: null
  };

  var dragState = null;

  // ---------------- utils ----------------
  function uid(prefix) {
    return prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function graphemes(str) {
    if (window.Intl && Intl.Segmenter) {
      try {
        return Array.from(new Intl.Segmenter().segment(str), function (s) { return s.segment; });
      } catch (e) {}
    }
    return Array.from(str);
  }

  function autoInitials(name) {
    var parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '';
    if (parts.length === 1) return graphemes(parts[0]).slice(0, 2).join('').toUpperCase();
    var first = graphemes(parts[0])[0] || '';
    var last = graphemes(parts[parts.length - 1])[0] || '';
    return (first + last).toUpperCase();
  }

  function displayInitials(str) {
    return graphemes(str || '').slice(0, 4).join('');
  }

  function nextColor() {
    return PALETTE[data.players.length % PALETTE.length];
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function getPlayer(id) {
    return data.players.filter(function (p) { return p.id === id; })[0];
  }

  function activePlayersList() {
    return data.players.filter(function (p) { return !p.archived; });
  }

  function ensureGameStats(player, gameName) {
    if (!player.stats[gameName]) player.stats[gameName] = { played: 0, won: 0 };
    return player.stats[gameName];
  }

  function resolveGameName(typed) {
    var t = (typed || '').trim();
    if (!t) return '';
    var existing = data.gameNames.filter(function (n) { return n.toLowerCase() === t.toLowerCase(); })[0];
    return existing || t;
  }

  function lastWinConditionForGame(name) {
    var matches = data.gameHistory.filter(function (g) { return g.gameName.toLowerCase() === name.toLowerCase() && g.winCondition; });
    if (matches.length) return matches[matches.length - 1].winCondition;
    return null;
  }

  function sortList(list, sort, thirdFn) {
    var col = sort.col, dir = sort.dir;
    var factor = dir === 'asc' ? 1 : -1;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (col === 'initials') { av = (a.initials || '').toLowerCase(); bv = (b.initials || '').toLowerCase(); }
      else if (col === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else { av = thirdFn(a); bv = thirdFn(b); }
      if (av < bv) return -1 * factor;
      if (av > bv) return 1 * factor;
      return a.name.localeCompare(b.name);
    });
  }

  function showToast(msg) {
    ui.toast = msg;
    render();
    setTimeout(function () { ui.toast = null; var t = document.querySelector('.toast'); if (t) t.remove(); }, 1800);
  }

  window.__scorekeeper_debug = { data: data, ui: ui };

  // ---------------- sort header helper ----------------
  function sortHeaderHtml(action, sort, cols) {
    // cols: [{key,label}]
    return '<div class="sort-row">' + cols.map(function (c) {
      var active = sort.col === c.key;
      var arrow = active ? (sort.dir === 'asc' ? '▲' : '▼') : '';
      return '<button data-action="' + action + '" data-col="' + c.key + '" class="' + (active ? 'active' : '') + '">' +
        esc(c.label) + (arrow ? ' <span class="sort-arrow">' + arrow + '</span>' : '') + '</button>';
    }).join('') + '</div>';
  }

  function avatarHtml(player, size) {
    var cls = size === 'sm' ? 'avatar' : 'avatar';
    var style = 'background:' + esc(player.color) + ';' + (size === 'sm' ? 'width:34px;height:34px;font-size:12px;' : '');
    return '<div class="' + cls + '" style="' + style + '">' + esc(displayInitials(player.initials)) + '</div>';
  }

  // ---------------- NEW GAME VIEW ----------------
  function thirdColForNewGame(p) {
    var resolved = resolveGameName(ui.newGame.gameNameInput);
    if (!resolved) return p.gamesPlayed;
    var st = p.stats[resolved];
    return st ? st.played : 0;
  }

  function statColLabel(p) {
    var resolved = resolveGameName(ui.newGame.gameNameInput);
    if (!resolved) return '<b>' + p.gamesPlayed + '</b>';
    var st = p.stats[resolved] || { played: 0, won: 0 };
    return '<b>' + st.played + '</b>/' + st.won;
  }

  function renderNewGame() {
    var ng = ui.newGame;
    var candidates = activePlayersList();
    var sorted = sortList(candidates, ui.newGameSort, thirdColForNewGame);

    var pickRows = sorted.map(function (p) {
      var selected = ng.activeIds.indexOf(p.id) !== -1;
      return '<div class="roster-pick-row ' + (selected ? 'selected' : '') + '" data-action="toggle-active-player" data-player-id="' + p.id + '">' +
        avatarHtml(p) +
        '<div class="player-name">' + esc(p.name) + '</div>' +
        '<div class="stat-col">' + statColLabel(p) + '<span data-insert-handle data-player-id="' + p.id + '" style="display:inline-block;margin-left:8px;color:var(--text-dim);touch-action:none;">⠿</span></div>' +
        '</div>';
    }).join('');

    var activeRows = ng.activeIds.length === 0
      ? '<div class="empty-state">No players selected. Tap or drag players below to add them.</div>'
      : ng.activeIds.map(function (pid, idx) {
        var p = getPlayer(pid);
        if (!p) return '';
        return '<div class="active-player-row" data-player-id="' + pid + '">' +
          '<span class="drag-handle" data-reorder-handle data-player-id="' + pid + '">☰</span>' +
          avatarHtml(p, 'sm') +
          '<div class="name">' + esc(p.name) + '</div>' +
          '<div class="arrows">' +
          '<button data-action="move-player-up" data-player-id="' + pid + '" ' + (idx === 0 ? 'disabled' : '') + '>▲</button>' +
          '<button data-action="move-player-down" data-player-id="' + pid + '" ' + (idx === ng.activeIds.length - 1 ? 'disabled' : '') + '>▼</button>' +
          '</div>' +
          '<button class="remove-btn" data-action="remove-active-player" data-player-id="' + pid + '">✕</button>' +
          '</div>';
      }).join('');

    var soloOrWin = ng.activeIds.length === 1
      ? '<div class="solo-note">Solo scoring — no win/loss stats will be tracked for this session.</div>'
      : '<div class="win-toggle">' +
        '<button data-action="set-win-condition" data-value="high" class="' + (ng.winCondition === 'high' ? 'selected' : '') + '">Highest score wins</button>' +
        '<button data-action="set-win-condition" data-value="low" class="' + (ng.winCondition === 'low' ? 'selected' : '') + '">Lowest score wins</button>' +
        '</div>';

    var canStart = ng.activeIds.length >= 1 && ng.gameNameInput.trim() !== '';

    var datalistOpts = data.gameNames.map(function (n) { return '<option value="' + esc(n) + '">'; }).join('');

    return '' +
      '<div class="header"><button class="back-btn" data-action="cancel-new-game">Cancel</button><h1>New Game</h1><div style="width:40px"></div></div>' +
      '<div class="scroll-area">' +
      '<div class="field" style="padding:14px 16px 0;">' +
      '<label>Game Name</label>' +
      '<input type="text" id="game-name-input" list="game-names-list" placeholder="e.g. Rummy" value="' + esc(ng.gameNameInput) + '">' +
      '<datalist id="game-names-list">' + datalistOpts + '</datalist>' +
      '</div>' +
      soloOrWin +
      '<div class="setup-section-title">Playing Order (' + ng.activeIds.length + ')</div>' +
      '<div class="active-players-panel">' + activeRows + '</div>' +
      '<div class="setup-section-title">Players</div>' +
      sortHeaderHtml('sort-newgame', ui.newGameSort, [{ key: 'initials', label: 'Initials' }, { key: 'name', label: 'Name' }, { key: 'gamesPlayed', label: ng.gameNameInput.trim() ? 'Played/Won' : 'Played' }]) +
      pickRows +
      '</div>' +
      '<div class="fab-wrap"><button class="btn" data-action="start-game" ' + (canStart ? '' : 'disabled') + '>Start Game</button></div>' +
      renderModal();
  }

  // ---------------- ACTIVE GAME VIEW ----------------
  function playerTotal(gp) {
    return gp.turns.reduce(function (s, v) { return s + (typeof v === 'number' ? v : 0); }, 0);
  }

  function scoreCellHtml(pid, round, value) {
    var se = ui.scoreEditor;
    var isActive = !!(se && se.playerId === pid && se.round === round);
    var has = typeof value === 'number';
    var display;
    if (isActive) {
      var typed = (se.negative ? '-' : '') + se.valueStr;
      display = se.valueStr === '' ? '_' : typed;
    } else {
      display = has ? value : '–';
    }
    var cls = 'score-cell' + (isActive ? ' editing' : (has ? '' : ' empty'));
    return '<td class="' + cls + '"><button data-action="open-score-editor" data-player-id="' + pid + '" data-round="' + round + '">' + display + '</button></td>';
  }

  function renderActiveGame() {
    var game = data.activeGame;
    var rounds = game.rounds;
    var horizontal = game.orientation === 'horizontal';

    var table;
    if (horizontal) {
      var headCells = game.players.map(function (gp) {
        var p = getPlayer(gp.playerId);
        return '<th><div class="th-player">' + avatarHtml(p, 'sm') + '<span class="pname">' + esc(p.name) + '</span></div></th>';
      }).join('');
      var bodyRows = '';
      for (var r = 0; r < rounds; r++) {
        bodyRows += '<tr><td class="row-head round-head-cell">R' + (r + 1) + '</td>' +
          game.players.map(function (gp) { return scoreCellHtml(gp.playerId, r, gp.turns[r]); }).join('') + '</tr>';
      }
      bodyRows += '<tr><td class="row-head"><button data-action="add-round">+ Round</button></td>' +
        game.players.map(function () { return '<td></td>'; }).join('') + '</tr>';
      var totalsRow = '<tr><td class="row-head total-cell">Total</td>' +
        game.players.map(function (gp) { return '<td class="score-cell total-cell">' + playerTotal(gp) + '</td>'; }).join('') + '</tr>';
      table = '<table class="score-table"><thead><tr><th class="row-head">Round</th>' + headCells + '</tr></thead><tbody>' + bodyRows + totalsRow + '</tbody></table>';
    } else {
      var roundHeads = '';
      for (var r2 = 0; r2 < rounds; r2++) roundHeads += '<th class="round-head-cell">R' + (r2 + 1) + '</th>';
      roundHeads += '<th><button data-action="add-round">+</button></th><th>Total</th>';
      var rows2 = game.players.map(function (gp) {
        var p = getPlayer(gp.playerId);
        var cells = '';
        for (var r3 = 0; r3 < rounds; r3++) cells += scoreCellHtml(gp.playerId, r3, gp.turns[r3]);
        return '<tr><td class="row-head"><div class="th-player" style="flex-direction:row;gap:6px;align-items:center;">' + avatarHtml(p, 'sm') + '<span class="pname" style="max-width:70px;">' + esc(p.name) + '</span></div></td>' +
          cells + '<td></td><td class="score-cell total-cell">' + playerTotal(gp) + '</td></tr>';
      }).join('');
      table = '<table class="score-table"><thead><tr><th class="row-head">Player</th>' + roundHeads + '</tr></thead><tbody>' + rows2 + '</tbody></table>';
    }

    return '' +
      '<div class="header"><button class="back-btn" data-action="back-to-roster">Roster</button><h1 style="font-size:15px;">' + esc(game.gameName) + '</h1>' +
      '<button class="icon-btn" data-action="end-game" style="background:var(--danger);color:#fff;">■</button></div>' +
      '<div class="game-toolbar"><span class="round-label">Round ' + rounds + (game.winCondition ? (' · ' + (game.winCondition === 'high' ? 'High wins' : 'Low wins')) : ' · Solo') + '</span>' +
      '<div class="orientation-toggle">' +
      '<button data-action="set-orientation" data-value="horizontal" class="' + (horizontal ? 'selected' : '') + '">Horiz</button>' +
      '<button data-action="set-orientation" data-value="vertical" class="' + (!horizontal ? 'selected' : '') + '">Vert</button>' +
      '</div></div>' +
      '<div class="scroll-area score-table-wrap">' + table + '</div>' +
      keypadBarHtml() +
      renderModal();
  }

  function keypadBarHtml() {
    var se = ui.scoreEditor;
    if (!se) return '';
    var p = getPlayer(se.playerId);
    var display = (se.negative ? '-' : '') + (se.valueStr === '' ? '0' : se.valueStr);
    var digitBtn = function (d) { return '<button data-action="score-digit" data-digit="' + d + '">' + d + '</button>'; };
    var grid = digitBtn(1) + digitBtn(2) + digitBtn(3) +
      digitBtn(4) + digitBtn(5) + digitBtn(6) +
      digitBtn(7) + digitBtn(8) + digitBtn(9) +
      '<button data-action="score-toggle-sign" class="' + (se.negative ? 'selected-toggle' : '') + '">+/–</button>' +
      digitBtn(0) +
      '<button data-action="score-backspace">⌫</button>';
    return '<div class="keypad-bar">' +
      '<div class="keypad-bar-header"><span>' + esc(p ? p.name : '') + ' · Round ' + (se.round + 1) + '</span><span class="live-value">' + display + (se.valueStr === '' ? ' <span style="font-size:11px;font-weight:400;color:var(--text-dim);">(scratch)</span>' : '') + '</span></div>' +
      '<div class="keypad-bar-grid">' + grid + '</div>' +
      '<div class="keypad-bar-actions">' +
      '<button class="scratch-btn" data-action="score-clear">Clear</button>' +
      '<button class="done-btn" data-action="score-done">Done</button>' +
      '</div></div>';
  }

  // ---------------- RESULTS VIEW ----------------
  function renderResults() {
    var res = ui.lastResults;
    var rowsHtml = res.rows.slice().sort(function (a, b) {
      if (res.solo) return 0;
      return a.rank - b.rank;
    }).map(function (r) {
      var p = getPlayer(r.playerId);
      var isWinner = res.winnerIds.indexOf(r.playerId) !== -1;
      return '<div class="result-row ' + (isWinner ? 'winner' : '') + '">' +
        '<div class="result-rank">' + (res.solo ? '' : '#' + r.rank) + '</div>' +
        avatarHtml(p) +
        '<div style="flex:1"><div class="player-name">' + esc(p.name) + (isWinner ? ' <span class="trophy">🏆</span>' : '') + '</div></div>' +
        '<div class="result-score">' + r.total + '</div>' +
        '</div>';
    }).join('');

    return '' +
      '<div class="header"><h1>Final Results</h1><div style="width:40px"></div></div>' +
      '<div class="scroll-area"><div class="results-list">' + rowsHtml + '</div></div>' +
      '<div class="fab-wrap"><button class="btn" data-action="results-done">Done</button></div>';
  }

  // ---------------- MODALS ----------------
  function colorGridHtml(selectedColor) {
    return '<div class="color-grid">' + PALETTE.map(function (c) {
      return '<button class="color-swatch ' + (c === selectedColor ? 'selected' : '') + '" data-color="' + c + '" style="background:' + c + ';" data-action="pick-color"></button>';
    }).join('') + '</div>';
  }

  function renderModal() {
    var m = ui.modal;
    if (!m) return '';

    if (m.type === 'addPlayer' || m.type === 'editPlayer') {
      var isEdit = m.type === 'editPlayer';
      var player = isEdit ? getPlayer(m.playerId) : null;
      var name = isEdit ? player.name : '';
      var initials = isEdit ? player.initials : '';
      var color = isEdit ? player.color : nextColor();
      var statsHtml = '';
      if (isEdit) {
        var keys = Object.keys(player.stats);
        statsHtml = keys.length === 0 ? '<div class="field"><label>Game Stats</label><div class="player-sub">No games played yet.</div></div>' :
          '<div class="field"><label>Game Stats (Played / Won)</label><div class="stat-detail-list">' +
          keys.map(function (k) {
            var s = player.stats[k];
            return '<div class="stat-detail-row"><span class="gname">' + esc(k) + '</span><span class="gnums">' + s.played + ' / ' + s.won + '</span></div>';
          }).join('') + '</div></div>';
      }
      return '<div class="modal-backdrop" data-action="close-modal-backdrop"><div class="modal">' +
        '<h2>' + (isEdit ? 'Edit Player' : 'Add Player') + '</h2>' +
        '<div class="field"><label>Name</label><input type="text" id="player-name-input" value="' + esc(name) + '" placeholder="Player name" autocomplete="off"></div>' +
        '<div class="field"><label>Initials (emoji ok)</label><input type="text" id="player-initials-input" value="' + esc(initials) + '" placeholder="AB" autocomplete="off"></div>' +
        '<div class="field"><label>Color</label>' + colorGridHtml(color) + '</div>' +
        statsHtml +
        (isEdit ? '<div class="field"><button class="btn ' + (player.archived ? '' : 'secondary') + '" data-action="toggle-archive-player" data-player-id="' + player.id + '">' + (player.archived ? 'Unarchive Player' : 'Archive Player') + '</button></div>' : '') +
        '<div class="modal-actions">' +
        '<button class="btn secondary" data-action="close-modal">Cancel</button>' +
        '<button class="btn" data-action="' + (isEdit ? 'save-edit-player' : 'save-add-player') + '" data-player-id="' + (isEdit ? player.id : '') + '">Save</button>' +
        '</div></div></div>';
    }

    if (m.type === 'menu') {
      return '<div class="modal-backdrop" data-action="close-modal-backdrop"><div class="modal">' +
        '<h2>Menu</h2>' +
        '<div class="menu-list">' +
        '<button data-action="export-data">⬇️ Export Data</button>' +
        '<button data-action="import-data">⬆️ Import Data</button>' +
        '<button data-action="toggle-archived">' + (ui.showArchived ? '🙈 Hide Archived Players' : '👁 Show Archived Players') + '</button>' +
        '</div>' +
        '<div class="modal-actions" style="margin-top:14px;"><button class="btn secondary" data-action="close-modal">Close</button></div>' +
        '</div></div>';
    }

    return '';
  }

  // ---------------- MAIN RENDER ----------------
  function render() {
    var app = document.getElementById('app');
    var scrollEl = document.querySelector('.score-table-wrap');
    var savedScrollTop = scrollEl ? scrollEl.scrollTop : null;
    var savedScrollLeft = scrollEl ? scrollEl.scrollLeft : null;
    var html;
    if (ui.view === 'newGame') html = renderNewGame();
    else if (ui.view === 'activeGame') html = renderActiveGame();
    else if (ui.view === 'results') html = renderResults();
    else html = renderRoster();
    if (ui.toast) html += '<div class="toast">' + esc(ui.toast) + '</div>';
    app.innerHTML = html;
    if (savedScrollTop !== null) {
      var newScrollEl = document.querySelector('.score-table-wrap');
      if (newScrollEl) {
        newScrollEl.scrollTop = savedScrollTop;
        newScrollEl.scrollLeft = savedScrollLeft;
      }
    }
    afterRender();
  }

  function afterRender() {
    var nameInput = document.getElementById('player-name-input');
    var initialsInput = document.getElementById('player-initials-input');
    if (nameInput && initialsInput) {
      nameInput.addEventListener('input', function () {
        if (initialsInput.dataset.edited !== 'true') {
          initialsInput.value = autoInitials(nameInput.value);
        }
      });
      initialsInput.addEventListener('input', function () {
        initialsInput.dataset.edited = 'true';
      });
    }
    var gameNameInput = document.getElementById('game-name-input');
    if (gameNameInput) {
      gameNameInput.addEventListener('input', function () {
        ui.newGame.gameNameInput = gameNameInput.value;
        updateNewGameLiveBits();
      });
    }
  }

  function updateNewGameLiveBits() {
    // update stat columns without losing focus on the text field
    document.querySelectorAll('.roster-pick-row').forEach(function (row) {
      var pid = row.getAttribute('data-player-id');
      var p = getPlayer(pid);
      if (!p) return;
      var statCol = row.querySelector('.stat-col');
      var handle = statCol.querySelector('[data-insert-handle]');
      statCol.innerHTML = statColLabel(p) + (handle ? handle.outerHTML : '');
    });
    // auto-suggest win condition if user hasn't manually chosen one this session
    var ng = ui.newGame;
    if (!ng.winConditionTouched) {
      var resolved = resolveGameName(ng.gameNameInput);
      var suggestion = resolved ? lastWinConditionForGame(resolved) : null;
      ng.winCondition = suggestion || ng.winCondition || 'high';
      document.querySelectorAll('[data-action="set-win-condition"]').forEach(function (btn) {
        btn.classList.toggle('selected', btn.getAttribute('data-value') === ng.winCondition);
      });
    }
    var label = ng.gameNameInput.trim() ? 'Played/Won' : 'Played';
    var thirdHeaderBtn = document.querySelector('.sort-row button[data-col="gamesPlayed"]');
    if (thirdHeaderBtn) {
      var arrowSpan = thirdHeaderBtn.querySelector('.sort-arrow');
      thirdHeaderBtn.childNodes[0].nodeValue = label + ' ';
    }
    var startBtn = document.querySelector('[data-action="start-game"]');
    if (startBtn) startBtn.disabled = !(ng.activeIds.length >= 1 && ng.gameNameInput.trim() !== '');
  }

  // ---------------- ACTIONS ----------------
  function openAddPlayer() {
    ui.modal = { type: 'addPlayer' };
    render();
  }

  function openEditPlayer(id) {
    ui.modal = { type: 'editPlayer', playerId: id };
    render();
  }

  function saveAddPlayer() {
    var name = document.getElementById('player-name-input').value.trim();
    if (!name) { showToast('Name required'); return; }
    var initials = document.getElementById('player-initials-input').value.trim() || autoInitials(name);
    var color = (document.querySelector('.color-swatch.selected') || {}).getAttribute ? document.querySelector('.color-swatch.selected').getAttribute('data-color') : nextColor();
    var player = { id: uid('p'), name: name, initials: initials, color: color || nextColor(), archived: false, gamesPlayed: 0, stats: {} };
    data.players.push(player);
    saveData();
    ui.modal = null;
    render();
  }

  function saveEditPlayer(id) {
    var player = getPlayer(id);
    if (!player) return;
    var name = document.getElementById('player-name-input').value.trim();
    if (!name) { showToast('Name required'); return; }
    var initials = document.getElementById('player-initials-input').value.trim() || autoInitials(name);
    var colorEl = document.querySelector('.color-swatch.selected');
    player.name = name;
    player.initials = initials;
    if (colorEl) player.color = colorEl.getAttribute('data-color');
    saveData();
    ui.modal = null;
    render();
  }

  function toggleArchivePlayer(id) {
    var player = getPlayer(id);
    if (!player) return;
    player.archived = !player.archived;
    saveData();
    ui.modal = null;
    render();
  }

  function startNewGameFlow() {
    ui.newGame = { gameNameInput: '', winCondition: 'high', winConditionTouched: false, activeIds: [] };
    ui.newGameSort = { col: 'name', dir: 'asc' };
    ui.view = 'newGame';
    render();
  }

  function cancelNewGame() {
    if (ui.newGame.activeIds.length > 0) {
      if (!confirm('Discard this new game setup?')) return;
    }
    ui.newGame = null;
    ui.view = 'roster';
    render();
  }

  function toggleActivePlayer(id) {
    var idx = ui.newGame.activeIds.indexOf(id);
    if (idx === -1) ui.newGame.activeIds.push(id);
    else ui.newGame.activeIds.splice(idx, 1);
    render();
  }

  function movePlayer(id, dir) {
    var ids = ui.newGame.activeIds;
    var idx = ids.indexOf(id);
    var swapWith = idx + dir;
    if (swapWith < 0 || swapWith >= ids.length) return;
    var tmp = ids[idx]; ids[idx] = ids[swapWith]; ids[swapWith] = tmp;
    render();
  }

  function removeActivePlayer(id) {
    var ids = ui.newGame.activeIds;
    var idx = ids.indexOf(id);
    if (idx !== -1) ids.splice(idx, 1);
    render();
  }

  function startGame() {
    var ng = ui.newGame;
    var resolved = resolveGameName(ng.gameNameInput);
    if (!resolved || ng.activeIds.length === 0) return;
    if (data.gameNames.indexOf(resolved) === -1) data.gameNames.push(resolved);
    data.activeGame = {
      id: uid('g'),
      gameName: resolved,
      winCondition: ng.activeIds.length === 1 ? null : ng.winCondition,
      orientation: 'horizontal',
      rounds: 1,
      players: ng.activeIds.map(function (pid) { return { playerId: pid, turns: [] }; })
    };
    saveData();
    ui.newGame = null;
    ui.view = 'activeGame';
    render();
  }

  function resumeGame() {
    ui.view = 'activeGame';
    render();
  }

  function discardActiveGame() {
    if (!confirm('Discard this in-progress game? This cannot be undone.')) return;
    data.activeGame = null;
    saveData();
    render();
  }

  function backToRoster() {
    ui.view = 'roster';
    render();
  }

  function setOrientation(val) {
    data.activeGame.orientation = val;
    saveData();
    render();
  }

  function addRound() {
    data.activeGame.rounds += 1;
    saveData();
    render();
  }

  function editorStateFor(playerId, round) {
    var gp = data.activeGame.players.filter(function (g) { return g.playerId === playerId; })[0];
    var existing = gp.turns[round];
    return {
      playerId: playerId,
      round: round,
      valueStr: (typeof existing === 'number') ? String(Math.abs(existing)) : '',
      negative: (typeof existing === 'number') ? existing < 0 : false
    };
  }

  // Tapping a cell makes it the live-editing cell. The keypad stays docked at
  // the bottom (no open/close modal). Tapping a different cell commits the
  // current one first (see commitScoreEditor: untouched/empty is left blank).
  function openScoreEditor(playerId, round) {
    var se = ui.scoreEditor;
    if (se) {
      if (se.playerId === playerId && se.round === round) return; // already editing this cell
      commitScoreEditor();
    }
    ui.scoreEditor = editorStateFor(playerId, round);
    render();
  }

  function scoreDigit(d) {
    var se = ui.scoreEditor;
    if (!se || se.valueStr.length >= 7) return;
    se.valueStr = (se.valueStr === '0' ? '' : se.valueStr) + d;
    render();
  }

  function scoreBackspace() {
    var se = ui.scoreEditor;
    if (!se) return;
    se.valueStr = se.valueStr.slice(0, -1);
    render();
  }

  function scoreClear() {
    if (!ui.scoreEditor) return;
    ui.scoreEditor.valueStr = '';
    ui.scoreEditor.negative = false;
    render();
  }

  function scoreToggleSign() {
    if (!ui.scoreEditor) return;
    ui.scoreEditor.negative = !ui.scoreEditor.negative;
    render();
  }

  function commitScore(playerId, round, value) {
    var gp = data.activeGame.players.filter(function (g) { return g.playerId === playerId; })[0];
    if (!gp) return;
    if (value === null) delete gp.turns[round];
    else gp.turns[round] = value;
    saveData();
  }

  // Called whenever editing ends WITHOUT pressing Done (tapping a different
  // cell, navigating away, ending the game, etc). Nothing typed => the cell is
  // left blank/unset (no score recorded), so scores can be entered out of
  // order. Anything actually typed still gets saved.
  function commitScoreEditor() {
    var se = ui.scoreEditor;
    if (!se) return;
    if (se.valueStr === '') {
      commitScore(se.playerId, se.round, null);
    } else {
      var n = parseInt(se.valueStr, 10) * (se.negative ? -1 : 1);
      commitScore(se.playerId, se.round, n);
    }
    ui.scoreEditor = null;
  }

  // Finds the next player (same round) in playing order, for auto-advance
  // after Done. Returns null if the current player is last in the lineup.
  function nextPlayerInRound(playerId) {
    var players = data.activeGame.players;
    var idx = -1;
    for (var i = 0; i < players.length; i++) {
      if (players[i].playerId === playerId) { idx = i; break; }
    }
    if (idx === -1 || idx + 1 >= players.length) return null;
    return players[idx + 1];
  }

  // Explicit Done: unlike clicking away, an empty box here is a deliberate
  // scratch (0), and entry automatically advances to the next player's box
  // in the same round so a whole round can be typed in one pass.
  function scoreDone() {
    var se = ui.scoreEditor;
    if (!se) return;
    var n = se.valueStr === '' ? 0 : parseInt(se.valueStr, 10) * (se.negative ? -1 : 1);
    commitScore(se.playerId, se.round, n);
    var next = nextPlayerInRound(se.playerId);
    ui.scoreEditor = next ? editorStateFor(next.playerId, se.round) : null;
    render();
  }

  function computeResults(game) {
    var rows = game.players.map(function (gp) {
      return { playerId: gp.playerId, total: playerTotal(gp) };
    });
    if (!game.winCondition) return { solo: true, rows: rows, winnerIds: [] };
    var dir = game.winCondition === 'low' ? 1 : -1;
    var sorted = rows.slice().sort(function (a, b) { return dir * (a.total - b.total); });
    var rank = 1;
    var result = [];
    for (var i = 0; i < sorted.length; i++) {
      if (i > 0 && sorted[i].total !== sorted[i - 1].total) rank = i + 1;
      result.push({ playerId: sorted[i].playerId, total: sorted[i].total, rank: rank });
    }
    var winnerIds = result.filter(function (r) { return r.rank === 1; }).map(function (r) { return r.playerId; });
    return { solo: false, rows: result, winnerIds: winnerIds };
  }

  function endGame() {
    if (!confirm('End game and record final scores?')) return;
    var game = data.activeGame;
    var results = computeResults(game);
    game.players.forEach(function (gp) {
      var player = getPlayer(gp.playerId);
      if (!player) return;
      player.gamesPlayed += 1;
      var st = ensureGameStats(player, game.gameName);
      st.played += 1;
    });
    if (!results.solo) {
      results.winnerIds.forEach(function (pid) {
        var player = getPlayer(pid);
        if (player) ensureGameStats(player, game.gameName).won += 1;
      });
    }
    data.gameHistory.push({
      id: uid('h'),
      gameName: game.gameName,
      winCondition: game.winCondition,
      date: new Date().toISOString(),
      orientation: game.orientation,
      players: game.players.map(function (gp) {
        return { playerId: gp.playerId, turns: gp.turns.slice(), total: playerTotal(gp) };
      }),
      winnerIds: results.solo ? [] : results.winnerIds
    });
    ui.lastResults = { solo: results.solo, rows: results.rows, winnerIds: results.winnerIds };
    data.activeGame = null;
    saveData();
    ui.view = 'results';
    render();
  }

  function resultsDone() {
    ui.lastResults = null;
    ui.view = 'roster';
    render();
  }

  function exportData() {
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'scorekeeper-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Exported');
  }

  function importData() {
    document.getElementById('import-file-input').click();
  }

  function handleImportFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(reader.result);
        if (!parsed || !Array.isArray(parsed.players)) throw new Error('bad shape');
        if (!confirm('This will replace all existing data. Continue?')) return;
        var d = defaultData();
        d.players = parsed.players || [];
        d.gameNames = parsed.gameNames || [];
        d.gameHistory = parsed.gameHistory || [];
        d.activeGame = parsed.activeGame || null;
        d.players.forEach(function (p) {
          if (!p.stats) p.stats = {};
          if (typeof p.gamesPlayed !== 'number') p.gamesPlayed = 0;
          if (typeof p.archived !== 'boolean') p.archived = false;
          if (!p.color) p.color = PALETTE[0];
        });
        data = d;
        window.__scorekeeper_debug.data = data;
        saveData();
        ui.modal = null;
        ui.view = 'roster';
        render();
        showToast('Import complete');
      } catch (e) {
        alert('Invalid backup file.');
      }
    };
    reader.readAsText(file);
  }

  // ---------------- CLICK DELEGATION ----------------
  // Actions the docked score keypad owns; any other action, while a cell is
  // being edited, first commits the pending entry (empty => scratch 0) so
  // navigating away, ending the game, etc. never silently drops what you typed.
  var KEYPAD_OWNED_ACTIONS = ['score-digit', 'score-backspace', 'score-clear', 'score-toggle-sign', 'score-done'];

  function handleClick(e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var action = el.getAttribute('data-action');
    var pid = el.getAttribute('data-player-id');

    if (ui.scoreEditor && action !== 'open-score-editor' && KEYPAD_OWNED_ACTIONS.indexOf(action) === -1) {
      commitScoreEditor();
    }

    switch (action) {
      case 'open-add-player': openAddPlayer(); break;
      case 'open-edit-player': openEditPlayer(pid); break;
      case 'save-add-player': saveAddPlayer(); break;
      case 'save-edit-player': saveEditPlayer(pid); break;
      case 'toggle-archive-player': toggleArchivePlayer(pid); break;
      case 'pick-color':
        document.querySelectorAll('.color-swatch').forEach(function (s) { s.classList.remove('selected'); });
        el.classList.add('selected');
        break;
      case 'close-modal': ui.modal = null; ui.scoreEditor = null; render(); break;
      case 'close-modal-backdrop': if (e.target === el) { ui.modal = null; ui.scoreEditor = null; render(); } break;
      case 'open-menu': ui.modal = { type: 'menu' }; render(); break;
      case 'toggle-archived': ui.showArchived = !ui.showArchived; ui.modal = null; render(); break;
      case 'export-data': exportData(); break;
      case 'import-data': importData(); break;
      case 'sort-roster':
        toggleSort(ui.rosterSort, el.getAttribute('data-col'));
        render();
        break;
      case 'sort-newgame':
        toggleSort(ui.newGameSort, el.getAttribute('data-col'));
        render();
        break;
      case 'start-new-game-flow': startNewGameFlow(); break;
      case 'cancel-new-game': cancelNewGame(); break;
      case 'toggle-active-player': toggleActivePlayer(pid); break;
      case 'move-player-up': movePlayer(pid, -1); break;
      case 'move-player-down': movePlayer(pid, 1); break;
      case 'remove-active-player': removeActivePlayer(pid); break;
      case 'set-win-condition':
        ui.newGame.winCondition = el.getAttribute('data-value');
        ui.newGame.winConditionTouched = true;
        render();
        break;
      case 'start-game': startGame(); break;
      case 'resume-game': resumeGame(); break;
      case 'discard-active-game': discardActiveGame(); break;
      case 'back-to-roster': backToRoster(); break;
      case 'set-orientation': setOrientation(el.getAttribute('data-value')); break;
      case 'add-round': addRound(); break;
      case 'end-game': endGame(); break;
      case 'open-score-editor': openScoreEditor(pid, parseInt(el.getAttribute('data-round'), 10)); break;
      case 'score-digit': scoreDigit(el.getAttribute('data-digit')); break;
      case 'score-backspace': scoreBackspace(); break;
      case 'score-clear': scoreClear(); break;
      case 'score-toggle-sign': scoreToggleSign(); break;
      case 'score-done': scoreDone(); break;
      case 'results-done': resultsDone(); break;
    }
  }

  function toggleSort(sort, col) {
    if (sort.col === col) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
    else { sort.col = col; sort.dir = 'asc'; }
  }

  // ---------------- DRAG (reorder within active list / insert from roster) ----------------
  function positionGhost(ghost, x, y) {
    ghost.style.left = x + 'px';
    ghost.style.top = y + 'px';
  }

  function handlePointerDown(e) {
    var reorderHandle = e.target.closest('[data-reorder-handle]');
    var insertHandle = e.target.closest('[data-insert-handle]');
    if (reorderHandle) {
      e.preventDefault();
      beginDrag(reorderHandle.getAttribute('data-player-id'), e);
    } else if (insertHandle) {
      e.preventDefault();
      beginDrag(insertHandle.getAttribute('data-player-id'), e, true);
    }
  }

  function beginDrag(playerId, e, isInsert) {
    var player = getPlayer(playerId);
    if (!player) return;
    var ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.style.width = '44px';
    ghost.style.height = '44px';
    ghost.style.borderRadius = '50%';
    ghost.style.background = player.color;
    ghost.style.display = 'flex';
    ghost.style.alignItems = 'center';
    ghost.style.justifyContent = 'center';
    ghost.style.color = '#fff';
    ghost.style.fontWeight = '700';
    ghost.style.fontSize = '13px';
    ghost.textContent = displayInitials(player.initials);
    document.body.appendChild(ghost);
    positionGhost(ghost, e.clientX, e.clientY);
    dragState = { playerId: playerId, ghost: ghost };
    if (isInsert && ui.newGame.activeIds.indexOf(playerId) === -1) {
      ui.newGame.activeIds.push(playerId);
      render();
    }
  }

  function handlePointerMove(e) {
    if (!dragState) return;
    e.preventDefault();
    positionGhost(dragState.ghost, e.clientX, e.clientY);
    var panel = document.querySelector('.active-players-panel');
    if (!panel || !ui.newGame) return;
    var rows = Array.prototype.slice.call(panel.querySelectorAll('.active-player-row'));
    var otherRows = rows.filter(function (r) { return r.getAttribute('data-player-id') !== dragState.playerId; });
    var insertBeforeId = null;
    for (var i = 0; i < otherRows.length; i++) {
      var rect = otherRows[i].getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) {
        insertBeforeId = otherRows[i].getAttribute('data-player-id');
        break;
      }
    }
    var ids = ui.newGame.activeIds.filter(function (id) { return id !== dragState.playerId; });
    if (insertBeforeId) {
      var idx = ids.indexOf(insertBeforeId);
      ids.splice(idx, 0, dragState.playerId);
    } else {
      ids.push(dragState.playerId);
    }
    if (JSON.stringify(ids) !== JSON.stringify(ui.newGame.activeIds)) {
      ui.newGame.activeIds = ids;
      render();
    }
  }

  function handlePointerUp() {
    if (!dragState) return;
    dragState.ghost.remove();
    dragState = null;
  }

  // ---------------- INIT ----------------
  function init() {
    document.addEventListener('click', handleClick);
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('pointermove', handlePointerMove, { passive: false });
    document.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('pointercancel', handlePointerUp);
    var fileInput = document.getElementById('import-file-input');
    if (fileInput) {
      fileInput.addEventListener('change', function () {
        if (fileInput.files && fileInput.files[0]) handleImportFile(fileInput.files[0]);
        fileInput.value = '';
      });
    }
    render();
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function () {});
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ---------------- ROSTER VIEW ----------------
  function renderRoster() {
    var players = data.players.filter(function (p) { return ui.showArchived || !p.archived; });
    var sorted = sortList(players, ui.rosterSort, function (p) { return p.gamesPlayed; });

    var rows = sorted.map(function (p) {
      return '<div class="player-row" data-action="open-edit-player" data-player-id="' + p.id + '" style="' + (p.archived ? 'opacity:0.45' : '') + '">' +
        avatarHtml(p) +
        '<div><div class="player-name">' + esc(p.name) + '</div>' +
        (p.archived ? '<div class="player-sub">Archived</div>' : '') +
        '</div>' +
        '<div class="stat-col"><b>' + p.gamesPlayed + '</b></div>' +
        '</div>';
    }).join('');

    var body = players.length === 0
      ? '<div class="empty-state">No players yet.<br>Tap + to add your first player.</div>'
      : sortHeaderHtml('sort-roster', ui.rosterSort, [{ key: 'initials', label: 'Initials' }, { key: 'name', label: 'Name' }, { key: 'gamesPlayed', label: 'Played' }]) + rows;

    var activeGameBanner = '';
    var newGameBtn = '<button class="btn" data-action="start-new-game-flow">New Game</button>';
    if (data.activeGame) {
      activeGameBanner = '<button class="btn" data-action="resume-game" style="margin-bottom:8px;">Resume: ' + esc(data.activeGame.gameName) + ' · Round ' + data.activeGame.rounds + '</button>' +
        '<button class="btn ghost" data-action="discard-active-game" style="margin-bottom:0;">Discard In-Progress Game</button>';
      newGameBtn = '';
    }

    return '' +
      '<div class="header"><h1>Score Keeper</h1>' +
      '<div class="header-actions">' +
      '<button class="icon-btn primary" data-action="open-add-player">+</button>' +
      '<button class="icon-btn" data-action="open-menu">⋮</button>' +
      '</div></div>' +
      '<div class="scroll-area">' + body + '</div>' +
      '<div class="fab-wrap">' + activeGameBanner + newGameBtn + '</div>' +
      renderModal();
  }

})();

