import { useCallback, useEffect, useRef, useState } from 'react';

import type { TrashEntry } from '../../api/types';
import { PocketCodeClient, PocketCodeError } from '../../api/client';
import { normalizeBaseUrl, probeHealth, type ProbeResult } from '../../api/probe';
import { openAppSettings } from '../../native';
import { APP_BUILD } from '../../app/version';
import type { Connection, PairAttempt } from '../../app/useConnection';

interface Props {
  connection: Connection;
  client: PocketCodeClient | null;
}

function describeProbe(probe: ProbeResult): { ok: boolean; title: string; hint?: string } {
  switch (probe.kind) {
    case 'online':
      return { ok: true, title: `已连接测试服务（延迟 ${probe.latencyMs}ms）` };
    case 'timeout':
      return {
        ok: false,
        title: '连接超时',
        hint: '电脑可能休眠/关机，或与电脑不在同一网络。确认电脑已连上这个网络后再试。',
      };
    case 'tls-mismatch':
      return {
        ok: false,
        title: '证书指纹不匹配',
        hint: '对方不是配对时的那台电脑，已拒绝连接。若电脑重装过 PocketCode，请重新扫码配对。',
      };
    case 'unreachable':
      return {
        ok: false,
        title: '无法连接',
        hint: '请核对：① 电脑上的 PocketCode 正在运行；② 地址与电脑管理窗口「连接状态」显示的一致；③ 手机连的是同一网络（手机代理软件可能干扰，可临时关闭再试）。',
      };
    case 'http-error':
      return { ok: false, title: `服务返回异常状态 HTTP ${probe.status}` };
    case 'unexpected-response':
      return { ok: false, title: '该地址不是 PocketCode 服务', hint: probe.detail };
    case 'invalid-address':
      return { ok: false, title: '地址格式无法识别', hint: probe.message };
  }
}

function describePairAttempt(attempt: PairAttempt): { ok: boolean; text: string } {
  return { ok: attempt.ok, text: attempt.message };
}

/** S2 连接页：扫码配对 + 手动地址诊断（health，不带凭据）。
 *  S3c 增补：回收区列表与恢复（跨项目的电脑端回收区放在全局连接页）。 */
export function ConnectionScreen({ connection, client }: Props) {
  const { pairing, lastProbe, busy, scanning, status, refresh, pairFromQr, unpair } =
    connection;
  const [input, setInput] = useState(pairing?.baseUrl ?? '');
  const [invalidTip, setInvalidTip] = useState<string | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [manualProbe, setManualProbe] = useState<ProbeResult | null>(null);
  const [pairAttempt, setPairAttempt] = useState<PairAttempt | null>(null);
  const [trashItems, setTrashItems] = useState<TrashEntry[] | null>(null);
  const [trashBusy, setTrashBusy] = useState(false);
  const [trashMessage, setTrashMessage] = useState<string | null>(null);
  const [trashError, setTrashError] = useState(false);

  const online = status.state === 'online';

  const loadTrash = useCallback(async () => {
    if (!client) return;
    setTrashBusy(true);
    try {
      const response = await client.listTrash();
      setTrashItems(response.items);
      setTrashMessage(null);
      setTrashError(false);
    } catch (cause) {
      setTrashItems(null);
      setTrashMessage(
        cause instanceof PocketCodeError ? cause.message : '无法读取回收区',
      );
      setTrashError(true);
    } finally {
      setTrashBusy(false);
    }
  }, [client]);

  // 进入连接页且已配对时加载一次回收区。
  // 注意：useConnection 每 15 秒 refresh 都会换新的 pairing/client 对象，
  // 不能直接依赖它们，否则回收区每 15 秒重拉并冲掉操作提示——这里按
  // 「服务器地址」节流，更新靠手动「刷新回收区」按钮。
  const trashLoadedFor = useRef<string | null>(null);
  useEffect(() => {
    const baseUrl = pairing?.baseUrl ?? null;
    if (baseUrl && trashLoadedFor.current !== baseUrl) {
      trashLoadedFor.current = baseUrl;
      void loadTrash();
    }
  }, [pairing, loadTrash]);

  const restoreTrashEntry = async (entry: TrashEntry) => {
    if (!client || trashBusy) return;
    if (
      !window.confirm(
        `把「${entry.original_path}」恢复到电脑上的原位置？\n若原位置已被占用，将不会覆盖。`,
      )
    ) {
      return;
    }
    setTrashBusy(true);
    setTrashMessage(null);
    try {
      const result = await client.restoreTrash(entry.trash_id);
      await loadTrash(); // 先刷新列表（内部会清消息），再写成功提示
      setTrashMessage(`已恢复到 ${result.restored_path}`);
      setTrashError(false);
    } catch (cause) {
      if (cause instanceof PocketCodeError && cause.code === 'ALREADY_EXISTS') {
        setTrashMessage(
          `原位置已被占用，未恢复（电脑上已有 ${entry.original_path}）。` +
            '请先在电脑上处理同名文件，再回到这里重试。',
        );
        setTrashError(true);
      } else {
        setTrashMessage(
          cause instanceof PocketCodeError ? cause.message : '恢复失败',
        );
        setTrashError(true);
      }
    } finally {
      setTrashBusy(false);
    }
  };

  const onScanPair = async () => {
    setPairAttempt(null);
    const attempt = await pairFromQr();
    setPairAttempt(attempt);
  };

  const onManualTest = async () => {
    const normalized = normalizeBaseUrl(input);
    if (!normalized) {
      setInvalidTip('无法识别这个地址。示例：10.59.163.124:8765');
      return;
    }
    setInvalidTip(null);
    setProbeBusy(true);
    setManualProbe(await probeHealth(normalized)); // 诊断模式：health，不带凭据
    setProbeBusy(false);
  };

  const manualDescription = manualProbe ? describeProbe(manualProbe) : null;
  const probeDescription = lastProbe ? describeProbe(lastProbe) : null;
  const pairDescription = pairAttempt ? describePairAttempt(pairAttempt) : null;

  return (
    <section>
      <h1 className="screen__title">连接</h1>

      {pairing ? (
        <>
          {status.state === 'revoked' ? (
            <div className="result result--bad">
              <p className="result__title">✘ 本手机的授权已被电脑撤销</p>
              <p className="result__hint">
                电脑端撤销后令牌立即失效。如需继续使用：在电脑端重新生成二维码后
                重新扫码配对，或先清除本机配对信息。
              </p>
              <div className="btnrow">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void onScanPair()}
                  disabled={scanning}
                >
                  {scanning ? '配对中…' : '重新扫码配对'}
                </button>
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={() => void unpair()}
                >
                  清除本机配对
                </button>
              </div>
            </div>
          ) : null}
          <div className="cardlist__item cardlist__item--static">
            <span>已配对电脑</span>
            <span className="cardlist__meta">{pairing.serverName}</span>
          </div>
          <p className="hint">{pairing.baseUrl}</p>
          {probeDescription ? (
            <div className={`result ${probeDescription.ok ? 'result--ok' : 'result--bad'}`}>
              <p className="result__title">
                {probeDescription.ok ? '✔ ' : '✘ '}
                {probeDescription.title}
              </p>
              {probeDescription.hint ? (
                <p className="result__hint">{probeDescription.hint}</p>
              ) : null}
            </div>
          ) : null}
          <div className="btnrow">
            <button
              type="button"
              className="btn"
              onClick={() => void refresh()}
              disabled={busy}
            >
              {busy ? '正在检查…' : '重新测试'}
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => void unpair()}
            >
              取消配对
            </button>
          </div>
          <p className="hint">
            取消配对后需要重新扫码；电脑端也可以撤销本手机的授权。
          </p>

          <h2 className="screen__subtitle">电脑回收区</h2>
          <p className="hint">
            目录页删除的文件/文件夹会进入电脑的回收区，可在这里跨会话恢复。
          </p>
          {trashMessage ? (
            <div className={`result ${trashError ? 'result--bad' : 'result--ok'}`}>
              <p className="result__title">{trashError ? '✘ ' : '✔ '}{trashMessage}</p>
            </div>
          ) : null}
          {trashItems === null ? (
            <p className="hint">{trashBusy ? '正在读取回收区…' : ''}</p>
          ) : trashItems.length === 0 ? (
            <p className="empty">回收区是空的。</p>
          ) : (
            <ul className="cardlist">
              {trashItems.map((entry) => (
                <li key={entry.trash_id}>
                  <div className="cardlist__item cardlist__item--static trashitem">
                    <div className="trashitem__info">
                      <span className="trashitem__path">{entry.original_path}</span>
                      <span className="cardlist__meta">
                        {entry.kind === 'dir' ? '文件夹' : '文件'}
                        {typeof entry.size === 'number' ? ` · ${entry.size} 字节` : ''}
                        {` · ${entry.deleted_at.slice(0, 19).replace('T', ' ')}`}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="trashitem__restore"
                      onClick={() => void restoreTrashEntry(entry)}
                      disabled={!online || trashBusy}
                    >
                      恢复
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="btnrow">
            <button
              type="button"
              className="btn"
              onClick={() => void loadTrash()}
              disabled={!online || trashBusy}
            >
              {trashBusy ? '正在刷新…' : '刷新回收区'}
            </button>
          </div>
          {!online ? <p className="hint">离线时无法读取/恢复回收区，联网后再试。</p> : null}
        </>
      ) : (
        <>
          <p className="field__label">第一步：扫描电脑上的配对二维码</p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void onScanPair()}
            disabled={scanning}
          >
            {scanning ? '配对中…（电脑上请点“允许”）' : '扫码配对'}
          </button>
          <p className="hint">
            在电脑 PocketCode 管理窗口点「显示配对二维码…」，然后用这里扫码。
            配对后本手机可访问该电脑全部授权项目。
          </p>
          {pairDescription ? (
            <div className={`result ${pairDescription.ok ? 'result--ok' : 'result--bad'}`}>
              <p className="result__title">
                {pairDescription.ok ? '✔ ' : '✘ '}
                {pairDescription.text}
              </p>
              {pairAttempt?.permissionDenied ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => void openAppSettings()}
                >
                  打开系统设置开启相机
                </button>
              ) : null}
            </div>
          ) : null}

          <p className="field__label">手动诊断（不配对也能测网络连通）</p>
          <input
            className="field__input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="例如 10.59.163.124:8765"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <div className="btnrow">
            <button
              type="button"
              className="btn"
              onClick={() => void onManualTest()}
              disabled={probeBusy}
            >
              {probeBusy ? '正在测试…' : '测试连接'}
            </button>
          </div>
          {invalidTip ? <p className="hint hint--error">{invalidTip}</p> : null}
          {manualDescription ? (
            <div className={`result ${manualDescription.ok ? 'result--ok' : 'result--bad'}`}>
              <p className="result__title">
                {manualDescription.ok ? '✔ ' : '✘ '}
                {manualDescription.title}
              </p>
              {manualDescription.hint ? (
                <p className="result__hint">{manualDescription.hint}</p>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      {status.state === 'tls-mismatch' ? (
        <p className="hint hint--error">
          当前网络里该地址的证书与配对时不一致，为安全起见已停止访问。
        </p>
      ) : null}
      <p className="hint" style={{ marginTop: 24, opacity: 0.6 }}>
        PocketCode {APP_BUILD}
      </p>
    </section>
  );
}
