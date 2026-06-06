import { AppShell } from '@/components/layout/AppShell';
import { TopStatusBar } from '@/components/layout/TopStatusBar';
import { SolarWindPanel } from '@/components/panels/SolarWindPanel';
import { SelectedSatellitePanel } from '@/components/panels/SelectedSatellitePanel';
import { AlertsPanel } from '@/components/panels/AlertsPanel';
import { DataReadinessPanel } from '@/components/panels/DataReadinessPanel';
import { ForecastModulePanel } from '@/components/panels/ForecastModulePanel';
import { PhysicalFluxPanel } from '@/components/panels/PhysicalFluxPanel';
import { SatelliteOperatorReport } from '@/components/panels/SatelliteOperatorReport';
import { ModelThresholdsPanel } from '@/components/panels/ModelThresholdsPanel';
import { VisualizationSwitcher } from '@/components/globe/VisualizationSwitcher';
import { SatelliteSelectionProvider } from '@/contexts/SatelliteSelectionContext';
import { SatelliteConfigProvider } from '@/contexts/SatelliteConfigContext';
import { fetchNoaaEphemerisData, fetchNoaaMagnetometerData, fetchNoaaPlasmaData } from '@/services/noaaSolarWindService';
import { fetchNoaaAlerts } from '@/services/noaaAlertsService';
import { fetchTleGroup } from '@/services/celestrakService';

export default async function Home() {
  const [noaaMagData, noaaPlasmaData, noaaEphemerisData, noaaAlertsData, celestrakData] = await Promise.all([
    fetchNoaaMagnetometerData(),
    fetchNoaaPlasmaData(),
    fetchNoaaEphemerisData(),
    fetchNoaaAlerts(),
    fetchTleGroup('stations'),
  ]);

  const isNoaaConnected = noaaMagData.isConnected || noaaPlasmaData.isConnected;
  const magTime = noaaMagData.lastUpdated ? new Date(noaaMagData.lastUpdated).getTime() : 0;
  const plasmaTime = noaaPlasmaData.lastUpdated ? new Date(noaaPlasmaData.lastUpdated).getTime() : 0;
  const lastUpdated = magTime > plasmaTime ? noaaMagData.lastUpdated : (plasmaTime > 0 ? noaaPlasmaData.lastUpdated : null);
  const partialAvailability = (noaaMagData.isConnected && !noaaPlasmaData.isConnected) || (!noaaMagData.isConnected && noaaPlasmaData.isConnected);

  return (
    <AppShell>
      <TopStatusBar
        noaaMagConnected={isNoaaConnected}
        noaaMagLastUpdated={lastUpdated}
        noaaMagPartial={partialAvailability}
        noaaAlertsConnected={noaaAlertsData.isConnected}
        noaaAlertsLastUpdated={noaaAlertsData.lastUpdated}
        celesTrakConnected={celestrakData.isConnected}
        celesTrakLastUpdated={celestrakData.lastUpdated}
      />

      <SatelliteSelectionProvider>
        <SatelliteConfigProvider initialTleData={celestrakData}>
          <main className="min-h-0 flex-1 overflow-visible xl:overflow-hidden">
            <div className="grid min-h-0 grid-cols-1 gap-3 lg:grid-cols-[340px_minmax(0,1fr)] xl:h-full xl:grid-cols-[360px_minmax(0,1fr)_370px]">
              <aside className="min-h-0 space-y-3 xl:h-full xl:overflow-y-auto xl:pr-1">
                <div className="min-h-[560px] xl:h-[58vh] xl:min-h-[460px]">
                  <SolarWindPanel
                    noaaMagData={noaaMagData}
                    noaaPlasmaData={noaaPlasmaData}
                    noaaEphemerisData={noaaEphemerisData}
                  />
                </div>

                <div className="min-h-[420px] xl:h-[36vh] xl:min-h-[340px]">
                  <PhysicalFluxPanel
                    compact
                    noaaMagData={noaaMagData}
                    noaaPlasmaData={noaaPlasmaData}
                  />
                </div>
              </aside>

              <section className="min-h-0 min-w-0 space-y-3 lg:flex lg:flex-col lg:space-y-0 xl:h-full xl:overflow-hidden">
                <div className="h-[520px] overflow-hidden rounded-lg border border-cyan-500/15 bg-slate-950/50 lg:h-[560px] xl:h-auto xl:min-h-0 xl:flex-1">
                  <VisualizationSwitcher
                    noaaMagData={noaaMagData}
                    noaaPlasmaData={noaaPlasmaData}
                    noaaEphemerisData={noaaEphemerisData}
                  />
                </div>

                <div className="grid min-h-[520px] gap-3 lg:grid-cols-2 xl:h-[285px] xl:min-h-[250px] xl:shrink-0">
                  <SatelliteOperatorReport
                    compact
                    noaaMagData={noaaMagData}
                    noaaPlasmaData={noaaPlasmaData}
                    noaaEphemerisData={noaaEphemerisData}
                  />
                  <AlertsPanel compact noaaAlertsData={noaaAlertsData} />
                </div>
              </section>

              <aside className="min-h-0 space-y-3 lg:col-span-2 lg:grid lg:grid-cols-2 lg:gap-3 lg:space-y-0 xl:col-span-1 xl:block xl:h-full xl:overflow-y-auto xl:pr-1 xl:space-y-3">
                <div className="min-h-[240px] xl:h-[220px] xl:min-h-0">
                  <SelectedSatellitePanel />
                </div>

                <div className="min-h-[240px] xl:h-[150px] xl:min-h-0">
                  <DataReadinessPanel
                    noaaMagData={noaaMagData}
                    noaaPlasmaData={noaaPlasmaData}
                    noaaAlertsData={noaaAlertsData}
                    celestrakData={celestrakData}
                  />
                </div>

                <div className="min-h-[430px] xl:h-[370px] xl:min-h-0">
                  <ForecastModulePanel
                    compact
                    noaaPlasmaData={noaaPlasmaData}
                    noaaEphemerisData={noaaEphemerisData}
                  />
                </div>

                <div className="min-h-[280px] xl:h-[300px] xl:min-h-0">
                  <ModelThresholdsPanel compact />
                </div>
              </aside>
            </div>
          </main>
        </SatelliteConfigProvider>
      </SatelliteSelectionProvider>
    </AppShell>
  );
}
