import type { UserConfig } from 'tsdown';

const shared: Partial<UserConfig> = {
  format: ['esm'],
  dts: true,
  sourcemap: true,
  target: 'node20',
};

const config: UserConfig[] = [
  {
    ...shared,
    entry: ['src/core/index.ts'],
    outDir: 'dist/core',
    clean: true,
  },
  {
    ...shared,
    entry: ['src/bigquery/index.ts'],
    outDir: 'dist/bigquery',
  },
  {
    ...shared,
    entry: ['src/s3/index.ts'],
    outDir: 'dist/s3',
  },
  {
    ...shared,
    entry: ['src/gcs/index.ts'],
    outDir: 'dist/gcs',
  },
  {
    ...shared,
    entry: ['src/sheets/index.ts'],
    outDir: 'dist/sheets',
  },
  {
    ...shared,
    entry: ['src/azure-blob/index.ts'],
    outDir: 'dist/azure-blob',
  },
];

export default config;
