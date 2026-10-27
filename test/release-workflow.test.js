import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const workflow = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** YAML is read as text here: a parser dependency for four assertions is not worth it. */
test('the release workflow publishes from a tag, with the OIDC identity provenance needs', () => {
	assert.match(workflow, /on:\s*\n\s*push:\s*\n\s*tags: \['v\*'\]/, 'a tag push must trigger it')
	assert.match(workflow, /id-token: write/, 'npm cannot sign an attestation without an OIDC token')
	assert.match(workflow, /npm publish --provenance/, 'the publish itself must ask for provenance')
	assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/, 'publishing needs the npm token')
})

test('the release workflow refuses to publish code that was never tested', () => {
	const publishAt = workflow.indexOf('run: npm publish --provenance')
	assert.ok(publishAt > 0)
	const before = workflow.slice(0, publishAt)
	assert.match(before, /npm ci/, 'dependencies come from the lockfile')
	assert.match(before, /npm run check/, 'the fast checks run first')
	assert.match(before, /npm test/, 'and the full suite')
	assert.match(before, /does not match package\.json/, 'the tag and the package version must agree')
})

test('a publish is never raced by a second run on the same tag', () => {
	assert.match(workflow, /concurrency:\s*\n\s*group: publish-/, 'two runs on one tag would double-publish')
	assert.match(workflow, /cancel-in-progress: false/, 'cancelling mid-publish is worse than waiting')
})

test('package metadata is ready for a public, provenance-carrying publish', () => {
	assert.equal(pkg.private, undefined, 'a private package cannot be published')
	assert.equal(pkg.publishConfig?.access, 'public')
	assert.ok(typeof pkg.repository?.url === 'string' && pkg.repository.url.includes('github.com'),
		'provenance ties the tarball to a repository, so the repository must be declared')
	assert.match(pkg.name, /^[@a-z0-9][a-z0-9._-]*$/)
})
