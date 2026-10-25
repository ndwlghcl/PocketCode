/**
 * 连接状态管理（S2c）：配对（扫码）、探测、15 秒自动刷新、取消配对。
 *
 * 状态机：unpaired（未配对）→ probing → online / offline / tls-mismatch。
 * 已配对时探测携带证书指纹；指纹不匹配单独标出（对方不是配对的那台电脑）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';

import { PocketCodeClient, PocketCodeError } from '../api/client';
import { probeHealth, type ProbeResult } from '../api/probe';
import { CameraPermissionError, scanQrCode } from '../native';
import { parseQrPayload } from '../features/settings/qrPayload';
import { clearPairing, loadPairing, savePairing, type PairingInfo } from '../storage/pairingStore';

const REFRESH_INTERVAL_MS = 15_000;

export type ConnectionStatus =
  | { state: 'unpaired' }
  | { state: 'probing' }
  | { state: 'online'; latencyMs: number }
  | { state: 'offline' }
  | { state: 'revoked' }
  | { state: 'tls-mismatch' };

export interface PairAttempt {
  ok: boolean;
  message: string;
  /** 相机权限被拒——界面应提供"打开系统设置"入口。 */
  permissionDenied?: boolean;
}

export interface Connection {
  pairing: PairingInfo | null;
  lastProbe: ProbeResult | null;
  busy: boolean;
  scanning: boolean;
  status: ConnectionStatus;
  refresh: () => Promise<void>;
  pairFromQr: () => Promise<PairAttempt>;
  unpair: () => Promise<void>;
}

function describePairError(error: unknown): string {
  if (error instanceof PocketCodeError) {
    switch (error.code) {
      case 'PAIRING_REJECTED':
        return '电脑用户拒绝了这次配对';
      case 'PAIRING_TIMEOUT':
        return '电脑端未及时确认，请重试';
      case 'PAIRING_CODE_USED':
        return '配对码已被使用，请在电脑端重新生成二维码';
      case 'PAIRING_CODE_INVALID':
        return '配对码无效或已过期，请在电脑端重新生成二维码';
      case 'OFFLINE':
        return error.details?.kind === 'tls'
          ? '证书指纹不匹配，拒绝连接'
          : '无法连接电脑，请确认网络与地址';
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : '配对失败';
}

export function useConnection(): Connection {
  const [pairing, setPairing] = useState<PairingInfo | null>(null);
  const [lastProbe, setLastProbe] = useState<ProbeResult | null>(null);
  const [authRevoked, setAuthRevoked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const sequence = useRef(0);

  useEffect(() => {
    void (async () => setPairing(await loadPairing()))();
  }, []);

  const refresh = useCallback(async () => {
    const current = await loadPairing();
    setPairing(current);
    if (!current) {
      setLastProbe(null);
      setAuthRevoked(false);
      return;
    }
    const seq = ++sequence.current;
    setBusy(true);
    const result = await probeHealth(current.baseUrl, {
      fingerprint: current.fingerprint,
    });
    if (seq !== sequence.current) return;

    if (result.kind !== 'online') {
      // 网络都不通时无从判断授权状态；撤销标记保留（恢复网络后立即显现）
      setLastProbe(result);
      setBusy(false);
      return;
    }

    // 匿名 health 无法发现"授权被撤销"，必须带令牌访问一次业务接口。
    const authClient = new PocketCodeClient({
      baseUrl: current.baseUrl,
      token: current.deviceToken,
      fingerprint: current.fingerprint,
    });
    try {
      await authClient.listProjects();
      setAuthRevoked(false);
    } catch (error) {
      setAuthRevoked(
        error instanceof PocketCodeError && error.status === 401,
      );
    }
    if (seq !== sequence.current) return;
    setLastProbe(result);
    setBusy(false);
  }, []);

  useEffect(() => {
    if (!pairing) return;
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pairing === null, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const pairFromQr = useCallback(async (): Promise<PairAttempt> => {
    if (!Capacitor.isNativePlatform()) {
      return { ok: false, message: '扫码仅在手机 App 中可用（浏览器开发模式请手动测试连接）' };
    }
    setScanning(true);
    try {
      const raw = await scanQrCode();
      if (!raw) return { ok: false, message: '未读到二维码内容' };
      const payload = parseQrPayload(raw);
      if (!payload) return { ok: false, message: '这个二维码不是 PocketCode 配对码' };

      const pairingClient = new PocketCodeClient({
        baseUrl: payload.addresses[0],
        fingerprint: payload.fingerprint,
        timeoutMs: 70_000, // 桌面端确认限时 60 秒
      });
      const response = await pairingClient.completePairing({
        pairing_code: payload.code,
        device_name: 'Android 手机',
        device_platform: 'android',
      });
      await savePairing({
        baseUrl: payload.addresses[0],
        fingerprint: payload.fingerprint,
        deviceToken: response.device_token,
        serverName: response.server_name,
      });
      await refresh();
      return { ok: true, message: `已配对：${response.server_name}` };
    } catch (error) {
      if (error instanceof CameraPermissionError) {
        return {
          ok: false,
          message: '未授予相机权限，无法扫码',
          permissionDenied: true,
        };
      }
      return { ok: false, message: describePairError(error) };
    } finally {
      setScanning(false);
    }
  }, [refresh]);

  const unpair = useCallback(async () => {
    await clearPairing();
    setPairing(null);
    setLastProbe(null);
    setAuthRevoked(false);
  }, []);

  const status: ConnectionStatus = !pairing
    ? { state: 'unpaired' }
    : lastProbe === null
      ? { state: 'probing' }
      : lastProbe.kind === 'online'
        ? authRevoked
          ? { state: 'revoked' }
          : { state: 'online', latencyMs: lastProbe.latencyMs }
        : lastProbe.kind === 'tls-mismatch'
          ? { state: 'tls-mismatch' }
          : { state: 'offline' };

  return { pairing, lastProbe, busy, scanning, status, refresh, pairFromQr, unpair };
}
