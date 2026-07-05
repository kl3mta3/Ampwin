// Sync package.json's "version" from the top-level version.txt so a single file
// is the source of truth for the build. Run by build.cmd before packaging;
// electron-builder reads the version from package.json (artifact name + the
// app's app.getVersion()). No-op if version.txt is missing or already in sync.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const versionFile = join(root, 'version.txt')
const pkgFile = join(root, 'package.json')

if (!existsSync(versionFile)) {
  console.log('[version] version.txt not found — keeping package.json version')
  process.exit(0)
}

const version = readFileSync(versionFile, 'utf8').trim()
// electron-builder requires a valid semver (X.Y.Z, optional -prerelease/+build).
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/.test(version)) {
  console.error(`[version] "${version}" in version.txt is not valid semver — aborting`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
if (pkg.version === version) {
  console.log(`[version] already ${version}`)
} else {
  console.log(`[version] ${pkg.version} -> ${version}`)
  pkg.version = version
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n')
}
