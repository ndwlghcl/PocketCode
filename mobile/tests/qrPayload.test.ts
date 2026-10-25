import { describe, expect, it } from 'vitest';

import { parseQrPayload } from '../src/features/settings/qrPayload';

const FINGERPRINT = 'sha256:' + 'c'.repeat(64);

function validPayload(): Record<string, unknown> {
  return {
    v: 1,
    addresses: ['https://10.59.163.124:8765'],
    port: 8765,
    fingerprint: FINGERPRINT,
    server_id: '0d0d3f6a-9c1b-4e2a-8f3d-7b6a5c4e3d2f',
    server_name: '书房电脑',
    code: 'ABCD-2345',
  };
}

describe('parseQrPayload（配对二维码）', () => {
  it('合法载荷完整解析', () => {
    const parsed = parseQrPayload(JSON.stringify(validPayload()));
    expect(parsed).not.toBeNull();
    expect(parsed?.code).toBe('ABCD-2345');
    expect(parsed?.serverName).toBe('书房电脑');
    expect(parsed?.fingerprint).toBe(FINGERPRINT);
  });

  it('非 JSON / 版本不对 / 缺字段一律拒绝', () => {
    expect(parseQrPayload('not json')).toBeNull();
    expect(parseQrPayload(JSON.stringify({ ...validPayload(), v: 2 }))).toBeNull();
    expect(parseQrPayload('{}')).toBeNull();
  });

  it('指纹格式错误拒绝', () => {
    expect(
      parseQrPayload(JSON.stringify({ ...validPayload(), fingerprint: 'sha256:short' })),
    ).toBeNull();
  });

  it('非 https 地址拒绝', () => {
    expect(
      parseQrPayload(
        JSON.stringify({ ...validPayload(), addresses: ['http://10.0.0.1:8765'] }),
      ),
    ).toBeNull();
  });

  it('配对码格式错误拒绝', () => {
    expect(
      parseQrPayload(JSON.stringify({ ...validPayload(), code: 'abcd' })),
    ).toBeNull();
  });

  it('端口越界拒绝', () => {
    expect(
      parseQrPayload(JSON.stringify({ ...validPayload(), port: 80 })),
    ).toBeNull();
  });
});
