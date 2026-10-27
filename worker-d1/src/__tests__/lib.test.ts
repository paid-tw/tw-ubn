import { describe, expect, it } from 'vitest';
import { normalizeFia, rocToISO, validateUBN } from '../lib';

describe('worker-d1 lib parity with ubn-core', () => {
  it('validates real UBNs', () => {
    for (const b of ['22099131', '87006234', '47529263', '38965019']) {
      expect(validateUBN(b)).toBe(true);
    }
    expect(validateUBN('22099130')).toBe(false);
    expect(validateUBN('123')).toBe(false);
  });

  it('converts ROC dates', () => {
    expect(rocToISO('0760321')).toBe('1987-03-21');
    expect(rocToISO('')).toBeNull();
  });

  it('normalizes a FIA response', () => {
    const r = normalizeFia('22099131', {
      businessNm: '台灣積體電路製造股份有限公司',
      isUseInvoice: 'Y',
      businessSetupDate: '0760221',
    });
    expect(r).toMatchObject({ found: true, useInvoice: true, setupDate: '1987-02-21', source: 'fia-api' });
  });
});
