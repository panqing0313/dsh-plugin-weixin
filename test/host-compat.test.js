import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  TESTED_HOSTS,
  compatibilityMarkdown,
  describeHost,
  detectHostVersion,
  hostStatus,
  isPreRelease,
} from '../src/host-compat.js'

test('the host version comes from the app bundle, and an override wins', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-host-'))
  const plist = path.join(dir, 'Info.plist')
  fs.writeFileSync(plist, '<plist><dict><key>CFBundleShortVersionString</key><string>0.2.1-rc.3</string></dict></plist>')

  assert.equal(detectHostVersion({ env: {}, plistPath: plist }), '0.2.1-rc.3')
  assert.equal(detectHostVersion({ env: { DSH_HOST_VERSION: '9.9.9' }, plistPath: plist }), '9.9.9')
  assert.equal(detectHostVersion({ env: {}, plistPath: path.join(dir, 'missing.plist') }), undefined)
  // "cannot tell" is distinct from "unsupported": one is a gap, the other is a warning.
  assert.deepEqual(hostStatus(undefined), { status: 'unknown', tested: TESTED_HOSTS })
})

test('an untested host is reported plainly, not as a failure', () => {
  assert.equal(hostStatus(TESTED_HOSTS[0]).status, 'tested')
  assert.equal(hostStatus('99.0.0').status, 'untested')
  assert.match(describeHost('99.0.0'), /not in the tested list/)
  assert.match(describeHost('99.0.0'), /first thing to check/)
  assert.match(describeHost(undefined), /host version unknown/)
  assert.match(describeHost(TESTED_HOSTS[0]), /\(tested\)/)
  // The caller that could not tell passes a word, not a version; it must not
  // come back as "host unknown is not in the tested list".
  assert.match(describeHost('unknown'), /host version unknown/)
  assert.doesNotMatch(describeHost('unknown'), /not in the tested list/)
  assert.equal(isPreRelease('0.2.1-rc.3'), true)
  assert.equal(isPreRelease('0.2.1'), false)
})

test('the docs table is generated from the tested list, so it cannot drift', () => {
  const markdown = compatibilityMarkdown('0.9.11')
  for (const host of TESTED_HOSTS) assert.ok(markdown.includes(`\`${host}\``), `the table names ${host}`)
  assert.ok(markdown.includes('`0.9.11`'))
  assert.equal(markdown.split('\n').filter((line) => line.startsWith('| `')).length, TESTED_HOSTS.length)
})

test('a version that is read is a version that is printed', () => {
  // Regression: `describeHost(detectHostVersion())` printed "host version
  // unknown" for a host that had just been read from the plist, because the
  // unknown branch was chosen by a different test than the version check.
  assert.equal(hostStatus('  0.2.2-rc.1  ').status, 'tested', 'surrounding space is not a different host')
  assert.match(describeHost('0.2.2-rc.1'), /host 0\.2\.2-rc\.1 \(tested\)/)
  assert.match(describeHost('99.0.0'), /host 99\.0\.0 is not in the tested list/)
  // Never print the word "undefined" at the operator.
  for (const version of [undefined, '', '   ', 'unknown', '99.0.0']) {
    assert.doesNotMatch(describeHost(version), /undefined/)
  }
})

test('the newest release is the last thing in the list', () => {
  // The list is oldest-first by contract: the card and doctor print it in
  // order, and a reader takes the last entry as "tested through at least this".
  assert.equal(TESTED_HOSTS.at(-1), '0.2.2-rc.1')
  assert.ok(TESTED_HOSTS.includes('0.2.1-rc.5'), 'older hosts stay listed: they were tested too')
})

test('per-host notes override the generic row, but only where given', () => {
  const markdown = compatibilityMarkdown('1.5.12', { '0.2.2-rc.1': '登录、收发、设置卡九个页签' })
  assert.match(markdown, /\| `1\.5\.12` \| `0\.2\.2-rc\.1` \| 登录、收发、设置卡九个页签 \|/)
  for (const host of TESTED_HOSTS.filter((h) => h !== '0.2.2-rc.1')) {
    assert.match(markdown, new RegExp(`\\| \`${host.replace(/\./g, '\\.')}\` \\| 真机验证过`), `${host} keeps the generic note`)
  }
})
