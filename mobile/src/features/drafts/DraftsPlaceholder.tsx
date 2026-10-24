/** 占位组件：S3 实现草稿箱（多文件多副本、离线可编辑、比较与分享标注）。 */
export function DraftsPlaceholder() {
  return (
    <section>
      <h1>草稿箱</h1>
      <p className="empty">
        S3 提供：多份命名草稿、离线编辑、与电脑/缓存/其他草稿比较；缓存清理不得影响草稿。
      </p>
    </section>
  );
}
