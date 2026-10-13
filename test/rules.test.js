// node test/rules.test.js  — checks bidding, trick and scoring rules.
'use strict';
const assert = require('assert');
const { Game, trickWinner, scoreRound } = require('../game');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ok -', name); };

function game(dealer = 3) {
  const events = [];
  const g = new Game({ emit: (e) => events.push(e), speed: 0, rng: () => 0.42 });
  g.dealer = dealer;
  g.start();
  g.dispose();
  return { g, events };
}

t('bidding starts left of the dealer', () => {
  const { g } = game(3);
  assert.strictEqual(g.turn, 0);
});

t('single bidder in first round wins after the dealer acts', () => {
  const { g } = game(3);
  g.placeBid(0, 0); g.placeBid(1, 8); g.placeBid(2, 0);
  assert.strictEqual(g.phase, 'bidding');
  g.placeBid(3, 0);
  assert.strictEqual(g.phase, 'trump');
  assert.strictEqual(g.bidder, 1);
  assert.strictEqual(g.bidValue, 8);
  assert.strictEqual(g.turn, 1);
});

t('must bid higher than the max so far', () => {
  const { g } = game(3);
  g.placeBid(0, 9);
  assert.ok(g.placeBid(1, 9));
  assert.ok(g.placeBid(1, 6));
  assert.strictEqual(g.placeBid(1, 10), null);
});

t('two bidders -> second round; highest wins when everyone before him passes', () => {
  const { g } = game(3);
  g.placeBid(0, 7); g.placeBid(1, 8); g.placeBid(2, 0); g.placeBid(3, 0);
  assert.strictEqual(g.phase, 'bidding');
  assert.strictEqual(g.turn, 0);
  g.placeBid(0, 0);
  assert.strictEqual(g.phase, 'trump');
  assert.strictEqual(g.bidder, 1);
});

t('second round raise continues the bidding', () => {
  const { g } = game(3);
  g.placeBid(0, 7); g.placeBid(1, 8); g.placeBid(2, 0); g.placeBid(3, 0);
  g.placeBid(0, 9);
  assert.strictEqual(g.turn, 1);
  g.placeBid(1, 0); g.placeBid(2, 0); g.placeBid(3, 0);
  assert.strictEqual(g.phase, 'trump');
  assert.strictEqual(g.bidder, 0);
  assert.strictEqual(g.bidValue, 9);
});

t('bid of 13 ends bidding at once', () => {
  const { g } = game(3);
  g.placeBid(0, 13);
  assert.strictEqual(g.phase, 'trump');
  assert.strictEqual(g.bidder, 0);
});

t('all pass -> bid again; all pass twice -> redeal with next dealer', () => {
  const { g, events } = game(3);
  for (const s of [0, 1, 2, 3]) g.placeBid(s, 0);
  assert.ok(events.some((e) => e.type === 'bid_again'));
  assert.strictEqual(g.phase, 'bidding');
  assert.strictEqual(g.turn, 0);
  for (const s of [0, 1, 2, 3]) g.placeBid(s, 0);
  assert.strictEqual(g.phase, 'redeal');
});

t('after an all-pass round, one bidder in the next round wins', () => {
  const { g } = game(3);
  for (const s of [0, 1, 2, 3]) g.placeBid(s, 0);
  g.placeBid(0, 0); g.placeBid(1, 0); g.placeBid(2, 7); g.placeBid(3, 0);
  assert.strictEqual(g.phase, 'trump');
  assert.strictEqual(g.bidder, 2);
});

t('highest bidder chooses trump and leads', () => {
  const { g } = game(3);
  g.placeBid(0, 0); g.placeBid(1, 8); g.placeBid(2, 0); g.placeBid(3, 0);
  assert.ok(g.chooseTrump(0, 'H'));
  assert.strictEqual(g.chooseTrump(1, 'H'), null);
  assert.strictEqual(g.phase, 'playing');
  assert.strictEqual(g.turn, 1);
});

t('must follow the led suit when possible', () => {
  const { g } = game(3);
  g.placeBid(0, 13); g.chooseTrump(0, 'S');
  g.hands = [['H5', 'S3'], ['H9', 'C2'], ['D4', 'S9'], ['H2', 'D8']];
  assert.strictEqual(g.play(0, 'H5'), null);
  assert.ok(g.play(1, 'C2'));             // has a heart
  assert.strictEqual(g.play(1, 'H9'), null);
  assert.strictEqual(g.play(2, 'S9'), null); // no hearts: any card
});

t('trick winner: highest of led suit, or highest trump', () => {
  assert.strictEqual(trickWinner([{ seat: 0, card: 'H5' }, { seat: 1, card: 'H14' }, { seat: 2, card: 'C14' }, { seat: 3, card: 'H2' }], 'S'), 1);
  assert.strictEqual(trickWinner([{ seat: 0, card: 'H5' }, { seat: 1, card: 'H14' }, { seat: 2, card: 'S2' }, { seat: 3, card: 'S3' }], 'S'), 3);
  assert.strictEqual(trickWinner([{ seat: 0, card: 'S5' }, { seat: 1, card: 'H14' }, { seat: 2, card: 'S12' }, { seat: 3, card: 'D3' }], 'S'), 2);
});

t('scoring', () => {
  assert.deepStrictEqual(scoreRound(0, 8, [9, 4]), { made: true, delta: [9, 0] });
  assert.deepStrictEqual(scoreRound(1, 8, [6, 7]), { made: false, delta: [0, -8] });
  assert.deepStrictEqual(scoreRound(1, 9, [7, 6]), { made: false, delta: [7, -9] });
  assert.deepStrictEqual(scoreRound(2, 13, [13, 0]), { made: true, delta: [26, 0] });
  assert.deepStrictEqual(scoreRound(3, 7, [6, 7]), { made: true, delta: [0, 7] });
});

console.log(`\n${passed} rule tests passed`);
