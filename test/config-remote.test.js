// Guards for the options form's host side (src/config-remote.js).
//
// The bug these exist for: the settings card could only edit the handful of ASR
// fields it had been written for, so every other option -- the sender
// allowlist, the length cap, the busy-message policy, the media size limits --
// was reachable only by hand-editing JSON. The risk in the fix is the reverse
// of the original problem: a form that shows a *wrong* value is worse than one
// that shows nothing, because an operator will trust it. So these tests check
// that the field list agrees with the real schema in both directions, and that
// a write reaches disk and reads back with the source it claims.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import nodePath from 'node:path'
import os from 'node:os'

const { Context } = await import('@deepseek-ai/cordis')
const { ConfigController, FIELDS } = await import('../src/config-remote.js')
const { Config } = await import('../src/index.js')

/** A throwaway state root, so nothing writes the operator's real config.json. */
function withStateRoot() {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'dsh-weixin-config-'))
  const previous = process.env.DSH_WEIXIN_STATE_DIR
  process.env.DSH_WEIXIN_STATE_DIR = root
  return {
    root,
    restore() {
      if (previous === undefined) delete process.env.DSH_WEIXIN_STATE_DIR
      else process.env.DSH_WEIXIN_STATE_DIR = previous
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

/** Build a controller on a real Context, the way the plugin does. */
function controller(config = {}) {
  return new ConfigController(new Context(), { config })
}

const fieldOf = (listing, path) => listing.groups.flatMap((group) => group.fields).find((field) => field.path === path)
const allFields = () => FIELDS.flatMap((group) => group.fields)

test('every field the form shows agrees with the schema default, in both directions', async () => {
  // This is the check that matters most. The form carries its own copy of each
  // default so it can say "this value is the default" and offer a reset; if that
  // copy drifts from the schema, a reset writes the wrong value and the form
  // reports a number the plugin will never use.
  const parsed = Config({})
  const readPath = (object, dotted) =>
    dotted.split('.').reduce((cursor, part) => (cursor && typeof cursor === 'object' ? cursor[part] : undefined), object)

  for (const field of allFields()) {
    assert.deepEqual(
      field.default,
      readPath(parsed, field.path),
      `${field.path}: the form's default must equal the schema's`,
    )
  }

  // And the other direction: an option added to the schema but never listed
  // here would be invisible in the card, which is the original complaint.
  const shown = new Set(allFields().map((field) => field.path))
  const missing = []
  for (const key of Object.keys(parsed)) {
    if (key === 'asr') continue
    if (!shown.has(key)) missing.push(key)
  }
  for (const key of Object.keys(parsed.asr ?? {})) {
    if (!shown.has(`asr.${key}`)) missing.push(`asr.${key}`)
  }
  assert.deepEqual(missing, [], 'every schema field must be reachable from the form')
})

test('a saved value wins over the composition, which wins over the default', async () => {
  const scope = withStateRoot()
  try {
    // From the composition: reported as `config` so the card can say where the
    // value came from, and so a reset is understood to fall back to it.
    const composed = controller({ maxMessageLength: 999, allowedSenders: ['from-yaml'] })
    let listing = await composed.list()
    assert.equal(fieldOf(listing, 'maxMessageLength').value, '999')
    assert.equal(fieldOf(listing, 'maxMessageLength').source, 'config')
    assert.equal(fieldOf(listing, 'allowedSenders').value, 'from-yaml')

    // A field nobody set reports the schema default.
    assert.equal(fieldOf(listing, 'markdownMode').source, 'default')
    assert.equal(fieldOf(listing, 'markdownMode').value, 'strip')

    // A saved value outranks the composition.
    await composed.save(JSON.stringify([{ path: 'maxMessageLength', value: '3000' }]), 'zh')
    listing = await composed.list()
    assert.equal(fieldOf(listing, 'maxMessageLength').value, '3000')
    assert.equal(fieldOf(listing, 'maxMessageLength').source, 'saved')
  } finally {
    scope.restore()
  }
})

test('a write reaches disk, and a fresh controller reads it -- i.e. it survives a restart', async () => {
  const scope = withStateRoot()
  try {
    const first = controller()
    await first.save(
      JSON.stringify([
        { path: 'allowedSenders', value: 'wxid_a\nwxid_b\n\n  wxid_c  ' },
        { path: 'maxMessageLength', value: '2000' },
        { path: 'typingIndicator', value: 'false' },
        { path: 'asr.model', value: 'mlx-community/whisper-small-mlx' },
        { path: 'asr.env', value: 'DSH_WEIXIN_ASR_LANGUAGE=zh\n# a comment\nHF_HOME=/tmp/hf' },
      ]),
      'zh',
    )

    const onDisk = JSON.parse(fs.readFileSync(nodePath.join(scope.root, 'config.json'), 'utf8'))
    // Types must land as types: a number stored as a string would satisfy the
    // form and then fail at message time.
    assert.deepEqual(onDisk.allowedSenders, ['wxid_a', 'wxid_b', 'wxid_c'])
    assert.equal(onDisk.maxMessageLength, 2000)
    assert.equal(onDisk.typingIndicator, false)
    assert.equal(onDisk.asr.model, 'mlx-community/whisper-small-mlx')
    assert.deepEqual(onDisk.asr.env, { DSH_WEIXIN_ASR_LANGUAGE: 'zh', HF_HOME: '/tmp/hf' })

    const restarted = controller()
    const listing = await restarted.list()
    assert.equal(fieldOf(listing, 'maxMessageLength').value, '2000')
    assert.equal(fieldOf(listing, 'allowedSenders').value, 'wxid_a\nwxid_b\nwxid_c')
    assert.equal(fieldOf(listing, 'asr.env').value, 'DSH_WEIXIN_ASR_LANGUAGE=zh\nHF_HOME=/tmp/hf')
  } finally {
    scope.restore()
  }
})

test('a bad value in a batch leaves every earlier edit unwritten', async () => {
  // A half-applied save is worse than a refused one: the operator sees an error
  // and cannot tell which fields were already written.
  //
  // The first entry is deliberately VALID and comes BEFORE the bad one, so an
  // implementation that validates and writes one field at a time leaves it on
  // disk. Asserting only "the file is unchanged" is not enough -- it also passes
  // when nothing was written at all, which is why the field itself is read back.
  const scope = withStateRoot()
  try {
    const c = controller()
    await c.save(JSON.stringify([{ path: 'allowedSenders', value: 'keep_me' }]), 'zh')
    const before = fs.readFileSync(nodePath.join(scope.root, 'config.json'), 'utf8')

    await assert.rejects(
      () =>
        c.save(
          JSON.stringify([
            { path: 'maxMessageLength', value: '2500' },
            { path: 'markdownMode', value: 'not-a-mode' },
          ]),
          'zh',
        ),
      (error) => error.code === 'bad_value',
    )

    assert.equal(fs.readFileSync(nodePath.join(scope.root, 'config.json'), 'utf8'), before, 'nothing may be written')
    const onDisk = JSON.parse(fs.readFileSync(nodePath.join(scope.root, 'config.json'), 'utf8'))
    assert.equal(onDisk.maxMessageLength, undefined, 'the valid field before the bad one must not be applied')
    const listing = await c.list()
    assert.equal(fieldOf(listing, 'maxMessageLength').value, '1500', 'it still reads as the default')
    assert.equal(fieldOf(listing, 'allowedSenders').value, 'keep_me')
  } finally {
    scope.restore()
  }
})

test('out-of-range and read-only fields are refused, and a bad path is named', async () => {
  const scope = withStateRoot()
  try {
    const c = controller()
    const rejects = async (entries, code) => {
      await assert.rejects(() => c.save(JSON.stringify(entries), 'zh'), (error) => error.code === code)
    }
    await rejects([{ path: 'maxMessageLength', value: '5' }], 'bad_value')
    await rejects([{ path: 'maxMessageLength', value: '999999' }], 'bad_value')
    await rejects([{ path: 'maxMessageLength', value: 'not-a-number' }], 'bad_value')
    await rejects([{ path: 'markdownMode', value: 'wat' }], 'bad_value')
    await rejects([{ path: 'asr.env', value: 'NOEQUALS' }], 'bad_value')
    await rejects([{ path: 'nope', value: '1' }], 'unknown_field')
    // `maxTurnWaitMs` is deliberately not editable from the form: lowering a
    // turn's safety bound is how long replies get silently truncated.
    await rejects([{ path: 'maxTurnWaitMs', value: '100' }], 'read_only')
  } finally {
    scope.restore()
  }
})

test('clearing a field removes it, so the default applies again', async () => {
  const scope = withStateRoot()
  try {
    const c = controller()
    await c.save(JSON.stringify([{ path: 'maxMessageLength', value: '2000' }, { path: 'cwd', value: '/tmp/x' }]), 'zh')
    assert.equal(fieldOf(await c.list(), 'maxMessageLength').source, 'saved')

    // An emptied number box and an emptied text box mean the same thing.
    let listing = await c.save(JSON.stringify([{ path: 'maxMessageLength', value: '' }, { path: 'cwd', value: '' }]), 'zh')
    assert.equal(fieldOf(listing, 'maxMessageLength').value, '1500')
    assert.equal(fieldOf(listing, 'maxMessageLength').source, 'default')
    assert.equal(fieldOf(listing, 'cwd').source, 'default')
  } finally {
    scope.restore()
  }
})

test('resetting one key keeps its siblings, and prunes a parent left empty', async () => {
  // Losing `asr.env` while resetting `asr.model` would look like a form bug and
  // cost the operator their transcription settings.
  const scope = withStateRoot()
  try {
    const c = controller()
    await c.save(JSON.stringify([{ path: 'asr.model', value: 'foo/bar' }, { path: 'asr.env', value: 'A=1' }]), 'zh')
    let listing = await c.reset(JSON.stringify(['asr.model']))
    assert.equal(fieldOf(listing, 'asr.model').source, 'default')
    assert.equal(fieldOf(listing, 'asr.env').value, 'A=1', 'the sibling must survive')

    listing = await c.reset(JSON.stringify(['asr.env']))
    assert.equal(fieldOf(listing, 'asr.env').source, 'default')
    const onDisk = JSON.parse(fs.readFileSync(nodePath.join(scope.root, 'config.json'), 'utf8'))
    // An empty `asr: {}` left behind is harmless to the reader but makes the
    // file look as though it still carries settings.
    assert.equal(onDisk.asr, undefined, 'an emptied section must not be left behind')
  } finally {
    scope.restore()
  }
})

test('the batch travels as JSON, and a malformed one is refused without writing', async () => {
  const scope = withStateRoot()
  try {
    const c = controller()
    await assert.rejects(() => c.save('{not json', 'zh'), (error) => error.code === 'bad_request')
    await assert.rejects(() => c.save('{"a":1}', 'zh'), (error) => error.code === 'bad_request')
    assert.equal(fs.existsSync(nodePath.join(scope.root, 'config.json')), false, 'a refused save writes nothing')
  } finally {
    scope.restore()
  }
})

test('the empty sender allowlist is stored, because empty means "refuse everyone"', async () => {
  // Distinct from clearing a scalar: for `allowedSenders` an empty list is a
  // decision (deny all), so it must be written rather than deleted -- deleting
  // it would let the schema default (also empty) hide which one is in force.
  const scope = withStateRoot()
  try {
    const c = controller()
    await c.save(JSON.stringify([{ path: 'allowedSenders', value: 'a\nb' }]), 'zh')
    const listing = await c.save(JSON.stringify([{ path: 'allowedSenders', value: '' }]), 'zh')
    assert.equal(fieldOf(listing, 'allowedSenders').value, '')
    const onDisk = JSON.parse(fs.readFileSync(nodePath.join(scope.root, 'config.json'), 'utf8'))
    assert.deepEqual(onDisk.allowedSenders, [])
  } finally {
    scope.restore()
  }
})

test('the form reports the file it writes, and every group is present', async () => {
  const scope = withStateRoot()
  try {
    const listing = await controller().list()
    assert.equal(listing.configFile, nodePath.join(scope.root, 'config.json'))
    assert.ok(listing.groups.length >= 4, 'the options are grouped, not one flat list')
    for (const group of listing.groups) {
      assert.ok(group.group && group.groupEn, 'each group is labelled in both languages')
      for (const field of group.fields) {
        assert.ok(field.label && field.labelEn, `${field.path} needs a label in both languages`)
        assert.ok(field.hint && field.hintEn, `${field.path} needs a hint in both languages`)
        assert.ok(field.type, `${field.path} needs a control type`)
      }
    }
  } finally {
    scope.restore()
  }
})
