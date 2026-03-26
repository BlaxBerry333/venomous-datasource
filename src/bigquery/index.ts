export type { BigQueryAuth } from '../core/index.js';
export type { BigQueryOptions, ProjectInfo, DatasetInfo } from './types.js';
export { BigQueryConnector } from './connector.js';

import { BigQueryConnector } from './connector.js';
import type { BigQueryOptions } from './types.js';

/**
 * Create a BigQuery connector instance.
 *
 * @param options - Connection options (projectId, datasetId, location). All fields are optional.
 *   When omitted, use `connect()` with auth credentials and then `useDataset()` to select a dataset.
 * @returns An unconnected BigQueryConnector. Call `connect()` before use.
 *
 * @example
 * ```typescript
 * import { createBigQueryConnector } from 'venomous-datasource/bigquery';
 *
 * // Traditional usage (projectId + datasetId)
 * const connector = createBigQueryConnector({
 *   projectId: 'my-project',
 *   datasetId: 'my_dataset',
 * });
 * await connector.connect({ credentials: {...} });
 * const tables = await connector.tables();
 * await connector.disconnect();
 *
 * // Exploration usage (no options)
 * const explorer = createBigQueryConnector();
 * await explorer.connect({ credentials: {...} });
 * const datasets = await explorer.datasets();
 * explorer.useDataset(datasets[0].datasetId);
 * const tables2 = await explorer.tables();
 * await explorer.disconnect();
 * ```
 */
export function createBigQueryConnector(options?: BigQueryOptions): BigQueryConnector {
  return new BigQueryConnector(options);
}
