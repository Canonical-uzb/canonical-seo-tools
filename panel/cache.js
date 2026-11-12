// Keeps the last check of each tab until that tab reloads or navigates (the background worker clears it then).
// IndexedDB in the extension's own origin: stays on this computer, has room for large reports.
const DB = 'canonical-cache';
const STORE = 'tabs';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally { db.close(); }
}

export const loadTab = (tabId) => tx('readonly', (s) => s.get(tabId)).catch(() => null);
export const saveTab = (tabId, data) => tx('readwrite', (s) => s.put({ ...data, at: Date.now() }, tabId)).catch(() => {});
export const dropTab = (tabId) => tx('readwrite', (s) => s.delete(tabId)).catch(() => {});
