import {fileURLToPath} from 'node:url'
import os from 'node:os'

// RINGI_BIN is one executable, not shell text; the default is this package's Node build.
export const BIN = process.env.RINGI_BIN ? [process.env.RINGI_BIN] :
  [process.execPath, fileURLToPath(new URL('../../../target/esm/cli.js', import.meta.url))]
export const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
export const shellBin = BIN.map(quote).join(' ')
// Never inherit the developer's live chat or hub in a fixture.
export const BASE = {...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX|CURSOR|RINGI_|GIT_)/.test(k))),
  GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0'}
export const FIXTURE_GIT = {...BASE, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@ringi',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@ringi'}
