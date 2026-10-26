/* ==========================================================================
   Linked Media Files (File System Access API)
   Remembers which local file a project was made from so the project can
   reopen it without the file picker. Handles survive in IndexedDB through
   structured cloning; they never survive JSON. Chromium desktop provides
   them; everywhere else the classic <input type="file"> flow is used.
   ========================================================================== */

const MEDIA_PICKER_TYPES = [{
  description: 'Audio & Video',
  accept: {
    'video/*': ['.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.ogv'],
    'audio/*': ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.weba']
  }
}];

/** True when the browser can hand out persistable file handles (Chromium desktop, secure context). */
export function supportsFileHandles() {
  return typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function';
}

/** Duck-types a FileSystemFileHandle: a restored IndexedDB record may hold anything under that name. */
export function isFileHandle(value) {
  return Boolean(value) && typeof value === 'object' && value.kind === 'file' && typeof value.getFile === 'function';
}

/** JSON.stringify replacer that leaves file handles out (they would serialise to an empty object). */
export function omitFileHandle(key, value) {
  return key === 'fileHandle' ? undefined : value;
}

/** Shallow copy of a session record without its file handle, for JSON backups and restores. */
export function stripFileHandle(data) {
  if (!data || typeof data !== 'object') return data;
  const { fileHandle, ...rest } = data;
  return rest;
}

/** The storage key a local file's project saves under (must agree with StateStore.getStorageKey). */
export function fileSessionKey(file) {
  return `ln_session_${file.name}_${file.size}`;
}

/**
 * Opens the native file picker and resolves { file, handle }, or null when the user cancels.
 * Rejects when the picker itself is unavailable or refused, so the caller can fall back to
 * the hidden <input type="file">. Must be called from a user gesture.
 */
export async function pickMediaFile() {
  try {
    const [handle] = await window.showOpenFilePicker({
      id: 'lined-notes-media', // Chrome remembers the last directory per id
      multiple: false,
      types: MEDIA_PICKER_TYPES,
      excludeAcceptAllOption: false
    });
    if (!handle) return null;
    return { file: await handle.getFile(), handle };
  } catch (err) {
    if (err && err.name === 'AbortError') return null;
    throw err;
  }
}

/**
 * Starts resolving the handle of the first dropped file. Call it synchronously inside the drop
 * handler: DataTransfer items are only readable while the event is being dispatched.
 * Resolves to null when the browser can't provide handles or the item is a directory.
 */
export function getDroppedFileHandle(dataTransfer) {
  const items = dataTransfer && dataTransfer.items;
  if (!items) return Promise.resolve(null);
  for (const item of items) {
    if (item.kind !== 'file') continue;
    if (typeof item.getAsFileSystemHandle !== 'function') return Promise.resolve(null);
    return item.getAsFileSystemHandle()
      .then(handle => (isFileHandle(handle) ? handle : null))
      .catch(() => null);
  }
  return Promise.resolve(null);
}

/** 'granted' | 'prompt' | 'denied'. A handle without permission methods is treated as readable. */
export async function queryHandlePermission(handle) {
  if (!isFileHandle(handle)) return 'denied';
  if (typeof handle.queryPermission !== 'function') return 'granted';
  try {
    return await handle.queryPermission({ mode: 'read' });
  } catch (err) {
    return 'prompt';
  }
}

/**
 * Asks for read access. The browser only shows its prompt during a user gesture; outside one the
 * request fails and 'prompt' is returned, meaning a click on Reopen is still needed.
 */
export async function requestHandlePermission(handle) {
  if (!isFileHandle(handle)) return 'denied';
  if (typeof handle.requestPermission !== 'function') return 'granted';
  try {
    return await handle.requestPermission({ mode: 'read' });
  } catch (err) {
    return 'prompt';
  }
}

/** Reads the handle's File: { file } on success, otherwise { error: 'missing' | 'denied' | 'failed' }. */
export async function readHandleFile(handle) {
  try {
    return { file: await handle.getFile() };
  } catch (err) {
    const name = err && err.name;
    if (name === 'NotFoundError') return { error: 'missing' };
    if (name === 'NotAllowedError' || name === 'SecurityError') return { error: 'denied' };
    return { error: 'failed' };
  }
}
