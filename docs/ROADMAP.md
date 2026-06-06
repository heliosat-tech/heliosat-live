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

- [ ] Crear cuenta en Vercel con GitHub → **Import** del repo `jnavasg16/HELIOSAT`.
- [ ] **Production Branch = `main`** (main ya contiene todo el trabajo).
- [ ] Pegar las 2 env vars en Vercel. **NO** poner `HELIOSAT_DISABLE_ADMIN_GATE` (abriría el playground a cualquiera).
- [ ] Deploy → obtener la URL.
- [ ] **Supabase → Authentication → URL Configuration:** añadir la URL de Vercel a *Site URL* y `…/auth/callback` a *Redirect URLs* (si no, el login falla en producción).
- [ ] **Verificar en vivo:** home con datos NOAA/Celestrak en directo; `/playground` y `/console` piden login (gate de admin OK).

**Entregable:** plataforma pública visible 24/7. 🎉

---

## Fase 2 — Endurecer producción 🔒 (~2-3 h)
**Objetivo:** cerrar los cabos que en serverless se comportan distinto que en local.

- [ ] **RLS en Supabase:** confirmar Row Level Security en todas las tablas con datos sensibles (la key publishable es pública por diseño).
- [ ] **Rutas que escriben a disco:** `src/app/api/console/arrival/route.ts` y `.../timing/route.ts` escriben en `data/console/`; en Vercel el disco es de **solo lectura** → petan al recalcular. Opciones:
  - **(A)** Dejarlas "solo local", no usarlas en producción. *(rápido, 0 trabajo)*
  - **(B)** Migrar su almacenamiento a Supabase para que funcionen online. *(más trabajo)*
- [ ] **Decisión D2.1:** ¿el playground/console interno debe funcionar *online* o basta usarlo en local? *(Recomendado: A para empezar.)*

---

## Fase 3 — Cimientos de la API para clientes 🔑 (~1-2 días)
**Objetivo:** superficie pública, versionada y autenticada por API key, **separada** de las rutas internas.

- [ ] **Definir el contrato JSON v1** del Real-Time Forecast: campos (velocidad, Bz, nivel G, hora de llegada estimada, timestamp…). Una vez publicado, se versiona y no se rompe.
- [ ] **Tabla `api_keys` en Supabase:** clave *hasheada* (nunca en claro), empresa, estado activo, límite de uso.
- [ ] **Auth por API key:** helper que valida `Authorization: Bearer <key>` contra esa tabla. *(Distinto del gate de admin actual, que es por cookie de sesión y no sirve para máquinas.)*
- [ ] **Nueva ruta `/api/v1/forecast/realtime`** — pública, protegida por API key, que **lee un valor precalculado** (no computa en vivo).
- [ ] **Rate limiting** por clave (p. ej. X req/min).

**Entregable:** endpoint llamable con `curl -H "Authorization: Bearer …"`.

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

- [ ] **Verificar** que el camino del forecast en tiempo real (`src/app/api/console/nowcast/route.ts`) depende **solo de datos en vivo de NOAA** y no de archivos locales `data/`.
- [ ] **Job programado** (~1 min): trae L1 de NOAA → calcula nowcast → guarda el "último forecast" en Supabase.
- [ ] La ruta `/api/v1/...` solo **lee esa fila** → respuesta rápida.
- [ ] **Decisión D4.1 — plan/scheduler:** el cron por minuto y los cómputos largos chocan con los límites del plan **gratis** de Vercel (crons poco frecuentes, funciones cortas). Opciones: **Vercel Pro**, o scheduler externo (GitHub Actions / `pg_cron` de Supabase). Evaluar con números reales.

**Entregable:** forecast siempre fresco, servido rápido y barato.

---

## Fase 5 — Producto y entrega al cliente 📦 (~2-3 días)
**Objetivo:** que una empresa pueda integrarse sola y nosotros podamos facturar/controlar.

- [ ] **Documentación de la API:** endpoint, auth, parámetros, respuesta, códigos de error, ejemplos en `curl`/Python/JS.
- [ ] **Emisión de claves:** proceso para dar de alta a cada empresa y entregarle su key.
- [ ] **Métricas de uso por cliente** (facturación + detección de abusos).
- [ ] **Monitorización y logs** (saber si la API o el cron se caen).
- [ ] **Política de versionado** (comunicar cambios sin romper integraciones).
- [ ] Onboarding del primer cliente con una key de prueba.

**Entregable:** API comercial lista para vender. 💰

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
| D2.1  | Herramientas internas: online vs solo local | Solo local al principio (opción A)     |
| D4.1  | Vercel Pro vs scheduler externo            | Decidir con números en Fase 4          |

## Principios clave (recordatorio)

- Al cliente se le da **URL + API key + docs**, nunca código.
- Solo se expone el **Real-Time Forecast**. El resto (playground, training, pipelines) es interno.
- La API se sirve **precalculada** (cron → Supabase → endpoint), no computada en vivo por petición.
- La auth de la API (API keys) es **distinta** del gate de admin por cookie de la web.
