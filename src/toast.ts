// ---------- Toast: a message at the bottom of the screen, for a few seconds ----------
export const toast = document.getElementById('toast')!;
let toastTimer: number | undefined;
export function showToast(text: string, ms = 4000) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), ms);
}
