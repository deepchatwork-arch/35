import type { Candle } from '@/types/domain';

export interface RejectionTouch {
  time: number;
  wickRatio: number;
  closedBackOutside: boolean;
}

export type OrderBlockStatus = 'untested' | 'tested-hold' | 'broken';

export interface TouchAnalysis {
  touchCount: number;
  rejections: RejectionTouch[];
  status: OrderBlockStatus;
  strengthScore: number;
  breakTime: number | null;
}

export interface OrderBlockZone {
  open: number;
  close: number;
  high: number;
  low: number;
  direction: 'bullish' | 'bearish';
  mitigated: boolean;
  filled: boolean;
  time: number;
  endTime: number;
  touchCount: number;
  rejections: RejectionTouch[];
  status: OrderBlockStatus;
  strengthScore: number;
}

export function analyzeOBTouches(
  candles: Candle[],
  direction: 'bullish' | 'bearish',
  zoneHigh: number,
  zoneLow: number,
): TouchAnalysis {
  let touchCount = 0;
  let strengthScore = 0.5;
  let status: OrderBlockStatus = 'untested';
  let breakTime: number | null = null;
  const rejections: RejectionTouch[] = [];

  for (const candle of candles) {
    if (direction === 'bullish' && candle.close < zoneLow) {
      status = 'broken';
      breakTime = candle.time;
      break;
    }
    if (direction === 'bearish' && candle.close > zoneHigh) {
      status = 'broken';
      breakTime = candle.time;
      break;
    }

    const enteredZone = candle.low <= zoneHigh && candle.high >= zoneLow;
    if (!enteredZone) continue;

    touchCount += 1;
    const range = Math.max(candle.high - candle.low, Number.EPSILON);
    const wick = direction === 'bullish'
      ? Math.min(candle.open, candle.close) - candle.low
      : candle.high - Math.max(candle.open, candle.close);
    const wickRatio = Math.max(0, Math.min(1, wick / range));
    const closedBackOutside = direction === 'bullish'
      ? candle.close >= zoneHigh
      : candle.close <= zoneLow;

    rejections.push({ time: candle.time, wickRatio, closedBackOutside });
    if (!closedBackOutside) continue;

    status = 'tested-hold';
    if (wickRatio >= 0.5) {
      strengthScore = Math.min(1, strengthScore + 0.15 + 0.1 * touchCount);
    } else {
      strengthScore = Math.max(0.2, strengthScore - 0.1);
    }
  }

  return { touchCount, rejections, status, strengthScore, breakTime };
}

export function orderBlockStrength(candles: Candle[], lookback: number = 50): OrderBlockZone[] {
  if (candles.length < 5) return [];

  const slice = candles.slice(-lookback);
  const lastTime = slice[slice.length - 1].time;
  const zones: OrderBlockZone[] = [];

  for (let i = 1; i < slice.length - 1; i += 1) {
    const current = slice[i];
    const next = slice[i + 1];
    const after = slice.slice(i + 2);

    if (current.close < current.open && next.close > current.high) {
      const fvg = detectFVG(slice, i);
      const analysis = analyzeOBTouches(after, 'bullish', current.high, current.low);
      const filled = fvg !== null && after.some((candle) => candle.low <= fvg.lower);
      zones.push({
        open: current.open, close: current.close, high: current.high, low: current.low,
        direction: 'bullish', mitigated: analysis.touchCount > 0, filled,
        time: current.time, endTime: analysis.breakTime ?? lastTime,
        touchCount: analysis.touchCount, rejections: analysis.rejections,
        status: analysis.status, strengthScore: analysis.strengthScore,
      });
    }

    if (current.close > current.open && next.close < current.low) {
      const fvg = detectFVG(slice, i);
      const analysis = analyzeOBTouches(after, 'bearish', current.high, current.low);
      const filled = fvg !== null && after.some((candle) => candle.high >= fvg.upper);
      zones.push({
        open: current.open, close: current.close, high: current.high, low: current.low,
        direction: 'bearish', mitigated: analysis.touchCount > 0, filled,
        time: current.time, endTime: analysis.breakTime ?? lastTime,
        touchCount: analysis.touchCount, rejections: analysis.rejections,
        status: analysis.status, strengthScore: analysis.strengthScore,
      });
    }
  }

  return zones.filter((zone) => !zone.filled);
}

export interface ImbalanceZone {
  upper: number;
  lower: number;
  direction: 'bullish' | 'bearish';
  filled: boolean;
  time: number;
  endTime: number;
}

export function detectImbalances(candles: Candle[], lookback: number = 50): ImbalanceZone[] {
  if (candles.length < 3) return [];

  const slice = candles.slice(-lookback);
  const lastTime = slice[slice.length - 1].time;
  const zones: ImbalanceZone[] = [];

  for (let i = 0; i < slice.length - 2; i += 1) {
    const first = slice[i];
    const third = slice[i + 2];
    const startTime = slice[i + 1].time;

    if (third.low > first.high) {
      zones.push({ upper: third.low, lower: first.high, direction: 'bullish', filled: slice.slice(i + 3).some((c) => c.low <= first.high), time: startTime, endTime: lastTime });
    }
    if (third.high < first.low) {
      zones.push({ upper: first.low, lower: third.high, direction: 'bearish', filled: slice.slice(i + 3).some((c) => c.high >= first.low), time: startTime, endTime: lastTime });
    }
  }

  return zones.filter((zone) => !zone.filled);
}

interface FVG {
  upper: number;
  lower: number;
}

function detectFVG(candles: Candle[], index: number): FVG | null {
  if (index + 2 > candles.length - 1) return null;
  const first = candles[index];
  const third = candles[index + 2];
  if (third.low > first.high) return { upper: third.low, lower: first.high };
  if (third.high < first.low) return { upper: first.low, lower: third.high };
  return null;
}
