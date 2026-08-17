import type { Candle, PatternResult, SignalStrength } from '@/types/domain';
import { superOrderBlocks } from '@/compute/indicators/super-order-block';
import { orderBlockStrength, detectImbalances } from '@/compute/indicators/order-block-strength';
import { supportResistance } from '@/compute/indicators/support-resistance';
import { macd } from '@/compute/indicators/macd';

export interface OBCResult extends PatternResult {
  targetZone?: number;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function strengthForConfidence(confidence: number): SignalStrength {
  if (confidence >= 0.75) return 'strong';
  if (confidence >= 0.5) return 'moderate';
  return 'weak';
}

const N_BARS = 12;
const MAX_FRESH_CANDLES = 3;

// Order Block Continuation: a fresh (1–3 candles) untested OB coincides with
// a |MACD histogram| extreme in the surrounding N bars, signalling momentum
// continuation away from the block.
export function detectOrderBlockContinuation(candles: Candle[]): OBCResult | null {
  if (candles.length < 30) return null;

  const blocks = superOrderBlocks(candles);
  const untestedBlocks = blocks.filter((b) => b.status === 'untested' || b.status === 'tested-hold');
  if (untestedBlocks.length === 0) return null;

  const last = candles[candles.length - 1];
  const closes = candles.map((c) => c.close);
  const { histogram } = macd(closes, 12, 26, 9);

  let bestResult: OBCResult | null = null;
  let bestConfidence = 0;

  for (const block of untestedBlocks) {
    const blockIdx = candles.findIndex((c) =>
      c.open === block.open && c.close === block.close && c.high === block.high && c.low === block.low,
    );
    if (blockIdx < 0) continue;

    const candlesSinceFormation = candles.length - 1 - blockIdx;
    if (candlesSinceFormation < 1 || candlesSinceFormation > MAX_FRESH_CANDLES) continue;

    const windowStart = Math.max(0, blockIdx - 1);
    const windowEnd = Math.min(histogram.length, windowStart + N_BARS);
    const windowAbs: number[] = [];
    for (let j = windowStart; j < windowEnd; j++) {
      if (histogram[j] !== null) windowAbs.push(Math.abs(histogram[j] as number));
    }
    if (windowAbs.length < 4) continue;

    const obHistIdx = Math.max(0, Math.min(windowAbs.length - 1, blockIdx - windowStart));
    const obHistValue = windowAbs[obHistIdx] ?? 0;
    const maxHist = Math.max(...windowAbs);
    const avgHist = windowAbs.reduce((a, b) => a + b, 0) / windowAbs.length;

    // OB formation bar's histogram must be the extreme (or within 80% of it)
    if (obHistValue < maxHist * 0.8) continue;

    const confidence = clamp01(avgHist > 0 ? obHistValue / (avgHist * 2) : 0.5);
    if (confidence <= bestConfidence) continue;

    const direction = block.direction === 'bullish' ? 'buy' : 'sell';
    const targetZone = findTargetZone(candles, direction, last.close);

    bestConfidence = confidence;
    bestResult = {
      name: 'order-block-continuation',
      direction,
      confidence,
      strength: strengthForConfidence(confidence),
      time: last.time,
      targetZone,
    };
  }

  return bestResult;
}

function findTargetZone(
  candles: Candle[],
  direction: 'buy' | 'sell',
  currentPrice: number,
): number | undefined {
  const candidates: number[] = [];

  const obZones = orderBlockStrength(candles);
  for (const z of obZones) {
    if (z.status === 'broken') continue;
    const level = direction === 'buy' ? z.high : z.low;
    if (direction === 'buy' && level > currentPrice) candidates.push(level);
    if (direction === 'sell' && level < currentPrice) candidates.push(level);
  }

  const fvgs = detectImbalances(candles);
  for (const f of fvgs) {
    if (f.filled) continue;
    const level = direction === 'buy' ? f.upper : f.lower;
    if (direction === 'buy' && level > currentPrice) candidates.push(level);
    if (direction === 'sell' && level < currentPrice) candidates.push(level);
  }

  const levels = supportResistance(candles);
  for (const l of levels) {
    if (direction === 'buy' && l.price > currentPrice) candidates.push(l.price);
    if (direction === 'sell' && l.price < currentPrice) candidates.push(l.price);
  }

  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) =>
    direction === 'buy'
      ? Math.abs(a - currentPrice) - Math.abs(b - currentPrice)
      : Math.abs(a - currentPrice) - Math.abs(b - currentPrice),
  );
  return candidates[0];
}
