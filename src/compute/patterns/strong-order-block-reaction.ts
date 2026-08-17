import type { Candle, PatternResult, SignalStrength } from '@/types/domain';
import { superOrderBlocks } from '@/compute/indicators/super-order-block';

function strengthForConfidence(confidence: number): SignalStrength {
  if (confidence >= 0.75) return 'strong';
  if (confidence >= 0.5) return 'moderate';
  return 'weak';
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// Strong order block reaction: price returns to an active order block and reacts.
// Zones with status 'broken' are excluded; 'tested-hold' zones are the strongest bounce setups.
export function detectStrongOrderBlockReaction(candles: Candle[]): PatternResult | null {
  if (candles.length < 10) return null;

  const blocks = superOrderBlocks(candles);
  const activeBlocks = blocks.filter((b) => b.status !== 'broken');
  if (activeBlocks.length === 0) return null;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  let bestConfidence = 0;
  let bestResult: PatternResult | null = null;

  for (const block of activeBlocks) {
    if (block.direction === 'bullish') {
      if (prev.low <= block.high && last.close > block.high) {
        const baseConfidence = clamp01((block.high - block.low) / (last.high - last.low + 1e-9));
        const confidence = clamp01(baseConfidence * block.strengthScore);
        if (confidence > bestConfidence && confidence > 0.3) {
          bestConfidence = confidence;
          bestResult = {
            name: 'strong-order-block-reaction',
            direction: 'buy',
            confidence,
            strength: strengthForConfidence(confidence),
            time: last.time,
          };
        }
      }
    } else {
      if (prev.high >= block.low && last.close < block.low) {
        const baseConfidence = clamp01((block.high - block.low) / (last.high - last.low + 1e-9));
        const confidence = clamp01(baseConfidence * block.strengthScore);
        if (confidence > bestConfidence && confidence > 0.3) {
          bestConfidence = confidence;
          bestResult = {
            name: 'strong-order-block-reaction',
            direction: 'sell',
            confidence,
            strength: strengthForConfidence(confidence),
            time: last.time,
          };
        }
      }
    }
  }
  return bestResult;
}
