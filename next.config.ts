import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  serverExternalPackages: ['parquetjs-lite'],
  // These data files are read from disk at request time (process.cwd()/data/...). On serverless
  // deploys Next must be told to bundle them with the functions that read them, or the live
  // forecast (ML model) and historical heatmaps (OMNI/ACE archives) silently fall back to empty.
  outputFileTracingIncludes: {
    '/': ['./data/ml-model/model.json'],
    '/api/console/corridor': ['./data/console/omni-archive.json', './data/console/ace-archive.json'],
    '/api/console/ml': ['./data/console/ml_metrics.json', './data/console/ml_data_split.json'],
    '/api/console/validation-data': ['./data/console/arrival.json', './data/console/timing.json', './data/console/ml_data_split.json'],
    '/api/console/geomagnetic-study': ['./data/console/geomagnetic-storm-study.json'],
    '/api/console/leo/inventory': ['./data/processed/thermosphere/manifest.v1.json'],
    '/api/console/leo/validation': [
      './data/model-runs/leo-density/study-summary.v1.json',
      './data/model-runs/leo-density/study-summary.v2.json',
      './data/model-runs/leo-density/*/study-summary.v1.json',
      './data/model-runs/leo-density/*/study-summary.v2.json',
    ],
    '/api/console/leo/validation/artifact': [
      './data/model-runs/leo-density/study-summary.v1.json',
      './data/model-runs/leo-density/study-summary.v2.json',
      './data/model-runs/leo-density/*/study-summary.v1.json',
      './data/model-runs/leo-density/*/study-summary.v2.json',
      './data/model-runs/leo-density/*/plots/*.png',
    ],
    '/api/console/leo/forecast': [
      './data/model-runs/leo-density/forecast-latest.v1.json',
      './data/model-runs/leo-density/*/forecast-latest.v1.json',
      './data/model-runs/leo-density/study-summary.v1.json',
      './data/model-runs/leo-density/study-summary.v2.json',
      './data/model-runs/leo-density/*/study-summary.v1.json',
      './data/model-runs/leo-density/*/study-summary.v2.json',
    ],
  },
  webpack: (config, { webpack }) => {
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/^\.\/wasm\/index\.js$/, (resource: { context: string; request: string }) => {
        if (resource.context.includes(`satellite.js${path.sep}dist`)) {
          resource.request = path.resolve(process.cwd(), 'src/lib/satelliteWasmStub.js');
        }
      }),
    );

    return config;
  },
};

export default nextConfig;
