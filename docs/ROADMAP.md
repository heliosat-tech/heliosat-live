# 🗺️ Roadmap HELIOSAT: de repo privado a plataforma + API comercial

De "no hay nada publicado" a "clientes consumiendo nuestra API".
Ordenado por fases; cada una se apoya en la anterior.

> **Stack:** Next.js 16 + Supabase. Repo: `jnavasg16/HELIOSAT`. Rama de producción: `main`.

---

## Fase 0 — Pre-vuelo ✈️ (~30 min)
**Objetivo:** asegurar que lo que vamos a desplegar arranca limpio.

- [X] **Build verde en local** — `npm run build`. Si sale algún error, arreglarlo antes de tocar Vercel.
- [X] **Confirmar las 2 variables** que la app necesita:
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- [X (no importa)] **Decisión D0.1 — dominio:** ¿basta `heliosat.vercel.app`, o queremos dominio propio (`heliosat.com`)? *(El dominio propio se puede añadir luego sin rehacer nada.)*

---

## Fase 1 — Publicar la plataforma en Vercel 🚀 (~1 h)
**Objetivo:** que cualquiera pueda ver la web pública online. **Cimiento de todo lo demás.**

- [X] Crear cuenta en Vercel con GitHub → **Import** del repo `jnavasg16/HELIOSAT`.
- [X] **Production Branch = `main`** (main ya contiene todo el trabajo).
- [X] Pegar las 2 env vars en Vercel. **NO** poner `HELIOSAT_DISABLE_ADMIN_GATE` (abriría el playground a cualquiera).
- [X] Deploy → obtener la URL.
- [X] **Supabase → Authentication → URL Configuration:** añadir la URL de Vercel a *Site URL* y `…/auth/callback` a *Redirect URLs* (si no, el login falla en producción).
- [X] **Verificar en vivo:** home con datos NOAA/Celestrak en directo; `/playground` y `/console` piden login (gate de admin OK).

**Entregable:** plataforma pública visible 24/7. 🎉

---

## Fase 2 — Endurecer producción 🔒 (~2-3 h)
**Objetivo:** cerrar los cabos que en serverless se comportan distinto que en local.

- [X] **RLS en Supabase:** RLS habilitado en las 4 tablas (`profiles`, `experiments`, `experiment_runs`, `predictions`) con políticas por `auth.uid()` — ver `supabase/admin-profiles.sql` y `supabase/training-experiments.sql`. *(Confirmar en el dashboard que esos SQL se ejecutaron en el proyecto en vivo: Database → Tables → cada tabla debe marcar "RLS enabled".)*
- [X] **Rutas que escriben a disco → Opción A (solo local).** Toda la escritura a disco se centraliza en `src/lib/fsCache.ts` (`writeJsonFileBestEffort`): en el FS de solo-lectura de Vercel el guardado se ignora sin petar (la ruta sigue sirviendo el valor recién calculado); en local funciona idéntico (calcula + cachea). Aplicado a **todas** las rutas/servicios internos con el mismo fallo, no solo `arrival`/`timing`: `omni-archive`, `ace-archive`, `console/series`, `live-events`, `console-events`, `goes-impact`, `ml-model`. *(Recordatorio: todas estas superficies son admin-only; la web pública no escribe a disco.)*
- [X] **Decisión D2.1 → A.** Las herramientas internas (console/playground) son **solo locales** por ahora. La migración a Supabase (opción B) queda para más adelante; encaja con Fases 3-4.

---

## Fase 3 — Cimientos de la API para clientes 🔑 (~1-2 días)
**Objetivo:** superficie pública, versionada y autenticada por API key, **separada** de las rutas internas.

- [X] **Contrato JSON v1** definido en `src/lib/api/forecastContract.ts` (`ForecastRealtimeV1`) y documentado en `docs/api-v1.md`: `observed` (velocidad, Bz, densidad, nivel G), `arrival` (ETA + lag de tránsito), `inbound_peak`, `issued_at`/`observed_at`. *(Es **v1 draft**: revisarlo antes de entregar la primera key — al integrarse un cliente queda congelado, solo cambios aditivos.)*
- [X] **Tabla `api_keys` en Supabase** (`supabase/api-keys.sql`): clave **hasheada** (SHA-256, nunca en claro), `company`, `is_active`, `rate_limit_per_min`, `expires_at`, `request_count`/`last_used_at`. RLS ON sin políticas → solo accesible por service-role.
- [X] **Auth por API key** (`src/lib/api/apiKeyAuth.ts`): parsea `Authorization: Bearer <key>`, la hashea y la valida vía la función SQL `consume_api_key` (atómica: valida + consume cuota). Independiente del gate de admin por cookie. Usa un **cliente service-role** server-only (`src/lib/supabase/service.ts`).
- [X] **Ruta `/api/v1/forecast/realtime`** (`src/app/api/v1/forecast/realtime/route.ts`): pública, protegida por API key, **lee** la fila precalculada de Supabase (no computa en vivo). 401/429/503 con headers `WWW-Authenticate`/`Retry-After`/`X-RateLimit-*`.
- [X] **Rate limiting** por clave: ventana fija de 60 s dentro de `consume_api_key` (límite `rate_limit_per_min` por key, configurable).

**Entregable:** endpoint llamable con `curl -H "Authorization: Bearer …"`. ✅ *(cómputo + publicación: `realtimeForecastService.ts`; el forecast se siembra con `POST /api/console/forecast/publish` (admin) hasta que el cron de Fase 4 lo automatice.)*

> **⚠️ Pasos manuales pendientes (no se pueden hacer desde el código):**
> 1. Ejecutar `supabase/api-keys.sql` en el SQL editor de Supabase. [X]
> 2. Añadir `SUPABASE_SERVICE_ROLE_KEY` en `.env.local` **y** en Vercel (secreto server-side; sin él la API devuelve 503). [X]
> 3. Emitir una key de prueba: `node scripts/mint-api-key.mjs --company "Test" --rate 60`. [X]
> 4. Sembrar el forecast al menos una vez: `POST /api/console/forecast/publish` (logueado como admin). [X]
> 5. Probar: `curl -H "Authorization: Bearer <key>" <host>/api/v1/forecast/realtime`. [X]

---

## Fase 4 — Precálculo automático (el cron) ⏱️ (~1 día)
**Objetivo:** que la API responda al instante sin disparar el cómputo pesado en cada petición.

Patrón: **precalcular → guardar → servir**

```
CRON (cada ~1 min)  ──▶  calcula nowcast (NOAA L1 → MRU → nivel G)
                          │ escribe "último forecast"
                          ▼
                    Supabase (fila 'latest')
                          │ lee (instantáneo)
cliente ──GET /v1/forecast──▶  API endpoint  ──▶ JSON en ~50 ms
     (con su API key)
```

- [X] **Verificado:** el camino del forecast en tiempo real (`realtimeForecastService.ts` → `liveL1HistoryService` → `mruForecastService`/`stormScaleService`) depende **solo de datos en vivo de NOAA**; cero lecturas de `data/` o `process.cwd` → serverless-safe.
- [X] **Job programado:** `GET /api/cron/publish-forecast` (autenticado por `CRON_SECRET`) hace precompute → store. Disparado por **GitHub Actions** (`.github/workflows/publish-forecast.yml`, cada ~5 min; + `workflow_dispatch` manual). La lógica vive en `publishRealtimeForecast()` (compartida con el publish admin).
- [X] La ruta `/api/v1/forecast/realtime` solo **lee la fila** `forecast_latest` → respuesta rápida (ya en Fase 3).
- [X] **Decisión D4.1 → GitHub Actions** (gratis, ~5 min; suficiente para un nowcast con 30-60 min de margen). Alternativas documentadas si se necesita 1-min: `pg_cron` de Supabase (gratis) o Vercel Cron (requiere Pro).

**Entregable:** forecast siempre fresco, servido rápido y barato. ✅

> **⚠️ Pasos manuales pendientes:**
> 1. Generar un `CRON_SECRET` (string largo aleatorio) y ponerlo en Vercel (env) **y** en los secrets del repo de GitHub.
> 2. Añadir el secret `HELIOSAT_BASE_URL` en GitHub (p. ej. `https://heliosat.vercel.app`, sin `/` final).
> 3. (Opcional) Probar el workflow a mano con **Run workflow** (`workflow_dispatch`) y verificar que `/api/v1/forecast/realtime` deja de dar 503.

---

## Fase 5 — Producto y entrega al cliente 📦 (~2-3 días)
**Objetivo:** que una empresa pueda integrarse sola y nosotros podamos facturar/controlar.

- [X] **Documentación de la API** (`docs/api-v1.md`): endpoint, auth, contrato/respuesta, códigos de error y ejemplos en `curl`/Python/JS.
- [X] **Emisión de claves:** `scripts/mint-api-key.mjs` (alta + token una vez), `list-api-keys.mjs` y `revoke-api-key.mjs` (ciclo de vida), con runbook de onboarding en `docs/operations.md`.
- [X] **Métricas de uso por cliente:** tabla `api_key_usage_daily` (por key y día UTC), incrementada dentro de `consume_api_key`; `list-api-keys.mjs --usage <días>` para facturación/abuso (+ `request_count` lifetime).
- [X] **Monitorización y logs:** `GET /api/v1/status` (200 si fresco, 503 si stale/sin datos → un uptime monitor caza API caída *o* cron parado); GitHub Actions avisa por email si el workflow falla; logs en Vercel.
- [X] **Política de versionado** documentada en `docs/api-v1.md`: versión en la ruta (`/v1`), cambios solo aditivos, breaking → `/v2` con ventana de deprecación.
- [X] **Onboarding del primer cliente:** proceso paso a paso en `docs/operations.md` (mint → entrega segura → verificación con `curl`).

**Entregable:** API comercial lista para vender. 💰 ✅

> **⚠️ Lo que queda es operativo (no código):** correr los pasos de setup de Fase 3-4 (SQL, env, secrets, primer publish) y emitir la primera key real. Todo el tooling está listo; ver `docs/operations.md`.

---

## Dependencias

```
Fase 0 (build OK)
   └─▶ Fase 1 (web online en Vercel)   ← cimiento
          └─▶ Fase 2 (endurecer)
                 └─▶ Fase 3 (API + keys)
                        └─▶ Fase 4 (cron precálculo)
                               └─▶ Fase 5 (docs, facturación, clientes)
```

## Decisiones pendientes

| #     | Decisión                                   | Recomendación                          |
|-------|--------------------------------------------|----------------------------------------|
| D0.1  | `vercel.app` vs dominio propio             | Empezar con `vercel.app`, dominio luego |
| D2.1  | Herramientas internas: online vs solo local | ✅ Resuelto → A (solo local)            |
| D4.1  | Vercel Pro vs scheduler externo            | ✅ Resuelto → GitHub Actions (gratis, ~5 min) |

## Principios clave (recordatorio)

- Al cliente se le da **URL + API key + docs**, nunca código.
- Solo se expone el **Real-Time Forecast**. El resto (playground, training, pipelines) es interno.
- La API se sirve **precalculada** (cron → Supabase → endpoint), no computada en vivo por petición.
- La auth de la API (API keys) es **distinta** del gate de admin por cookie de la web.
