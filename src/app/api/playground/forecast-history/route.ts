import { NextResponse } from 'next/server';
import { getCurrentAdminState } from '@/lib/supabase/admin';
import {
  fetchForecastHistory,
  RANGE_CONFIG,
  type HistoryRange,
} from '@/services/forecastHistoryService';
import {
  detectLiveEvents,
  verifyEvent,
  DETECTION_PRESETS,
  type LiveEvent,
} from '@/services/liveEventService';
import { loadStoredEvents, loadEventCatalog, saveEventCatalog } from '@/services/liveEventStore';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

const VALID_RANGES: HistoryRange[] = ['live', '1d', '1w', '1m', '1y'];

interface EventBand {
  id: string;
  startMs: number;
  endMs: number;
  gLevel: number;
  gCode: string;
  label: string;
  status: LiveEvent['verification']['status'];
}

/** Band G level = the observed level once verified, else the strongest forecast. */
function eventToBand(event: LiveEvent): EventBand {
  const v = event.verification;
  const maxPredicted = Math.max(0, ...event.predictions.map(p => p.gLevel));
  const level = v.status === 'verified' && v.observedGLevel != null ? v.observedGLevel : maxPredicted;
  const code = v.status === 'verified' && v.observedGCode ? v.observedGCode : `G${level}`;
  return {
    id: event.id,
    startMs: new Date(event.detectedAtL1Utc).getTime(),
    endMs: new Date(event.endAtL1Utc).getTime(),
    gLevel: level,
    gCode: code,
    label: event.driver.label,
    status: v.status,
  };
}

/**
 * Time-ranged solar-wind history for the Live Forecast charts, plus the storm
 * event bands within the visible window and the year-long event catalog.
 *  - live/1d/1w bands come from the live (RTSW) event store.
 *  - 1m/1y rebuild + persist the OMNI year catalog (detect over the OMNI window,
 *    verify against OMNI's own Kp), and bands come from it.
 */
export async function GET(request: Request) {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const url = new URL(request.url);
  const rangeParam = url.searchParams.get('range') as HistoryRange | null;
  const range: HistoryRange = rangeParam && VALID_RANGES.includes(rangeParam) ? rangeParam : 'live';

  const history = await fetchForecastHistory(range);
  const nowMs = Date.now();

  let bands: EventBand[] = [];
  let catalogEvents: LiveEvent[] = [];

  if (history.source === 'omni' && history.omni) {
    // Rebuild the catalog from this OMNI window. OMNI is already at Earth, so the
    // propagation distance is ~0 (arrival ≈ detection); verify against OMNI's Kp.
    const detected = detectLiveEvents(history.omni.samples, 0, DETECTION_PRESETS.omniHourly);
    catalogEvents = detected.map(event => ({ ...event, verification: verifyEvent(event, history.omni!.kpSeries, nowMs) }));
    await saveEventCatalog(catalogEvents);
    bands = catalogEvents
      .filter(e => new Date(e.endAtL1Utc).getTime() >= history.startMs && new Date(e.detectedAtL1Utc).getTime() <= history.endMs)
      .map(eventToBand);
  } else {
    const stored = await loadStoredEvents();
    bands = stored
      .filter(e => new Date(e.endAtL1Utc).getTime() >= history.startMs && new Date(e.detectedAtL1Utc).getTime() <= history.endMs)
      .map(eventToBand);
    // Surface the persisted year catalog for the history list even on short ranges.
    catalogEvents = await loadEventCatalog();
  }

  const verifiedCatalog = catalogEvents.filter(e => e.verification.status === 'verified');
  const catalogHits = verifiedCatalog.filter(e => e.verification.verdicts.some(v => v.hit)).length;

  return NextResponse.json(
    {
      range,
      source: history.source,
      cadenceLabel: history.cadenceLabel,
      startMs: history.startMs,
      endMs: history.endMs,
      points: history.points,
      mru: history.mru,
      ml: history.ml,
      mlAvailable: history.mlAvailable,
      bands,
      catalog: {
        count: catalogEvents.length,
        verified: verifiedCatalog.length,
        hits: catalogHits,
        spanDays: RANGE_CONFIG['1y'].days,
        events: catalogEvents.slice(0, 200),
      },
      warnings: history.warnings,
      generatedAtUtc: new Date(nowMs).toISOString(),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
