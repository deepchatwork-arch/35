import type {
  Candle,
  MarketStructure,
  IndicatorSnapshot,
  SignalDirection,
} from '@/types/domain';
import type { SessionRegime } from '@/compute/session-regime';
import type { SmartMoneyResult } from '@/compute/indicators/smart-money';

export interface PatternContext {
  candles: Candle[];
  index: number;
  structure: MarketStructure;
  session: SessionRegime;
  smartMoney: SmartMoneyResult;
  indicators: IndicatorSnapshot | undefined;
}

export function sessionBoost(session: SessionRegime): number {
  if (session === 'overlap') return 1.15;
  if (session === 'london' || session === 'newyork') return 1.05;
  return 0.7;
}

export function htfAlignment(structure: MarketStructure, direction: SignalDirection): number {
  // HTF approximation on 1M data — replace with real multi-timeframe fetch when available
  if (structure.bos && ((direction === 'buy' && structure.trend === 'up') || (direction === 'sell' && structure.trend === 'down'))) return 1.0;
  if (structure.choch) return 0.75;
  if (structure.trend === 'range') return 0.4;
  return 0.5;
}

export function volumeFactor(ratio: number): number {
  if (ratio > 1.5) return 1.15;
  if (ratio >= 1.0) return 1.05;
  return 0.85;
}

const ATR_PROXIMITY_MULTIPLIER = 1.5;
const FRESH_OB_MAX_AGE = 20;
const FRESH_FVG_MAX_AGE = 20;

export function intervalSeconds(candles: { time: number }[]): number {
  if (candles.length < 2) return 60;
  const diff = candles[1].time - candles[0].time;
  return diff > 0 ? diff : 60;
}

export function obFvgConfluenceBonus(
  smartMoney: SmartMoneyResult,
  patternCandle: Candle,
  direction: SignalDirection,
  atrValue: number | null,
  intervalSec: number,
): number {
  const proximity = atrValue != null ? ATR_PROXIMITY_MULTIPLIER * atrValue : 0;
  const candleTime = patternCandle.time;

  const wantType = direction === 'buy' ? 'bullish' : 'bearish';

  for (const ob of smartMoney.orderBlocks) {
    if (ob.type !== wantType) continue;
    const ageInBars = intervalSec > 0 ? (candleTime - ob.time) / intervalSec : candleTime - ob.time;
    if (ageInBars < 0 || ageInBars > FRESH_OB_MAX_AGE) continue;
    const mid = (ob.top + ob.bottom) / 2;
    if (proximity > 0 && Math.abs(patternCandle.low - mid) <= proximity) return 0.1;
    if (proximity > 0 && Math.abs(patternCandle.high - mid) <= proximity) return 0.1;
  }

  for (const fvg of smartMoney.fvgs) {
    if (fvg.type !== wantType || fvg.broken) continue;
    const ageInBars = intervalSec > 0 ? (candleTime - fvg.time) / intervalSec : candleTime - fvg.time;
    if (ageInBars < 0 || ageInBars > FRESH_FVG_MAX_AGE) continue;
    const mid = (fvg.top + fvg.bottom) / 2;
    if (proximity > 0 && Math.abs(patternCandle.low - mid) <= proximity) return 0.05;
    if (proximity > 0 && Math.abs(patternCandle.high - mid) <= proximity) return 0.05;
  }

  return 0;
}

export interface ConfirmationResult {
  multiplier: number;
  confirmed: boolean;
  contradicted: boolean;
}

export function nextCandleConfirmation(
  patternCandle: Candle,
  confirmCandle: Candle,
  direction: SignalDirection,
): ConfirmationResult {
  const patternBodyTop = Math.max(patternCandle.open, patternCandle.close);
  const patternBodyBottom = Math.min(patternCandle.open, patternCandle.close);

  if (direction === 'buy') {
    const strongClose = confirmCandle.close > patternBodyTop;
    const weakClose = confirmCandle.close > patternCandle.high * 0.5 + patternBodyBottom * 0.5;
    const contradicted = confirmCandle.close < patternCandle.low;

    if (strongClose) return { multiplier: 1.25, confirmed: true, contradicted: false };
    if (contradicted) return { multiplier: 0, confirmed: false, contradicted: true };
    if (weakClose) return { multiplier: 1.10, confirmed: true, contradicted: false };
    return { multiplier: 0.85, confirmed: false, contradicted: false };
  }

  const strongClose = confirmCandle.close < patternBodyBottom;
  const weakClose = confirmCandle.close < patternBodyBottom * 0.5 + patternCandle.high * 0.5;
  const contradicted = confirmCandle.close > patternCandle.high;

  if (strongClose) return { multiplier: 1.25, confirmed: true, contradicted: false };
  if (contradicted) return { multiplier: 0, confirmed: false, contradicted: true };
  if (weakClose) return { multiplier: 1.10, confirmed: true, contradicted: false };
  return { multiplier: 0.85, confirmed: false, contradicted: false };
}

export function isAsiaOrClosed(session: SessionRegime): boolean {
  return session === 'sydney' || session === 'tokyo' || session === 'closed';
}

export function hasPrecedingBullish(candles: Candle[], patternIndex: number, count: number): boolean {
  let bullish = 0;
  const start = Math.max(0, patternIndex - count);
  for (let i = start; i < patternIndex; i++) {
    if (candles[i].close > candles[i].open) bullish++;
  }
  return bullish >= 3;
}

export function hasPrecedingBearish(candles: Candle[], patternIndex: number, count: number): boolean {
  let bearish = 0;
  const start = Math.max(0, patternIndex - count);
  for (let i = start; i < patternIndex; i++) {
    if (candles[i].close < candles[i].open) bearish++;
  }
  return bearish >= 3;
}

export function nearEma21InTrend(
  indicators: IndicatorSnapshot | undefined,
  candle: Candle,
  direction: SignalDirection,
): boolean {
  if (!indicators || indicators.emaFast == null) return false;
  const ema = indicators.emaFast;
  const range = candle.high - candle.low || 1e-9;
  if (direction === 'buy') {
    return Math.abs(candle.low - ema) < range * 0.3;
  }
  return Math.abs(candle.high - ema) < range * 0.3;
}

export function nearEma200(
  indicators: IndicatorSnapshot | undefined,
  candle: Candle,
): boolean {
  if (!indicators || indicators.emaSlow == null) return false;
  const range = candle.high - candle.low || 1e-9;
  return Math.abs(candle.close - indicators.emaSlow) < range * 0.5;
}

export function isNearSwingLevel(
  structure: MarketStructure,
  candle: Candle,
  atrValue: number | null,
): boolean {
  const proximity = atrValue != null ? ATR_PROXIMITY_MULTIPLIER * atrValue : 0;
  if (proximity <= 0) return false;
  if (structure.swingHigh != null && Math.abs(candle.high - structure.swingHigh) <= proximity) return true;
  if (structure.swingLow != null && Math.abs(candle.low - structure.swingLow) <= proximity) return true;
  return false;
}
