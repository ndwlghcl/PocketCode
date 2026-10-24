import type { ProjectSummary } from '../../api/types';

interface Props {
  projects: ProjectSummary[];
  onOpenProject: (project: ProjectSummary) => void;
}

/** 启动默认页：项目列表。真实数据与“最近阅读”标记在 S2 实现。 */
export function ProjectListScreen({ projects, onOpenProject }: Props) {
  return (
    <section>
      <h1 className="screen__title">项目</h1>
      {projects.length === 0 ? (
        <p className="empty">尚未连接电脑。首次使用请先在电脑端添加授权项目。</p>
      ) : (
        <ul className="cardlist">
          {projects.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                className="cardlist__item"
                onClick={() => onOpenProject(project)}
              >
                <span className="cardlist__name">{project.name}</span>
                <span className="cardlist__meta">快照 #{project.revision}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
