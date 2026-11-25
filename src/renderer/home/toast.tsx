// 操作结果提示：删除后的“撤销”（R06.AC-2）和失败提示。读屏软件通过 role=status 读出。

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error';
  action?: { label: string; run: () => void };
  durationMs: number;
}

interface ToastApi {
  show(toast: Omit<Toast, 'id' | 'durationMs' | 'tone'> & { tone?: Toast['tone']; durationMs?: number }): void;
  error(message: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('ToastProvider missing');
  return api;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const nextId = useRef(0);

  const show = useCallback<ToastApi['show']>((input) => {
    window.clearTimeout(timer.current);
    const next: Toast = { tone: 'info', durationMs: 4000, ...input, id: ++nextId.current };
    setToast(next);
    timer.current = window.setTimeout(() => setToast(null), next.durationMs);
  }, []);

  const error = useCallback((message: string) => show({ message, tone: 'error', durationMs: 6000 }), [show]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <ToastContext.Provider value={{ show, error }}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {toast && (
          <div className={`toast toast-${toast.tone}`} key={toast.id}>
            <span>{toast.message}</span>
            {toast.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  toast.action?.run();
                  setToast(null);
                }}
              >
                {toast.action.label}
              </button>
            )}
            <button type="button" className="toast-close" aria-label="关闭提示" onClick={() => setToast(null)}>
              ×
            </button>
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}
