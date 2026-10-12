// cache: checks of immutable heads reused within one operation; nothing survives into the next one.

import type {Handle} from './types.ts'

// Reuse immutable-head checks within one operation; no ref or alarm survives into the next one.
const checking = new WeakMap<Handle, Map<string, unknown>>()

export const withVerification = <T>(H: Handle, fn: () => T): T => {
  if (checking.has(H)) return fn()
  checking.set(H, new Map())
  try {return fn()} finally {checking.delete(H)}
}

export const memo = <T>(H: Handle, key: string, fn: () => T): T => {
  const cache = checking.get(H)
  if (cache?.has(key)) return cache.get(key) as T
  const value = fn()
  cache?.set(key, value)
  return value
}
