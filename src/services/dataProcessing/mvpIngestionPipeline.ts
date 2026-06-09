import { fetchGoesContextSamples, type GoesClientOptions } from '../dataSources/goes';
import { fetchGroundIndexSamples, type GroundIndexClientOptions } from '../dataSources/ground';
import {
  fetchAceHistoricalL1Samples,
  fetchSwpcRtswL1Samples,
  type HistoricalL1Range,
} from '../dataSources/l1';
import type { DataSourceFetchResult, GoesSample, GroundIndexSample, L1FetchResult, L1Sample } from '../dataSources/types';
import { writeProcessedSourceCache, writeRawSourceCache, type IngestionCacheWriteResult } from './cacheWriter';

export interface MvpIngestionPipelineOptions {
  includeLiveL1?: boolean;
  historicalL1Range?: HistoricalL1Range | null;
  goes?: GoesClientOptions;
  ground?: GroundIndexClientOptions;
  writeCaches?: boolean;
}

export interface MvpIngestionPipelineSnapshot {
  generatedAtUtc: string;
  liveL1: L1FetchResult | null;
  historicalL1: L1FetchResult | null;
  goes: DataSourceFetchResult<GoesSample>;
  ground: DataSourceFetchResult<GroundIndexSample>;
  processed: {
    l1Samples: L1Sample[];
    geoSamples: GoesSample[];
    groundSamples: GroundIndexSample[];
  };
  cacheWrites: IngestionCacheWriteResult[];
}

function sortByTimeUtc<T extends { timeUtc: string }>(rows: T[]) {
  return [...rows].sort((a, b) => new Date(a.timeUtc).getTime() - new Date(b.timeUtc).getTime());
}

function dedupeByTimeAndSource<T extends { timeUtc: string; source?: string; satellite?: string }>(rows: T[]) {
  return [
    ...new Map(
      rows.map(row => [
        `${row.timeUtc}|${row.source ?? 'ground'}|${row.satellite ?? ''}`,
        row,
      ]),
    ).values(),
  ];
}

export async function ingestMvpDataSources(
  options: MvpIngestionPipelineOptions = {},
): Promise<MvpIngestionPipelineSnapshot> {
  const generatedAtUtc = new Date().toISOString();
  const includeLiveL1 = options.includeLiveL1 ?? true;
  const [liveL1Result, historicalL1Result, goes, ground] = await Promise.all([
    includeLiveL1 ? fetchSwpcRtswL1Samples({ window: '2-hour', includeEphemeris: true }) : Promise.resolve(null),
    options.historicalL1Range
      ? fetchAceHistoricalL1Samples({ range: options.historicalL1Range })
      : Promise.resolve(null),
    fetchGoesContextSamples(options.goes),
    fetchGroundIndexSamples(options.ground),
  ]);

  const l1Samples = sortByTimeUtc(dedupeByTimeAndSource([
    ...(liveL1Result?.samples ?? []),
    ...(historicalL1Result?.samples ?? []),
  ]));
  const geoSamples = sortByTimeUtc(goes.samples);
  const groundSamples = sortByTimeUtc(ground.samples);
  const cacheWrites: IngestionCacheWriteResult[] = [];

  if (options.writeCaches) {
    const rawWrites = await Promise.all([
      liveL1Result
        ? writeRawSourceCache('swpc_rtsw', liveL1Result.samples, { fetchedAtUtc: liveL1Result.fetchedAtUtc })
        : Promise.resolve(null),
      historicalL1Result
        ? writeRawSourceCache('ace_cdaweb_hapi', historicalL1Result.samples, { fetchedAtUtc: historicalL1Result.fetchedAtUtc })
        : Promise.resolve(null),
      writeRawSourceCache('goes', goes.samples, { fetchedAtUtc: goes.fetchedAtUtc }),
      writeRawSourceCache('ground_indices', ground.samples, { fetchedAtUtc: ground.fetchedAtUtc }),
    ]);

    cacheWrites.push(...rawWrites.filter((write): write is IngestionCacheWriteResult => write !== null));

    const processedWrites = await Promise.all([
      writeProcessedSourceCache('mvp_l1_samples', l1Samples, { fetchedAtUtc: generatedAtUtc }),
      writeProcessedSourceCache('mvp_geo_context', geoSamples, { fetchedAtUtc: generatedAtUtc }),
      writeProcessedSourceCache('mvp_ground_response', groundSamples, { fetchedAtUtc: generatedAtUtc }),
    ]);
    cacheWrites.push(...processedWrites);
  }

  return {
    generatedAtUtc,
    liveL1: liveL1Result,
    historicalL1: historicalL1Result,
    goes,
    ground,
    processed: {
      l1Samples,
      geoSamples,
      groundSamples,
    },
    cacheWrites,
  };
}
