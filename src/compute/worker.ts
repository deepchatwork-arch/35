/// <reference lib="webworker" />
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from '@/types/messages';
import type {
  IndicatorConfig,
  CalibrationResult,
  Timeframe,
  FeatureName,
  Candle,
} from '@/types/domain';
import { buildFullSnapshot } from '@/compute/full-snapshot';
import { computeIndicators } from '@/compute/IndicatorAggregator';
import { ema, StreamingEMA } from '@/compute/indicators/ema';
import { lastNonNull } from '@/compute/indicators/helpers';
import { buildSignal } from '@/decision/signal-builder';

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: WorkerOutboundMessage): void {
  ctx.postMessage(msg);
}

interface StreamingState {
  emaFast: StreamingEMA;
  emaSlow: StreamingEMA;
  emaSignal: StreamingEMA | null;
  macdPrevFast: number | null;
  macdPrevSlow: number | null;
  macdLine: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  bollMiddle: number | null;
  bollUpper: number | null;
  bollLower: number | null;
  bollBuffer: number[];
  bollSum: number;
  bollSumSq: number;
  lastCandleTime: number | null;
}

let streaming: StreamingState | null = null;

function createStreaming(config: IndicatorConfig): StreamingState {
  return {
    emaFast: new StreamingEMA(config.emaFast),
    emaSlow: new StreamingEMA(config.emaSlow),
    emaSignal: null,
    macdPrevFast: null,
    macdPrevSlow: null,
    macdLine: null,
    macdSignal: null,
    macdHistogram: null,
    bollMiddle: null,
    bollUpper: null,
    bollLower: null,
    bollBuffer: [],
    bollSum: 0,
    bollSumSq: 0,
    lastCandleTime: null,
  };
}

function seedStreamingFromBatch(
  candles: { close: number; time: number }[],
  config: IndicatorConfig,
): StreamingState {
  const closes = candles.map((c) => c.close);
  const state = createStreaming(config);

  const emaFastArr = ema(closes, config.emaFast);
  const emaSlowArr = ema(closes, config.emaSlow);

  const lastFast = lastNonNull(emaFastArr);
  const lastSlow = lastNonNull(emaSlowArr);
  if (lastFast !== null) state.emaFast.seed(lastFast);
  if (lastSlow !== null) state.emaSlow.seed(lastSlow);

  state.lastCandleTime = candles.length > 0 ? candles[candles.length - 1].time : null;
  return state;
}

ctx.onmessage = (e: MessageEvent<WorkerInboundMessage>) => {
  const data = e.data;
  try {
    switch (data.type) {
      case 'candle_closed':
      case 'snapshot_request': {
        const { snapshot, series } = buildFullSnapshot(data.candles, data.config, data.activeFeatures);
        const resultType = data.type === 'candle_closed' ? 'candle_closed_result' : 'snapshot_result';
        streaming = seedStreamingFromBatch(data.candles, data.config);
        post({ type: resultType, requestId: data.requestId, snapshot, series });
        break;
      }
      case 'tick_update': {
        const snapshot = computeIncremental(data);
        post({ type: 'tick_update_result', requestId: data.requestId, snapshot });
        break;
      }
      case 'reset_streaming': {
        streaming = null;
        break;
      }
      case 'calibrate': {
        const result = calibrateInWorker(
          data.symbolId,
          data.timeframe,
          data.candles,
          data.config,
          data.pipSize,
        );
        post({ type: 'calibrate_result', requestId: data.requestId, result });
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'compute failed';
    post({ type: 'worker_error', requestId: data.requestId, message });
  }
};

function computeIncremental(
  data: Extract<WorkerInboundMessage, { type: 'tick_update' }>,
): import('@/types/domain').IndicatorSnapshot {
  const candles = data.candles;
  const config = data.config;
  const activeFeatures = data.activeFeatures;

  if (!streaming || candles.length === 0) {
    return computeIndicators(candles, config, activeFeatures).snapshot;
  }

  const lastCandle = candles[candles.length - 1];

  if (streaming.lastCandleTime === null || lastCandle.time !== streaming.lastCandleTime) {
    streaming = seedStreamingFromBatch(candles, config);
    return computeIndicators(candles, config, activeFeatures).snapshot;
  }

  streaming.emaFast.update(lastCandle.close);
  streaming.emaSlow.update(lastCandle.close);

  return computeIndicators(candles, config, activeFeatures).snapshot;
}

const ATR_MULTIPLIER_OPTIONS = [1.5, 2, 2.5, 3];
const DEFAULT_MULT = 2;
const MIN_TRADES = 8;

function calibrateInWorker(
  symbolId: string,
  timeframe: Timeframe,
  candles: Candle[],
  config: IndicatorConfig,
  pipSize: number,
): CalibrationResult {
  const features: FeatureName[] = [];
  const { snapshot: lastSnapshot } = buildFullSnapshot(candles, config, features);
  const atrValue = lastSnapshot.indicators.atr ?? null;
  let best: CalibrationResult | null = null;

  for (const mult of ATR_MULTIPLIER_OPTIONS) {
    const trades = backtestInWorker(symbolId, timeframe, candles, config, mult, features);
    if (trades.length < MIN_TRADES) continue;
    let wins = 0;
    for (const t of trades) if (t.win) wins += 1;
    const winRate = wins / trades.length;
    const stopPips = atrValue !== null ? (atrValue * mult) / pipSize : 0;
    const tpPips = atrValue !== null ? (atrValue * mult * 2) / pipSize : 0;
    const candidate: CalibrationResult = {
      symbolId,
      timeframe,
      atrMultiplier: mult,
      stopLossPips: stopPips,
      takeProfitPips: tpPips,
      winRate,
      totalTrades: trades.length,
      calibratedAt: Date.now(),
    };
    if (best === null || winRate > best.winRate) best = candidate;
  }

  if (best) return best;

  const stopPips = atrValue !== null ? (atrValue * DEFAULT_MULT) / pipSize : 0;
  const tpPips = atrValue !== null ? (atrValue * DEFAULT_MULT * 2) / pipSize : 0;
  return {
    symbolId,
    timeframe,
    atrMultiplier: DEFAULT_MULT,
    stopLossPips: stopPips,
    takeProfitPips: tpPips,
    winRate: 0,
    totalTrades: 0,
    calibratedAt: Date.now(),
  };
}

function backtestInWorker(
  symbolId: string,
  timeframe: Timeframe,
  candles: Candle[],
  config: IndicatorConfig,
  atrMultiplier: number,
  activeFeatures: FeatureName[],
): { win: boolean }[] {
  const trades: { win: boolean }[] = [];
  const warmup = Math.max(config.emaSlow, config.bbPeriod, config.macdSlow, config.rsiPeriod, config.atrPeriod) + 5;
  if (candles.length <= warmup + 10) return trades;

  for (let i = warmup; i < candles.length - 5; i++) {
    const slice = candles.slice(0, i + 1);
    const { snapshot } = buildFullSnapshot(slice, config, activeFeatures);
    const signal = buildSignal({
      symbolId,
      timeframe,
      candles: slice,
      config,
      atrMultiplier,
      activeFeatures,
      snapshot,
      calibration: null,
      tick: null,
      barsToResolve: 5,
    });
    if (!signal) continue;
    const stop = signal.stopLoss;
    const tp = signal.takeProfit;
    const isLong = signal.direction === 'buy';
    let resolved = false;
    let win = false;
    for (let j = i + 1; j < Math.min(candles.length, i + 6); j++) {
      const c = candles[j];
      if (isLong) {
        if (c.low <= stop) { resolved = true; win = false; break; }
        if (c.high >= tp) { resolved = true; win = true; break; }
      } else {
        if (c.high >= stop) { resolved = true; win = false; break; }
        if (c.low <= tp) { resolved = true; win = true; break; }
      }
    }
    if (resolved) trades.push({ win });
  }
  return trades;
}
