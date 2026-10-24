/** 占位组件：S1/S2 实现连接诊断、服务器地址、缓存策略与主题设置。 */
export function SettingsPlaceholder() {
  return (
    <section>
      <h1>设置</h1>
      <p className="empty">
        S1 提供：手动地址测试与连接诊断；S2 提供：扫码配对、可信设备、缓存策略。
      </p>
    </section>
  );
}
