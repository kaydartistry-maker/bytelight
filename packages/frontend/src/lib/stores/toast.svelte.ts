let toasts = $state<Array<{ id: number; message: string; type: 'success' | 'error' | 'info' }>>([]);
let nextId = 0;

export function getToasts() {
  return toasts;
}

export function showToast(message: string, type: 'success' | 'error' | 'info' = 'info', duration = 4000) {
  const id = nextId++;
  toasts = [...toasts, { id, message, type }];
  setTimeout(() => {
    toasts = toasts.filter(t => t.id !== id);
  }, duration);
}

export function dismissToast(id: number) {
  toasts = toasts.filter(t => t.id !== id);
}
