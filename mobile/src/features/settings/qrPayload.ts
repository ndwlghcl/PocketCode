/**
 * 配对二维码载荷解析（电脑端 pairing_qr_payload 的逆操作）。
 * 严格校验：字段缺失、指纹格式不对、地址不是 https 一律拒绝。
 */

export interface QrPayload {
  addresses: string[];
  port: number;
  fingerprint: string;
  serverId: string;
  serverName: string;
  code: string;
}

export function parseQrPayload(text: string): QrPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const data = raw as Record<string, unknown>;
  if (data.v !== 1) return null;

  const addresses = data.addresses;
  if (
    !Array.isArray(addresses) ||
    addresses.length === 0 ||
    !addresses.every((a) => typeof a === 'string' && a.startsWith('https://'))
  ) {
    return null;
  }
  const fingerprint = data.fingerprint;
  if (typeof fingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(fingerprint)) {
    return null;
  }
  const code = data.code;
  if (typeof code !== 'string' || !/^[A-Z0-9-]{6,32}$/.test(code)) {
    return null;
  }
  const port = data.port;
  const serverId = data.server_id;
  const serverName = data.server_name;
  if (typeof port !== 'number' || port < 1024 || port > 65535) return null;
  if (typeof serverId !== 'string' || serverId.length === 0) return null;
  if (typeof serverName !== 'string' || serverName.length === 0) return null;

  return {
    addresses: addresses as string[],
    port,
    fingerprint,
    serverId,
    serverName,
    code,
  };
}
