// chessEngine.js
// Pure chess-rules engine shared by the browser client and the Node server.
// No DOM, no I/O — safe to run in either environment.
(function (root) {
  'use strict';

  function initialBoard() {
    const b = Array.from({ length: 8 }, () => Array(8).fill(null));
    const back = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
    for (let f = 0; f < 8; f++) {
      b[0][f] = 'b' + back[f];
      b[1][f] = 'bP';
      b[6][f] = 'wP';
      b[7][f] = 'w' + back[f];
    }
    return b;
  }

  function initialState() {
    return {
      board: initialBoard(),
      turn: 'w',
      castling: { wK: true, wQ: true, bK: true, bQ: true },
      epTarget: null,        // [r,c] square a pawn can capture en passant onto
      halfmoveClock: 0,      // resets on pawn move / capture, 100 => 50-move rule draw
      history: [],
      capturedW: [],
      capturedB: [],
      lastMove: null,
      gameOver: false,
      result: ''
    };
  }

  function cloneState(s) {
    return {
      board: s.board.map(r => r.slice()),
      turn: s.turn,
      castling: Object.assign({}, s.castling),
      epTarget: s.epTarget ? [s.epTarget[0], s.epTarget[1]] : null,
      halfmoveClock: s.halfmoveClock,
      history: s.history.slice(),
      capturedW: s.capturedW.slice(),
      capturedB: s.capturedB.slice(),
      lastMove: s.lastMove ? { from: s.lastMove.from.slice(), to: s.lastMove.to.slice() } : null,
      gameOver: s.gameOver,
      result: s.result
    };
  }

  function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
  function color(p) { return p ? p[0] : null; }
  function type(p) { return p ? p[1] : null; }
  function sqName(r, c) { return 'abcdefgh'[c] + (8 - r); }

  // Raw (pseudo-legal) moves ignoring self-check, but including castling/en-passant candidates.
  function rawMoves(state, r, c) {
    const b = state.board, p = b[r][c];
    if (!p) return [];
    const col = color(p), t = type(p), moves = [];
    const push = (rr, cc, flags) => {
      if (!inBounds(rr, cc)) return;
      const target = b[rr][cc];
      if (!target) moves.push({ to: [rr, cc], flags: flags || {} });
      else if (color(target) !== col) moves.push({ to: [rr, cc], flags: Object.assign({ capture: true }, flags) });
    };
    const slide = (dirs) => {
      for (const [dr, dc] of dirs) {
        let rr = r + dr, cc = c + dc;
        while (inBounds(rr, cc)) {
          const target = b[rr][cc];
          if (!target) moves.push({ to: [rr, cc], flags: {} });
          else { if (color(target) !== col) moves.push({ to: [rr, cc], flags: { capture: true } }); break; }
          rr += dr; cc += dc;
        }
      }
    };

    if (t === 'P') {
      const dir = col === 'w' ? -1 : 1, start = col === 'w' ? 6 : 1, promoRank = col === 'w' ? 0 : 7;
      if (inBounds(r + dir, c) && !b[r + dir][c]) {
        moves.push({ to: [r + dir, c], flags: { promotion: r + dir === promoRank } });
        if (r === start && !b[r + 2 * dir][c]) moves.push({ to: [r + 2 * dir, c], flags: { doubleStep: true } });
      }
      for (const dc of [-1, 1]) {
        const rr = r + dir, cc = c + dc;
        if (!inBounds(rr, cc)) continue;
        if (b[rr][cc] && color(b[rr][cc]) !== col) {
          moves.push({ to: [rr, cc], flags: { capture: true, promotion: rr === promoRank } });
        } else if (state.epTarget && state.epTarget[0] === rr && state.epTarget[1] === cc) {
          moves.push({ to: [rr, cc], flags: { capture: true, enPassant: true } });
        }
      }
    } else if (t === 'N') {
      for (const [dr, dc] of [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]]) push(r + dr, c + dc);
    } else if (t === 'B') {
      slide([[-1, -1], [-1, 1], [1, -1], [1, 1]]);
    } else if (t === 'R') {
      slide([[-1, 0], [1, 0], [0, -1], [0, 1]]);
    } else if (t === 'Q') {
      slide([[-1, -1], [-1, 1], [1, -1], [1, 1], [-1, 0], [1, 0], [0, -1], [0, 1]]);
    } else if (t === 'K') {
      for (const dr of [-1, 0, 1]) for (const dc of [-1, 0, 1]) if (dr || dc) push(r + dr, c + dc);
      // Castling candidates (legality of squares/king-in-check checked by caller)
      const rights = state.castling;
      const row = col === 'w' ? 7 : 0;
      if (r === row && c === 4) {
        if ((col === 'w' ? rights.wK : rights.bK) && !b[row][5] && !b[row][6] && b[row][7] === col + 'R') {
          moves.push({ to: [row, 6], flags: { castle: 'K' } });
        }
        if ((col === 'w' ? rights.wQ : rights.bQ) && !b[row][1] && !b[row][2] && !b[row][3] && b[row][0] === col + 'R') {
          moves.push({ to: [row, 2], flags: { castle: 'Q' } });
        }
      }
    }
    return moves;
  }

  function findKing(board, col) {
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (board[r][c] === col + 'K') return [r, c];
    return null;
  }

  function isSquareAttacked(state, r, c, byColor) {
    for (let rr = 0; rr < 8; rr++) for (let cc = 0; cc < 8; cc++) {
      const p = state.board[rr][cc];
      if (p && color(p) === byColor) {
        // Use simple attack patterns (not castling) to avoid recursion issues.
        const t = type(p);
        if (t === 'P') {
          const dir = byColor === 'w' ? -1 : 1;
          if (rr + dir === r && (cc - 1 === c || cc + 1 === c)) return true;
          continue;
        }
        if (t === 'K') {
          if (Math.abs(rr - r) <= 1 && Math.abs(cc - c) <= 1 && (rr !== r || cc !== c)) return true;
          continue;
        }
        const moves = rawMoves(state, rr, cc);
        if (moves.some(m => m.to[0] === r && m.to[1] === c && !m.flags.castle)) return true;
      }
    }
    return false;
  }

  function inCheck(state, col) {
    const k = findKing(state.board, col);
    if (!k) return false;
    return isSquareAttacked(state, k[0], k[1], col === 'w' ? 'b' : 'w');
  }

  // Legal moves for one square: raw moves filtered to not leave own king in check,
  // with castling additionally requiring the king not pass through/land on an attacked square.
  function legalMovesFor(state, r, c) {
    const p = state.board[r][c];
    if (!p) return [];
    const col = color(p);
    const candidates = rawMoves(state, r, c);
    return candidates.filter(m => {
      if (m.flags.castle) {
        const row = r;
        const passSquares = m.flags.castle === 'K' ? [4, 5, 6] : [4, 3, 2];
        for (const cc of passSquares) if (isSquareAttacked(state, row, cc, col === 'w' ? 'b' : 'w')) return false;
        return true;
      }
      const after = simulateMove(state, [r, c], m.to, m.flags, 'Q');
      return !inCheck(after, col);
    });
  }

  function allLegalMoves(state, col) {
    const all = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = state.board[r][c];
      if (p && color(p) === col) {
        for (const m of legalMovesFor(state, r, c)) all.push({ from: [r, c], to: m.to, flags: m.flags });
      }
    }
    return all;
  }

  // Applies a move to a *clone* of the board/state fields relevant to check-testing only
  // (does not touch history/captures/turn) — used internally to test "does this leave me in check".
  function simulateMove(state, from, to, flags, promotion) {
    const s = cloneState(state);
    applyRaw(s, from, to, flags, promotion || 'Q');
    return s;
  }

  function applyRaw(s, from, to, flags, promotion) {
    const [r, c] = from, [rr, cc] = to;
    const p = s.board[r][c];
    const col = color(p);
    if (flags.enPassant) {
      s.board[r][cc] = null; // captured pawn is beside the destination, on the moving pawn's row
    }
    s.board[rr][cc] = p;
    s.board[r][c] = null;
    if (flags.promotion) {
      s.board[rr][cc] = col + (promotion || 'Q');
    }
    if (flags.castle) {
      const row = r;
      if (flags.castle === 'K') { s.board[row][5] = col + 'R'; s.board[row][7] = null; }
      else { s.board[row][3] = col + 'R'; s.board[row][0] = null; }
    }
  }

  // Full move application with bookkeeping: history, captures, castling rights, en passant target,
  // halfmove clock, turn flip, and end-of-game detection (checkmate / stalemate / draw rules).
  // promotion: 'Q'|'R'|'B'|'N' (defaults to Q if omitted)
  function applyMove(state, from, to, promotionPiece) {
    const s = cloneState(state);
    const [r, c] = from, [rr, cc] = to;
    const p = s.board[r][c];
    if (!p) return { ok: false, error: 'No piece on source square.' };
    const col = color(p);
    if (col !== s.turn) return { ok: false, error: 'Not that side\'s turn.' };

    const legal = legalMovesFor(s, r, c).find(m => m.to[0] === rr && m.to[1] === cc);
    if (!legal) return { ok: false, error: 'Illegal move.' };
    const flags = legal.flags;
    const promotion = flags.promotion ? (['Q', 'R', 'B', 'N'].includes(promotionPiece) ? promotionPiece : 'Q') : null;

    const capturedPiece = flags.enPassant ? (col === 'w' ? 'bP' : 'wP') : s.board[rr][cc];
    const isPawnMove = type(p) === 'P';
    const isCapture = !!flags.capture;

    let notation = (type(p) !== 'P' ? type(p) : '') + (isCapture ? 'x' : '') + sqName(rr, cc);
    if (flags.castle) notation = flags.castle === 'K' ? 'O-O' : 'O-O-O';
    if (promotion) notation += '=' + promotion;

    if (capturedPiece) (color(capturedPiece) === 'w' ? s.capturedW : s.capturedB).push(capturedPiece);

    applyRaw(s, from, to, flags, promotion);

    // Update castling rights
    if (type(p) === 'K') { if (col === 'w') { s.castling.wK = false; s.castling.wQ = false; } else { s.castling.bK = false; s.castling.bQ = false; } }
    if (type(p) === 'R') {
      if (col === 'w' && r === 7 && c === 0) s.castling.wQ = false;
      if (col === 'w' && r === 7 && c === 7) s.castling.wK = false;
      if (col === 'b' && r === 0 && c === 0) s.castling.bQ = false;
      if (col === 'b' && r === 0 && c === 7) s.castling.bK = false;
    }
    // Rook captured on its home square also revokes rights
    if (rr === 7 && cc === 0) s.castling.wQ = false;
    if (rr === 7 && cc === 7) s.castling.wK = false;
    if (rr === 0 && cc === 0) s.castling.bQ = false;
    if (rr === 0 && cc === 7) s.castling.bK = false;

    // En passant target for *next* move
    s.epTarget = flags.doubleStep ? [(r + rr) / 2, c] : null;

    // Halfmove clock (50-move rule)
    s.halfmoveClock = (isPawnMove || isCapture) ? 0 : s.halfmoveClock + 1;

    s.lastMove = { from: [r, c], to: [rr, cc] };
    s.turn = col === 'w' ? 'b' : 'w';

    const opp = s.turn;
    const oppMoves = allLegalMoves(s, opp);
    const oppInCheck = inCheck(s, opp);

    s.gameOver = false;
    s.result = '';
    if (oppMoves.length === 0) {
      s.gameOver = true;
      s.result = oppInCheck ? ((opp === 'w' ? 'Black' : 'White') + ' wins — checkmate') : 'Draw — stalemate';
      notation += oppInCheck ? '#' : '';
      if (!oppInCheck) notation += ' (stalemate)';
    } else if (oppInCheck) {
      notation += '+';
    } else if (s.halfmoveClock >= 100) {
      s.gameOver = true;
      s.result = 'Draw — 50-move rule';
    } else if (isInsufficientMaterial(s.board)) {
      s.gameOver = true;
      s.result = 'Draw — insufficient material';
    }

    s.history.push(notation);
    return { ok: true, state: s, notation, captured: capturedPiece || null };
  }

  function isInsufficientMaterial(board) {
    const pieces = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (board[r][c]) pieces.push(board[r][c]);
    if (pieces.length > 4) return false;
    const nonKing = pieces.filter(p => type(p) !== 'K');
    if (nonKing.length === 0) return true; // K vs K
    if (nonKing.length === 1 && (type(nonKing[0]) === 'B' || type(nonKing[0]) === 'N')) return true; // K+minor vs K
    if (nonKing.length === 2 && nonKing.every(p => type(p) === 'B') && color(nonKing[0]) !== color(nonKing[1])) {
      // K+B vs K+B of same-colored bishops is a draw; opposite-colored is not. Keep it simple: treat as not-forced-draw.
      return false;
    }
    return false;
  }

  const api = { initialState, cloneState, legalMovesFor, allLegalMoves, applyMove, inCheck, findKing, sqName };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChessEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
