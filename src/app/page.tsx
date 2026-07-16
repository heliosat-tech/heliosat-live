import { AppShell } from '@/components/layout/AppShell';
import { ExpandableMissionWidget, ResizableMissionLayout } from '@/components/layout/ResizableMissionLayout';
import { DashboardSourceStatusBridge } from '@/components/layout/DashboardSourceStatusBridge';
import { classifyL1SourceStatus, type SourceStatus } from '@/components/layout/sourceStatus';
import { MissionHeadlineBar } from '@/components/panels/MissionHeadlineBar';
import { L1PropagationPanel, ArrivalHeatmapPanel } from '@/components/panels/L1ForecastPanel';
import { SatelliteWatchlistPanel } from '@/components/panels/SatelliteWatchlistPanel';
import { AlertsPanel } from '@/components/panels/AlertsPanel';
import { DataReadinessPanel } from '@/components/panels/DataReadinessPanel';
import { SatelliteOperatorReport } from '@/components/panels/SatelliteOperatorReport';
import { ModelThresholdsPanel } from '@/components/panels/ModelThresholdsPanel';
import { VisualizationSwitcher } from '@/components/globe/VisualizationSwitcher';
import { SatelliteSelectionProvider } from '@/contexts/SatelliteSelectionContext';
import { SatelliteConfigProvider } from '@/contexts/SatelliteConfigContext';
import { SatelliteWatchProvider } from '@/contexts/SatelliteWatchContext';
import { DashboardSync } from '@/components/DashboardSync';
import { fetchNoaaEphemerisData, fetchNoaaMagnetometerData, fetchNoaaPlasmaData } from '@/services/noaaSolarWindService';
import { fetchNoaaAlerts } from '@/services/noaaAlertsService';
import { fetchTleGroup, type CelesTrakResponse } from '@/services/celestrakService';
import { buildL1ForecastPanelData } from '@/services/l1ForecastPanelService';
import { fetchNoaaStormScales } from '@/services/noaaStormScalesService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// The home is server-rendered on every navigation (force-dynamic). CelesTrak can be slow or
// down — its service retries for ~12s — and must not hold the whole dashboard render hostage.
// Cap the initial TLE fetch: if it overruns, render with an empty catalog and let the globe
// hydrate from /api/tle client-side. The in-flight fetchTleGroup keeps running and populates
// celestrakService's own cache, so the next render is warm.
const TLE_RENDER_BUDGET_MS = 3_000;
async function fetchTleForRender(): Promise<CelesTrakResponse> {
  const fallback: CelesTrakResponse = {
    isConnected: false,
    lastUpdated: null,
    errorMessage: 'CelesTrak slow — loading in background',
    tles: [],
    stale: false,
  };
  return Promise.race([
    fetchTleGroup('stations'),
    new Promise<CelesTrakResponse>(resolve => setTimeout(() => resolve(fallback), TLE_RENDER_BUDGET_MS)),
  ]);
}

export default async function Home() {
  const [noaaMagData, noaaPlasmaData, noaaEphemerisData, noaaAlertsData, celestrakData, l1ForecastData, stormScalesData] = await Promise.all([
    fetchNoaaMagnetometerData(),
    fetchNoaaPlasmaData(),
    fetchNoaaEphemerisData(),
    fetchNoaaAlerts(),
    fetchTleForRender(),
    buildL1ForecastPanelData(),
    fetchNoaaStormScales(),
  ]);

  const magneticAvailable = l1ForecastData.latest.bt !== null || l1ForecastData.latest.bz !== null;
  const plasmaAvailable = l1ForecastData.latest.speed !== null || l1ForecastData.latest.density !== null;
  const l1Status = classifyL1SourceStatus({
    sampleTimeUtc: l1ForecastData.latest.sampleTimeUtc,
    freshness: l1ForecastData.freshness,
    magneticAvailable,
    plasmaAvailable,
  });

  // Server snapshot for NOAA-backed sources. CelesTrak is appended by the client bridge so
  // the one existing catalog fetch can reconcile a time-capped SSR result after hydration.
  const sources: SourceStatus[] = [
    {
      id: 'l1-solar-wind',
      name: 'L1 Solar Wind',
      status: l1Status,
      lastUpdated: l1ForecastData.latest.sampleTimeUtc,
      detail: l1ForecastData.sourceLabel ? `Live source: ${l1ForecastData.sourceLabel}` : l1ForecastData.warnings[0] ?? null,
    },
    {
      id: 'noaa-alerts',
      name: 'NOAA Alerts',
      status: noaaAlertsData.isConnected ? 'connected' : 'offline',
      lastUpdated: noaaAlertsData.lastUpdated,
      detail: noaaAlertsData.errorMessage,
    },
    {
      id: 'noaa-storm-scales',
      name: 'NOAA Storm Scales (G/S/R)',
      status: stormScalesData.observed === null
        ? 'offline'
        : stormScalesData.observed.observedAtUtc
          ? 'connected'
          : 'partial',
      lastUpdated: stormScalesData.observed?.observedAtUtc ?? null,
      detail: stormScalesData.errorMessage,
    },
  ];

  return (
    <AppShell>
      <SatelliteSelectionProvider>
        <SatelliteConfigProvider initialTleData={celestrakData}>
          <DashboardSourceStatusBridge sources={sources} />
          <SatelliteWatchProvider>
            {/* Persists tracked satellites + instruments/thresholds to Supabase per account. */}
            <DashboardSync />
            <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-visible xl:overflow-hidden">
              {/* Titular: a la izquierda lo observado en Tierra (G real + viento solar llegando),
                  a la derecha lo medido en L1 + el pronóstico de G y su tiempo de llegada. */}
              <MissionHeadlineBar l1={l1ForecastData} observed={stormScalesData.observed} />

              <ResizableMissionLayout
                left={(
                  <ExpandableMissionWidget
                    title="L1 -> Earth Propagation"
                    className="xl:min-h-0 xl:flex-1"
                    detail={(
                      <div className="h-full min-h-[720px]">
                        <L1PropagationPanel data={l1ForecastData} expanded />
                      </div>
                    )}
                  >
                    <div className="min-h-[760px] xl:h-full xl:min-h-0">
                      <L1PropagationPanel data={l1ForecastData} />
                    </div>
                  </ExpandableMissionWidget>
                )}
                center={(
                  <>
                    {/* SITUACIÓN — vista del globo + operaciones inmediatas */}
                    <div className="h-[520px] overflow-hidden rounded-lg border border-cyan-500/15 bg-slate-950/50 lg:h-[560px] xl:h-auto xl:min-h-0 xl:flex-1">
                      <VisualizationSwitcher
                        noaaMagData={noaaMagData}
                        noaaPlasmaData={noaaPlasmaData}
                        noaaEphemerisData={noaaEphemerisData}
                      />
                    </div>

                    <div className="grid min-h-[520px] gap-3 lg:grid-cols-2 xl:h-[270px] xl:min-h-[240px] xl:shrink-0">
                      <ExpandableMissionWidget
                        title="Forecast Heatmaps"
                        detail={(
                          <div className="h-full min-h-[620px]">
                            <ArrivalHeatmapPanel data={l1ForecastData} expanded />
                          </div>
                        )}
                      >
                        <div className="h-full min-h-[240px]">
                          <ArrivalHeatmapPanel data={l1ForecastData} />
                        </div>
                      </ExpandableMissionWidget>

                      <ExpandableMissionWidget
                        title="NOAA Alerts"
                        detail={(
                          <div className="h-full min-h-[620px]">
                            <AlertsPanel noaaAlertsData={noaaAlertsData} />
                          </div>
                        )}
                      >
                        <div className="h-full min-h-[240px]">
                          <AlertsPanel compact noaaAlertsData={noaaAlertsData} />
                        </div>
                      </ExpandableMissionWidget>
                    </div>
                  </>
                )}
                rightTop={(
                  /* PRONÓSTICO · IMPACTO — asesoría del satélite (mitad de arriba, redimensionable) */
                  <ExpandableMissionWidget
                    title="Satellite Operator Report"
                    className="xl:h-full"
                    detail={(
                      <div className="h-full min-h-[620px]">
                        <SatelliteOperatorReport
                          noaaMagData={noaaMagData}
                          noaaPlasmaData={noaaPlasmaData}
                          noaaEphemerisData={noaaEphemerisData}
                          kp={l1ForecastData.latest.kp}
                        />
                      </div>
                    )}
                  >
                    <div className="min-h-[430px] xl:h-full xl:min-h-0">
                      <SatelliteOperatorReport
                        compact
                        noaaMagData={noaaMagData}
                        noaaPlasmaData={noaaPlasmaData}
                        noaaEphemerisData={noaaEphemerisData}
                        kp={l1ForecastData.latest.kp}
                      />
                    </div>
                  </ExpandableMissionWidget>
                )}
                rightBottom={(
                  /* PRONÓSTICO · IMPACTO — watch-list con umbrales (mitad de abajo, redimensionable) */
                  <ExpandableMissionWidget
                    title="Selected Satellite"
                    className="xl:h-full"
                    detail={(
                      <div className="h-full min-h-[620px]">
                        <SatelliteWatchlistPanel
                          noaaMagData={noaaMagData}
                          noaaPlasmaData={noaaPlasmaData}
                          kp={l1ForecastData.latest.kp}
                        />
                      </div>
                    )}
                  >
                    <div className="min-h-[240px] xl:h-full xl:min-h-0">
                      <SatelliteWatchlistPanel
                        compact
                        noaaMagData={noaaMagData}
                        noaaPlasmaData={noaaPlasmaData}
                        kp={l1ForecastData.latest.kp}
                      />
                    </div>
                  </ExpandableMissionWidget>
                )}
                diagnostics={(
                  <>
                    {/* DIAGNÓSTICO — contexto/salud de datos, plegado por defecto */}
                    <div className="min-h-[150px]">
                      <DataReadinessPanel
                        noaaMagData={noaaMagData}
                        noaaPlasmaData={noaaPlasmaData}
                        noaaAlertsData={noaaAlertsData}
                      />
                    </div>
                    <div className="min-h-[300px]">
                      <ModelThresholdsPanel compact />
                    </div>
                  </>
                )}
              />
            </main>
          </SatelliteWatchProvider>
        </SatelliteConfigProvider>
      </SatelliteSelectionProvider>
    </AppShell>
  );
}
