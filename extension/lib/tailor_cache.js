// Tailoring the same resume to the same posting twice costs a second AI call and returns the same
// PDF, so the result is kept. The key is a hash of everything the call actually depends on - the
// model, the system prompt and the whole user message - which means it needs no invalidation rule:
// edit a bullet, change the model, or point at a different posting and the key simply stops matching.
// Its own storage key, like the usage meter, so a write here never races the big store write.
const KEY = "tailor_cache";
const MAX = 12;

export async function tailorKey(model, system, prompt) {
  // Length-prefixed so no combination of the three parts can hash to the same key as another.
  const join = [model, system, prompt].map((s) => `${s.length}:${s}`).join("");
  const bytes = new TextEncoder().encode(join);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A cache is an optimisation, never a reason to fail a tailoring run: every read and write here
// swallows its errors, so a full disk or a corrupt entry costs an AI call rather than the feature.
export async function readTailored(key, store = chrome.storage.local) {
  try {
    const hit = ((await store.get(KEY))[KEY] || {})[key];
    return hit && hit.value ? hit.value : null;
  } catch {
    return null;
  }
}

export async function writeTailored(key, value, store = chrome.storage.local) {
  try {
    const all = (await store.get(KEY))[KEY] || {};
    all[key] = { at: Date.now(), value };
    // Oldest evicted. A dozen writes can land in the same millisecond and tie on `at`, and a stable
    // sort would then keep the twelve oldest, so position breaks the tie: later in the object wins,
    // because a new key is appended to the end of it. That only holds while the object is ordered
    // oldest first, which is why what is kept is turned back the right way round before it is
    // stored - written newest first, the very next tie would read the order backwards and evict
    // the newest entry instead.
    const keep = Object.entries(all)
      .map((entry, i) => [entry, i])
      .sort((a, b) => b[0][1].at - a[0][1].at || b[1] - a[1])
      .slice(0, MAX)
      .map(([entry]) => entry)
      .reverse();
    await store.set({ [KEY]: Object.fromEntries(keep) });
  } catch {
    /* nothing to do: the caller already has the tailored resume */
  }
}

export async function clearTailored(store = chrome.storage.local) {
  try {
    await store.remove(KEY);
  } catch {
    /* already gone */
  }
}
