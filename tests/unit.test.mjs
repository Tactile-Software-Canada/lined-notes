/* ==========================================================================
   Unit tests for pure helpers — run with: node --test tests/*.test.mjs
   No dependencies; only modules without top-level DOM access are imported.
   ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatSRTTime,
  formatVTTTime,
  parseTimeToSeconds,
  parseMediaUrl,
  sanitizeImageSrc
} from '../js/utils.js';
import { ImportManager } from '../js/import.js';

// ImportManager's constructor touches the DOM; its parsers don't, so call them on a bare instance
const importer = Object.create(ImportManager.prototype);

test('formatSRTTime never produces 4-digit milliseconds', () => {
  assert.equal(formatSRTTime(1.9996), '00:00:02,000');
  assert.equal(formatSRTTime(59.9999), '00:01:00,000');
  assert.equal(formatSRTTime(3725.5), '01:02:05,500');
  assert.equal(formatSRTTime(-1), '00:00:00,000');
  assert.equal(formatVTTTime(1.25), '00:00:01.250');
});

test('parseTimeToSeconds handles SRT, VTT and short forms', () => {
  assert.equal(parseTimeToSeconds('00:01:02,500'), 62.5);
  assert.equal(parseTimeToSeconds('01:02.5'), 62.5);
  assert.equal(parseTimeToSeconds('42'), 42);
  assert.ok(Number.isNaN(parseTimeToSeconds('')));
});

test('parseMediaUrl recognises YouTube forms and start times', () => {
  assert.equal(parseMediaUrl('https://youtu.be/dQw4w9WgXcQ?t=1m30s').startTime, 90);
  assert.equal(parseMediaUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ').videoId, 'dQw4w9WgXcQ');
  const direct = parseMediaUrl('https://example.com/media/talk.mp3');
  assert.equal(direct.type, 'direct');
  assert.equal(direct.isAudio, true);
  assert.equal(parseMediaUrl('ftp://example.com/a.mp4'), null);
});

test('sanitizeImageSrc only allows image data URLs and http(s)', () => {
  assert.equal(sanitizeImageSrc('x" onerror="alert(1)'), null);
  assert.equal(sanitizeImageSrc('javascript:alert(1)'), null);
  assert.equal(sanitizeImageSrc('data:text/html;base64,PHNjcmlwdD4='), null);
  assert.equal(sanitizeImageSrc('data:image/jpeg;base64,/9j/4AAQ=='), 'data:image/jpeg;base64,/9j/4AAQ==');
  assert.equal(sanitizeImageSrc('https://img.youtube.com/vi/x/hqdefault.jpg'), 'https://img.youtube.com/vi/x/hqdefault.jpg');
  assert.equal(sanitizeImageSrc(null), null);
});

test('JSON import notes are validated', () => {
  assert.equal(importer.normalizeJsonNote({ start: 'abc', text: 'x' }), null);
  assert.equal(importer.normalizeJsonNote({ start: -3, text: 'x' }), null);
  const n = importer.normalizeJsonNote({ id: 7, start: '4.5', end: 2, text: 'hi', tag: 'bogus', thumb: 'x" onerror="y' });
  assert.equal(n.id, '7');
  assert.equal(n.start, 4.5);
  assert.equal(n.end, null); // end before start is dropped
  assert.equal(n.tag, 'note'); // unknown tags fall back
  assert.equal(n.thumb, null);
});

test('CSV import handles quotes, commas and newlines in cells', () => {
  const csv = 'Start Time,Start Seconds,End Time,End Seconds,Tag,Note\n' +
    '"00:00:01.0",1.000,"","","Issue","He said ""hi"", then\nleft"\n';
  const [note] = importer.parseCSVNotes(csv);
  assert.equal(note.start, 1);
  assert.equal(note.tag, 'issue');
  assert.equal(note.text, 'He said "hi", then\nleft');
});

test('subtitle import parses cues', () => {
  const srt = '1\n00:00:01,000 --> 00:00:03,500\nFirst line\n\n2\n00:00:05,000 --> 00:00:06,000\nSecond\n';
  const notes = importer.parseSubtitleCues(srt);
  assert.equal(notes.length, 2);
  assert.equal(notes[0].end, 3.5);
  assert.equal(notes[1].text, 'Second');
});

// ─── UX round: launch params, note editing, undo, backups ─────────────

import { parseLaunchParams, resolveNoteTimes } from '../js/utils.js';
import { UndoHistory } from '../js/history.js';
import { parseBackup, mergeSessionData } from '../js/sessions.js';

test('parseLaunchParams reads deep links, share targets and shortcuts', () => {
  assert.deepEqual(parseLaunchParams('?action=open', ''), { action: 'open', mediaInput: null });
  assert.equal(parseLaunchParams('?v=dQw4w9WgXcQ&t=90').mediaInput, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90');
  assert.equal(parseLaunchParams('?v=dQw4w9WgXcQ', '#t=1m30s').mediaInput, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s');
  // a URL that already carries its own start time is left alone
  assert.equal(parseLaunchParams('?url=' + encodeURIComponent('https://youtu.be/dQw4w9WgXcQ?t=5') + '&t=90').mediaInput, 'https://youtu.be/dQw4w9WgXcQ?t=5');
  // Android share sheets often put the link inside free text
  assert.equal(parseLaunchParams('?text=' + encodeURIComponent('Watch this https://youtu.be/dQw4w9WgXcQ !')).mediaInput, 'https://youtu.be/dQw4w9WgXcQ');
  assert.deepEqual(parseLaunchParams('', ''), { action: null, mediaInput: null });
});

test('resolveNoteTimes validates edited start/end', () => {
  const note = { start: 10.04, end: null };
  assert.deepEqual(resolveNoteTimes(note, null, null, 60), { start: 10.04, end: null }); // unchanged keeps precision
  assert.deepEqual(resolveNoteTimes(note, '00:00:05.0', '00:00:08', 60), { start: 5, end: 8 });
  assert.deepEqual(resolveNoteTimes({ start: 5, end: 8 }, null, '', 60), { start: 5, end: null });
  assert.equal(resolveNoteTimes(note, 'abc', null, 60).error, 'Invalid start time');
  assert.equal(resolveNoteTimes(note, null, '00:00:09', 60).error, 'End time must be after the start time');
  assert.equal(resolveNoteTimes(note, '02:00', null, 60).error, 'Start is past the end of the media');
  assert.deepEqual(resolveNoteTimes(note, null, '99', 60), { start: 10.04, end: 60 }); // end clamped to duration
});

test('UndoHistory caps size, snapshots shallowly and merges repeated keys', () => {
  const h = new UndoHistory(3);
  const notes = [{ id: 'a', start: 1 }];
  for (let i = 0; i < 5; i++) h.push(`op${i}`, notes);
  assert.equal(h.size, 3);
  assert.equal(h.undo(notes).label, 'op4');

  const h2 = new UndoHistory();
  h2.push('nudge', [{ id: 'a', start: 1 }], 'nudge:a');
  h2.push('nudge', [{ id: 'a', start: 1.1 }], 'nudge:a');
  assert.equal(h2.size, 1);
  assert.equal(h2.undo([]).notes[0].start, 1); // the run reverts to before the first nudge

  const live = [{ id: 'b', start: 2 }];
  h2.push('edit', live);
  live[0].start = 99;
  assert.equal(h2.undo(live).notes[0].start, 2); // later mutation doesn't leak into the snapshot
});

test('UndoHistory redo walks forward and is cleared by a new change', () => {
  const h = new UndoHistory();
  const v0 = [{ id: 'a', text: 'v0' }];
  const v1 = [{ id: 'a', text: 'v1' }];
  const v2 = [{ id: 'a', text: 'v2' }];
  h.push('edit', v0); // v0 -> v1
  h.push('edit', v1); // v1 -> v2
  assert.equal(h.undo(v2).notes[0].text, 'v1');
  assert.equal(h.undo(v1).notes[0].text, 'v0');
  assert.equal(h.undo(v0), null);
  assert.equal(h.redo(v0).notes[0].text, 'v1');
  assert.equal(h.redo(v1).notes[0].text, 'v2');
  assert.equal(h.redo(v2), null);

  assert.equal(h.undo(v2).notes[0].text, 'v1');
  h.push('delete', v1); // a new change after undo drops the redo branch
  assert.equal(h.redoSize, 0);
  assert.equal(h.redo(v1), null);
});

test('UndoHistory only merges back-to-back runs', () => {
  const h = new UndoHistory();
  h.push('nudge', [{ id: 'a', start: 1 }], 'nudge:a');   // run 1 starts at 1
  h.undo([{ id: 'a', start: 1.3 }]);                    // undo run 1
  h.redo([{ id: 'a', start: 1 }]);                      // redo it -> start 1.3
  h.push('nudge', [{ id: 'a', start: 1.3 }], 'nudge:a'); // run 2 must be its own step
  assert.equal(h.size, 2);
  assert.equal(h.undo([{ id: 'a', start: 1.6 }]).notes[0].start, 1.3);
});

test('parseBackup validates the file and sanitises notes', () => {
  assert.throws(() => parseBackup('not json'), /not valid JSON/);
  assert.throws(() => parseBackup('{"notes":[]}'), /Not a Lined Notes backup/);
  const entries = parseBackup(JSON.stringify({
    type: 'backup',
    sessions: [
      { key: 'ln_session_a.mp4_1', data: { fileName: 'a.mp4', notes: [{ id: 1, start: 2, text: 'ok', thumb: 'x" onerror="y' }, { start: 'bad' }] } },
      { key: 'other_key', data: { notes: [] } }
    ]
  }));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].data.notes.length, 1);
  assert.equal(entries[0].data.notes[0].thumb, null);
});

test('mergeSessionData keeps existing metadata and unions notes by id', () => {
  const existing = { fileName: 'Renamed', updatedAt: '2026-01-02T00:00:00Z', notes: [{ id: '1', start: 5 }] };
  const incoming = { fileName: 'orig.mp4', updatedAt: '2026-03-01T00:00:00Z', notes: [{ id: '1', start: 5 }, { id: '2', start: 1 }] };
  const merged = mergeSessionData(existing, incoming);
  assert.equal(merged.fileName, 'Renamed');
  assert.deepEqual(merged.notes.map(n => n.id), ['2', '1']);
  assert.equal(merged.updatedAt, '2026-03-01T00:00:00Z');
  assert.equal(mergeSessionData(null, incoming), incoming);
});

test('backup restore keeps note edit times and the newer copy of a note', () => {
  const [entry] = parseBackup(JSON.stringify({
    type: 'backup',
    sessions: [{ key: 'ln_session_a.mp4_1', data: { notes: [
      { id: 'x', start: 1, text: 'laptop edit', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' },
      { id: 'y', start: 2, text: 'stale', createdAt: '2026-01-01T00:00:00.000Z' }
    ] } }]
  }));
  assert.equal(entry.data.notes[0].updatedAt, '2026-05-01T00:00:00.000Z');
  assert.equal('updatedAt' in entry.data.notes[1], false);

  const existing = { notes: [
    { id: 'x', start: 1, text: 'old', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'y', start: 2, text: 'phone edit', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-04-01T00:00:00.000Z' }
  ] };
  const merged = mergeSessionData(existing, entry.data);
  assert.deepEqual(merged.notes.map(n => n.text), ['laptop edit', 'phone edit']);
});

// ─── Getting Started guide ──────────────────────────────────────────────

import { shouldAutoShowOnboarding, ONBOARDING_STEPS } from '../js/onboarding.js';

test('onboarding auto-shows only on a genuine first visit', () => {
  const fresh = { seen: false, hasSavedProjects: false, launchedWithMedia: false };
  assert.deepEqual(shouldAutoShowOnboarding(fresh), { show: true, markSeen: true });
  assert.deepEqual(shouldAutoShowOnboarding({ ...fresh, seen: true }), { show: false, markSeen: false });
  // existing users aren't first-time visitors
  assert.deepEqual(shouldAutoShowOnboarding({ ...fresh, hasSavedProjects: true }), { show: false, markSeen: true });
  // opened straight into media: don't interrupt, show next time
  assert.deepEqual(shouldAutoShowOnboarding({ ...fresh, launchedWithMedia: true }), { show: false, markSeen: false });
});

test('onboarding steps provide desktop and touch copy', () => {
  assert.equal(ONBOARDING_STEPS.length, 6);
  for (const step of ONBOARDING_STEPS) {
    assert.ok(step.title && step.body(false).trim() && step.body(true).trim(), step.id);
  }
  // keyboard tips are swapped out on touch devices
  const capture = ONBOARDING_STEPS.find(s => s.id === 'capture');
  assert.match(capture.body(false), /<kbd>N<\/kbd>/);
  assert.doesNotMatch(capture.body(true), /<kbd>/);
});

// ─── Linked media files (File System Access API helpers) ───────────────

import {
  isFileHandle, omitFileHandle, stripFileHandle, fileSessionKey,
  getDroppedFileHandle, queryHandlePermission, requestHandlePermission, readHandleFile
} from '../js/file-handles.js';
import { state } from '../js/state.js';

// Handles are host objects; a minimal stand-in with the methods the app relies on
const fakeHandle = (overrides = {}) => ({
  kind: 'file',
  name: 'clip.mp4',
  getFile: async () => ({ name: 'clip.mp4', size: 10 }),
  queryPermission: async () => 'prompt',
  requestPermission: async () => 'granted',
  ...overrides
});

test('isFileHandle only accepts handle-shaped objects', () => {
  assert.equal(isFileHandle(fakeHandle()), true);
  assert.equal(isFileHandle({ kind: 'directory', getFile() { } }), false);
  assert.equal(isFileHandle({}), false);       // what a handle becomes after a JSON round trip
  assert.equal(isFileHandle(null), false);
  assert.equal(isFileHandle('clip.mp4'), false);
});

test('file handles stay out of JSON but other fields survive', () => {
  const data = { fileName: 'clip.mp4', notes: [{ id: 1 }], fileHandle: fakeHandle() };
  assert.deepEqual(JSON.parse(JSON.stringify(data, omitFileHandle)), { fileName: 'clip.mp4', notes: [{ id: 1 }] });
  const stripped = stripFileHandle(data);
  assert.equal('fileHandle' in stripped, false);
  assert.equal(stripped.notes, data.notes);
  assert.equal(isFileHandle(data.fileHandle), true, 'the original record is left alone');
  assert.equal(stripFileHandle(null), null);
});

test('parseBackup drops anything a backup carries as fileHandle', () => {
  const [entry] = parseBackup(JSON.stringify({
    type: 'backup',
    sessions: [{ key: 'ln_session_a.mp4_1', data: { fileName: 'a.mp4', fileHandle: {}, notes: [] } }]
  }));
  assert.equal('fileHandle' in entry.data, false);
  // Merging such a restore into a linked project must keep the stored handle
  const existing = { fileName: 'a.mp4', fileHandle: fakeHandle(), notes: [] };
  assert.equal(isFileHandle(mergeSessionData(existing, entry.data).fileHandle), true);
});

test('fileSessionKey matches the key the state store saves a file under', () => {
  const file = { name: 'a b.mp4', size: 1234 };
  state.mediaSourceType = 'file';
  state.mediaFile = file;
  assert.equal(fileSessionKey(file), state.getStorageKey());
  state.mediaFile = null;
  state.mediaSourceType = null;
});

test('getDroppedFileHandle resolves the first dropped file and tolerates everything else', async () => {
  const handle = fakeHandle();
  const items = [
    { kind: 'string' },
    { kind: 'file', getAsFileSystemHandle: async () => handle },
    { kind: 'file', getAsFileSystemHandle: async () => { throw new Error('nope'); } }
  ];
  assert.equal(await getDroppedFileHandle({ items }), handle);
  assert.equal(await getDroppedFileHandle({ items: [{ kind: 'file', getAsFileSystemHandle: async () => ({ kind: 'directory' }) }] }), null);
  assert.equal(await getDroppedFileHandle({ items: [{ kind: 'file', getAsFileSystemHandle: async () => { throw new Error('x'); } }] }), null);
  assert.equal(await getDroppedFileHandle({ items: [{ kind: 'file' }] }), null, 'browser without the API');
  assert.equal(await getDroppedFileHandle({ items: [] }), null);
  assert.equal(await getDroppedFileHandle(null), null);
});

test('permission helpers report what the handle says and degrade safely', async () => {
  assert.equal(await queryHandlePermission(fakeHandle()), 'prompt');
  assert.equal(await requestHandlePermission(fakeHandle()), 'granted');
  assert.equal(await queryHandlePermission(fakeHandle({ queryPermission: undefined })), 'granted', 'no permission model means readable');
  // Chrome rejects requestPermission outside a user gesture: that just means a click is still needed
  assert.equal(await requestHandlePermission(fakeHandle({ requestPermission: async () => { throw new DOMException('gesture', 'SecurityError'); } })), 'prompt');
  assert.equal(await queryHandlePermission({}), 'denied');
  assert.equal(await requestHandlePermission(null), 'denied');
});

test('readHandleFile classifies getFile failures', async () => {
  const { file } = await readHandleFile(fakeHandle());
  assert.equal(file.name, 'clip.mp4');
  const failing = name => fakeHandle({ getFile: async () => { throw new DOMException('x', name); } });
  assert.deepEqual(await readHandleFile(failing('NotFoundError')), { error: 'missing' });
  assert.deepEqual(await readHandleFile(failing('NotAllowedError')), { error: 'denied' });
  assert.deepEqual(await readHandleFile(failing('SecurityError')), { error: 'denied' });
  assert.deepEqual(await readHandleFile(failing('InvalidStateError')), { error: 'failed' });
});

// ─── Last open project ───────────────────────────────────────────────

import { SessionsManager } from '../js/sessions.js';
import { APP_CONFIG } from '../js/config.js';

const fakeStorage = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
// SessionsManager's constructor touches the DOM; the last-project helpers only need db and openSessionByKey
const bareSessions = (records = {}) => {
  const s = Object.create(SessionsManager.prototype);
  s.db = { get: async k => records[k] || null };
  s.opened = [];
  s.openSessionByKey = async k => { s.opened.push(k); };
  return s;
};

test('last project is remembered, forgotten by key, and read back', () => {
  globalThis.localStorage = fakeStorage();
  const s = bareSessions();
  assert.equal(s.getLastProjectKey(), null);
  s.rememberLastProject('ln_session_a.mp4_1');
  assert.equal(s.getLastProjectKey(), 'ln_session_a.mp4_1');
  s.forgetLastProject('ln_session_other_2');
  assert.equal(s.getLastProjectKey(), 'ln_session_a.mp4_1', 'deleting another project leaves it');
  s.forgetLastProject('ln_session_a.mp4_1');
  assert.equal(s.getLastProjectKey(), null);
  s.rememberLastProject('ln_session_a.mp4_1');
  s.forgetLastProject();
  assert.equal(s.getLastProjectKey(), null, 'New Project clears it unconditionally');
  s.rememberLastProject(null);
  assert.equal(s.getLastProjectKey(), null);
});

test('reopenLastProject opens the remembered project only when nothing got there first', async () => {
  globalThis.localStorage = fakeStorage();
  const key = 'ln_session_a.mp4_1';
  let s = bareSessions({ [key]: { fileName: 'a.mp4', notes: [] } });
  assert.equal(await s.reopenLastProject(), false, 'nothing remembered');
  assert.deepEqual(s.opened, []);

  localStorage.setItem(APP_CONFIG.lastProjectKey, key);
  assert.equal(await s.reopenLastProject(), true);
  assert.deepEqual(s.opened, [key]);
  assert.equal(s.getLastProjectKey(), key, 'stays remembered after reopening');

  s = bareSessions({ [key]: { fileName: 'a.mp4', notes: [] } });
  assert.equal(await s.reopenLastProject(() => true), false, 'an OS file launch takes precedence');
  assert.deepEqual(s.opened, []);

  s = bareSessions({});
  assert.equal(await s.reopenLastProject(), false, 'deleted elsewhere');
  assert.equal(s.getLastProjectKey(), null, 'a missing project is forgotten');

  localStorage.setItem(APP_CONFIG.lastProjectKey, key);
  s = bareSessions({ [key]: { fileName: 'a.mp4', notes: [] } });
  state.detachedMode = true; // something is already showing
  assert.equal(await s.reopenLastProject(), false);
  state.detachedMode = false;
  assert.deepEqual(s.opened, []);
});

test('autoRestoreSession saves a notebook for media opened for the first time, even with no notes', async () => {
  state.mediaSourceType = 'file';
  state.mediaFile = { name: 'a.mp4', size: 1 };
  state.mediaTitle = 'a.mp4';
  state.notes = [];
  const key = state.getStorageKey();
  const withSaveSpy = s => { s.saves = 0; s.saveSession = async () => { s.saves++; }; return s; };

  const fresh = withSaveSpy(bareSessions({}));
  await fresh.autoRestoreSession();
  assert.equal(fresh.saves, 1, 'new media gets an empty notebook');

  const known = withSaveSpy(bareSessions({ [key]: { fileName: 'a.mp4', notes: [] } }));
  await known.autoRestoreSession();
  assert.equal(known.saves, 0, 'an existing notebook is not rewritten just for opening it');

  state.mediaFile = null;
  state.mediaSourceType = null;
  state.mediaTitle = null;
});
