// group-state: process-group membership and whether its observed members have finished; only Z is a zombie.

export type GroupMember = {group: number, state: string}
export const procMember = (text: string): GroupMember | null => {
  const close = text.lastIndexOf(')')
  if (!/^\d+ \(/.test(text) || close < 0) return null
  const fields = text.slice(close + 1).trim().split(/\s+/)
  const group = Number(fields[2]), state = fields[0]
  return /^[A-Za-z]$/.test(state) && Number.isSafeInteger(group) && group >= 0 ? {group, state} : null
}
export const psMember = (text: string): GroupMember | null => {
  const match = /^\s*(\d+)\s+([A-Za-z][^\s]*)\s*$/.exec(text)
  if (!match) return null
  const group = Number(match[1])
  return Number.isSafeInteger(group) ? {group, state: match[2][0]} : null
}
// No matching row, or an unreadable row that might belong to this group, cannot prove it is quiescent.
export const groupRunning = (group: number, members: Array<GroupMember | null>): boolean | null => {
  const own = members.filter(m => m?.group === group)
  if (own.some(m => m!.state !== 'Z')) return true
  return own.length && members.every(m => m !== null) ? false : null
}
