import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  serverExternalPackages: ['parquetjs-lite'],
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
