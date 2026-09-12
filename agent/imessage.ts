import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const exec = promisify(execFile)
const automatedTexts = new Map<string, Set<string>>()
const selfAllowed = (phone: string) => (process.env.IMESSAGE_SELF_ALLOW ?? '').split(',').map(s => s.trim()).includes(phone)
const canonicalText = (text: string) => text.normalize('NFC').replace(/\r\n/g, '\n')
export function assertAllowed(phone: string) {
  if (!/^\+[1-9]\d{7,14}$/.test(phone) || !(process.env.IMESSAGE_ALLOW ?? '').split(',').map(s => s.trim()).includes(phone)) throw new Error('Phone is not in IMESSAGE_ALLOW')
}
export async function sendIMessage(phone: string, text: string) {
  assertAllowed(phone)
  // Register before osascript: Messages may insert a row before it returns.
  const texts = automatedTexts.get(phone) ?? new Set<string>()
  texts.add(canonicalText(text)); automatedTexts.set(phone, texts)
  const quote = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n') + '"'
  for (const service of ['iMessage', 'SMS']) {
    try {
      await exec('osascript', ['-e', `tell application "Messages" to send ${quote(text)} to participant ${quote(phone)} of (1st account whose service type = ${service})`])
      return true
    } catch (error) { console.warn(`[imessage] ${service} unavailable: ${String(error).slice(0, 140)}`) }
  }
  return false
}
export function createIMessageReader(db: Database.Database, startDateNs: number) {
  const cursors = new Map<string, number>()
  const query = db.prepare('SELECT message.ROWID AS rowid, message.text, message.date FROM message JOIN handle ON message.handle_id = handle.ROWID WHERE handle.id = ? AND (message.is_from_me = 0 OR ? = 1) AND message.date > ? AND message.ROWID > ? ORDER BY message.ROWID')
  return (phone: string) => {
    assertAllowed(phone)
    const self = selfAllowed(phone)
    const rows = query.all(phone, self ? 1 : 0, startDateNs, cursors.get(phone) ?? 0) as Array<{ rowid: number; text: string | null; date: number }>
    if (rows.length) cursors.set(phone, rows.at(-1)!.rowid)
    // Keep every sent text for this process lifetime: duplicate/synced copies and
    // failed-send retries must never re-enter the conversation as patient replies.
    return rows.filter(row => row.text && (!self || !automatedTexts.get(phone)?.has(canonicalText(row.text))))
  }
}
export function pollIMessages(active: () => Array<{ phone: string; patientId: string }>, receive: (patientId: string, text: string) => Promise<void>) {
  let db: Database.Database
  try { db = new Database(join(homedir(), 'Library/Messages/chat.db'), { readonly: true, fileMustExist: true }) }
  catch (error) { console.warn('[imessage] receive unavailable; console fallback active:', String(error)); return () => {} }
  const startDateNs = (Date.now() - Date.UTC(2001, 0, 1)) * 1e6
  const read = createIMessageReader(db, startDateNs)
  let busy = false
  const timer = setInterval(async () => {
    if (busy) return
    busy = true
    try {
      for (const { phone, patientId } of active()) {
        for (const row of read(phone)) if (row.text) await receive(patientId, row.text)
      }
    } catch (error) { console.warn('[imessage] poll:', String(error)) }
    finally { busy = false }
  }, 2000)
  return () => { clearInterval(timer); db.close() }
}
export const appleDateToUnix = (nanoseconds: number) => Date.UTC(2001, 0, 1) + nanoseconds / 1e6
