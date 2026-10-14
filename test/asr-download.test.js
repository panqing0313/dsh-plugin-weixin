// Guards for the ASR model download path (src/asr-remote.js).
//
// The bug these exist for: the controller hard-coded `huggingface-cli`. On
// huggingface_hub >= 1.0 that entry point is a stub which exits 1 printing
// nothing but a "no longer works, use `hf` instead" banner — so downloads
// never ran, and the settings card reported the banner as the reason, giving
// the operator a list of CLI examples instead of a diagnosis.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import nodePath from 'node:path'

const require$path = () => nodePath

const HOST = fs.readFileSync(new URL('../src/asr-remote.js', import.meta.url), 'utf8')

// The detection block, lifted so it can run against a fake spawn/platform.
const BODY = HOST.match(/const HF_CLI_CANDIDATES = \[[\s\S]*?\n}\n\n\/\*\* Whether running[\s\S]*?\n}\n/)[0]

// `resolveHfCli` probes PATH with spawnSync, so it cannot be imported into the
// test process without touching the real machine. Lift the function out and
// run it against a fake spawn, which also lets us assert the probe contract.
function loadResolveHfCli(platform = 'darwin') {
  const body = HOST.match(/const HF_CLI_CANDIDATES = \[[\s\S]*?\n}\n\n\/\*\* Whether running[\s\S]*?\n}\n/)[0]
  return new Function('spawnSync', 'process', 'path', `${body}; return resolveHfCli`)(
    undefined,
    { env: {}, platform },
    require$path(),
  )
}

test('the download prefers `hf`, because `huggingface-cli` no longer works', () => {
  const probes = []
  const resolve = loadResolveHfCli()
  const spawnSync = (command) => {
    probes.push(command)
    // Simulate huggingface_hub >= 1.0: only `hf` answers successfully, and the
    // deprecated entry point exits non-zero with a banner.
    return { status: command === 'hf' ? 0 : 1 }
  }
  const fn = new Function('spawnSync', 'process', 'path', `${BODY}; return resolveHfCli`)(
    spawnSync,
    { env: {}, platform: 'darwin' },
    nodePath,
  )
  assert.deepEqual(fn(), { command: 'hf', shell: false })
  // `hf` is first, so the broken CLI is never even probed.
  assert.deepEqual(probes, ['hf'])
})

test('the download falls back to `huggingface-cli` on installs that only have it', () => {
  const probes = []
  const fn = new Function('spawnSync', 'process', 'path', `${BODY}; return resolveHfCli`)(
    (command) => {
      probes.push(command)
      // huggingface_hub < 1.0: `hf` does not exist, the old name still works.
      return { status: command === 'huggingface-cli' ? 0 : 1 }
    },
    { env: {}, platform: 'darwin' },
    nodePath,
  )
  assert.deepEqual(fn(), { command: 'huggingface-cli', shell: false })
  assert.deepEqual(probes, ['hf', 'huggingface-cli'], 'both candidates must be tried in order')
})

test('DSH_WEIXIN_HF_CLI overrides detection and skips probing entirely', () => {
  const probes = []
  const fn = new Function('spawnSync', 'process', 'path', `${BODY}; return resolveHfCli`)(
    (command) => {
      probes.push(command)
      return { status: 0 }
    },
    { env: { DSH_WEIXIN_HF_CLI: '/opt/custom/hf' }, platform: 'darwin' },
    nodePath,
  )
  assert.deepEqual(fn(), { command: '/opt/custom/hf', shell: false })
  assert.deepEqual(probes, [], 'an explicit override must not be second-guessed')
})

test('a CLI that cannot be spawned at all still yields a usable default', () => {
  const fn = new Function('spawnSync', 'process', 'path', `${BODY}; return resolveHfCli`)(
    () => {
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    },
    { env: {}, platform: 'darwin' },
    nodePath,
  )
  assert.deepEqual(fn(), { command: 'hf', shell: false })
})

// Windows: `pip` installs a `.cmd` shim, and Node will not execute one without
// a shell (EINVAL). Detection must therefore find it and flag it.
test('on Windows a bare name is probed through PATHEXT suffixes', () => {
  const resolveWith = (answerFor) => new Function('spawnSync', 'process', 'path', `${BODY}; return resolveHfCli`)(
    (command) => ({ status: answerFor(command) ? 0 : 1 }),
    { env: {}, platform: 'win32' },
    nodePath,
  )
  // Only the .cmd shim exists — no extensionless `hf`, no .exe.
  const found = resolveWith((command) => command === 'hf.cmd')()
  assert.deepEqual(found, { command: 'hf.cmd', shell: true }, 'a .cmd shim must be found and run via a shell')

  // A real .exe needs no shell.
  const exe = resolveWith((command) => command === 'hf.exe')()
  assert.deepEqual(exe, { command: 'hf.exe', shell: false }, 'an .exe must not be wrapped in a shell')
})

test('a Windows .cmd override is flagged as needing a shell', () => {
  const fn = new Function('spawnSync', 'process', 'path', `${BODY}; return resolveHfCli`)(
    () => ({ status: 0 }),
    { env: { DSH_WEIXIN_HF_CLI: 'C:\\Python\\Scripts\\hf.exe' }, platform: 'win32' },
    nodePath,
  )
  assert.deepEqual(fn(), { command: 'C:\\Python\\Scripts\\hf.exe', shell: false })
})

test('the download passes shell: true exactly when the CLI is a shim', () => {
  // Reading the source is the only way to check the spawn call itself; a unit
  // test of resolveHfCli alone would not notice the flag being dropped.
  assert.match(HOST, /\.\.\.\(cli\.shell \? \{ shell: true \} : \{\}\)/, 'spawn must set shell for shims')
  assert.match(HOST, /if \(cli\.shell\) args\.unshift\(cli\.command\)/, 'a shell run needs the command inside the argument list')
  assert.match(HOST, /spawn\(cli\.command, args, \{/, 'spawn must use the resolved command')
})

// The failure text is what the operator actually reads, so it must not be the
// CLI's deprecation banner or a wall of progress-bar fragments.
function summarize(stderr) {
  const body = HOST.match(/const HF_NOISE = [\s\S]*?\n}\n/)[0]
  const fn = new Function(`${body}; return summarizeHfFailure`)
  return fn()(stderr)
}

// Verbatim stderr from `huggingface-cli download` on huggingface_hub 1.17.0.
const DEPRECATION_BANNER = [
  'Warning: `huggingface-cli` is deprecated and no longer works. Use `hf` instead.',
  '',
  'Hint: `hf` is already installed! Use it directly.',
  '',
  'Hint: Examples:',
  '  hf auth login',
  '  hf download unsloth/gemma-4-31B-it-GGUF',
  '  hf upload my-cool-model . .',
  '  hf models ls --search "gemma"',
  '  hf repos ls --format json',
  "  hf jobs run python:3.12 python -c 'print(\"Hello!\")'",
  '  hf --help',
].join('\n')

test('the deprecation banner is never shown as the failure reason', () => {
  const message = summarize(DEPRECATION_BANNER)
  assert.equal(message, '', 'a pure banner carries no diagnosis and must collapse to nothing')
  for (const noise of ['Hint:', 'Examples:', 'hf auth login', 'hf --help', 'no longer works']) {
    assert.ok(!message.includes(noise), `failure text must not contain ${JSON.stringify(noise)}`)
  }
})

test('a real error survives, with its banner noise stripped', () => {
  const message = summarize(
    [
      'Warning: `huggingface-cli` is deprecated and no longer works. Use `hf` instead.',
      'Hint: `hf` is already installed! Use it directly.',
      'huggingface_hub.errors.RepositoryNotFoundError: 404 Client Error. Repository Not Found for url: https://huggingface.co/api/models/nope/nope',
    ].join('\n'),
  )
  assert.ok(message.includes('RepositoryNotFoundError'), 'the actual diagnosis must be kept')
  assert.ok(message.includes('nope/nope'), 'and it must name the repo that failed')
  assert.ok(!message.includes('Hint:'), 'banner noise must be stripped')
})

test('progress-bar redraws are not mistaken for an error', () => {
  const message = summarize(
    ['  45%|████████          | 1.2G/2.6G [00:12<00:15, 95.3MB/s]', '  90%|███████████████ | 2.3G/2.6G [00:24<00:03, 98.1MB/s]'].join('\r'),
  )
  assert.equal(message, '', 'a progress bar is not a diagnosis')
})

test('the failure message names the CLI it actually ran', () => {
  // The old code interpolated `cli` into the spawn-error text but reported the
  // downloaded exit status bare, so a failed run never said which binary ran.
  assert.match(HOST, /`\$\{cli\.command\} 下载失败：\$\{detail\}`/, 'exit failures must name the CLI')
  assert.match(HOST, /`找不到 \$\{cli\.command\}，请 pip install -U huggingface_hub/, 'spawn failures must name the CLI')
  // And it must not tell the user to install a package they already have.
  assert.ok(
    !/请先 pip install huggingface_hub/.test(HOST),
    'the old message told users to install what the CLI banner says is already installed',
  )
})
