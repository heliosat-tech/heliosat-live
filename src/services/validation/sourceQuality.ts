export interface QualityFlagSummary {
  flag: string;
  count: number;
}

export interface SourceQualitySummary {
  sampleCount: number;
  samplesWithFlags: number;
  flags: QualityFlagSummary[];
}

export function summarizeSourceQuality(
  samples: Array<{ qualityFlags?: readonly string[] }>,
): SourceQualitySummary {
  const counts = new Map<string, number>();
  let samplesWithFlags = 0;

  samples.forEach(sample => {
    const flags = sample.qualityFlags ?? [];
    if (flags.length > 0) {
      samplesWithFlags += 1;
    }

    flags.forEach(flag => {
      counts.set(flag, (counts.get(flag) ?? 0) + 1);
    });
  });

  return {
    sampleCount: samples.length,
    samplesWithFlags,
    flags: [...counts.entries()]
      .map(([flag, count]) => ({ flag, count }))
      .sort((a, b) => b.count - a.count || a.flag.localeCompare(b.flag)),
  };
}

export function hasAnyMeasuredValue<T extends Record<string, unknown>>(
  sample: T,
  fields: Array<keyof T>,
) {
  return fields.some(field => {
    const value = sample[field];
    return typeof value === 'number' && Number.isFinite(value);
  });
}
