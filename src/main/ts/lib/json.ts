// json: JSON read strictly. JSON.parse silently keeps the last of duplicate
// fields; for contracts and authority that hides a second value, so the structure is checked first and a duplicate
// field is refused.

import {fail} from './fail.ts'


const LITERAL = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/
// A recursive-descent check of JSON's structure: each kind of value is one small method.
class Strict {
  at = 0
  readonly text: string
  readonly label: string
  constructor(text: string, label: string) { this.text = text; this.label = label }
  bad(): never { return fail(`${this.label}: malformed or duplicate JSON field at ${this.at}`) }
  ws(): void { while (this.at < this.text.length && /\s/.test(this.text[this.at])) this.at++ }
  peek(): string { this.ws(); return this.text[this.at] }
  take(c: string): void { if (this.text[this.at++] !== c) this.bad() }
  str(): string {
    const start = this.at++
    while (this.at < this.text.length && this.text[this.at] !== '"') this.at += this.text[this.at] === '\\' ? 2 : 1
    this.take('"')
    try { return JSON.parse(this.text.slice(start, this.at)) } catch { return this.bad() }
  }
  // The character after the next item: a comma, or the closing bracket.
  next(): string { this.ws(); return this.text[this.at++] }
  // Items between an opening bracket and `close`, separated by commas.
  items(close: string, item: () => void): void {
    this.at++
    if (this.peek() === close) { this.at++; return }
    do item(); while (this.next() === ',')
    if (this.text[this.at - 1] !== close) this.bad()
  }
  object(): void {
    const keys = new Set<string>()
    this.items('}', () => this.member(keys))
  }
  member(keys: Set<string>): void {
    if (this.peek() !== '"') this.bad()
    const k = this.str()
    if (keys.has(k)) this.bad()
    keys.add(k)
    this.ws()
    this.take(':')
    this.value()
  }
  literal(): void { this.at += (LITERAL.exec(this.text.slice(this.at)) ?? this.bad())[0].length }
  value(): void {
    const c = this.peek()
    if (c === '{') this.object()
    else if (c === '[') this.items(']', () => this.value())
    else if (c === '"') this.str()
    else this.literal()
  }
}
export const strictJson = <T = unknown>(text: string, label = 'JSON'): T => {
  const s = new Strict(text, label)
  s.value()
  s.ws()
  if (s.at !== text.length) s.bad()
  return JSON.parse(text) as T
}
