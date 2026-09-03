import { useStore } from '../lib/store';
import ConceptMapViewer from './ConceptMapViewer';

// 概念网络展示页（资料区二级，面向所有用户）：复用教师后台「关系网络」图谱组件，
// 只读浏览术语/学者间的逻辑关系；默认不显示派生同级（全开会过密/卡顿），也不提供开关。
export default function ConceptMapView() {
  const { vocab } = useStore();

  return (
    <div>
      <h1>概念网络</h1>
      <p className="muted" style={{ fontSize: '0.9rem' }}>
        浏览词条之间的逻辑关系：蓝色箭头 = 高于（高→低）、绿色虚线 = 并列、红色虚线 = 相反。
        输入概念可聚焦其局部上下游并调整查看范围；节点越深代表连接越广（可能是核心概念）。
      </p>
      {vocab.length === 0 ? (
        <div className="card center">
          <p className="muted">词库尚未加载，请稍后刷新重试。</p>
        </div>
      ) : (
        <ConceptMapViewer vocab={vocab} title="概念网络" height={520} />
      )}
    </div>
  );
}
