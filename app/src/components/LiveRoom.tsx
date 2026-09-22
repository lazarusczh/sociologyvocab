// 课堂活动入口容器：按角色分流
//   教师 → LiveHost（创建/控制课堂活动）
//   学生 → LiveStudent（加入/答题）
// 将来加入第二种实时活动（如课堂猜词）时，在这里按 kind 再分流一层即可。
import { useStore } from '../lib/store';
import LiveHost from './LiveHost';
import LiveStudent from './LiveStudent';

export default function LiveRoom() {
  const { authUser, isTeacher } = useStore();

  // 未登录也给个明确说明（入口本身不隐藏，便于排查"看不到入口"到底是登录态还是没部署）
  if (!authUser) {
    return (
      <div className="card">
        <h2>课堂活动</h2>
        <p className="muted">课堂活动需要登录账号后才能参加，请先登录。</p>
      </div>
    );
  }

  return isTeacher ? <LiveHost /> : <LiveStudent />;
}
