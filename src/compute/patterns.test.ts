import { describe, it, expect } from 'vitest';
import { detectAllPatterns } from '@/compute/patterns';
import { detectHammer, detectDoji, detectShootingStar, detectInvertedHammer, detectHangingMan, detectMarubozuBullish, detectMarubozuBearish } from '@/compute/patterns/single';
import { detectBullishEngulfing, detectBearishEngulfing, detectBullishHarami, detectBearishHarami } from '@/compute/patterns/double';
import { detectMorningStar, detectEveningStar } from '@/compute/patterns/triple';
import { detectPinBar } from '@/compute/patterns/pin-bar';
import { detectInsideBar } from '@/compute/patterns/inside-bar';
import { detectMeanReversion } from '@/compute/patterns/mean-reversion';
import type { PatternContext } from '@/compute/patterns/pattern-context';
import type { Candle, FeatureName, MarketStructure, IndicatorSnapshot } from '@/types/domain';
import type { SmartMoneyResult } from '@/compute/indicators/smart-money';

function candle(
  time: number,
  open: number,
  close: number,
  high: number,
  low: number,
  volume = 100,
): Candle {
  return { time, open, high, low, close, volume };
}

const ALL: FeatureName[] = [];

const RANGE_STRUCTURE: MarketStructure = {
  trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false,
};

const UP_STRUCTURE: MarketStructure = {
  trend: 'up', bos: true, choch: false, swingHigh: 110, swingLow: 95, provisional: false,
};

const DOWN_STRUCTURE: MarketStructure = {
  trend: 'down', bos: true, choch: false, swingHigh: 110, swingLow: 95, provisional: false,
};

const EMPTY_SMART_MONEY: SmartMoneyResult = {
  orderBlocks: [], fvgs: [], rejectionBlocks: [], bosEvents: [],
};

const NO_INDICATORS: IndicatorSnapshot = {
  rsi: null, emaFast: null, emaSlow: null,
  macd: null, macdSignal: null, macdHistogram: null,
  atr: null, bollingerUpper: null, bollingerMiddle: null, bollingerLower: null,
  vwap: null, vwapIsProxyVolume: false,
  volumeProfilePoc: null, volumeProfilePocIsProxyVolume: false,
  meanReversionRsi: null, impulseVelocity: null,
};

function makeCtx(
  candles: Candle[],
  overrides: Partial<PatternContext> = {},
): PatternContext {
  return {
    candles,
    index: candles.length - 2,
    structure: UP_STRUCTURE,
    session: 'london',
    smartMoney: EMPTY_SMART_MONEY,
    indicators: NO_INDICATORS,
    ...overrides,
  };
}

// Build a bullish uptrend sequence: N rising candles, then a pattern candle, then a confirm candle
function uptrendCandles(patternCandle: Candle, confirmCandle: Candle, count = 6): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const base = 100 + i * 1.5;
    candles.push(candle(i, base, base + 1, base + 1.2, base - 0.3, 100));
  }
  candles.push(patternCandle);
  candles.push(confirmCandle);
  return candles;
}

function downtrendCandles(patternCandle: Candle, confirmCandle: Candle, count = 6): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const base = 120 - i * 1.5;
    candles.push(candle(i, base, base - 1, base + 0.3, base - 1.2, 100));
  }
  candles.push(patternCandle);
  candles.push(confirmCandle);
  return candles;
}

describe('detectAllPatterns', () => {
  it('returns empty for single candle', () => {
    expect(detectAllPatterns([candle(0, 1, 2, 2.5, 0.5)], ALL)).toEqual([]);
  });

  it('detects bullish engulfing', () => {
    const candles = [
      candle(0, 10, 8, 10.5, 7.5),
      candle(1, 7.5, 11, 11.5, 7),
    ];
    const patterns = detectAllPatterns(candles, ALL);
    expect(patterns.some((p) => p.name === 'bullish-engulfing')).toBe(true);
  });

  it('detects bearish engulfing', () => {
    const candles = [
      candle(0, 8, 10, 10.5, 7.5),
      candle(1, 11, 7.5, 11.5, 7),
    ];
    const patterns = detectAllPatterns(candles, ALL);
    expect(patterns.some((p) => p.name === 'bearish-engulfing')).toBe(true);
  });

  it('detects doji', () => {
    const candles = [
      candle(0, 10, 8, 10.5, 7.5),
      candle(1, 10, 10.01, 12, 8),
    ];
    const patterns = detectAllPatterns(candles, ALL);
    expect(patterns.some((p) => p.name === 'doji')).toBe(true);
  });

  it('detects hammer', () => {
    const candles = [
      candle(0, 10, 9, 10.5, 8),
      candle(1, 9, 9.5, 9.6, 7),
    ];
    const patterns = detectAllPatterns(candles, ALL);
    const hammer = patterns.find((p) => p.name === 'hammer');
    expect(hammer).toBeDefined();
    expect(hammer?.direction).toBe('buy');
  });

  it('filters out patterns not in activeFeatures', () => {
    const candles = [
      candle(0, 10, 8, 10.5, 7.5),
      candle(1, 7.5, 11, 11.5, 7),
    ];
    const patterns = detectAllPatterns(candles, ['doji'] as FeatureName[]);
    expect(patterns.some((p) => p.name === 'bullish-engulfing')).toBe(false);
    expect(patterns.some((p) => p.name === 'doji')).toBe(false);
  });
});

// ─── detectHammer (unchigned signature) ────────────────────────────

describe('detectHammer', () => {
  it('detects hammer with long lower wick', () => {
    const c = candle(0, 10, 10.5, 10.6, 8);
    const result = detectHammer(c);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('hammer');
    expect(result?.direction).toBe('buy');
  });

  it('returns null for non-hammer candle', () => {
    const c = candle(0, 10, 11, 11, 9.5);
    expect(detectHammer(c)).toBeNull();
  });
});

// ─── detectDoji (unchanged signature) ──────────────────────────────

describe('detectDoji', () => {
  it('detects doji when body is < 1% of range', () => {
    const c = candle(0, 10, 10.005, 11, 9);
    expect(detectDoji(c)).not.toBeNull();
  });

  it('returns null when body is too large', () => {
    const c = candle(0, 10, 11, 12, 9);
    expect(detectDoji(c)).toBeNull();
  });
});

// ─── detectShootingStar ────────────────────────────────────────────

describe('detectShootingStar', () => {
  it('detects shooting star with bullish context and confirmation', () => {
    // Pattern candle: small body in lower third, long upper wick (>=2x body), tiny lower wick (<=0.5x body)
    const pattern = candle(6, 112, 111, 116, 110.9, 200);
    const confirm = candle(7, 111, 109, 111.5, 108, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, { structure: { trend: 'up', bos: false, choch: true, swingHigh: 116, swingLow: 95, provisional: false } });
    const result = detectShootingStar(ctx);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('shooting-star');
    expect(result?.direction).toBe('sell');
    expect(result?.time).toBe(confirm.time);
  });

  it('returns null without preceding bullish impulse', () => {
    const pattern = candle(1, 112, 111, 116, 110.9, 150);
    const confirm = candle(2, 111, 109, 111.5, 108, 120);
    const candles = [
      candle(0, 110, 109, 111, 108),
      pattern,
      confirm,
    ];
    const ctx = makeCtx(candles, { structure: RANGE_STRUCTURE });
    expect(detectShootingStar(ctx)).toBeNull();
  });

  it('returns null in Asia session', () => {
    const pattern = candle(6, 112, 111, 116, 110.9, 200);
    const confirm = candle(7, 111, 109, 111.5, 108, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, { session: 'tokyo' });
    expect(detectShootingStar(ctx)).toBeNull();
  });

  it('returns null when next candle contradicts (bullish close)', () => {
    const pattern = candle(6, 112, 111, 116, 110.9, 200);
    const confirm = candle(7, 111, 117, 118, 110.5, 120); // bullish, closes above pattern high
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles);
    expect(detectShootingStar(ctx)).toBeNull();
  });
});

// ─── detectPinBar ──────────────────────────────────────────────────

describe('detectPinBar', () => {
  it('detects bullish pin bar near swing low with confirmation', () => {
    // Bullish pin bar: long lower wick, body in upper third
    const pattern = candle(6, 100, 100.5, 101, 94, 150);
    const confirm = candle(7, 100, 102, 102.5, 99.5, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, {
      structure: { ...UP_STRUCTURE, swingLow: 94 },
      indicators: { ...NO_INDICATORS, atr: 3 },
    });
    const result = detectPinBar(ctx);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('pin-bar');
    expect(result?.direction).toBe('buy');
  });

  it('detects bearish pin bar near swing high with confirmation', () => {
    // Bearish pin bar: long upper wick, body in lower third
    const pattern = candle(6, 110, 109.5, 116, 109, 150);
    const confirm = candle(7, 109, 107, 109.5, 106, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, {
      structure: { ...DOWN_STRUCTURE, swingHigh: 116 },
      indicators: { ...NO_INDICATORS, atr: 3 },
    });
    const result = detectPinBar(ctx);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('sell');
  });

  it('returns null without proximity to OB/FVG or swing level', () => {
    const pattern = candle(6, 100, 100.5, 101, 94, 150);
    const confirm = candle(7, 100, 102, 102.5, 99.5, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, {
      structure: { trend: 'range', bos: false, choch: false, swingHigh: 200, swingLow: 50, provisional: false },
      indicators: { ...NO_INDICATORS, atr: 1 },
    });
    expect(detectPinBar(ctx)).toBeNull();
  });

  it('returns null when body is too large', () => {
    const pattern = candle(6, 100, 103, 104, 99, 150); // body=3, range=5, body/range=0.6
    const confirm = candle(7, 103, 105, 106, 102, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, { structure: { ...UP_STRUCTURE, swingLow: 99 }, indicators: { ...NO_INDICATORS, atr: 3 } });
    expect(detectPinBar(ctx)).toBeNull();
  });

  it('returns null in Asia session', () => {
    const pattern = candle(6, 100, 100.5, 101, 94, 150);
    const confirm = candle(7, 100, 102, 102.5, 99.5, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, {
      structure: { ...UP_STRUCTURE, swingLow: 94 },
      indicators: { ...NO_INDICATORS, atr: 3 },
      session: 'sydney',
    });
    expect(detectPinBar(ctx)).toBeNull();
  });
});

// ─── detectHangingMan ──────────────────────────────────────────────

describe('detectHangingMan', () => {
  it('detects hanging man with uptrend, RSI >= 60, and confirmation', () => {
    // Hanging man: small body in upper third, long lower wick, small upper wick
    // Use choch=true to signal potential reversal (htfAlignment=0.75 for counter-trend)
    // Hanging man: body in upper third, long lower wick (>=2x body), tiny upper wick (<=0.5x body)
    const pattern = candle(6, 111.5, 112, 112.05, 108, 200);
    const confirm = candle(7, 111.5, 109, 112, 108, 120); // bearish close below pattern body
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, {
      structure: { trend: 'up', bos: false, choch: true, swingHigh: 113, swingLow: 95, provisional: false },
      indicators: { ...NO_INDICATORS, rsi: 70 },
      session: 'overlap',
    });
    const result = detectHangingMan(ctx);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('hanging-man');
    expect(result?.direction).toBe('sell');
    expect(result?.confirmedByNextCandle).toBe(true);
  });

  it('returns null without confirmation candle', () => {
    const pattern = candle(6, 111.5, 112, 112.05, 108, 150);
    const confirm = candle(7, 111.5, 112, 113, 111, 120); // bullish close, no confirmation
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, {
      structure: UP_STRUCTURE,
      indicators: { ...NO_INDICATORS, rsi: 65 },
    });
    expect(detectHangingMan(ctx)).toBeNull();
  });

  it('returns null when RSI < 60 (if RSI available)', () => {
    const pattern = candle(6, 111.5, 112, 112.05, 108, 200);
    const confirm = candle(7, 111.5, 109, 112, 108, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, {
      structure: { trend: 'up', bos: false, choch: true, swingHigh: 113, swingLow: 95, provisional: false },
      indicators: { ...NO_INDICATORS, rsi: 45 },
    });
    expect(detectHangingMan(ctx)).toBeNull();
  });

  it('returns null in closed session', () => {
    const pattern = candle(6, 111.5, 112, 112.05, 108, 200);
    const confirm = candle(7, 111.5, 109, 112, 108, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, {
      structure: { trend: 'up', bos: false, choch: true, swingHigh: 113, swingLow: 95, provisional: false },
      indicators: { ...NO_INDICATORS, rsi: 65 },
      session: 'closed',
    });
    expect(detectHangingMan(ctx)).toBeNull();
  });
});

// ─── detectInvertedHammer ───────────────────────────────────────────

describe('detectInvertedHammer', () => {
  it('detects inverted hammer with downtrend, RSI <= 40, and confirmation', () => {
    // Inverted hammer: small body in lower third, long upper wick, small lower wick
    // Use choch=true to signal potential reversal (htfAlignment=0.75 for counter-trend)
    // Inverted hammer: body in lower third, long upper wick (>=2x body), tiny lower wick (<=0.5x body)
    const pattern = candle(6, 88, 88.5, 92, 88.45, 200);
    const confirm = candle(7, 88, 91, 92, 87.5, 120); // bullish close above pattern body
    const candles = downtrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, {
      structure: { trend: 'down', bos: false, choch: true, swingHigh: 110, swingLow: 87, provisional: false },
      indicators: { ...NO_INDICATORS, rsi: 25 },
      session: 'overlap',
    });
    const result = detectInvertedHammer(ctx);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('inverted-hammer');
    expect(result?.direction).toBe('buy');
    expect(result?.confirmedByNextCandle).toBe(true);
  });

  it('returns null without confirmation', () => {
    const pattern = candle(6, 88, 88.5, 92, 88.45, 150);
    const confirm = candle(7, 88, 86, 89, 85, 120); // bearish, no confirmation
    const candles = downtrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, {
      structure: DOWN_STRUCTURE,
      indicators: { ...NO_INDICATORS, rsi: 35 },
    });
    expect(detectInvertedHammer(ctx)).toBeNull();
  });

  it('returns null when RSI > 40 (if RSI available)', () => {
    const pattern = candle(6, 88, 88.5, 92, 88.45, 200);
    const confirm = candle(7, 88, 91, 92, 87.5, 120);
    const candles = downtrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, {
      structure: { trend: 'down', bos: false, choch: true, swingHigh: 110, swingLow: 87, provisional: false },
      indicators: { ...NO_INDICATORS, rsi: 50 },
    });
    expect(detectInvertedHammer(ctx)).toBeNull();
  });

  it('returns null without preceding bearish impulse', () => {
    const pattern = candle(1, 88, 88.5, 92, 88.45, 200);
    const confirm = candle(2, 88, 91, 92, 87.5, 120);
    const candles = [
      candle(0, 90, 92, 93, 89), // bullish
      pattern,
      confirm,
    ];
    const ctx = makeCtx(candles, {
      structure: RANGE_STRUCTURE,
      indicators: { ...NO_INDICATORS, rsi: 35 },
    });
    expect(detectInvertedHammer(ctx)).toBeNull();
  });
});

// ─── detectMarubozuBullish ─────────────────────────────────────────

describe('detectMarubozuBullish', () => {
  it('detects bullish marubozu with volume and trend', () => {
    // Marubozu: body >= 90% of range, tiny wicks, bullish
    const pattern = candle(6, 100, 106, 106.1, 99.9, 200);
    const confirm = candle(7, 106, 107, 108, 105, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, { structure: UP_STRUCTURE });
    const result = detectMarubozuBullish(ctx);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('marubozu-bullish');
    expect(result?.direction).toBe('buy');
    expect(result?.volumeConfirmed).toBe(true);
  });

  it('returns null in range without BOS/CHoCH', () => {
    const pattern = candle(6, 100, 106, 106.1, 99.9, 200);
    const confirm = candle(7, 106, 107, 108, 105, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, { structure: RANGE_STRUCTURE });
    expect(detectMarubozuBullish(ctx)).toBeNull();
  });

  it('returns null with volume below average', () => {
    const pattern = candle(6, 100, 106, 106.1, 99.9, 50); // low volume
    const confirm = candle(7, 106, 107, 108, 105, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, { structure: UP_STRUCTURE });
    expect(detectMarubozuBullish(ctx)).toBeNull();
  });

  it('returns null in Asia session', () => {
    const pattern = candle(6, 100, 106, 106.1, 99.9, 200);
    const confirm = candle(7, 106, 107, 108, 105, 120);
    const candles = uptrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, { structure: UP_STRUCTURE, session: 'tokyo' });
    expect(detectMarubozuBullish(ctx)).toBeNull();
  });
});

// ─── detectMarubozuBearish ─────────────────────────────────────────

describe('detectMarubozuBearish', () => {
  it('detects bearish marubozu with volume and downtrend', () => {
    const pattern = candle(6, 110, 104, 110.1, 103.9, 200);
    const confirm = candle(7, 104, 103, 105, 102, 120);
    const candles = downtrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, { structure: DOWN_STRUCTURE });
    const result = detectMarubozuBearish(ctx);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('marubozu-bearish');
    expect(result?.direction).toBe('sell');
  });

  it('returns null in range without BOS/CHoCH', () => {
    const pattern = candle(6, 110, 104, 110.1, 103.9, 200);
    const confirm = candle(7, 104, 103, 105, 102, 120);
    const candles = downtrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, { structure: RANGE_STRUCTURE });
    expect(detectMarubozuBearish(ctx)).toBeNull();
  });

  it('returns null with volume below average', () => {
    const pattern = candle(6, 110, 104, 110.1, 103.9, 50);
    const confirm = candle(7, 104, 103, 105, 102, 120);
    const candles = downtrendCandles(pattern, confirm);
    const ctx = makeCtx(candles, { structure: DOWN_STRUCTURE });
    expect(detectMarubozuBearish(ctx)).toBeNull();
  });
});

// ─── Existing double/triple pattern tests (unchanged) ──────────────

describe('detectBullishEngulfing', () => {
  it('detects bullish engulfing pattern', () => {
    const prev = candle(0, 10, 8, 10.5, 7.5);
    const cur = candle(1, 7, 11, 11.5, 6.5);
    const result = detectBullishEngulfing(prev, cur);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('buy');
  });

  it('confidence varies with body ratio', () => {
    const prev1 = candle(0, 10, 9, 10.5, 8.5);
    const cur1 = candle(1, 8, 12, 12.5, 7.5);
    const prev2 = candle(0, 10, 9.9, 10.5, 9.5);
    const cur2 = candle(1, 9.5, 11, 11.5, 9);
    const r1 = detectBullishEngulfing(prev1, cur1);
    const r2 = detectBullishEngulfing(prev2, cur2);
    expect(r1?.confidence).not.toBe(r2?.confidence);
  });
});

describe('detectBearishEngulfing', () => {
  it('detects bearish engulfing pattern', () => {
    const prev = candle(0, 8, 10, 10.5, 7.5);
    const cur = candle(1, 11, 7, 11.5, 6.5);
    const result = detectBearishEngulfing(prev, cur);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('sell');
  });
});

describe('detectBullishHarami', () => {
  it('detects bullish harami', () => {
    const prev = candle(0, 10, 7, 10.5, 6.5);
    const cur = candle(1, 7.5, 8, 8.5, 7);
    const result = detectBullishHarami(prev, cur);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('buy');
  });
});

describe('detectBearishHarami', () => {
  it('detects bearish harami', () => {
    const prev = candle(0, 7, 10, 10.5, 6.5);
    const cur = candle(1, 9, 8.5, 9.5, 8);
    const result = detectBearishHarami(prev, cur);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('sell');
  });
});

describe('detectMorningStar', () => {
  it('detects morning star after downtrend', () => {
    const candles: Candle[] = [
      candle(0, 25, 23, 25.5, 22.5),
      candle(1, 23, 21, 24, 20),
      candle(2, 21, 19, 22, 18),
      candle(3, 19, 17, 20, 16),
      candle(4, 17, 15, 18, 14),
      candle(5, 15, 12, 16, 11),
      candle(6, 12, 10, 13, 9),
      candle(7, 10.5, 10.8, 11.5, 10),
      candle(8, 11, 14, 14.5, 10.5),
    ];
    const result = detectMorningStar(candles);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('buy');
  });

  it('requires preceding downtrend', () => {
    const candles: Candle[] = [
      candle(0, 10, 12, 12.5, 9.5),
      candle(1, 12, 14, 14.5, 11.5),
      candle(2, 14, 16, 16.5, 13.5),
      candle(3, 16, 15, 17, 14.5),
      candle(4, 15, 13, 16, 12),
      candle(5, 13, 12.5, 14, 12),
      candle(6, 12.5, 16, 16.5, 12),
    ];
    const result = detectMorningStar(candles);
    expect(result).toBeNull();
  });
});

describe('detectEveningStar', () => {
  it('detects evening star after uptrend', () => {
    const candles: Candle[] = [
      candle(0, 8, 10, 10.5, 7.5),
      candle(1, 10, 12, 12.5, 9.5),
      candle(2, 12, 14, 14.5, 11.5),
      candle(3, 14, 16, 16.5, 13.5),
      candle(4, 16, 18, 18.5, 15.5),
      candle(5, 18, 20, 20.5, 17.5),
      candle(6, 20, 19.5, 21, 19),
      candle(7, 19.5, 15, 20, 14.5),
    ];
    const result = detectEveningStar(candles);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('sell');
  });
});

describe('detectInsideBar', () => {
  it('detects inside bar', () => {
    const prev = candle(0, 10, 12, 13, 9);
    const cur = candle(1, 10.5, 11, 11.5, 10);
    const result = detectInsideBar(prev, cur);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('inside-bar');
  });

  it('returns null when current exceeds previous range', () => {
    const prev = candle(0, 10, 12, 13, 9);
    const cur = candle(1, 10.5, 14, 14.5, 10);
    expect(detectInsideBar(prev, cur)).toBeNull();
  });
});

describe('detectMeanReversion', () => {
  it('does not conflict with SMC trend (BOS suppresses)', () => {
    const candles: Candle[] = Array.from({ length: 40 }, (_, i) => ({
      time: i,
      open: 100 + i * 2,
      high: 103 + i * 2,
      low: 99 + i * 2,
      close: 102 + i * 2,
      volume: 100,
    }));
    const snapshot = {
      rsi: 80, emaFast: 170, emaSlow: 160,
      macd: 10, macdSignal: 8, macdHistogram: 2,
      atr: 3, bollingerUpper: 180, bollingerMiddle: 150, bollingerLower: 120,
      vwap: null, vwapIsProxyVolume: false, volumeProfilePoc: null, volumeProfilePocIsProxyVolume: false,
      meanReversionRsi: null, impulseVelocity: null,
    };
    const result = detectMeanReversion(candles, snapshot, 80);
    expect(result).toBeNull();
  });
});
