// 弹层先消费 Android 返回；根页面监听器统一分发，避免多个原生监听器同时返回。
const layers: { close: () => void }[] = [];
export function addBackLayer(close: () => void): () => void {
  const layer = { close }; layers.push(layer);
  return () => { const index = layers.indexOf(layer); if (index >= 0) layers.splice(index, 1); };
}
export function closeTopLayer(): boolean {
  const layer = layers.at(-1);
  if (!layer) return false;
  layer.close(); return true;
}
