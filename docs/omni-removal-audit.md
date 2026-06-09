# OMNI Removal — Full Audit & Phased Plan (HelioSat Next.js MVP)

Goal: remove OMNI from the **main MVP data pipeline, UI narrative, and validation
narrative**. OMNI may remain only as an **optional legacy/internal benchmark**; it must
not be used by the main MVP pages, the main validation statistics, or the public API.

**Action legend**
- **REMOVE** — on a main MVP path (operational pages / main validation / public API). OMNI must go.
- **HIDE** — UI/copy that surfaces OMNI on a main page; remove the line/label/narrative.
- **LEGACY** — internal/research code (playground, offline benchmark); may stay if disconnected from the main MVP and not presented as the headline truth.

**Replacement key:** `L1-hist` = ACE `AC_H2_MFI`/`AC_H2_SWE` (DSCOVR/Wind backup) · `GEO` = GOES (proton/electron/X-ray/magnetometer) · `GND` = Kp/Dst/SYM-H (GFZ/Kyoto/NCEI) · `—` = none needed.

---

## 1. Public API & live forecast — already OMNI-free ✅

| File | Function/Component | Current OMNI usage | Action | Replacement |
|---|---|---|---|---|
| `src/app/api/v1/forecast/realtime/route.ts` | GET v1 forecast | none | KEEP | — |
| `src/app/api/v1/status/route.ts` | GET status | none | KEEP | — |
| `src/lib/api/forecastContract.ts` | v1 types | none | KEEP | — |
| `src/services/realtimeForecastService.ts` | compute/publish forecast | none (NOAA SWPC L1 only) | KEEP | — |

**Finding:** the public product is already clean. Only lock the wording (no "near-Earth"; G as proxy).

---

## 2. Operational console — Real-time tab, transit corridor, live charts

| File | Function/Component | Current OMNI usage | Action | Replacement |
|---|---|---|---|---|
| `src/services/transitCorridorService.ts` | `buildTransitCorridorSeries` | `sliceArchive` OMNI fallback (`omni_reference` candidate) for the heatmap history | **REMOVE** | L1-hist (ACE) + live tail; else honest "no data" |
| `src/app/api/console/series/route.ts` | `computeSeries`, `WINDOWS` | `source:'omni'` (1y/5y charts); `compare` near-Earth OMNI "truth" line; `fetchOmniHourlyHistory`; Kp from OMNI | **REMOVE** | L1-hist (ACE) line; GND for Kp/Dst |
| `src/components/console/ConsoleScreen.tsx` | charts, legend, `ArchiveStatus` UI | "L1 · OMNI" line/legend/toggle/info; OMNI archive build+status panel; `source:'omni'` label/type | **HIDE/REMOVE** | ACE line; archive UI → ACE-only |
| `src/services/consoleSeriesCache.ts` | `read/writeSeriesCache` | generic disk cache (comment mentions OMNI) | KEEP | — (stops caching OMNI once §2 series change) |
| `src/services/dataCoverageService.ts` | `DEFAULT_COVERAGE_DATASETS` | `'OMNI_HRO_1MIN'` in coverage anchor | **REMOVE** | `AC_K0_SWE`/ACE + GEO/GND datasets |

---

## 3. Validation & Studies tab — the **main validation statistics** (all OMNI today)

All current validation uses OMNI `Timeshift`/near-Earth as the truth. Under the new
architecture the headline validation is **operational relevance** (did an L1 driver precede
a real GOES + ground response inside the predicted window). The OMNI-based studies should
be **demoted to optional legacy benchmark**, not deleted blindly, and only **after** the new
validation exists (otherwise we lose validation in the interim).

| File | Function/Component | Current OMNI usage | Action | Replacement |
|---|---|---|---|---|
| `src/services/mruArrivalAccuracyService.ts` | `computeArrivalAccuracy` | arrival error vs OMNI `Timeshift` (5-yr stats; Kp strata from OMNI archive) | **REMOVE as headline → LEGACY** | New: driver→GEO/GND response validation |
| `src/app/api/console/arrival/route.ts` | GET arrival | serves the above | REMOVE-from-main / LEGACY | new validation route |
| `src/services/mruTimingService.ts` | `computeMruTimingStats` | timing distribution vs OMNI `Timeshift` (1981–2026) | LEGACY (optional cross-check) | GEO/GND lag distribution |
| `src/app/api/console/timing/route.ts` | GET timing | serves the above | LEGACY | — |
| `src/services/mruBacktestService.ts` | `computeBacktest` | ACE propagated scored vs OMNI near-Earth truth | LEGACY | ACE→GEO/GND skill |
| `src/app/api/console/backtest/route.ts` | GET backtest | serves the above | LEGACY | — |
| `src/services/mruValidationService.ts` | variable-alignment | ACE input vs OMNI HRO 1-min "Earth truth" | LEGACY | (no near-Earth SW truth without OMNI; keep as optional) |
| `src/app/api/console/validation-data/route.ts` | GET "Data Used" | reports OMNI archive status + OMNI-based study roles | **REMOVE OMNI rows** | GEO + GND archive status; keep ACE |
| `src/app/api/console/archive/route.ts` | `buildOmniArchive`/report | builds & reports the OMNI archive | REMOVE-from-main / LEGACY | build ACE (+ GEO/GND) archives |

---

## 4. Training Data tab & Playground — internal research (legacy)

The playground (experiments, exploration, historic plots, ML) uses OMNI as "Earth truth"
for ACE→OMNI training/exploration. It is internal research, not a main MVP page, so it can
remain **LEGACY**; only fix wording (OMNI is not the main validation truth) and relabel it
clearly as legacy/optional.

| File | Function/Component | Current OMNI usage | Action | Replacement |
|---|---|---|---|---|
| `src/services/l1EarthData.ts` | `fetchAceOmniSamples` | fetches ACE (L1) + OMNI (Earth) together | LEGACY | drop OMNI half → ACE-only, or keep as optional |
| `src/services/explorationService.ts` | coupling/univariate | ACE vs OMNI lag/correlation | LEGACY | — |
| `src/services/historicPlotService.ts` | `buildOmniCharts` | OMNI HRO chart deck (`omni-hro`) | LEGACY/HIDE | ACE/GOES/GND charts |
| `src/services/forecastHistoryService.ts` | history `1m`/`1y` | OMNI hourly for long ranges | LEGACY | L1-hist (ACE) for `1y` |
| `src/services/mlModelService.ts` | training | trains ACE→OMNI (bakes ACE→OMNI offset) | LEGACY | ACE-only / GND labels |
| `src/services/goesImpactService.ts` | GOES impact model | `fetchAceOmniSamples` for L1 input | LEGACY | use ACE-only L1 input |
| `src/services/liveEventService.ts` / `liveEventStore.ts` | `omniHourly` preset / OMNI catalog | OMNI-window event detection/catalog | LEGACY | RTSW/ACE event log |
| `src/services/trainingDataInventory.ts` | `archiveDataset('omni-archive.json')` | lists OMNI archive as a dataset | RELABEL LEGACY | add GEO/GND datasets |
| `src/services/trainingExperimentConfig.ts` | `l1_source` options | `omni_hro_1min` option | RELABEL LEGACY | `ace_*` options |
| `src/services/physicalDriverResolutionService.ts` | source enum | `'omni_reference'` value | KEEP (enum) / LEGACY | — |
| `src/services/spaceWeatherSourceCatalog.ts` | catalog | `omni-hro` entry | RELABEL LEGACY | — |
| `src/services/pipeline/connectorRegistry.ts` | connectors | `'omni-hro':'hapi'` | KEEP/LEGACY | — |
| `src/app/api/playground/forecast-history/route.ts` | history/catalog | rebuilds catalog from OMNI window | LEGACY | ACE/GND |
| `src/app/api/playground/training-data/route.ts` | training inventory | dataset lists include `OMNI_HRO_1MIN` | RELABEL LEGACY | ACE + GEO/GND |
| `src/app/api/playground/live-forecast-ml/route.ts` | live ML | comment: avoid ACE→OMNI bias | KEEP | — |
| `src/components/playground/*` (Exploration*, ModelsOverview, MruValidation, MruLiveForecast, DataQuality, HistoricAvailabilityCalendar, PlaygroundDashboard, experimentDataDependencies, playgroundScreenInfo) | panels/copy | render/label OMNI as Earth truth | RELABEL LEGACY / fix wording | — |

---

## 5. Dedicated OMNI plumbing

| File | Current OMNI usage | Action | Replacement |
|---|---|---|---|
| `src/services/omniArchiveStore.ts` | builds/slices local OMNI2 hourly archive + Kp/Dst | **LEGACY** (disconnect from main consumers in §2/§3) | ACE archive + GND |
| `src/services/omniHistoryService.ts` | OMNI hourly via HAPI (`OMNI2_H0_MRG1HR`) | **LEGACY** | ACE history + GND |
| `data/console/omni-archive.json` | cached OMNI archive (gitignored, local) | DELETE locally once unused | — |

---

## 6. Docs, types, sample JSON, tests

| File | OMNI usage | Action |
|---|---|---|
| `docs/api-v1.md`, `docs/operations.md` | none | KEEP ✅ |
| `docs/ROADMAP.md` (old) | Fase 2 mentions omni-archive disk write | UPDATE narrative |
| `docs/heliosat-mvp-audit.md` | presents OMNI as validation truth | UPDATE to no-OMNI framing |
| `docs/report/heliosat-university-report.tex`, `docs/report/make_plots.py` | the 5-yr/45-yr validation IS OMNI-based | KEEP as historical record; annotate "OMNI-era validation" |
| `docs/ROADMAP-physical-driver-mvp.md`, `docs/heliosat-next-development-prompts.md` | reference OMNI as the thing being removed | KEEP (planning) |
| `data/space-weather-variable-catalog.yaml` | OMNI entry | RELABEL LEGACY |
| Types: `'live'|'compare'|'omni'` (series), `source:'rtsw'|'omni'` (forecastHistory), `'omni_reference'` (driver resolution) | OMNI in unions | REMOVE `'omni'` from operational unions (§2); keep enum values used by legacy |
| `src/services/*.test.ts` (2 files) | none | KEEP ✅ |

---

## 7. Phased implementation plan (no code yet)

**Phase 1 — Lock the clean core (low effort).**
Confirm `/api/v1` + `realtimeForecastService` stay OMNI-free; enforce wording discipline
(no "near-Earth"; G = proxy; GOES = context; OMNI ≠ truth) in the main pages/docs.

**Phase 2 — Operational console off OMNI.**
`series/route.ts`: drop `source:'omni'` and the `compare` OMNI truth line → charts on L1
live + ACE historical; Kp/Dst from ground sources. `transitCorridorService`: drop OMNI
fallback. `ConsoleScreen`: remove the "L1 · OMNI" line/legend/labels and the OMNI archive
build UI. `dataCoverageService`: drop `OMNI_HRO_1MIN`.

**Phase 3 — Ingest the new validation data (prerequisite for Phase 4).**
Add ingestion for GEO (GOES magnetometer + proton/electron/X-ray) and ground (Kp, Dst,
SYM-H) historical+live. Build local archives parallel to the ACE archive.

**Phase 4 — New validation = operational relevance (replaces OMNI headline).**
Implement driver-interval → GEO/ground response validation (hit rate, false-alarm rate,
lead-time and L1→response lag distributions) vs persistence + 27-day-recurrence baselines.
Rewire the Validation tab to this. **Demote** arrival/timing/backtest to an optional
"legacy benchmark" section (kept, flagged, not headline). Update `validation-data` "Data
Used" to GEO/GND/ACE.

**Phase 5 — Playground relabel (lower priority).**
Mark all OMNI-based exploration/ML/training as LEGACY in copy and inventory; optionally
switch ACE→OMNI training truth to ACE-only or ground labels. No urgent functional change.

**Phase 6 — Docs & wording sweep.**
Update ROADMAP/audit to the no-OMNI framing; add "what HelioSat does not claim"; annotate
the university report as OMNI-era validation. `lint` + `build`.

**Dependencies:** P2 independent · P4 requires P3 · demote OMNI validation only after P4 ships.

---

## 8. Key decisions

| # | Decision | Recommendation |
|---|---|---|
| K1 | OMNI services (`omniArchiveStore`, `omniHistoryService`, mru*Validation): delete vs keep as dormant LEGACY | Keep as LEGACY (lower risk; optional cross-check), disconnected from main MVP |
| K2 | Variable-alignment validation has **no** non-OMNI near-Earth solar-wind truth | Accept: validate operational relevance vs GEO/GND instead; keep ACE↔OMNI as optional legacy |
| K3 | Long-range (1y/5y) console charts without OMNI | Use ACE historical archive; if absent, show "no data" honestly |
| K4 | University report (OMNI-based results) | Keep as historical record; future validation re-run on GEO/GND |
