import type { ReactNode } from 'react';

/** 通用确认弹层：替代 window.confirm（iframe 预览沙箱里 confirm 被禁用，自定义 UI 在 iframe 与 APK WebView 中都可可靠工作）。
 *
 * 约定：
 * - `onConfirm` 只负责「执行」，关弹层由调用方决定（便于执行期间保持弹层与按钮 busy）；
 * - `confirmDisabled` 可用来做「延迟可点」——防止连点两下时第二次点击穿过弹层直接命中确认。
 */
export default function ConfirmModal({ open, title, body, confirmText = '确认', cancelText = '取消', confirmDisabled = false, dismissOnBackdrop = true, onCancel, onConfirm }: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmText?: string;
  cancelText?: string;
  confirmDisabled?: boolean;
  /** 点遮罩是否等同「取消」。误触敏感的场景（如交卷确认）建议传 false，只认按钮。 */
  dismissOnBackdrop?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(15, 20, 27, 0.45)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}
      onClick={dismissOnBackdrop ? onCancel : undefined}
    >
      <div className="card" style={{ maxWidth: 440, width: '100%', padding: '1rem' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        <div className="muted" style={{ fontSize: '0.9rem', whiteSpace: 'pre-line' }}>{body}</div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.9rem' }}>
          <button onClick={onCancel} disabled={confirmDisabled}>{cancelText}</button>
          <button className="primary" onClick={onConfirm} disabled={confirmDisabled}>{confirmText}</button>
        </div>
      </div>
    </div>
  );
}
