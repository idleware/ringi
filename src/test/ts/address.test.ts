// E8's pure public-address grammar; no home, filesystem target or provider is opened by these tests.
import {describe, it} from 'node:test'
import assert from 'node:assert/strict'
import url from 'node:url'
import {syncBuiltinESMExports} from 'node:module'
import {canonical, parseAddress} from '../../main/ts/core/hub/rooms/address.ts'
import type {RoomAddress} from '../../main/ts/core/hub/rooms/address.ts'

describe('E8 public room addresses', () => {
  it('requires an ACE label to decode and round trip even when the runtime accepts invalid ASCII unchanged', () => {
    const {domainToASCII, domainToUnicode} = url
    try {
      // The permissive fallback reported on Node 26.11: invalid ACE input is returned as ASCII by both APIs.
      url.domainToASCII = value => value === 'xn--a' ? value : domainToASCII(value)
      url.domainToUnicode = value => value === 'xn--a' ? value : domainToUnicode(value)
      syncBuiltinESMExports()
      for (const host of ['xn--a', 'xn--a.example', 'example.xn--a']) {
        assert.throws(() => parseAddress(`github://${host}/team/fix`, 'lookup'), /bad room address/)
        assert.throws(() => canonical({kind: 'remote', provider: 'github', host, space: 'team', room: 'fix'}), /bad room address/)
      }
      for (const host of ['xn--bcher-kva.example', 'xn--e1afmkfd.xn--p1ai']) {
        assert.equal(canonical(parseAddress(`github://${host}/team/fix`, 'create')), `github://${host}/team/fix`)
      }
    } finally {
      url.domainToASCII = domainToASCII; url.domainToUnicode = domainToUnicode
      syncBuiltinESMExports()
    }
  })

  it('distinguishes bare create from catalogue lookup and preserves the room name grammar', () => {
    for (const room of ['fix', 'a.b', 'agent_2', 'fix-badge', 'a'.repeat(64)]) {
      assert.deepEqual(parseAddress(room, 'create'), {kind: 'local', room})
      assert.deepEqual(parseAddress(room, 'lookup'), {kind: 'name', room})
      assert.deepEqual(parseAddress('local://' + room, 'lookup'), {kind: 'local', room})
      assert.equal(canonical(parseAddress(room, 'create')), 'local://' + room)
    }
    assert.deepEqual(parseAddress('%66ix', 'lookup'), {kind: 'name', room: 'fix'})
    assert.equal(canonical(parseAddress('LOCAL://%66ix', 'create')), 'local://fix')
  })

  it('canonicalizes provider aliases, DNS, ports and IP literals without changing the namespace', () => {
    const cases = [
      ['gh://GITHUB.COM/team/%66ix', 'github://github.com/team/fix'],
      ['gl://gitlab.EXAMPLE/team/fix', 'gitlab://gitlab.example/team/fix'],
      ['forgejo://127.0.0.1:00022/team/fix', 'forgejo://127.0.0.1:22/team/fix'],
      ['GITEA://[2001:0DB8:0:0:0:0:0:1]:0443/team/fix', 'gitea://[2001:db8::1]:443/team/fix'],
      ['gitlab://[::ffff:192.0.2.1]/team/fix', 'gitlab://[::ffff:c000:201]/team/fix'],
      ['forgejo://xn--bcher-kva.example/team/fix', 'forgejo://xn--bcher-kva.example/team/fix'],
      ['github://github.com:443/team/fix', 'github://github.com:443/team/fix'],
    ]
    for (const [input, output] of cases) {
      const address = parseAddress(input, 'lookup')
      assert.notEqual(address.kind, 'name')
      if (address.kind === 'name') assert.fail('a full URI is not a bare selector')
      assert.equal(canonical(address), output)
      assert.deepEqual(parseAddress(output, 'lookup'), address)
    }
  })

  it('allows remote spaces only for create, never allocates from a lookup or an extra component', () => {
    const space = parseAddress('gh://GITHUB.COM/team', 'create')
    assert.deepEqual(space, {kind: 'space', provider: 'github', host: 'github.com', space: 'team'})
    assert.equal(canonical(space), 'github://github.com/team')
    for (const input of ['github://github.com/team', 'github://github.com', 'gitlab://host/team/sub/fix']) {
      assert.throws(() => parseAddress(input, 'lookup'), /bad room address/, input)
    }
    assert.throws(() => parseAddress('gitlab://host/team/sub/fix', 'create'), /bad room address/)
  })

  it('folds a service port only when the selected adapter explicitly declares that default', () => {
    const address = parseAddress('forgejo://forge.example:00443/team/fix', 'create')
    assert.equal(canonical(address), 'forgejo://forge.example:443/team/fix')
    assert.equal(canonical(address, 443), 'forgejo://forge.example/team/fix')
    assert.equal(canonical(address, 8443), 'forgejo://forge.example:443/team/fix')
    assert.equal(canonical(parseAddress('forgejo://forge.example/team/fix', 'create'), 8443), 'forgejo://forge.example/team/fix')
    assert.throws(() => canonical(address, 0), /bad room address/)
    assert.throws(() => canonical(address, NaN), /bad room address/)
  })

  it('decodes local filenames once and serializes their exact Unicode and literal percent characters', () => {
    const cases = [
      ['local:///tmp/caf%C3%A9/fix', '/tmp/café/fix', 'local:///tmp/caf%C3%A9/fix'],
      ['local:///tmp/café/fix', '/tmp/café/fix', 'local:///tmp/caf%C3%A9/fix'],
      ['local:///tmp/a%252Fb/fix', '/tmp/a%2Fb/fix', 'local:///tmp/a%252Fb/fix'],
      ['local:///tmp/a%20b/fix', '/tmp/a b/fix', 'local:///tmp/a%20b/fix'],
      ['local:///tmp/a%3Ab%40c%23d%3Fe/fix', '/tmp/a:b@c#d?e/fix', 'local:///tmp/a%3Ab%40c%23d%3Fe/fix'],
      ['local:///tmp/e%CC%81/fix', '/tmp/e\u0301/fix', 'local:///tmp/e%CC%81/fix'],
    ]
    for (const [input, path, output] of cases) {
      const address = parseAddress(input, 'create')
      assert.deepEqual(address, {kind: 'path', path})
      assert.equal(canonical(address), output)
      assert.deepEqual(parseAddress(output, 'lookup'), address)
    }
    assert.deepEqual(parseAddress('local:///tmp/Existing%20Copy', 'lookup'), {kind: 'path', path: '/tmp/Existing Copy'})
    assert.throws(() => parseAddress('local:///tmp/Existing%20Copy', 'create'), /bad room address/)
    assert.notEqual(canonical({kind: 'path', path: '/tmp/é/fix'}), canonical({kind: 'path', path: '/tmp/e\u0301/fix'}))
  })

  it('rejects raw or encoded traversal before URL normalization can erase it', () => {
    for (const input of [
      'local:///tmp/../fix', 'local:///tmp/./fix', 'local:///tmp/%2e%2E/fix',
      'local:///tmp/%2e/fix', 'local:///tmp/a%2Fb/fix', 'local:///tmp/a%5Cb/fix',
      'local:///tmp//fix', 'local:///tmp/fix/', 'local:///', 'local://',
      'forgejo://host/team/../fix', 'forgejo://host/team/%2e%2e', 'forgejo://host/team/%2Ffix',
      'forgejo://host/team/%5Cfix', 'forgejo://host//fix', 'forgejo://host/team/fix/',
      'local:///tmp/a:b/fix', 'local:///tmp/a[b]/fix',
    ]) assert.throws(() => parseAddress(input, 'create'), /bad room address/, input)
  })

  it('rejects metadata, credentials, malformed authorities and implicit transport schemes', () => {
    for (const input of [
      'github://user@host/team/fix', 'github://host/team/fix?', 'github://host/team/fix#',
      'github://host/team/fix?token=x', 'github://host/team/fix#fragment',
      'github://ho%73t/team/fix', 'github://bücher.example/team/fix', 'github://host./team/fix',
      'github://host:0/team/fix', 'github://host:65536/team/fix', 'github://host:-1/team/fix',
      'github://host:/team/fix', 'github://host:1e2/team/fix', 'github://host:1:2/team/fix',
      'github://127.1/team/fix', 'github://0177.0.0.1/team/fix', 'github://0x7f000001/team/fix',
      'github://[fe80::1%25en0]/team/fix', 'github://::1/team/fix', 'github://[no-ip]/team/fix',
      'github://-host/team/fix', 'github://host_/team/fix', 'github://xn--a/team/fix',
      'local://fix:22', 'local://host/fix', 'local:/tmp/fix', '/tmp/fix', '~/fix',
      'git+ssh://host/team/fix', 'ssh://host/team/fix', 'file:///tmp/fix', 'unknown://host/team/fix',
      ' github://host/team/fix', 'github://host/team/fix\n', 'github://host\\team/fix',
    ]) assert.throws(() => parseAddress(input, 'create'), /bad room address/, input)
  })

  it('rejects bad UTF-8, escapes, controls and invalid room names without recursive decoding', () => {
    for (const raw of ['%', '%0', '%GG', '%C0%AF', '%E0%80%AE', '%ED%A0%80', '%FF', '%00', '%1F', '%7F', '%C2%80', '\ud800']) {
      assert.throws(() => parseAddress('local:///tmp/' + raw + '/fix', 'lookup'), /bad room address/, raw)
    }
    for (const room of ['main', 'chat', 'Fix', '.fix', 'fix.', 'fix--2', 'fix.lock', 'a'.repeat(65), '%252F', '%2566ix']) {
      assert.throws(() => parseAddress(room, 'create'), /bad room address/, room)
    }
    for (const input of ['forgejo://host/team/fix.git', 'github://host/team/main', 'github://host/team/chat']) {
      assert.throws(() => parseAddress(input, 'create'), /bad room address/, input)
    }
  })

  it('refuses malformed structured values at the canonical serializer boundary', () => {
    const values = [
      {kind: 'local', room: 'main'}, {kind: 'path', path: '/tmp/../fix'},
      {kind: 'path', path: '/'}, {kind: 'path', path: '/tmp/\ud800'},
      {kind: 'remote', provider: 'gh', host: 'host', space: 'team', room: 'fix'},
      {kind: 'remote', provider: 'github', host: 'user@host', space: 'team', room: 'fix'},
      {kind: 'remote', provider: 'github', host: 'host', port: NaN, space: 'team', room: 'fix'},
      {kind: 'remote', provider: 'github', host: 'host', space: 'team/other', room: 'fix'},
      {kind: 'name', room: 'fix'},
    ]
    for (const value of values) assert.throws(() => canonical(value as RoomAddress), /bad room address/)
  })
})
