import type { Candle, PatternResult, SignalStrength } from '@/types/domain';
import { computeStructure } from '@/compute/indicators/trend-structure';
import { superOrderBlocks } from '@/compute/indicators/super-order-block';
import { macd } from '@/compute/indicators/macd';

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function strengthForConfidence(confidence: number): SignalStrength {
  if (confidence >= 0.75) return 'strong';
  if (confidence >= 0.5) return 'moderate';
  return 'weak';
}

const MIN_SERIES_LENGTH = 4;
const LOOKBACK_BARS = 15;

// MACD Deceleration in Medium Trend: after a sustained same-color histogram run
// that monotonically decays, a "pause" candle (small body) appears, then the
// histogram flips color — but the first bar of the new color is smaller in
// magnitude than the last bar of the old color. Signal direction follows the
// prevailing trend (continuation, not reversal).
export function detectMacdDecelerationContinuation(candles: Candle[]): PatternResult | null {
  if (candles.length < 35) return null;

  const closes = candles.map((c) => c.close);
  const { histogram } = macd(closes, 12, 26, 9);

  const struct = computeStructure(candles, LOOKBACK_BARS);
  if (struct.trend === 'range') return null;

  const direction: 'buy' | 'sell' = struct.trend === 'up' ? 'buy' : 'sell';

  const windowStart = Math.max(0, histogram.length - 15);
  const histWindow: (number | null)[] = histogram.slice(windowStart);

  const valid = histWindow.filter((h): h is number => h !== null);
  if (valid.length < MIN_SERIES_LENGTH + 2) return null;

  const lastIdx = histWindow.length - 1;
  const flipIdx = lastIdx - 1;
  if (flipIdx < MIN_SERIES_LENGTH) return null;

  const flipValue = histWindow[flipIdx];
  const lastValue = histWindow[lastIdx];
  if (flipValue === null || lastValue === null) return null;

  const flipSign = Math.sign(flipValue);
  const lastSign = Math.sign(lastValue);
  if (flipSign === 0 || lastSign === 0) return null;
  if (flipSign === lastSign) return null;

  // Last bar of the old (pre-flip) color series
  const oldSeries: number[] = [];
  for (let i = flipIdx - 1; i >= 0; i--) {
    const h = histWindow[i];
    if (h === null) break;
    if (Math.sign(h) === flipSign) break;
    oldSeries.unshift(h);
  }
  if (oldSeries.length < MIN_SERIES_LENGTH) return null;

  // Monotonically decaying magnitude (|h[i]| <= |h[i-1]|, allowing flat)
  for (let i = 1; i < oldSeries.length; i++) {
    if (Math.abs(oldSeries[i]) > Math.abs(oldSeries[i - 1])) return null;
  }

  // New color's first bar must be smaller in magnitude than old series' last bar
  if (Math.abs(flipValue) >= Math.abs(oldSeries[oldSeries.length - 1])) return null;

  // "Pause" candle: body smaller than 10-bar average body
  const pauseIdx = candles.length - 2;
  if (pauseIdx < 10) return null;
  const pauseCandle = candles[pauseIdx];
  const pauseBody = Math.abs(pauseCandle.close - pauseCandle.open);
  let avgBody = 0;
  for (let i = pauseIdx - 10; i < pauseIdx; i++) {
    avgBody += Math.abs(candles[i].close - candles[i].open);
  }
  avgBody /= 10;
  if (pauseBody >= avgBody) return null;

  let confidence = 0.4 + clamp01(Math.abs(lastValue) / (Math.abs(oldSeries[0]) + 1e-9)) * 0.15;
  confidence = clamp01(confidence);

  // Bonus if there's an unbroken OB/level in the trend direction
  const blocks = superOrderBlocks(candles);
  const last = candles[candles.length - 1];
  const hasTrendBlock = blocks.some((b) =>
    b.status !== 'broken' &&
    b.direction === (direction === 'buy' ? 'bullish' : 'bearish') &&
    Math.abs(last.close - (direction === 'buy' ? b.low : b.high)) <= (b.high - b.low) * 3,
  );
  if (hasTrendBlock) confidence = clamp01(confidence + 0.15);

  return {
    name: 'macd-deceleration-continuation',
    direction,
    confidence,
    strength: strengthForConfidence(confidence),
    time: last.time,
  };
}
