import { describe, expect, it } from 'vitest';
import { isClosedCompanyStatus, normalizeFia, normalizeGcis, rocToISO, validateUBN } from '../lib';

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

  it('classifies every terminated GCIS company status as closed', () => {
    // Each desc counted in #7, plus the other termination forms seen live.
    for (const desc of [
      '解散',
      '廢止',
      '合併解散',
      '解散已清算完結',
      '核准設立但已命令解散',
      '核准設立，但已命令解散',
      '廢止登記',
      '廢止登記已清算完結',
      '撤銷',
      '撤銷公司設立',
      '撤回登記',
      '撤銷登記',
      '撤銷許可',
      '廢止許可',
      '撤銷已清算完結',
      '撤回登記已清算完結',
    ]) {
      expect(isClosedCompanyStatus(desc), desc).toBe(true);
    }
    for (const desc of ['核准設立', '核准登記', '重整', '']) {
      expect(isClosedCompanyStatus(desc), desc).toBe(false);
    }
  });

  it('normalizes a GCIS company row', () => {
    const closed = normalizeGcis('00002799', {
      Company_Status_Desc: '解散',
      Company_Name: '鑫晶生物科技有限公司',
      Company_Location: '',
      Revoke_App_Date: '1141124',
    });
    expect(closed).toEqual({
      found: true,
      ban: '00002799',
      name: '鑫晶生物科技有限公司',
      address: undefined,
      source: 'gcis',
      companyStatus: '解散',
      status: 'closed',
      closedDate: '2025-11-24',
    });

    const live = normalizeGcis('22099131', {
      Company_Status_Desc: '核准設立',
      Company_Name: '台灣積體電路製造股份有限公司',
      Company_Location: '新竹科學園區新竹市力行六路8號',
      Revoke_App_Date: '',
    });
    expect(live).toMatchObject({ found: true, source: 'gcis', companyStatus: '核准設立', closedDate: null });
    expect(live.status).toBeUndefined();
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
