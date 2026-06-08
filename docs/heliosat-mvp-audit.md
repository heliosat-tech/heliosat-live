# HelioSat MVP - Auditoría de Producto y Arquitectura

Fecha de revisión: 2026-06-08

Este documento aplica el Prompt 1 de `docs/heliosat-next-development-prompts.md` al repositorio actual. La conclusión principal es que HelioSat ya no es un proyecto greenfield: existe una aplicación Next.js 16/TypeScript con consola interna, API pública v1, precálculo vía Supabase y varias piezas de validación histórica. El trabajo siguiente debe mejorar y aclarar esa base, no sustituirla por una arquitectura Python/FastAPI paralela.

## Definición Actual Del MVP

El núcleo correcto del MVP es:

1. Medir viento solar e IMF en L1 con fuentes en vivo.
2. Propagar esos paquetes desde L1 hasta el entorno near-Earth/bow-shock con un modelo MRU/ballístico transparente.
3. Exponer llegada, lead time y variables físicas propagadas.
4. Traducir esos drivers físicos a ventanas de riesgo operativo.
5. Usar Kp/G como proxy de respuesta geomagnética y como validación contextual, no como variable física principal.

La app ya implementa buena parte de esto, pero la narrativa de API y UI todavía está demasiado centrada en `g_level`.

## Superficies Del Producto

| Área | Estado actual | Archivos principales | Comentario |
| --- | --- | --- | --- |
| Real-time Forecast | Funcional. Muestra nowcast, cola L1 inbound, gráficos y forecast log. | `src/components/console/ConsoleScreen.tsx`, `src/app/api/console/route.ts`, `src/app/api/console/nowcast/route.ts`, `src/services/realtimeForecastService.ts` | Es la pestaña más cercana al producto comercial. Debe enfatizar Vsw, Bz, Bt, densidad, Pdyn y Em antes que G. |
| Training Data | Funcional como inventario de datasets. | `src/components/console/TrainingDataPanel.tsx`, `src/app/api/console/training-data/route.ts`, `src/services/trainingDataInventory.ts` | Debe explicar roles: input L1, truth near-Earth, contexto GEO/Kp, gaps y readiness. |
| Validation & Studies | Funcional con arrival accuracy y backtest MRU. | `src/app/api/console/arrival/route.ts`, `src/app/api/console/backtest/route.ts`, `src/app/api/console/timing/route.ts`, `src/services/mruArrivalAccuracyService.ts`, `src/services/mruBacktestService.ts`, `src/services/mruTimingService.ts` | Tiene base científica buena, pero necesita una sección "Data Used" y separar timing, variable alignment, eventos y proxy G/Kp. |
| Public API v1 | Funcional, autenticada por API key y servida precalculada. | `src/app/api/v1/forecast/realtime/route.ts`, `src/app/api/v1/status/route.ts`, `src/lib/api/forecastContract.ts`, `src/services/realtimeForecastService.ts` | El contrato v1 draft es demasiado G-heavy y le faltan campos físicos/quality/uncertainty. |
| Internal/admin API | Amplia y útil para consola/playground. | `src/app/api/console/*`, `src/app/api/playground/*` | Mantener interna. No convertir playground en producto público. |
| Cron/precompute | Implementado. | `src/app/api/cron/publish-forecast/route.ts`, `.github/workflows/publish-forecast.yml`, `publishRealtimeForecast()` | Patrón correcto: cron calcula, Supabase guarda, API pública lee. |

## Servicios Clave

| Servicio | Rol |
| --- | --- |
| `liveL1HistoryService.ts` | Ingesta en vivo de NOAA SWPC: magnetómetro, plasma y efemérides L1. Une series por minuto y calcula distancia L1 si la efeméride es fiable. |
| `mruForecastService.ts` | Propagación MRU/ballística. Usa `delta_t = distance / speed`. Mantiene las variables L1 como variables propagadas. |
| `realtimeForecastService.ts` | Orquestación del nowcast real-time, mapping a contrato público, publicación en Supabase y lectura del último forecast. |
| `stormScaleService.ts` | Conversión heurística de drivers físicos a Kp/G proxy. Ya incluye Em `Vsw * max(0, -Bz) * 1e-3`. |
| `consoleForecastLog.ts` | Log de forecasts históricos recientes desde muestras L1 propagadas y verificación posterior contra Kp. |
| `liveEventService.ts` | Detección de eventos en series live/históricas. Existe base para shocks y Bz sur, pero falta producto API estable de hazard. |
| `trainingDataInventory.ts` | Inventario de datasets locales para training/experimentos. |
| `mruArrivalAccuracyService.ts` | Validación de tiempo de llegada contra OMNI Timeshift. |
| `mruBacktestService.ts` | Backtest histórico: ACE upstream como input y OMNI near-Earth como truth. |
| `mruTimingService.ts` | Distribución histórica de errores de timing MRU contra OMNI Timeshift. |

## Fuentes De Datos

| Fuente | Uso actual | Tipo | Rol científico | Limitaciones |
| --- | --- | --- | --- | --- |
| NOAA SWPC DSCOVR/L1 live | `liveL1HistoryService.ts`, consola real-time, cron/API pública | Live | Input principal para forecast L1 -> Earth | Depende de disponibilidad SWPC. Gaps/stale deben salir como quality flags. |
| NOAA SWPC ephemerides | `liveL1HistoryService.ts` | Live | Distancia L1 medida si está en rango razonable | Si falla, se usa distancia nominal 1.5e6 km. Conviene exponer `distance_source`. |
| ACE archive local | `data/console/ace-archive.json`, `aceArchiveStore.ts`, backtest | Histórico cacheado | Input upstream L1 para validación histórica | Cobertura local: 2021-01-01 a 2026-05-15, 42,404 filas. Después de 2024 hay gaps fuertes en plasma/speed. |
| OMNI archive local | `data/console/omni-archive.json`, `omniArchiveStore.ts`, backtest/training | Histórico cacheado | Truth near-Earth/time-shifted para variables solares y Kp/Dst | Cobertura local: 2021-01-01 a 2026-05-27, 47,341 filas. Es truth histórico, no feed live de predicción. |
| OMNI HRO 1-min/5-min | `mruArrivalAccuracyService.ts`, `mruTimingService.ts` | Histórico descargado/caché | Timeshift y validación de llegada L1 -> bow shock | Timeshift es una referencia derivada por OMNI, no una medición directa simple. |
| GOES/GEO archive local | `data/console/geo-archive.json`, `geoArchiveStore.ts` | Histórico cacheado | Contexto de respuesta GEO/magnetosfera | Cobertura local: 2020-12-03 a 2026-06-03, 48,060 filas. No es truth de viento solar L1. |
| NOAA storm scales / GOES R/S | `noaaStormScalesService.ts`, sidebar | Live/contextual | Observed radiation/flare context | R/S son observaciones contextuales; no deben ser core del forecast L1 -> Earth. |
| Kp/G | `stormScaleService.ts`, backtest, consola | Observado/proxy | Respuesta geomagnética para validación y operador | Kp es índice terrestre, no variable in-situ ni output físico primario. |
| Supabase | API keys, forecast_latest, auth/admin | Producción | Persistencia comercial y serving API | La API pública depende de último forecast precalculado. |
| CelesTrak/TLE | Visualización/orbit context | Live/contextual | Contexto satelital/orbital | No participa en la predicción física L1 -> Earth. |

## Datos Locales Confirmados

| Archivo | Estado |
| --- | --- |
| `data/console/arrival.json` | Validación arrival sobre evento May 2024 G5 "Gannon"; stats multianuales 2021-01-01 a 2026-05-01; fuente `omni-1min`. |
| `data/console/timing.json` | 156,441 muestras de timing, cobertura 1981-01-01 a 2026-05-14. |
| `data/console/omni-archive.json` | 47,341 filas, 2021-01-01 a 2026-05-27, actualizado 2026-06-04. |
| `data/console/ace-archive.json` | 42,404 filas, 2021-01-01 a 2026-05-15, actualizado 2026-06-04. |
| `data/console/geo-archive.json` | 48,060 filas, 2020-12-03 a 2026-06-03, actualizado 2026-06-04. |

## Supuestos Científicos Importantes

- La propagación actual es MRU/ballística: cada paquete viaja a velocidad solar-wind constante desde L1 hasta near-Earth/bow shock.
- Si la distancia por efeméride no está disponible o no es fiable, se usa distancia nominal de 1,500,000 km.
- La incertidumbre de llegada no debe ocultarse. Para el contrato público conviene exponer una incertidumbre base de unos 10-15 min hasta que haya calibración específica.
- Bz GSM sur, velocidad, densidad, Bt, presión dinámica y coupling electric field son los drivers físicos relevantes.
- El nivel G/Kp estimado es una capa interpretativa derivada, útil para operadores, pero no debe venderse como medición o predicción directa del índice observado.
- OMNI sirve para validación histórica near-Earth/time-shifted; no sustituye a la ingesta live.
- GOES es contexto de respuesta orbital/radiación, no el dato truth de solar wind.

## Puntos A Mantener

- Mantener la arquitectura Next.js 16 + TypeScript + API routes.
- Mantener las tres pestañas: Real-time Forecast, Training Data, Validation & Studies.
- Mantener el patrón de producción ya implementado: cron/precompute -> Supabase -> API pública rápida.
- Mantener MRU determinista como baseline científico explicable antes de meter ML.
- Mantener playground y rutas `/api/console` como superficies internas/admin.
- Mantener la documentación operativa de API keys, rate limit y cron.

## Puntos A Renombrar O Clarificar

- En UI y docs, cambiar el framing de "G forecast" a "physical-driver forecast + G proxy".
- En el contrato público, mantener compatibilidad v1 si hace falta, pero añadir campos físicos explícitos y marcar `g_level` como proxy.
- En Validation & Studies, añadir una sección visible de datos usados por estudio.
- En Training Data, distinguir claramente `ACE upstream input`, `OMNI near-Earth truth`, `GOES response context` y `Kp/G proxy labels`.
- En Real-time Forecast, hacer que el gráfico L1 -> Earth y las tarjetas usen la misma historia: paquete L1 actual, paquetes inbound, ETA, driver físico dominante.

## Gaps Técnicos

- El contrato `ForecastRealtimeV1` no incluye todavía `model_version`, `target`, `quality_flags`, `confidence`, `arrival_uncertainty_minutes`, `distance_source`, `propagated_variables` ni `derived_features`.
- `Pdyn` no aparece como feature centralizada/publicada, aunque las variables necesarias existen.
- Em existe en `stormScaleService.ts`, pero no está modelado como feature de forecast en el contrato público.
- Faltan rolling windows y gradientes como capa común de features para forecast/eventos.
- Hay detección de eventos en `liveEventService.ts`, pero falta una API estable de events/hazard bajo `/api/v1`.
- Validation & Studies no deja suficientemente claro qué datasets usa cada benchmark.
- No hay script de tests en `package.json`; antes de cambios de lógica conviene añadir tests unitarios para funciones puras o, como mínimo, verificación reproducible.
- La API pública está en draft pero `docs/ROADMAP.md` la presenta como lista para cliente; conviene endurecer contrato antes de entregar una key real.

## Backlog Priorizado

### Real-time Forecast

1. Endurecer contrato público de `/api/v1/forecast/realtime` con campos físicos, incertidumbre, quality flags y `estimated_g_level_proxy`.
2. Centralizar derived features: Pdyn, Em, rolling min/max y gradientes.
3. Alinear la visual CME/L1 -> Earth con los mismos paquetes propagados que alimentan charts/API.
4. Añadir detección y resumen de driver dominante: southward Bz, high speed, high Pdyn, high Em o shock-like gradient.

### Training Data

5. Añadir narrativa de roles por dataset: input, truth, response context, proxy label, candidate source.
6. Mostrar gaps críticos de ACE/OMNI/GOES y readiness por variable, no solo cobertura temporal.

### Validation & Studies

7. Añadir "Data Used" dentro de la pestaña: dataset, resolución, cobertura, rol y limitaciones.
8. Separar explícitamente arrival-time validation, variable-alignment validation, event validation y G-level proxy validation.
9. Incorporar métricas de eventos cuando la capa hazard esté estable: precision/recall, onset error, duration error y peak error.

### API Y Documentación

10. Actualizar `docs/api-v1.md` y añadir una sección "What HelioSat does not claim": no mide near-Earth live directamente, no predice Kp como variable física primaria, no comanda satélites y no sustituye alertas oficiales.

## Siguiente Prompt Recomendado

Aplicar el Prompt 2: `Physical Forecast API Contract Hardening`.

Motivo: es el cuello de botella comercial y científico. Antes de añadir más UI o hazard, conviene que la API pública y los tipos internos nombren correctamente lo que HelioSat predice: llegada y variables físicas propagadas, con incertidumbre y calidad explícitas. Esto permite que Real-time Forecast, Training Data y Validation & Studies hablen el mismo lenguaje.
