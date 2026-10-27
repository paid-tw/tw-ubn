import { describe, expect, it } from 'vitest';
import { datasetResult, normalizeFia, rocToISO, shardOf, validateUBN } from '../lib';

describe('worker lib parity with ubn-core', () => {
  it('validates real UBNs', () => {
    for (const b of ['22099131', '87006234', '47529263', '38965019']) {
      expect(validateUBN(b)).toBe(true);
    }
    expect(validateUBN('22099130')).toBe(false);
    expect(validateUBN('123')).toBe(false);
  });

  it('matches the shared shard vector', () => {
    expect(shardOf('22099131', 256)).toBe(216);
  });

  it('converts ROC dates', () => {
    expect(rocToISO('0760321')).toBe('1987-03-21');
    expect(rocToISO('')).toBeNull();
  });

  it('carries shard status and leaves it unset for older shards', () => {
    const suspended = datasetResult({
      ban: '87003412',
      name: '惜緣農業資材行',
      useInvoice: true,
      status: 'suspended',
    });
    expect(suspended).toMatchObject({
      found: true,
      ban: '87003412',
      useInvoice: true,
      status: 'suspended',
      source: 'dataset',
    });

    const legacy = datasetResult({ ban: '22099131', name: '台積電', useInvoice: true });
    expect(legacy.status).toBeUndefined();
    expect(JSON.parse(JSON.stringify(legacy)).status).toBeUndefined();
  });

  it('normalizes a FIA response', () => {
    const r = normalizeFia('22099131', {
      businessNm: '台灣積體電路製造股份有限公司',
      businessAddress: '新竹市力行六路8號',
      isUseInvoice: 'Y',
      businessSetupDate: '0760221',
    });
    expect(r).toMatchObject({
      found: true,
      ban: '22099131',
      name: '台灣積體電路製造股份有限公司',
      useInvoice: true,
      setupDate: '1987-02-21',
      source: 'fia-api',
    });
  });
});
