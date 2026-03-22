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
    entry: ['src/google-sheets/index.ts'],
    outDir: 'dist/google-sheets',
  },
  {
    ...shared,
    entry: ['src/azure-blob-storage/index.ts'],
    outDir: 'dist/azure-blob-storage',
  },
];

export default config;
