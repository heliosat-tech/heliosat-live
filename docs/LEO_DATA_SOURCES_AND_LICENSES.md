# LEO density data sources, provenance and licensing

Last source verification: 2026-07-13. This document applies to the authenticated HelioSat research module only.

## ESA VirES thermospheric density

Official service: <https://vires.services/hapi/> (HAPI 3.0).  
Catalog: <https://vires.services/hapi/catalog>.  
Density example maintained by VirES: <https://notebooks.vires.services/notebooks/03l1_demo-dns>.

The importer uses the documented request form:

```text
GET https://vires.services/hapi/info?dataset=<COLLECTION>
GET https://vires.services/hapi/data?dataset=<COLLECTION>&parameters=...&start=<UTC>&stop=<UTC>&format=json&include=header
```

`stop` is exclusive. Imports are chunked below the collection's advertised `x_maxTimeSelection` and retain the query, catalog metadata, access time and SHA-256 checksum.

| Mission / spacecraft | HAPI collection | Native cadence | Catalog coverage observed 2026-07-13 |
| --- | --- | ---: | --- |
| Swarm A, POD density | `SW_OPER_DNSAPOD_2_` | 30 s | 2014-01-01 through 2026-05-31 |
| Swarm B, POD density | `SW_OPER_DNSBPOD_2_` | 30 s | 2014-01-01 through 2026-05-31 |
| Swarm C, POD density | `SW_OPER_DNSCPOD_2_` | 30 s | 2014-01-01 through 2026-05-31 |
| Swarm A, accelerometer density | `SW_OPER_DNSAACC_2_` | 10 s | 2014-02-01 through 2025-11-30 |
| Swarm B, accelerometer density | `SW_OPER_DNSBACC_2_` | 10 s | 2015-03-01 through 2025-11-30 |
| Swarm C, accelerometer density | `SW_OPER_DNSCACC_2_` | 10 s | 2014-02-01 through 2025-11-30 |
| GRACE-FO 1, accelerometer density | `GF_OPER_DNS1ACC_2_` | 10 s | 2018-05-29 through 2026-04-30 |
| GRACE-FO 2 density | none in the current HAPI catalog | — | unavailable |

HelioSat does not substitute GRACE-FO 1 for GRACE-FO 2. GRACE-FO 2 therefore remains a visible, explicit unavailable state until an official density product exists.

The canonical mapping uses:

- `Timestamp` as UTC;
- `Latitude_GD` and `Longitude_GD` as GRS80 geodetic degrees;
- `Height_GD` in metres, converted to kilometres with the original value retained in raw data;
- `local_solar_time` in hours;
- `density` in kg/m³;
- `validity_flag`, when supplied (`0` nominal, `1` anomalous).

Swarm ACC does not expose a validity flag through this HAPI collection. Missing quality metadata stays null; it is not changed to a nominal flag. Although HAPI metadata reports no numeric fill value, official example responses contain `9.99e32`; the parser treats absolute density values at or above `1e30` as missing and never sends them into the baseline, training or metrics. The same defensive rule converts out-of-range auxiliary latitude, longitude, altitude and local-solar-time fill values to null without relabelling the density row as an observation of those coordinates.

Catalog coverage is nominal availability, not proof of continuity. Direct inspection found gaps in some Swarm ACC products. The staged primary corpus therefore uses the four mutually available products `SW_OPER_DNS{A,B,C}POD_2_` and `GF_OPER_DNS1ACC_2_` for 2021–2025; Swarm ACC remains a diagnostic candidate pending a versioned continuity map.

These products are retrospective density observations, not a real-time operational density feed.

## ESA/VirES terms and attribution

Governing material:

- ESA data terms: <https://vires.services/data_terms>
- VirES service terms: <https://vires.services/service_terms>

Required project practice:

- Preserve collection IDs, source attribution and legal notices.
- Credit `ESA / VirES for Swarm` in UI and artifacts.
- Publications must contain “Data provided by the European Space Agency.”
- Mark received ESA data and analysed information with `© ESA (<year of reception>)` as required by the terms.
- Do not expose or redistribute raw dumps from the public dashboard. Onward distribution of free ESA datasets requires ESA confirmation.
- Review commercial use and redistribution with counsel/ESA before any public or customer-facing deployment.

Local raw and processed files are ignored by Git. The Internal Console exposes inventory and derived research results, not a downloadable mirror of ESA data.

## NRLMSIS baseline

Wrapper: `pymsis==0.12.0`, <https://swxtrec.github.io/pymsis/>. The wrapper supports NRLMSISE-00, NRLMSIS 2.0 and NRLMSIS 2.1. HelioSat requests version 2.1 and records it in every output.

The Python wrapper is MIT-licensed, but the NRLMSIS 2.x source has separate NRL academic/non-commercial terms: <https://raw.githubusercontent.com/SWxTREC/pymsis/main/MSIS2_LICENSE>. The baseline is therefore disabled unless `HELIOSAT_ENABLE_NRLMSIS_RESEARCH=true` and must be treated as `research_only / license_unreviewed`. Enabling a flag records intent; it is not a substitute for legal authorization.

Inputs are explicit and retained in lineage:

- UTC timestamp;
- geodetic longitude/latitude and altitude in km;
- previous-day daily F10.7;
- an explicitly selected 81-day F10.7 average mode;
- seven-element Ap storm history when storm-time mode is used.

HelioSat does **not** use the default pymsis ancillary downloader. It downloads exact NASA SPDF OMNI2 hourly yearly files from <https://spdf.gsfc.nasa.gov/pub/data/omni/low_res_omni/> and retains their SHA-256 digests. The official column definition is <https://spdf.gsfc.nasa.gov/pub/data/omni/low_res_omni/omni2.text>.

Two physically separate baseline modes are implemented:

- `trailing_81_day` uses observations ending at D−1 and is the default and mandatory mode for the staged multi-year study. It is causal by observation time, while source publication latency remains an explicit limitation.
- `centered_81_day_retrospective` uses future days around the target date and is retained only for legacy pilot reproduction and retrospective diagnostics. It is explicitly barred from issuance-time use and is stored in a different directory tree.

NASA SPDF's current data-use policy places deposited public data under CC0 where permitted and expects substantive reuse to cite the data package and original source: <https://spdf.gsfc.nasa.gov/data_use_policy.html>. HelioSat preserves file-level checksums and NASA/SPDF attribution; this does not alter ESA or NRLMSIS restrictions.

## Experimental live atmosphere forcing

The live snapshot command records exact raw responses, retrieval times, URLs and checksums from:

- NOAA SWPC F10.7 JSON: <https://services.swpc.noaa.gov/json/f107_cm_flux.json>;
- NOAA SWPC planetary K-index product, including `a_running`: <https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json>;
- NASA SPDF current-year OMNI2 hourly file for a causal trailing 81-day F10.7 mean.

NRLMSIS receives the previous UTC day's NOAA F10.7, the latest causal trailing OMNI2 F10.7a no older than seven days, and a seven-value Ap vector derived only from NOAA values available at issuance. OMNI2 publication latency remains visible. If any required observation is missing or stale, baseline/forecast publication stops; no climatological number is substituted.

Live solar-wind forcing reuses HelioSat's existing NOAA SWPC real-time solar-wind products (`solar-wind/mag-7-day.json`, `solar-wind/plasma-7-day.json` and the corresponding ephemerides), whose spacecraft can be DSCOVR or ACE according to the feed metadata, followed by the existing MRU propagation. These are preliminary near-real-time values and can be revised; they are never presented as the retrospective OMNI reference archive.

NOAA government information is generally public information unless specifically marked, with no endorsement or accuracy warranty; preserve NOAA attribution and product timestamps. See <https://oceanservice.noaa.gov/disclaimer.html> and the SWPC service itself at <https://services.swpc.noaa.gov/>.

Future orbit context comes from CelesTrak GP data and SGP4/satellite.js. The implemented request is `https://celestrak.org/NORAD/elements/gp.php?GROUP=<group>&FORMAT=TLE`, matching the documented query contract at <https://celestrak.org/NORAD/documentation/gp-data-formats.php>. The catalog cache is process memory only with a 30-minute TTL; it is not redistributed or committed. CelesTrak/Space-Track redistribution history is legally non-trivial, so public or commercial redistribution remains pending explicit review: <https://celestrak.org/norad/elements/notice.php>. CelesTrak unavailability without a real cached catalog leaves the forecast unavailable.

## Deployment gates

The LEO module must remain internal until all of the following are reviewed:

1. ESA data use, attribution and redistribution.
2. NRLMSIS 2.x commercial authorization or a replacement baseline with compatible terms.
3. Held-out scientific validation and uncertainty calibration.
4. Validated altitude/mission/domain limits.
5. Operator-supplied spacecraft parameters or clearly separated research scenarios.
