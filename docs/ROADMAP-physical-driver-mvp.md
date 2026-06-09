# 🛰️ Roadmap — HELIOSAT: del proxy G/Kp al forecast de *drivers físicos* (L1 → bow-shock)

**Reenfoque del MVP.** El producto central deja de ser el "nivel G" y pasa a ser el
**forecast de los drivers físicos del viento solar** medidos en L1 y propagados al
*bow-shock nose* de la Tierra (Vsw, n_p, Bz, |B|, y derivados Pdyn, Em, acoplo de Newell).
El **G/Kp** queda como un **proxy operativo derivado** y una **respuesta de validación**,
nunca como la variable medida/predicha central.

**OMNI.** Deja de ser una **fuente operativa** del console (gráficas en vivo, corredor,
Kp). Según la descripción del proyecto y `docs/heliosat-next-development-prompts.md`
(Prompt 4), OMNI *time-shifted al bow-shock* es la **verdad de validación offline** — ver
**Decisión D1** sobre si se conserva solo ahí o se elimina por completo.

> **Stack (sin cambios):** Next.js 16 + TypeScript + Supabase + rutas API. **No** se
> migra a Python/FastAPI. Todo el trabajo es sobre el MVP actual.

---

## ✅ Estado actual (ya hecho)

- Plataforma pública desplegada en Vercel; gate de admin por cookie; RLS en Supabase.
- **API v1** `GET /api/v1/forecast/realtime` con contrato **físico ya ampliado**
  (`propagated_variables`, `derived_features`, `quality_flags`, `confidence`,
  `limitations`, `estimated_g_level_proxy`, `model_version`, `distance_source`…) +
  `GET /api/v1/status`. Auth por API key, rate-limit, cron de precálculo (GitHub Actions).
- Console con 3 pestañas: **Real-time Forecast**, **Training Data**, **Validation & Studies**.
- Real-time: corredor L1→Earth (heatmap en vivo + replay histórico por `transitCorridorService`).
- Validación: arrival-accuracy, timing y backtest (basados en OMNI `Timeshift`).

---

## Fase 0 — Sacar OMNI del console *operativo* 🔌 (~1 día)

**Objetivo:** que el camino operativo (Real-time + corredor) corra **solo** con datos en
vivo de L1 (NOAA SWPC / DSCOVR, ACE de respaldo) + GOES (contexto GEO) + índices de tierra
(Kp/Dst/SYM-H de sus fuentes propias), **sin OMNI**.

- [ ] **`transitCorridorService.ts`** — eliminar el fallback `sliceArchive`
  (`omni_reference`); el heatmap histórico se construye desde la cola en vivo + (opcional)
  archivo **ACE**. Si para una ventana no hay datos no-OMNI → mostrar "no data" honesto.
- [ ] **`api/console/series/route.ts`** — eliminar la fuente `omni` (1y/5y) y la línea
  "near-Earth OMNI truth" de `compare`; las gráficas en vivo (24h/7d/30d) quedan con
  **L1 en vivo + ACE + MRU**. Mover el rango histórico largo a un estudio de validación.
- [ ] **`ConsoleScreen.tsx`** — quitar la serie/leyenda/toggle "L1 · OMNI", el bloque de
  estado/`build` del archivo OMNI en la pestaña operativa, y las etiquetas de fuente OMNI.
- [ ] **Kp/Dst operativos** — donde el console mostraba Kp desde el archivo OMNI, usar la
  fuente de índices en tiempo real (NOAA / servicio de índices), no OMNI.
- [ ] **Decisión D1** *(crítica — contradice la descripción del proyecto):* ¿se elimina
  OMNI **también** de la validación offline (arrival/timing/backtest/variable-alignment) o
  se conserva ahí como verdad de validación? *(Recomendado: conservar en validación; ver
  Fase 5. Si total → hay que definir una nueva verdad de validación primero.)*

**Entregable:** Real-time y corredor sin ninguna dependencia de OMNI; build + lint verdes.

---

## Fase 1 — Reenfoque a *drivers físicos* (no G/Kp) 🧭 (~1-2 días)

**Objetivo:** que el producto comunique y exponga **drivers físicos** como núcleo, con
G/Kp claramente etiquetado como proxy. (Prompt 1.)

- [ ] **Audit** del producto contra las 3 pestañas; backlog priorizado (≤10 ítems).
- [ ] Real-time: encabezar con "qué mide L1 ahora", "qué viene de camino", "cuándo llega",
  "qué driver físico domina"; degradar la tarjeta G a "estimated response / proxy".
- [ ] Renombrar/aclarar copy donde se sugiera que Kp/G es medido o es el forecast central.

**Entregable:** narrativa y UI centradas en drivers físicos; G como proxy explícito.

---

## Fase 2 — Endurecer el contrato de la API física 🔒 (~0.5-1 día)

**Objetivo:** cerrar el contrato físico de `/api/v1` (Prompt 2). *Gran parte ya está hecho.*

- [ ] Verificar/cerrar `quality_flags` (stale source, gaps), `confidence`
  (degradar si falta `speed`), `arrival_uncertainty_minutes` (configurable, ~10-15 min).
- [ ] Asegurar que **no** se implica que Kp/G es medido o predicho como producto central.
- [ ] `docs/api-v1.md`: un ejemplo JSON realista + sección "scientific meaning".

**Entregable:** contrato v1 estable, físico y operador-facing; `lint` + `build` verdes.

---

## Fase 3 — Derived features, eventos y capa de *hazard* ⚙️ (~2-3 días)

**Objetivo:** capa transparente de interpretación de riesgo sobre el forecast físico
(reglas, sin ML). (Prompt 3.)

- [ ] Consolidar derived features: `Pdyn` (nPa), `Em` (mV/m), `min Bz` y `max Pdyn`/`Em`
  en ventanas 15/30/60 min, gradientes de Vsw/n/Bz/Pdyn.
- [ ] Detección de eventos sobre el forecast propagado: `incoming_shock`,
  `southward_bz_interval`, `high_dynamic_pressure_interval`, `high_coupling_interval`,
  `geomagnetic_risk_window`.
- [ ] Hazard basado en reglas: severity (low/moderate/high/severe), confidence, main_driver,
  physical_drivers, expected_start/peak/end_utc, lead_time, operator_message,
  `estimated_g_level_proxy` (etiquetado como proxy).
- [ ] Exponer vía `/api/v1` (público estable) y/o `/api/console` (UI interna). Funciones
  puras + tests/verificación manual.

**Entregable:** eventos + ventana de riesgo + mensaje al operador, todo trazable a medidas.

---

## Fase 4 — Capa de *severity* calibrada (Kp/G como proxy) 📈 (~3-5 días)

**Objetivo:** sustituir la heurística manual Kp→G por un mapeo **calibrado** sobre
histórico, manteniéndolo como proxy derivado. (Descripción §Severity + Prompt 3/4.)

- [ ] Inputs = coupling (Newell `dΦ/dt`, `Em`) + drivers en ventana. Modelo simple e
  interpretable primero (regresión regularizada / GBT; ordinal o logístico para
  `P(G≥G_i)` en G1/G2/G3) antes que secuencias.
- [ ] **Decisión D2 — target:** Kp (3 h) vs **SYM-H/Dst** (1-min, mejor casado con lead de
  minutos) — o ambos. *(Recomendado: empezar con SYM-H/Dst por la cadencia.)*
- [ ] **Baselines obligatorios a batir:** persistencia y recurrencia a 27 días.
- [ ] Validar sobre el mismo span multi-año que la validación de timing.

**Entregable:** proxy G calibrado y validado, con baselines superados y traza a drivers.

---

## Fase 5 — *Validation & Studies* clarificada y honesta 🔬 (~2 días)

**Objetivo:** separar y explicar los estudios; aquí **vive OMNI** como verdad (si D1 =
conservar). (Prompt 4.)

- [ ] Separar 4 estudios: (1) **arrival-time** (MRU vs OMNI `Timeshift`), (2)
  **variable-alignment** (ACE propagado vs OMNI shifted como verdad), (3) **eventos**
  (onset/duración/pico, precision/recall), (4) **G-proxy** (vs Kp/G, claramente como proxy).
- [ ] Sección "**Data Used**" por estudio: dataset, resolución, cobertura local, rol
  (input L1 / verdad near-Earth / contexto / label), limitaciones conocidas.
- [ ] Mostrar estado del archivo local: rango+filas de ACE, OMNI, GEO; span+muestras del
  cache de arrival. No ocultar gaps ni incertidumbre.

**Entregable:** pestaña de validación científicamente clara y auditable.

---

## Fase 6 — UX del operador y documentación 📚 (~1-2 días)

**Objetivo:** pulir narrativa y docs sin cambiar arquitectura. (Prompt 5.)

- [ ] Tooltips/explicaciones compactas: OMNI Timeshift, MRU, L1, bow shock, GOES, Kp/G.
- [ ] Docs: definición científica del MVP, ejemplos de salida de API, y sección
  "**what HELIOSAT does not claim**" (no comanda satélites; no mide el viento near-Earth
  salvo por validación histórica OMNI; no predice Kp medido como variable central; G es
  proxy derivado).
- [ ] Verificar layout desktop/móvil; `lint` + `build`.

**Entregable:** console y docs coherentes con el MVP físico.

---

## Dependencias

```
Fase 0 (quitar OMNI operativo)
   └─▶ Fase 1 (reenfoque a drivers)
          └─▶ Fase 2 (contrato API físico)
                 └─▶ Fase 3 (derived features + eventos + hazard)
                        └─▶ Fase 4 (severity calibrada)   ← usa validación de Fase 5
                               └─▶ Fase 6 (UX + docs)
Fase 5 (validación) es transversal y habilita Fase 4.
```

## Decisiones pendientes

| #   | Decisión                                              | Recomendación                                  |
|-----|-------------------------------------------------------|------------------------------------------------|
| D1  | Alcance de "quitar OMNI": operativo vs **total**      | Operativo; conservar OMNI solo en validación   |
| D2  | Target de severity: Kp vs SYM-H/Dst                   | Empezar por SYM-H/Dst (cadencia 1-min)         |
| D3  | Heatmap histórico sin OMNI: ¿solo ACE o "no data"?    | ACE si hay archivo; si no, "no data" honesto   |

## Principios clave

- El **núcleo** es el forecast de drivers físicos L1 → bow-shock. G/Kp es **proxy**.
- **OMNI** = verdad de validación histórica, **no** fuente operativa.
- **GOES** = contexto de respuesta en GEO, **no** verdad del viento solar en L1.
- Todo forecast debe ser **trazable** a medidas en vivo y a una hipótesis de propagación.
- Antes de añadir complejidad (ML): pipeline físico consistente + benchmark robusto.
