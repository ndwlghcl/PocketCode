import { useState } from 'react';
import type { ManifestNode, ProjectSummary } from '../../api/types';
import { sortEntries } from './sortEntries';

interface Props {
  project: ProjectSummary;
  /** S0 使用 mock 根目录；S2 换成 manifest 快照。 */
  rootChildren: ManifestNode[];
  onBack: () => void;
}

interface Row {
  node: ManifestNode;
  depth: number;
}

/** 把目录树扁平化为“文件夹前、文件后、名称排序”的行列表。 */
function flatten(children: ManifestNode[], depth: number, out: Row[]): void {
  for (const node of sortEntries(children)) {
    out.push({ node, depth });
    if (node.type === 'dir') {
      flatten(node.children, depth + 1, out);
    }
  }
}

/** GitHub 风格逐层浏览的骨架（PRD §4.1）；文件点击行为在 S2 接入阅读器。 */
export function ExplorerScreen({ project, rootChildren, onBack }: Props) {
  const [hint, setHint] = useState<string | null>(null);
  const rows: Row[] = [];
  flatten(rootChildren, 0, rows);

  return (
    <section>
      <div className="navrow">
        <button type="button" className="navrow__back" onClick={onBack}>
          ‹ 返回
        </button>
        <span className="navrow__title">{project.name}</span>
      </div>
      <ul className="filelist">
        {rows.map(({ node, depth }) => (
          <li key={`${node.type}:${node.path}`}>
            <button
              type="button"
              className="filelist__item"
              style={{ paddingLeft: `${12 + depth * 20}px` }}
              onClick={() => {
                if (node.type === 'file') {
                  setHint(`“${node.name}” 将在 S2 打开只读阅读器（当前为骨架演示）`);
                }
              }}
            >
              <span className="filelist__icon">{node.type === 'dir' ? '📁' : '📄'}</span>
              <span>{node.name}</span>
            </button>
          </li>
        ))}
      </ul>
      {hint ? <p className="hint">{hint}</p> : null}
    </section>
  );
}
