import type { Candle } from '@/types/domain';
import { analyzeOBTouches, type OrderBlockStatus, type RejectionTouch } from './order-block-strength';

export interface SuperOrderBlock {
  open: number;
  close: number;
  high: number;
  low: number;
  direction: 'bullish' | 'bearish';
  mitigated: boolean;
  breaker: boolean;
  touchCount: number;
  rejections: RejectionTouch[];
  status: OrderBlockStatus;
  strengthScore: number;
}

export function superOrderBlocks(candles: Candle[], lookback: number = 100): SuperOrderBlock[] {
  if (candles.length < 10) return [];

  const slice = candles.slice(-lookback);
  const blocks: SuperOrderBlock[] = [];

  for (let i = 2; i < slice.length - 1; i += 1) {
    const previous = slice[i - 1];
    const current = slice[i];
    const next = slice[i + 1];
    const after = slice.slice(i + 2);

    const bullish = current.close < current.open && next.close > current.open && next.close > previous.high;
    const bearish = current.close > current.open && next.close < current.open && next.close < previous.low;

    if (bullish || bearish) {
      const direction = bullish ? 'bullish' : 'bearish';
      const analysis = analyzeOBTouches(after, direction, current.high, current.low);
      blocks.push({
        open: current.open, close: current.close, high: current.high, low: current.low,
        direction, mitigated: analysis.touchCount > 0, breaker: analysis.status === 'broken',
        touchCount: analysis.touchCount, rejections: analysis.rejections,
        status: analysis.status, strengthScore: analysis.strengthScore,
      });
    }
  }

  return blocks;
}
