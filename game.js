// Whist game rules. Pure logic + timers; the room layer turns events into network messages.
//
// Seats 0..3 go clockwise around the table, so the player to your LEFT is (seat + 1) % 4.
// Teams: seats 0 & 2 are team 0, seats 1 & 3 are team 1 (partners face each other).
// Cards are strings: suit letter + rank, e.g. "H14" = ace of hearts, "C2" = two of clubs.
'use strict';

const SUITS = ['C', 'D', 'H', 'S']; // clubs, diamonds, hearts, spades
const TARGET = parseInt(process.env.WHIST_TARGET || '51', 10); // tests may lower it

// When bidding goes past the first round, may a player who passed earlier raise again?
// The rules say "another round of bidding with the same rules", so yes by default.
const PASSED_PLAYERS_CAN_REBID = true;

const left = (s) => (s + 1) % 4;
const teamOf = (s) => s % 2;
const suitOf = (c) => c[0];
const rankOf = (c) => parseInt(c.slice(1), 10);

function newDeck() {
  const d = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push(s + r);
  return d;
}

function shuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Sort a hand for display: suits alternate colours (S, H, C, D), high cards on the right.
const DISPLAY_ORDER = { S: 0, H: 1, C: 2, D: 3 };
function sortHand(h) {
  return h.slice().sort((a, b) => DISPLAY_ORDER[suitOf(a)] - DISPLAY_ORDER[suitOf(b)] || rankOf(a) - rankOf(b));
}

function trickWinner(trick, trump) {
  const lead = suitOf(trick[0].card);
  let best = trick[0];
  for (const p of trick.slice(1)) {
    const bs = suitOf(best.card), ps = suitOf(p.card);
    if (ps === bs) { if (rankOf(p.card) > rankOf(best.card)) best = p; }
    else if (ps === trump) best = p;           // first trump beats any non-trump
    // otherwise a discard: never wins
  }
  void lead;
  return best.seat;
}

function scoreRound(bidder, bid, tricks) {
  const bt = teamOf(bidder), dt = 1 - bt;
  const delta = [0, 0];
  const made = tricks[bt] >= bid;
  if (made) {
    delta[bt] = (bid === 13 && tricks[bt] === 13) ? 26 : tricks[bt];
  } else {
    delta[bt] = -bid;
    delta[dt] = tricks[dt] >= 7 ? tricks[dt] : 0;
  }
  return { made, delta };
}

class Game {
  /**
   * @param {object} o
   * @param {(ev:object)=>void} o.emit  called for every game event
   * @param {number} [o.speed=1]        multiplies pauses (tests use 0)
   * @param {()=>number} [o.rng]
   */
  constructor(o) {
    this.emit = o.emit;
    this.speed = o.speed ?? 1;
    this.rng = o.rng || Math.random;
    this.scores = [0, 0];
    this.dealer = Math.floor(this.rng() * 4);
    this.roundNo = 0;
    this.phase = 'idle';
    this.hands = [[], [], [], []];
    this.turn = -1;
    this.trick = [];
    this.tricks = [0, 0];
    this.bidder = -1;
    this.bidValue = 0;
    this.trump = null;
    this.lastRound = null;
    this.winnerTeam = -1;
    this.timers = new Set();
    this.resetBidding();
  }

  later(ms, fn) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms * this.speed);
    this.timers.add(t);
  }

  dispose() { for (const t of this.timers) clearTimeout(t); this.timers.clear(); }

  resetBidding() {
    this.bidding = {
      highest: 0, highSeat: -1,
      acted: 0,                 // actions in the current bidding round
      roundBidders: new Set(),  // seats that bid in the current round
      openingRound: true,       // still in the first round that contains a bid
      allPassRounds: 0,
      last: [null, null, null, null], // last action per seat: null, 0 = pass, 7..13
      passed: [false, false, false, false],
      round: 1,
    };
  }

  start() { this.startRound(); }

  startRound() {
    this.roundNo++;
    const deck = shuffle(newDeck(), this.rng);
    this.hands = [0, 1, 2, 3].map((i) => sortHand(deck.slice(i * 13, i * 13 + 13)));
    this.trick = [];
    this.tricks = [0, 0];
    this.bidder = -1;
    this.bidValue = 0;
    this.trump = null;
    this.resetBidding();
    this.phase = 'bidding';
    this.turn = left(this.dealer);
    this.emit({ type: 'deal', dealer: this.dealer, round: this.roundNo });
  }

  minBid() { return Math.max(7, this.bidding.highest + 1); }

  // value: 0 = pass, 7..13 = bid
  placeBid(seat, value) {
    if (this.phase !== 'bidding') return 'Not bidding now';
    if (seat !== this.turn) return 'Not your turn';
    value = value | 0;
    const b = this.bidding;
    if (value !== 0) {
      if (value < 7 || value > 13) return 'Bid must be 7 to 13';
      if (value <= b.highest) return `You must bid more than ${b.highest}`;
      if (!PASSED_PLAYERS_CAN_REBID && b.passed[seat]) return 'You already passed';
    }
    b.last[seat] = value;
    if (value === 0) b.passed[seat] = true;
    else { b.highest = value; b.highSeat = seat; b.roundBidders.add(seat); }
    b.acted++;
    this.emit({ type: 'bid', seat, value });

    if (value === 13) return this.finishBidding();

    let next = left(seat);
    // The highest bidder gets the turn back with everyone else having passed -> he wins.
    if (b.highSeat >= 0 && next === b.highSeat) return this.finishBidding();

    if (b.acted >= 4) {
      if (b.highSeat < 0) {
        b.allPassRounds++;
        if (b.allPassRounds >= 2) {
          // Nobody wanted it twice: collect the cards, next dealer deals again.
          this.phase = 'redeal';
          this.turn = -1;
          this.emit({ type: 'redeal' });
          this.later(2200, () => { this.dealer = left(this.dealer); this.startRound(); });
          return null;
        }
        b.acted = 0; b.round++;
        b.last = [null, null, null, null];
        this.emit({ type: 'bid_again' });
        next = left(this.dealer);
      } else if (b.openingRound && b.roundBidders.size === 1) {
        return this.finishBidding();
      } else {
        b.openingRound = false;
        b.acted = 0; b.round++;
        b.roundBidders = new Set();
      }
    }
    // Skip players who may not bid any more (only when re-bidding is disabled).
    if (!PASSED_PLAYERS_CAN_REBID && b.round > 1) {
      let guard = 0;
      while (b.passed[next] && next !== b.highSeat && guard++ < 4) next = left(next);
      if (next === b.highSeat) return this.finishBidding();
    }
    this.turn = next;
    this.emit({ type: 'turn' });
    return null;
  }

  finishBidding() {
    const b = this.bidding;
    this.bidder = b.highSeat;
    this.bidValue = b.highest;
    this.phase = 'trump';
    this.turn = this.bidder;
    this.emit({ type: 'bid_won', seat: this.bidder, value: this.bidValue });
    return null;
  }

  chooseTrump(seat, suit) {
    if (this.phase !== 'trump') return 'Not choosing the power suit now';
    if (seat !== this.bidder) return 'Only the highest bidder chooses';
    if (!SUITS.includes(suit)) return 'Unknown suit';
    this.trump = suit;
    this.phase = 'playing';
    this.turn = this.bidder; // the highest bidder leads the first play
    this.emit({ type: 'trump', suit, seat });
    return null;
  }

  legalCards(seat) {
    const hand = this.hands[seat];
    if (this.trick.length === 0) return hand.slice();
    const lead = suitOf(this.trick[0].card);
    const follow = hand.filter((c) => suitOf(c) === lead);
    return follow.length ? follow : hand.slice();
  }

  play(seat, card) {
    if (this.phase !== 'playing') return 'Not playing now';
    if (seat !== this.turn) return 'Not your turn';
    const hand = this.hands[seat];
    const i = hand.indexOf(card);
    if (i < 0) return 'You do not have that card';
    if (!this.legalCards(seat).includes(card)) return 'You must follow the suit that was led';
    hand.splice(i, 1);
    this.trick.push({ seat, card });
    this.emit({ type: 'play', seat, card });

    if (this.trick.length < 4) {
      this.turn = left(seat);
      this.emit({ type: 'turn' });
      return null;
    }
    const winner = trickWinner(this.trick, this.trump);
    this.tricks[teamOf(winner)]++;
    this.phase = 'trick_end';
    this.turn = -1;
    this.emit({ type: 'trick', winner, cards: this.trick.slice() });
    this.later(1500, () => {
      this.trick = [];
      if (this.hands[0].length === 0) return this.endRound();
      this.phase = 'playing';
      this.turn = winner; // winner of the play starts the next one
      this.emit({ type: 'turn' });
    });
    return null;
  }

  endRound() {
    const { made, delta } = scoreRound(this.bidder, this.bidValue, this.tricks);
    this.scores[0] += delta[0];
    this.scores[1] += delta[1];
    this.lastRound = {
      round: this.roundNo, bidder: this.bidder, bid: this.bidValue, trump: this.trump,
      tricks: this.tricks.slice(), delta, made, scores: this.scores.slice(),
    };
    this.phase = 'round_end';
    this.turn = -1;
    this.emit({ type: 'round_end', result: this.lastRound });

    const winner = this.scores.findIndex((s) => s >= TARGET);
    if (winner >= 0) {
      this.later(4500, () => {
        this.phase = 'game_over';
        this.winnerTeam = winner;
        this.emit({ type: 'game_over', team: winner, scores: this.scores.slice() });
      });
      return;
    }
    this.later(6500, () => { this.dealer = left(this.dealer); this.startRound(); });
  }

  // What one seat is allowed to see. seat = -1 for spectators.
  viewFor(seat) {
    const b = this.bidding;
    return {
      phase: this.phase,
      round: this.roundNo,
      dealer: this.dealer,
      turn: this.turn,
      seat,
      hand: seat >= 0 ? this.hands[seat].slice() : [],
      counts: this.hands.map((h) => h.length),
      legal: seat >= 0 && seat === this.turn && this.phase === 'playing' ? this.legalCards(seat) : [],
      bidding: { highest: b.highest, highSeat: b.highSeat, minBid: this.minBid(), last: b.last.slice(), round: b.round },
      bidder: this.bidder,
      bid: this.bidValue,
      trump: this.trump,
      trick: this.trick.slice(),
      tricks: this.tricks.slice(),
      scores: this.scores.slice(),
      target: TARGET,
      lastRound: this.lastRound,
      winnerTeam: this.winnerTeam,
    };
  }
}

module.exports = { Game, SUITS, TARGET, trickWinner, scoreRound, suitOf, rankOf, teamOf, left, sortHand };
