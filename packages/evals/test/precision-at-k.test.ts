import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scorePrecisionAtK, scoreRecallAtK } from '../src/index.js';

// Known ranking + known relevant set, precision/recall computed by hand.
const ranking = ['a', 'b', 'c', 'd', 'e'];
const relevant = new Set(['a', 'c', 'e', 'z']); // |relevant| = 4

describe('scorePrecisionAtK', () => {
  it('computes precision over the top-k', () => {
    // top-3 = [a, b, c]; hits = {a, c} => matched 2, total min(3,5)=3
    const result = scorePrecisionAtK(ranking, relevant, 3);
    assert.equal(result.ok, true);
    assert.equal(result.matched, 2);
    assert.equal(result.total, 3);
    assert.equal(result.score, 2 / 3);
  });

  it('uses actual retrieved count as denominator when k > retrieved length', () => {
    // top-10 capped to [a,b,c,d,e]; hits = {a,c,e} => matched 3, total min(10,5)=5
    const result = scorePrecisionAtK(ranking, relevant, 10);
    assert.equal(result.ok, true);
    assert.equal(result.matched, 3);
    assert.equal(result.total, 5);
    assert.equal(result.score, 3 / 5);
  });

  it('counts distinct hits, ignoring duplicate ids', () => {
    // top-4 = [a, a, b, c]; distinct hits within top-k = {a, c} => matched 2
    const dupRanking = ['a', 'a', 'b', 'c', 'd'];
    const result = scorePrecisionAtK(dupRanking, relevant, 4);
    assert.equal(result.matched, 2);
    assert.equal(result.total, 4);
    assert.equal(result.score, 2 / 4);
  });

  it('is not well-formed when k <= 0', () => {
    assert.deepEqual(scorePrecisionAtK(ranking, relevant, 0), {
      ok: false,
      score: 0,
      matched: 0,
      total: 0,
    });
    assert.deepEqual(scorePrecisionAtK(ranking, relevant, -1), {
      ok: false,
      score: 0,
      matched: 0,
      total: 0,
    });
  });

  it('is not well-formed when nothing was retrieved (zero denominator)', () => {
    assert.deepEqual(scorePrecisionAtK([], relevant, 5), {
      ok: false,
      score: 0,
      matched: 0,
      total: 0,
    });
  });

  it('returns score 0 on zero hits but stays well-formed', () => {
    const result = scorePrecisionAtK(['x', 'y'], relevant, 2);
    assert.equal(result.ok, true);
    assert.equal(result.matched, 0);
    assert.equal(result.total, 2);
    assert.equal(result.score, 0);
  });
});

describe('scoreRecallAtK', () => {
  it('computes recall over the top-k against the full relevant set', () => {
    // top-3 = [a, b, c]; hits = {a, c} => matched 2, total |relevant|=4
    const result = scoreRecallAtK(ranking, relevant, 3);
    assert.equal(result.ok, true);
    assert.equal(result.matched, 2);
    assert.equal(result.total, 4);
    assert.equal(result.score, 2 / 4);
  });

  it('recovers more relevant ids as k grows', () => {
    // top-5 = all; hits = {a, c, e} => matched 3, total 4
    const result = scoreRecallAtK(ranking, relevant, 5);
    assert.equal(result.matched, 3);
    assert.equal(result.total, 4);
    assert.equal(result.score, 3 / 4);
  });

  it('counts distinct hits, ignoring duplicate ids', () => {
    const dupRanking = ['a', 'a', 'c', 'c'];
    const result = scoreRecallAtK(dupRanking, relevant, 4);
    assert.equal(result.matched, 2); // {a, c}
    assert.equal(result.total, 4);
    assert.equal(result.score, 2 / 4);
  });

  it('is not well-formed when k <= 0', () => {
    assert.deepEqual(scoreRecallAtK(ranking, relevant, 0), {
      ok: false,
      score: 0,
      matched: 0,
      total: 0,
    });
  });

  it('is not well-formed when the relevant set is empty (zero denominator)', () => {
    assert.deepEqual(scoreRecallAtK(ranking, new Set<string>(), 3), {
      ok: false,
      score: 0,
      matched: 0,
      total: 0,
    });
  });
});
