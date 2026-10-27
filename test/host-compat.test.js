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
  assert.equal(isPreRelease('0.2.1-rc.3'), true)
  assert.equal(isPreRelease('0.2.1'), false)
})

test('the docs table is generated from the tested list, so it cannot drift', () => {
  const markdown = compatibilityMarkdown('0.9.11')
  for (const host of TESTED_HOSTS) assert.ok(markdown.includes(`\`${host}\``), `the table names ${host}`)
  assert.ok(markdown.includes('`0.9.11`'))
  assert.equal(markdown.split('\n').filter((line) => line.startsWith('| `')).length, TESTED_HOSTS.length)
})
