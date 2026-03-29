import type { UserConfig } from 'tsdown';

const shared: Partial<UserConfig> = {
  format: ['esm'],
  dts: true,
  sourcemap: true,
  target: 'node20',
};

const connectorModules = [
  'bigquery',
  'aws-s3',
  'google-cloud-storage',
  'google-sheets',
  'azure-blob-storage',
  'firestore',
  'mongodb',
] as const;

const config: UserConfig[] = [
  {
    ...shared,
    entry: ['src/core/index.ts'],
    outDir: 'dist/core',
    clean: true,
  },
  ...connectorModules.map(
    (mod): UserConfig => ({
      ...shared,
      entry: [`src/${mod}/index.ts`],
      outDir: `dist/${mod}`,
      external: [/\.\.\/core\//],
    })
  ),
];

export default config;
