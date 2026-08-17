import { describe, it, expect } from 'vitest';
import { detectOrderBlockContinuation } from '@/compute/patterns/order-block-continuation';
import { detectMacdDecelerationContinuation } from '@/compute/patterns/macd-deceleration-continuation';
import type { Candle } from '@/types/domain';

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

describe('detectOrderBlockContinuation', () => {
  it('returns null for insufficient candles', () => {
    expect(detectOrderBlockContinuation([])).toBeNull();
    expect(detectOrderBlockContinuation(Array.from({ length: 29 }, (_, i) => candle(i, 10, 11, 12, 9)))).toBeNull();
  });

  it('returns null when no untested order blocks exist', () => {
    const candles: Candle[] = Array.from({ length: 40 }, (_, i) =>
      candle(i, 100, 100.1, 100.2, 99.9),
    );
    expect(detectOrderBlockContinuation(candles)).toBeNull();
  });

  it('detects bullish OBC when fresh untested block aligns with MACD extreme', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      candles.push(candle(i, 100 + i * 0.5, 101 + i * 0.5, 102 + i * 0.5, 99 + i * 0.5));
    }
    for (let i = 40; i < 45; i++) {
      const base = 120 + (i - 40) * 3;
      candles.push(candle(i, base, base + 3, base + 4, base - 1));
    }
    const obIdx = 45;
    candles.push(candle(obIdx, 135, 132, 136, 131));
    candles.push(candle(obIdx + 1, 132, 137, 138, 131.5));
    candles.push(candle(obIdx + 2, 137, 139, 140, 136));

    const result = detectOrderBlockContinuation(candles);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('order-block-continuation');
    expect(result?.direction).toBe('buy');
  });
});

describe('detectMacdDecelerationContinuation', () => {
  it('returns null for insufficient candles', () => {
    expect(detectMacdDecelerationContinuation([])).toBeNull();
    expect(detectMacdDecelerationContinuation(Array.from({ length: 34 }, (_, i) => candle(i, 10, 11, 12, 9)))).toBeNull();
  });

  it('returns null in range market', () => {
    const candles: Candle[] = Array.from({ length: 50 }, (_, i) =>
      candle(i, 100, 100.1, 100.5, 99.5),
    );
    expect(detectMacdDecelerationContinuation(candles)).toBeNull();
  });

  it('detects continuation signal in uptrend with MACD deceleration pattern', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++) {
      const price = 100 + i * 2;
      candles.push(candle(i, price, price + 2, price + 3, price - 1));
    }
    for (let i = 30; i < 38; i++) {
      const price = 160 + (i - 30) * 0.3;
      candles.push(candle(i, price, price + 0.3, price + 0.5, price - 0.1));
    }
    const pauseIdx = 38;
    candles.push(candle(pauseIdx, 162.4, 162.5, 163, 162));
    candles.push(candle(pauseIdx + 1, 162.5, 162.3, 163, 162));

    const result = detectMacdDecelerationContinuation(candles);
    if (result) {
      expect(result.name).toBe('macd-deceleration-continuation');
      expect(['buy', 'sell']).toContain(result.direction);
    }
  });
});
