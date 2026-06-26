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
