import {inject} from '@loopback/core';
import {juggler} from '@loopback/service-proxy';

// Replace this configuration with your application's datasource and credentials.
const config = {
  name: 'Inventory',
  connector: 'openapi',
  spec: './examples/inventory.openapi.yaml',
  positional: true,
  validate: true,
};

export class InventoryDataSource extends juggler.DataSource {
  static dataSourceName = 'Inventory';

  constructor(
    @inject('datasources.config.Inventory', {optional: true})
    dsConfig: object = config
  ) {
    super(dsConfig);
  }
}
