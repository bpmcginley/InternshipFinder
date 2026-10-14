// Retry delays must release a canceled run immediately, without starting another request.
export function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException("The request was canceled.", "AbortError");
}

export function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    try { throwIfAborted(signal); } catch (error) { reject(error); return; }
    const finish = () => { signal?.removeEventListener("abort", cancel); resolve(); };
    const timer = setTimeout(finish, ms);
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(signal.reason || new DOMException("The request was canceled.", "AbortError"));
    };
    signal?.addEventListener("abort", cancel, { once: true });
  });
}
