// The explain output boundary's verdict vocabulary.
//
// core's classifyResims answers 'unavoidable' for a funds/reserve refusal; the replay benchmark
// calls that bucket 'excluded-funds'. Neither is renamed. The public surface normalises instead,
// so "unavoidable" on this site means exactly one thing: a same-block race.

import { describe, expect, it } from 'vitest';
import {
  isFundsRefusal,
  publicVerdict,
  withPublicVerdict,
} from '../apps/web/lib/verdict.js';

const resims = (o1: string, o2 = 'revert', o3 = 'revert') => [
  { k: 1, outcome: o1 },
  { k: 2, outcome: o2 },
  { k: 3, outcome: o3 },
];

describe('funds refusals are never shown as "unavoidable"', () => {
  it('maps the engine\'s unavoidable+funds to excluded-funds', () => {
    const e = { avoidableAt: 'unavoidable', avoidableClass: 'unavoidable', resims: resims('funds', 'funds', 'funds') };
    expect(isFundsRefusal(e)).toBe(true);
    expect(publicVerdict(e)).toBe('excluded-funds');
    expect(withPublicVerdict(e).avoidableAt).toBe('excluded-funds');
    expect(withPublicVerdict(e).avoidableClass).toBe('excluded-funds');
  });

  it('reads the re-simulation outcome, not the rationale text', () => {
    // No resims at all: nothing to misread, so it stays as the engine said.
    const e = { avoidableAt: 'unavoidable', avoidableClass: 'unavoidable' };
    expect(isFundsRefusal(e)).toBe(false);
    expect(publicVerdict(e)).toBe('unavoidable');
  });

  it('accepts an already-normalised label from an upstream', () => {
    expect(isFundsRefusal({ avoidableClass: 'excluded-funds' })).toBe(true);
  });
});

describe('"unavoidable" is reserved for same-block races', () => {
  it('a genuine same-block race keeps its own name', () => {
    const e = { avoidableAt: 'same-block', avoidableClass: 'same-block', resims: resims('success', 'success', 'success') };
    expect(publicVerdict(e)).toBe('same-block');
  });

  it('a true unavoidable verdict with no funds signal is left alone', () => {
    const e = { avoidableAt: 'unavoidable', avoidableClass: 'unavoidable', resims: resims('revert') };
    expect(publicVerdict(e)).toBe('unavoidable');
  });
});

describe('avoidable verdicts pass through untouched', () => {
  for (const k of ['N-1', 'N-2', 'N-3'] as const) {
    it(`${k} stays ${k}`, () => {
      expect(publicVerdict({ avoidableAt: k, avoidableClass: 'knowable', resims: resims('revert') })).toBe(k);
    });
  }

  it('a class name with no usable at-k is reported as unknown, not guessed', () => {
    expect(publicVerdict({ avoidableClass: 'knowable' })).toBe('unknown');
  });

  it('an unrecognised verdict never becomes a confident one', () => {
    expect(publicVerdict({ avoidableAt: 'something-new' })).toBe('unknown');
    expect(publicVerdict({})).toBe('unknown');
  });

  it('leaves every other field of the explanation alone', () => {
    const e = { avoidableAt: 'N-3', rationale: 'because', burnedWei: '123', resims: resims('revert') };
    const out = withPublicVerdict(e);
    expect(out.rationale).toBe('because');
    expect(out.burnedWei).toBe('123');
  });
});
