import { AppShell } from '@/components/layout/AppShell';
import { ExpandableMissionWidget, ResizableMissionLayout } from '@/components/layout/ResizableMissionLayout';
import { TopStatusBar, type SourceStatus } from '@/components/layout/TopStatusBar';
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
import { fetchTleGroup } from '@/services/celestrakService';
import { buildL1ForecastPanelData } from '@/services/l1ForecastPanelService';
import { fetchNoaaStormScales } from '@/services/noaaStormScalesService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function Home() {
  const [noaaMagData, noaaPlasmaData, noaaEphemerisData, noaaAlertsData, celestrakData, l1ForecastData, stormScalesData] = await Promise.all([
    fetchNoaaMagnetometerData(),
    fetchNoaaPlasmaData(),
    fetchNoaaEphemerisData(),
    fetchNoaaAlerts(),
    fetchTleGroup('stations'),
    buildL1ForecastPanelData(),
    fetchNoaaStormScales(),
  ]);

  const isNoaaConnected = noaaMagData.isConnected || noaaPlasmaData.isConnected;
  const magTime = noaaMagData.lastUpdated ? new Date(noaaMagData.lastUpdated).getTime() : 0;
  const plasmaTime = noaaPlasmaData.lastUpdated ? new Date(noaaPlasmaData.lastUpdated).getTime() : 0;
  const lastUpdated = magTime > plasmaTime ? noaaMagData.lastUpdated : (plasmaTime > 0 ? noaaPlasmaData.lastUpdated : null);
  const partialAvailability = (noaaMagData.isConnected && !noaaPlasmaData.isConnected) || (!noaaMagData.isConnected && noaaPlasmaData.isConnected);

  // One extensible list of the live feeds, shown in the header's "Data sources" dropdown.
  const sources: SourceStatus[] = [
    { name: 'NOAA Solar Wind (RTSW)', connected: isNoaaConnected, partial: partialAvailability, lastUpdated },
    { name: 'NOAA Alerts', connected: noaaAlertsData.isConnected, lastUpdated: noaaAlertsData.lastUpdated },
    { name: 'NOAA Storm Scales (G/S/R)', connected: stormScalesData.observed !== null, lastUpdated: stormScalesData.observed?.observedAtUtc ?? stormScalesData.fetchedAtUtc },
    { name: 'CelesTrak (TLE)', connected: celestrakData.isConnected, stale: celestrakData.stale, lastUpdated: celestrakData.lastUpdated },
  ];

  return (
    <AppShell>
      <TopStatusBar sources={sources} />

      <SatelliteSelectionProvider>
        <SatelliteConfigProvider initialTleData={celestrakData}>
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
                        celestrakData={celestrakData}
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
