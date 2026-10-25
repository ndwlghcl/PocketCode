/**
 * 配对信息持久化：baseUrl、证书指纹、device_token、电脑名。
 *
 * token 必须走安全存储（原生 EncryptedSharedPreferences，ADR-0002）；
 * 浏览器开发模式退化为 localStorage（secureStorage 内部已标注）。
 */

import { secureStorage } from '../native';

export interface PairingInfo {
  baseUrl: string;
  fingerprint: string;
  deviceToken: string;
  serverName: string;
}

const PAIRING_KEY = 'pairing';

function isValid(info: unknown): info is PairingInfo {
  if (typeof info !== 'object' || info === null) return false;
  const candidate = info as Partial<PairingInfo>;
  return (
    typeof candidate.baseUrl === 'string' &&
    candidate.baseUrl.startsWith('https://') &&
    typeof candidate.fingerprint === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(candidate.fingerprint) &&
    typeof candidate.deviceToken === 'string' &&
    candidate.deviceToken.length >= 20 &&
    typeof candidate.serverName === 'string'
  );
}

export async function loadPairing(): Promise<PairingInfo | null> {
  const raw = await secureStorage.get(PAIRING_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return isValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function savePairing(info: PairingInfo): Promise<void> {
  await secureStorage.set(PAIRING_KEY, JSON.stringify(info));
}

export async function clearPairing(): Promise<void> {
  await secureStorage.remove(PAIRING_KEY);
}
