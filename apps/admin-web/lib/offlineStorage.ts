// Offline Storage layer for OralAI using browser IndexedDB.
// Provides local durability for audio recordings, upload queues, and exam session recovery.

export type StoredAnswer = {
  attemptId: string;
  sessionId: string;
  audio: Blob;
  filteredAudio: Blob | null;
  sttSource: "original" | "filtered";
  transcript: string;
  confidence: number | null;
  sttSkippedReason?: "MODEL_MISSING";
  originalText: string;
  key: string;
  savedAt: number;
};

export type StoredUploadJob = {
  id: string;
  attemptId: string;
  sessionId: string;
  kind: "AUDIO" | "SCREEN";
  blob: Blob;
  progress: number;
  status: "pending" | "uploading" | "done" | "failed";
  error?: string;
  updatedAt: number;
};

export type StoredSessionState = {
  sessionId: string;
  examId: string;
  attemptNumber: number;
  currentAttemptId?: string | null;
  lastActive: number;
};

const DB_NAME = "oralai_exam_offline_v1";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function isIndexedDBSupported(): boolean {
  return typeof window !== "undefined" && typeof window.indexedDB !== "undefined";
}

function getDB(): Promise<IDBDatabase | null> {
  if (!isIndexedDBSupported()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    try {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains("answers")) {
          const answerStore = db.createObjectStore("answers", { keyPath: "attemptId" });
          answerStore.createIndex("by_session", "sessionId", { unique: false });
        }

        if (!db.objectStoreNames.contains("uploadJobs")) {
          const jobStore = db.createObjectStore("uploadJobs", { keyPath: "id" });
          jobStore.createIndex("by_session", "sessionId", { unique: false });
          jobStore.createIndex("by_status", "status", { unique: false });
        }

        if (!db.objectStoreNames.contains("sessionState")) {
          db.createObjectStore("sessionState", { keyPath: "sessionId" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = (e) => {
        console.warn("[offlineStorage] Failed to open IndexedDB:", e);
        resolve(null);
      };
      request.onblocked = () => {
        console.warn("[offlineStorage] IndexedDB upgrade blocked by open tab");
        resolve(null);
      };
    } catch (e) {
      console.warn("[offlineStorage] IndexedDB initialization error:", e);
      resolve(null);
    }
  });

  return dbPromise;
}

/**
 * Saves or updates a recorded pending answer in local IndexedDB.
 */
export async function savePendingAnswer(answer: StoredAnswer): Promise<void> {
  const db = await getDB();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction("answers", "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.objectStore("answers").put(answer);
    } catch (e) {
      console.warn("[offlineStorage] savePendingAnswer error:", e);
      resolve();
    }
  });
}

/**
 * Retrieves a pending answer for a specific question attempt.
 */
export async function getPendingAnswer(attemptId: string): Promise<StoredAnswer | null> {
  const db = await getDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction("answers", "readonly");
      const req = tx.objectStore("answers").get(attemptId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Deletes a stored pending answer once it has been safely submitted.
 */
export async function deletePendingAnswer(attemptId: string): Promise<void> {
  const db = await getDB();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction("answers", "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.objectStore("answers").delete(attemptId);
    } catch {
      resolve();
    }
  });
}

/**
 * Saves or updates an upload job in IndexedDB.
 */
export async function saveUploadJob(job: StoredUploadJob): Promise<void> {
  const db = await getDB();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction("uploadJobs", "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.objectStore("uploadJobs").put({ ...job, updatedAt: Date.now() });
    } catch (e) {
      console.warn("[offlineStorage] saveUploadJob error:", e);
      resolve();
    }
  });
}

/**
 * Updates partial status/progress for an upload job.
 */
export async function updateUploadJobStatus(
  id: string,
  patch: Partial<StoredUploadJob>,
): Promise<void> {
  const db = await getDB();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction("uploadJobs", "readwrite");
      const store = tx.objectStore("uploadJobs");
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        if (getReq.result) {
          const updated = { ...getReq.result, ...patch, updatedAt: Date.now() };
          store.put(updated);
        }
        resolve();
      };
      getReq.onerror = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Gets all pending/in-flight/failed upload jobs for a given exam session.
 */
export async function getUploadJobsForSession(sessionId: string): Promise<StoredUploadJob[]> {
  const db = await getDB();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction("uploadJobs", "readonly");
      const index = tx.objectStore("uploadJobs").index("by_session");
      const req = index.getAll(sessionId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

/**
 * Gets all pending or failed upload jobs across all sessions.
 */
export async function getAllIncompleteUploadJobs(): Promise<StoredUploadJob[]> {
  const db = await getDB();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction("uploadJobs", "readonly");
      const req = tx.objectStore("uploadJobs").getAll();
      req.onsuccess = () => {
        const jobs = (req.result || []) as StoredUploadJob[];
        resolve(jobs.filter((j) => j.status !== "done"));
      };
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

/**
 * Deletes an upload job when verified complete on the backend.
 */
export async function deleteUploadJob(id: string): Promise<void> {
  const db = await getDB();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction("uploadJobs", "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.objectStore("uploadJobs").delete(id);
    } catch {
      resolve();
    }
  });
}

/**
 * Removes completed jobs for a session to prevent storage bloat.
 */
export async function clearCompletedUploadJobs(sessionId: string): Promise<void> {
  const db = await getDB();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction("uploadJobs", "readwrite");
      const store = tx.objectStore("uploadJobs");
      const index = store.index("by_session");
      const req = index.getAll(sessionId);
      req.onsuccess = () => {
        const jobs = (req.result || []) as StoredUploadJob[];
        for (const j of jobs) {
          if (j.status === "done") {
            store.delete(j.id);
          }
        }
        resolve();
      };
      req.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Saves current active session metadata.
 */
export async function saveSessionState(state: StoredSessionState): Promise<void> {
  const db = await getDB();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction("sessionState", "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.objectStore("sessionState").put(state);
    } catch {
      resolve();
    }
  });
}

/**
 * Clears session state when the exam is submitted or completed.
 */
export async function clearSessionState(sessionId: string): Promise<void> {
  const db = await getDB();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction("sessionState", "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.objectStore("sessionState").delete(sessionId);
    } catch {
      resolve();
    }
  });
}
