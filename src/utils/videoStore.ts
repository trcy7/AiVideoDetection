/** IndexedDB-backed store for analyzed video blobs, keyed by history id.
 *
 *  Why not localStorage: history metadata lives in localStorage, but videos are
 *  megabytes each and localStorage caps at ~5 MB. Blob object-URLs also die on
 *  reload, so a persisted history item had no video to replay. IndexedDB holds
 *  real Blobs at disk-scale quota, and we mint a fresh object URL on demand when
 *  a history item is opened. Every call degrades to a no-op if IndexedDB is
 *  unavailable (private mode, quota) — history stays a convenience, never fatal.
 */
const DB_NAME = "ecnet-videos";
const STORE = "videos";
const VERSION = 1;
/** Skip storing videos above this size to protect the user's disk quota;
 *  those history items fall back to their thumbnail. */
const MAX_STORE_BYTES = 80 * 1024 * 1024;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putVideo(id: string, blob: Blob): Promise<void> {
  if (typeof indexedDB === "undefined" || blob.size > MAX_STORE_BYTES) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* quota / unavailable — silently skip; item keeps its thumbnail */
  }
}

export async function getVideo(id: string): Promise<Blob | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await openDb();
    const blob = await new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve((req.result as Blob) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return blob;
  } catch {
    return null;
  }
}

export async function deleteVideo(id: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    /* ignore */
  }
}

/** Drop any stored blob whose id is no longer in the history (evicted at the
 *  20-item cap), so IndexedDB can't grow without bound. */
export async function pruneVideos(keepIds: string[]): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const keep = new Set(keepIds);
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const req = store.getAllKeys();
      req.onsuccess = () => {
        for (const k of req.result as IDBValidKey[]) {
          if (!keep.has(String(k))) store.delete(k);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    /* ignore */
  }
}

export async function clearVideos(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    /* ignore */
  }
}
