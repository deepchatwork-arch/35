import { create } from 'zustand';
import type { Candle, Tick, Timeframe, FeatureName, Signal } from '@/types/domain';
import { connectionManager } from '@/data/connection-manager';
import { findSymbol, TIMEFRAME_SECONDS } from '@/data/symbols';
import { isMarketOpen } from '@/data/market-hours';
import { compactTimeline } from '@/data/compact-timeline';
import { workerClient } from '@/compute/WorkerClient';
import { computeSnapshot } from '@/compute/IndicatorAggregator';
import { buildFullSnapshot } from '@/compute/full-snapshot';
import { serverClock } from '@/data/server-clock';
import { playSignalAlert, playPriorityAlert } from '@/lib/audio';
import { captureError, addBreadcrumb } from '@/lib/sentry';
import { useSettingsStore } from './settingsStore';
import { useAnalyticsStore } from './useAnalyticsStore';
import { DecisionEngine } from '@/decision/engine';
import { OutcomeScheduler } from '@/decision/outcome-scheduler';
import {
  CalibrationModel,
  loadCalibrationState,
  persistCalibrationState,
  MIN_SAMPLES,
} from '@/decision/calibration-model';
import { FEATURE_COUNT, FEATURE_KEYS, shouldRevise, reviseSignal } from '@/decision/signal-builder';
import {
  saveSignal,
  updateSignalOutcome,
  loadCalibrationStateFromDb,
  saveCalibrationState,
} from '@/lib/signal-persistence';
import { useDemoAccountStore } from '@/stores/useDemoAccountStore';
import { PRE_CLOSE_SIGNAL_LEAD_MS } from '@/lib/constants';

const MAX_CANDLES = 600;
const COMPUTE_THROTTLE_MS = 800;
const TICK_THROTTLE_MS = 200;
const BARS_TO_RESOLVE = 5;
const MARKET_HOURS_RECHECK_MS = 30_000;

type CandleLifecycleState = 'live' | 'stale' | 'closed';

interface TickState {
  candles: Candle[];
  currentPrice: number | null;
  loading: boolean;
  error: string | null;
  lastPriceFlash: 'up' | 'down' | null;
  activeSymbolId: string;
  activeTimeframe: Timeframe;
  historyLoadedKey: string | null;
  marketClosed: boolean;
  unsubscribe: (() => void) | null;
  lastComputeAt: number;
  lastTickAt: number;
  lastTick: Tick | null;
  lastCandleUpdatedAt: number;
  lastCandleCloseAtMs: number;
  candleLifecycle: CandleLifecycleState;
  indicatorSnapshot: ReturnType<typeof computeSnapshot> | null;
  indicatorSeries: ReturnType<typeof buildFullSnapshot>['series'] | null;
  fullSnapshot: ReturnType<typeof buildFullSnapshot>['snapshot'] | null;
  prioritySignal: Signal | null;
  start: (symbolId: string, timeframe: Timeframe) => Promise<void>;
  stop: () => void;
  clearError: () => void;
  clearPrioritySignal: () => void;
}

let engine: DecisionEngine | null = null;
let outcomeScheduler: OutcomeScheduler | null = null;
let calibrationModel: CalibrationModel | null = null;
let preCloseTriggeredCandleTime: number | null = null;
let marketHoursTimer: ReturnType<typeof setInterval> | null = null;
let preCloseTimer: ReturnType<typeof setTimeout> | null = null;

function startMarketHoursWatch(
  set: (partial: Partial<TickState>) => void,
  get: () => TickState,
): void {
  if (marketHoursTimer) clearInterval(marketHoursTimer);
  marketHoursTimer = setInterval(() => {
    const { activeSymbolId } = get();
    if (!activeSymbolId) return;
    const symbol = findSymbol(activeSymbolId);
    if (!symbol) return;
    const closed = !isMarketOpen(symbol);
    const prev = get().marketClosed;
    if (closed !== prev) {
      set({ marketClosed: closed });
      const cur = useAnalyticsStore.getState().connectionStatus;
      if (closed && cur === 'live') {
        useAnalyticsStore.setState({ connectionStatus: 'market_closed' });
      } else if (!closed && cur === 'market_closed') {
        useAnalyticsStore.setState({ connectionStatus: 'live' });
      }
    }
  }, MARKET_HOURS_RECHECK_MS);
}

function ensureEngine(): DecisionEngine {
  if (!engine) {
    calibrationModel = loadCalibrationState(FEATURE_COUNT);
    if (calibrationModel) {
      useAnalyticsStore.getState().setCalibrationState(calibrationModel.exportState());
      // Try to load newer state from database (supersedes localStorage if available)
      void loadCalibrationStateFromDb().then((dbState) => {
        if (!dbState) return;
        if (!calibrationModel) return;
        calibrationModel.loadState(dbState.state);
        if (dbState.samples.length > 0) {
          calibrationModel.loadSamples(dbState.samples);
          calibrationModel.retrain();
        }
        useAnalyticsStore.getState().setCalibrationState(calibrationModel.exportState());
      });
    } else {
      // No localStorage state — try database directly
      void loadCalibrationStateFromDb().then((dbState) => {
        if (!dbState) return;
        const model = new CalibrationModel(FEATURE_COUNT);
        model.loadState(dbState.state);
        if (dbState.samples.length > 0) {
          model.loadSamples(dbState.samples);
          model.retrain();
        }
        calibrationModel = model;
        if (engine) {
          (engine as unknown as { calibration: CalibrationModel | null }).calibration = model;
        }
        useAnalyticsStore.getState().setCalibrationState(model.exportState());
      });
    }
    const sensitivity = useSettingsStore.getState().sensitivity;
    engine = new DecisionEngine({
      calibration: calibrationModel,
      barsToResolve: BARS_TO_RESOLVE,
      scoreThreshold: sensitivity === 'strict' ? 4 : 2,
      signalToggles: useSettingsStore.getState().signalToggles,
    });
  }
  return engine;
}

function ensureScheduler(): OutcomeScheduler {
  if (!outcomeScheduler) {
    outcomeScheduler = new OutcomeScheduler();
  }
  return outcomeScheduler;
}

export const useTickStore = create<TickState>((set, get) => ({
  candles: [],
  currentPrice: null,
  loading: false,
  error: null,
  lastPriceFlash: null,
  activeSymbolId: '',
  activeTimeframe: '15m',
  historyLoadedKey: null,
  marketClosed: false,
  unsubscribe: null,
  lastComputeAt: 0,
  lastTickAt: 0,
  lastTick: null,
  lastCandleUpdatedAt: 0,
  lastCandleCloseAtMs: 0,
  candleLifecycle: 'live',
  indicatorSnapshot: null,
  indicatorSeries: null,
  fullSnapshot: null,
  prioritySignal: null,

  start: async (symbolId: string, timeframe: Timeframe) => {
    const state = get();
    if (state.activeSymbolId === symbolId && state.activeTimeframe === timeframe && state.unsubscribe) {
      return;
    }
    state.stop();
    workerClient.resetStreaming();

    // Clear all state on mode/symbol switch
    set({
      candles: [],
      currentPrice: null,
      indicatorSnapshot: null,
      indicatorSeries: null,
      fullSnapshot: null,
      prioritySignal: null,
      lastPriceFlash: null,
      lastTick: null,
      lastCandleUpdatedAt: Date.now(),
      lastCandleCloseAtMs: 0,
      candleLifecycle: 'live',
    });
    useAnalyticsStore.getState().clearAll();
    preCloseTriggeredCandleTime = null;

    ensureEngine();
    ensureScheduler();
    outcomeScheduler!.clear();

    set({
      loading: true,
      error: null,
      activeSymbolId: symbolId,
      activeTimeframe: timeframe,
      historyLoadedKey: null,
      marketClosed: false,
      lastCandleUpdatedAt: Date.now(),
      lastCandleCloseAtMs: 0,
      candleLifecycle: 'live',
    });
    useAnalyticsStore.setState({ connectionStatus: 'connecting' });

    const symbol = findSymbol(symbolId);
    if (!symbol) {
      set({ loading: false, error: `Unknown symbol: ${symbolId}` });
      useAnalyticsStore.setState({ connectionStatus: 'failed' });
      return;
    }

    const marketClosed = !isMarketOpen(symbol);
    set({ marketClosed });
    if (marketClosed) {
      useAnalyticsStore.setState({ connectionStatus: 'market_closed' });
    }
    startMarketHoursWatch(set, get);

    const historyKey = `${symbolId}:${timeframe}`;
    try {
      const { status, candles: history } = await connectionManager.connectAndGetHistory(symbol, timeframe);
      if (get().activeSymbolId !== symbolId || get().activeTimeframe !== timeframe) return;

      if (status === 'failed') {
        set({ loading: false, error: 'All data sources failed to connect' });
        useAnalyticsStore.setState({ connectionStatus: 'failed' });
        return;
      }

      const deduped = dedupeHistory(history);
      const compacted = compactTimeline(deduped, timeframe, symbol.assetClass);
      const settings = useSettingsStore.getState();
      const features = getActiveFeatures(settings);
      const snapshot = computeSnapshot(compacted, settings.indicators);
      const { snapshot: fullSnap, series: fullSeries } = buildFullSnapshot(compacted, settings.indicators, features);
      set({
        candles: compacted,
        historyLoadedKey: historyKey,
        loading: false,
        currentPrice: compacted.length > 0 ? compacted[compacted.length - 1].close : null,
        indicatorSnapshot: snapshot,
        indicatorSeries: fullSeries,
        fullSnapshot: fullSnap,
        lastCandleUpdatedAt: Date.now(),
        lastCandleCloseAtMs: 0,
        candleLifecycle: 'live',
      });
      useDemoAccountStore.getState().resolveFromHistory(symbolId, timeframe, compacted);
    } catch (err) {
      if (get().activeSymbolId !== symbolId) return;
      const message = err instanceof Error ? err.message : 'Failed to load market data';
      set({ loading: false, error: message });
      useAnalyticsStore.setState({ connectionStatus: 'failed' });
      return;
    }

    const unsubCandles = connectionManager.onCandle((candle, isClosed) =>
      handleCandle(candle, isClosed, set, get),
    );
    const unsubTicks = connectionManager.onTick((tick) => handleTick(tick, set, get));
    set({ unsubscribe: () => { unsubCandles(); unsubTicks(); } });

    schedulePreCloseTimer(set, get);
  },

  stop: () => {
    const { unsubscribe } = get();
    if (unsubscribe) {
      unsubscribe();
      set({ unsubscribe: null });
    }
    if (marketHoursTimer) { clearInterval(marketHoursTimer); marketHoursTimer = null; }
    if (preCloseTimer) { clearTimeout(preCloseTimer); preCloseTimer = null; }
    connectionManager.disconnect();
    set({ activeSymbolId: '' });
  },

  clearError: () => set({ error: null }),
  clearPrioritySignal: () => set({ prioritySignal: null }),
}));

let statusUnsub: (() => void) | null = null;
statusUnsub = connectionManager.onStatus((status) => {
  useAnalyticsStore.setState({ connectionStatus: status });
});
if (import.meta.hot) {
  import.meta.hot.dispose(() => { if (statusUnsub) statusUnsub(); });
}

let sensitivityUnsub: (() => void) | null = null;
sensitivityUnsub = useSettingsStore.subscribe((s, prev) => {
  if (s.sensitivity !== prev.sensitivity && engine) {
    engine.setScoreThreshold(s.sensitivity === 'strict' ? 4 : 2);
  }
  if (s.signalToggles !== prev.signalToggles && engine) {
    engine.setSignalToggles(s.signalToggles);
  }
});
if (import.meta.hot) {
  import.meta.hot.dispose(() => { if (sensitivityUnsub) sensitivityUnsub(); });
}

function getActiveFeatures(settings: { activePatterns: string[]; activeIndicators: string[] }): FeatureName[] {
  return [...settings.activePatterns, ...settings.activeIndicators] as FeatureName[];
}

function dedupeHistory(candles: Candle[]): Candle[] {
  const seen = new Set<number>();
  const out: Candle[] = [];
  for (const c of candles) {
    if (seen.has(c.time)) continue;
    seen.add(c.time);
    out.push(c);
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

function deriveCandleLifecycleState(
  candle: Candle,
  timeframe: Timeframe,
  serverNowMs: number,
  lastUpdatedAtMs: number,
  isClosed: boolean,
  lastCandleCloseAtMs: number,
): CandleLifecycleState {
  const closeTimeMs = (candle.time + TIMEFRAME_SECONDS[timeframe]) * 1000;
  if (isClosed || serverNowMs >= closeTimeMs) {
    const staleThresholdMs = Math.max(15_000, TIMEFRAME_SECONDS[timeframe] * 1000 * 2);
    if (lastCandleCloseAtMs > 0 && serverNowMs - lastCandleCloseAtMs > staleThresholdMs) {
      return 'stale';
    }
    return 'closed';
  }
  if (lastUpdatedAtMs > 0 && serverNowMs - lastUpdatedAtMs > Math.max(15_000, TIMEFRAME_SECONDS[timeframe] * 1000 * 2)) {
    return 'stale';
  }
  return 'live';
}

export function handleCandle(
  candle: Candle,
  isClosed: boolean,
  set: (partial: Partial<TickState>) => void,
  get: () => TickState,
): void {
  if (get().activeSymbolId === '') return;
  const candles = [...get().candles];
  const last = candles[candles.length - 1];
  if (last && last.time === candle.time) {
    candles[candles.length - 1] = candle;
  } else if (!last || candle.time > last.time) {
    // confirmEntryPrice вызывается безусловно при появлении новой свечи —
    // до дедап-гварда ниже. Это покрывает сценарий resync(): при повторной
    // доставке уже обработанного перехода свечи гвард пропускает резолюцию,
    // но confirmEntryPrice всё равно должна сработать, если цена ещё не
    // подтверждена (идемпотентна — правит только entryPrice === null).
    if (last) {
      useDemoAccountStore.getState().confirmEntryPrice(
        get().activeSymbolId, get().activeTimeframe, candle.time, candle.open,
      );
    }
    if (last) {
      const prevCloseMs = (last.time + TIMEFRAME_SECONDS[get().activeTimeframe]) * 1000;
      if (get().lastCandleCloseAtMs !== prevCloseMs) {
        set({
          lastCandleUpdatedAt: serverClock.now(),
          lastCandleCloseAtMs: prevCloseMs,
          candleLifecycle: 'closed',
        });
        maybeCompute(set, get);
        useDemoAccountStore.getState().checkExpiries(last.close, prevCloseMs, get().activeSymbolId, get().activeTimeframe);
        maybeEvaluateSignal(set, get, true, candle.open);
        maybeResolveOutcomes(set, get);
      }
    }
    candles.push(candle);
    if (candles.length > MAX_CANDLES) candles.shift();
    preCloseTriggeredCandleTime = null;
    schedulePreCloseTimer(set, get);
  } else {
    return;
  }
  const state = get();
  const serverNowMs = serverClock.now();
  const lifecycle = deriveCandleLifecycleState(
    candle,
    state.activeTimeframe,
    serverNowMs,
    state.lastCandleUpdatedAt,
    isClosed,
    state.lastCandleCloseAtMs,
  );
  set({
    candles,
    currentPrice: candle.close,
    lastCandleUpdatedAt: serverNowMs,
    lastCandleCloseAtMs: isClosed ? (candle.time + TIMEFRAME_SECONDS[state.activeTimeframe]) * 1000 : state.lastCandleCloseAtMs,
    candleLifecycle: lifecycle,
  });

  if (isClosed) {
    maybeCompute(set, get);
    useDemoAccountStore.getState().checkExpiries(candle.close, (candle.time + TIMEFRAME_SECONDS[state.activeTimeframe]) * 1000, state.activeSymbolId, state.activeTimeframe);
    maybeEvaluateSignal(set, get, true);
    maybeResolveOutcomes(set, get);
  } else {
    maybeEvaluateSignal(set, get, false);
    maybeConsiderRevision(set, get);
  }
}

function handleTick(
  tick: Tick,
  set: (partial: Partial<TickState>) => void,
  get: () => TickState,
): void {
  if (get().activeSymbolId === '') return;
  const now = Date.now();
  const throttled = now - get().lastTickAt < TICK_THROTTLE_MS;
  const prevPrice = get().currentPrice ?? tick.price;
  const flash = tick.price > prevPrice ? 'up' : tick.price < prevPrice ? 'down' : get().lastPriceFlash;

  const candles = get().candles;
  if (candles.length > 0 && !throttled) {
    const updated = [...candles];
    const last = { ...updated[updated.length - 1] };
    last.close = tick.price;
    if (tick.price > last.high) last.high = tick.price;
    if (tick.price < last.low) last.low = tick.price;
    updated[updated.length - 1] = last;
    set({ candles: updated });
  }

  if (throttled) {
    set({ currentPrice: tick.price, lastTick: tick, lastCandleUpdatedAt: now, lastCandleCloseAtMs: get().lastCandleCloseAtMs, candleLifecycle: 'live' });
    return;
  }
  set({ currentPrice: tick.price, lastPriceFlash: flash, lastTickAt: now, lastTick: tick, lastCandleUpdatedAt: now, lastCandleCloseAtMs: get().lastCandleCloseAtMs, candleLifecycle: 'live' });
  maybeTriggerPreClose(set, get);
}

function schedulePreCloseTimer(
  set: (partial: Partial<TickState>) => void,
  get: () => TickState,
): void {
  if (preCloseTimer) { clearTimeout(preCloseTimer); preCloseTimer = null; }

  const state = get();
  if (state.activeSymbolId === '' || state.candles.length === 0) return;

  const lastCandle = state.candles[state.candles.length - 1];
  const tfSeconds = TIMEFRAME_SECONDS[state.activeTimeframe];
  const closeTimeMs = (lastCandle.time + tfSeconds) * 1000;
  const serverNowMs = serverClock.now();
  const msUntilClose = closeTimeMs - serverNowMs;

  if (msUntilClose <= PRE_CLOSE_SIGNAL_LEAD_MS && msUntilClose > 0) {
    maybeTriggerPreClose(set, get);
    return;
  }

  if (msUntilClose <= 0) return;

  const delay = msUntilClose - PRE_CLOSE_SIGNAL_LEAD_MS;
  preCloseTimer = setTimeout(() => {
    preCloseTimer = null;
    maybeTriggerPreClose(set, get);
  }, Math.max(0, delay));
}

function maybeTriggerPreClose(
  set: (partial: Partial<TickState>) => void,
  get: () => TickState,
): void {
  void set;
  const state = get();
  if (state.activeSymbolId === '' || state.candles.length === 0) return;

  const lastCandle = state.candles[state.candles.length - 1];
  const tfSeconds = TIMEFRAME_SECONDS[state.activeTimeframe];
  const serverNowMs = serverClock.now();

  if (!ensureEngine().shouldEmitPreClose(serverNowMs, lastCandle.time, tfSeconds)) return;
  if (state.candleLifecycle !== 'live') return;
  if (preCloseTriggeredCandleTime === lastCandle.time) return;

  preCloseTriggeredCandleTime = lastCandle.time;

  const settings = useSettingsStore.getState();
  const features = getActiveFeatures(settings);
  const eng = ensureEngine();

  const signal = eng.evaluate(
    state.activeSymbolId,
    state.activeTimeframe,
    state.candles,
    settings.indicators,
    settings.atrMultiplier,
    features,
    state.lastTick,
    serverNowMs,
    false,
  );

  if (!signal) return;

  const preCloseSignal: Signal = { ...signal, isPreClose: true };
  const analytics = useAnalyticsStore.getState();
  analytics.setCurrentSignal(preCloseSignal);
  analytics.upsertSignal(preCloseSignal);
  ensureScheduler().schedule(preCloseSignal);
  void saveSignal(preCloseSignal);
  // entryPrice не передаётся: signal.entryPrice — это close ещё формирующейся
  // свечи, а не реальный open следующей. Передача его сюда немедленно зафиксирует
  // неверную цену входа и заблокирует последующую коррекцию через
  // confirmEntryPrice (guard на entryPrice === null не сработает).
  // Реальная цена подтверждается в handleCandle при появлении новой свечи.
  useDemoAccountStore.getState().openTrade(preCloseSignal);

  const prob = preCloseSignal.calibratedProbability ?? preCloseSignal.score / 10;
  const isPriority = preCloseSignal.strength === 'strong' && prob >= settings.priorityThreshold;
  if (isPriority) {
    set({ prioritySignal: preCloseSignal });
    if (settings.soundPrioritySignal) playPriorityAlert(preCloseSignal.direction);
  } else if (settings.soundNewSignal) {
    playSignalAlert(preCloseSignal.direction);
  }
}

function maybeCompute(
  set: (partial: Partial<TickState>) => void,
  get: () => TickState,
): void {
  const state = get();
  if (state.candleLifecycle === 'stale') return;
  const now = Date.now();
  if (now - state.lastComputeAt < COMPUTE_THROTTLE_MS) return;
  set({ lastComputeAt: now });
  const settings = useSettingsStore.getState();
  const features = getActiveFeatures(settings);
  void workerClient
    .candleClosed(state.activeSymbolId, state.activeTimeframe, state.candles, settings.indicators, features)
    .then(({ snapshot, series }) => {
      const cur = get();
      if (cur.activeSymbolId !== state.activeSymbolId || cur.activeTimeframe !== state.activeTimeframe) return;
      set({ indicatorSnapshot: snapshot.indicators, indicatorSeries: series, fullSnapshot: snapshot });
    })
    .catch((err) => {
      captureError(err, { context: 'worker.candleClosed' });
    });
}

function maybeEvaluateSignal(
  set: (partial: Partial<TickState>) => void,
  get: () => TickState,
  isClosed: boolean,
  knownOpenPrice?: number,
): void {
  void set;
  const state = get();
  const settings = useSettingsStore.getState();
  const features = getActiveFeatures(settings);
  const eng = ensureEngine();
  const serverNowMs = serverClock.now();

  const signal = eng.evaluate(
    state.activeSymbolId,
    state.activeTimeframe,
    state.candles,
    settings.indicators,
    settings.atrMultiplier,
    features,
    state.lastTick,
    serverNowMs,
    isClosed,
  );

  let finalSignal: Signal | null = signal;
  if (isClosed) {
    const frozen = eng.onCandleClosed();
    finalSignal = frozen ?? signal;
  }
  if (!finalSignal) return;

  // Демо-сделка открывается РОВНО одним из двух способов, и никогда — на
  // произвольном промежуточном тике внутри свечи:
  //  1) maybeTriggerPreClose — основной путь, срабатывает ровно один раз за
  //     свечу, за PRE_CLOSE_SIGNAL_LEAD_MS до её закрытия, с ценой, близкой
  //     к реальному открытию следующей свечи;
  //  2) здесь, при isClosed === true — подстраховка на случай, если
  //     pre-close таймер не успел сработать (например, вкладка была
  //     свёрнута/выгружена браузером). Дедуп по signal.id в openTrade
  //     гарантирует, что если pre-close уже открыл сделку, повторного
  //     открытия здесь не произойдёт.
  // Ветка isClosed === false (промежуточный тик) сделку НЕ открывает —
  // раньше это давало случайную точку входа по первому попавшемуся тику
  // внутри свечи и "съедало" более точную pre-close попытку через дедуп.
  if (isClosed) {
    const lastCandle = state.candles[state.candles.length - 1];
    if (preCloseTriggeredCandleTime === lastCandle.time) {
      useDemoAccountStore.getState().openTrade(finalSignal, knownOpenPrice);
    }
  }

  const analytics = useAnalyticsStore.getState();
  analytics.addSignal(finalSignal);
  ensureScheduler().schedule(finalSignal);
  void saveSignal(finalSignal);
}

function maybeConsiderRevision(
  _set: (partial: Partial<TickState>) => void,
  get: () => TickState,
): void {
  const state = get();
  const eng = ensureEngine();
  const frozen = eng.getFrozenSignal();
  if (!frozen) return;

  const settings = useSettingsStore.getState();
  const features = getActiveFeatures(settings);
  const serverNowMs = serverClock.now();

  const newSignal = eng.evaluate(
    state.activeSymbolId,
    state.activeTimeframe,
    state.candles,
    settings.indicators,
    settings.atrMultiplier,
    features,
    state.lastTick,
    serverNowMs,
    false,
  );
  if (!newSignal) return;

  if (shouldRevise(newSignal.score, frozen.score)) {
    const revised = reviseSignal(
      frozen,
      newSignal.score,
      newSignal.reason,
      eng.getLastSnapshot() ?? {
        indicators: newSignal.indicators,
        patterns: [],
        structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false },
        regime: 'range',
        lastPrice: newSignal.entryPrice,
        candleTime: newSignal.time,
      },
      calibrationModel,
    );
    const analytics = useAnalyticsStore.getState();
    analytics.addSignal(revised);
  }
}

function maybeResolveOutcomes(
  _set: (partial: Partial<TickState>) => void,
  get: () => TickState,
): void {
  const state = get();
  const sched = ensureScheduler();
  const eng = ensureEngine();
  const analytics = useAnalyticsStore.getState();

  sched.onCandleClosed(state.candles, (resolved, signal) => {
    analytics.updateSignalOutcome(resolved.signalId, resolved.outcome);
    void updateSignalOutcome(resolved.signalId, resolved.outcome);
    const outcomeRecord = eng.recordOutcome(signal, resolved.outcome);
    if (outcomeRecord && calibrationModel) {
      persistCalibrationState(calibrationModel);
      void saveCalibrationState(calibrationModel.exportState(), calibrationModel.getSamples());
      useAnalyticsStore.getState().setCalibrationState(calibrationModel.exportState());
      addBreadcrumb(`Outcome resolved: ${resolved.outcome}`, {
        signalId: resolved.signalId,
        samples: calibrationModel.getSampleCount(),
      });
    }
    analytics.recomputeStats();
  });
}

export { MIN_SAMPLES, FEATURE_KEYS, maybeTriggerPreClose };
