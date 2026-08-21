import type { CSSProperties } from 'react';
import { useStore } from '../lib/store';

// 礼花配色：与整体界面素雅风格协调，同时保留庆祝感
const CONFETTI_COLORS = [
  '#5b6e8c', // accent
  '#4a7a4a', // success
  '#c98a3b', // warn（明亮金黄）
  '#b0524a', // danger
  '#8a6fb0', // 紫
  '#d3a02c', // 金
];

interface ConfettiPiece {
  left: number;    // 起始水平位置（%）
  w: number;       // 宽 px
  h: number;       // 高 px
  color: string;
  round: boolean;  // 圆形纸屑 or 矩形彩带
  delay: number;   // 动画延迟 s
  dur: number;     // 动画时长 s
  dx: number;      // 水平漂移 px
  rot: number;     // 旋转角度 deg
}

function makeConfetti(): ConfettiPiece[] {
  return Array.from({ length: 80 }, (_, i) => {
    const round = Math.random() > 0.45;
    const w = 6 + Math.random() * 6;
    const h = round ? w : 12 + Math.random() * 8;
    return {
      left: Math.random() * 100,
      w,
      h,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      round,
      delay: Math.random() * 1.4,
      dur: 2.6 + Math.random() * 1.8,
      dx: (Math.random() - 0.5) * 260,
      rot: (Math.random() - 0.5) * 720,
    };
  });
}

// 打卡成功弹窗：完成一组正式练习且当天达标后弹出
export default function CheckInCelebration() {
  const { checkinCelebration, dismissCelebration } = useStore();
  if (!checkinCelebration) return null;

  const pieces = makeConfetti();

  return (
    <div className="celebration-overlay" onClick={dismissCelebration}>
      <div className="celebration-confetti" aria-hidden="true">
        {pieces.map((p, i) => (
          <span
            key={i}
            className="confetti-piece"
            style={
              {
                left: `${p.left}%`,
                width: `${p.w}px`,
                height: `${p.h}px`,
                background: p.color,
                borderRadius: p.round ? '50%' : '2px',
                '--dur': `${p.dur}s`,
                '--delay': `${p.delay}s`,
                '--dx': `${p.dx}px`,
                '--rot': `${p.rot}deg`,
              } as CSSProperties
            }
          />
        ))}
      </div>
      <div
        className="celebration-modal"
        role="dialog"
        aria-modal="true"
        aria-label="打卡成功"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="celebration-icon" aria-hidden="true">✓</div>
        <div className="celebration-title">打卡成功！</div>
        <div className="celebration-desc">今日打卡目标已完成，继续保持！</div>
        <button className="primary" onClick={dismissCelebration}>太棒了，继续学习</button>
      </div>
    </div>
  );
}