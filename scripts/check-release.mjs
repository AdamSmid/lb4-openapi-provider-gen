import {readFile} from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const tag = process.argv[2] ?? process.env.RELEASE_TAG;
if (tag !== `v${pkg.version}`) throw new Error(`Release tag must be v${pkg.version}; received ${tag ?? '(missing)'}.`);
if (pkg.private || pkg.name !== 'lb4-openapi-provider-gen') throw new Error('Unexpected package identity or private package.');
if (pkg.license === 'UNLICENSED' || !pkg.license) throw new Error('Choose the package license before publishing.');
if (process.env.GITHUB_REPOSITORY) {
  const expected = `https://github.com/${process.env.GITHUB_REPOSITORY}.git`;
  if (pkg.repository?.url !== `git+${expected}`) throw new Error(`package.json repository must match ${expected}.`);
}
console.log(`Release metadata matches ${tag}.`);
