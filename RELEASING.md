# Releasing lb4-openapi-provider-gen

The package is prepared for `AdamSmid/lb4-openapi-provider-gen`, with MIT licensing
and the unscoped npm name `lb4-openapi-provider-gen`. Keep `repository`, `homepage`
and `bugs` in `package.json` aligned with the actual repository before publishing.

## Standalone GitHub repository

Use only this directory as the repository root. Do not include the parent
application or its history.

From a standalone checkout, if Git is not already initialized:

```sh
git init -b main
git add .
git commit -m "Prepare lb4-openapi-provider-gen 0.1.0"
```

With an authenticated GitHub CLI, create and push the repository:

```sh
gh repo create AdamSmid/lb4-openapi-provider-gen \
  --public --source=. --remote=origin --push \
  --description "Generate typed LoopBack 4 service providers from OpenAPI 3.0"
```

Alternatively, create an empty repository in GitHub, then use
`git remote add origin https://github.com/AdamSmid/lb4-openapi-provider-gen.git`
and `git push -u origin main`. If the checkout already has `origin`, use it without
adding it again.

CI runs tests, checks the example and verifies a package installation on Ubuntu
and macOS using Node.js 22 and 24. Workflows must live in `.github/workflows/` at
the root of the new repository.

## Validate the release

```sh
npm ci
npm test
npm run check:example
npm run test:package
npm run check:release -- v0.1.0
npm pack --dry-run
```

`prepack` builds the distributable. `prepublishOnly` runs tests, the example drift
check and package-install verification before a normal `npm publish`.
The npm tarball includes only compiled output, TypeScript source, package
metadata, README, changelog and license. Examples, tests and CI scripts belong
to the source repository and are excluded from npm.

## Bootstrap the first npm version

The npm package must exist before its trusted publisher can be configured.
For initial `0.1.0`, sign in as the intended npm owner and publish manually:

```sh
npm login
npm whoami
npm publish --access public
```

Complete any npm two-factor authentication prompt. This step actually publishes
the package; preparation, `npm pack`, tests and dry runs neither publish nor
reserve the name.

## Configure trusted publishing

In npm package Settings → Trusted publishing, add GitHub Actions with:

- Organization/user: `AdamSmid`
- Repository: `lb4-openapi-provider-gen`
- Workflow filename: `publish.yml`
- Environment: blank (the workflow does not specify one)
- Allowed actions: enable direct `npm publish`

The workflow uses Node.js 24, npm 11 and `id-token: write` for OIDC. No stored
`NPM_TOKEN` is needed. It publishes with provenance from the public repository.
See [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

## Subsequent releases

After bootstrapping `0.1.0`, start automated releases at `0.1.1` or later:

1. Update `CHANGELOG.md` and verify CI passes.
2. Run `npm version patch` (or `minor`/`major`) from a clean standalone checkout.
   This updates both manifests, commits them and creates the version tag.
3. Push: `git push origin main --follow-tags`.
4. Publish a non-prerelease GitHub Release for that tag, such as `v0.1.1`.

The workflow verifies the tag matches `package.json`, checks the repository
metadata, runs prepublish checks and publishes. Do not trigger it for a version
already published manually. Prerelease GitHub Releases are skipped; supporting
prerelease npm dist-tags is a separate release-policy change.

Verify the workflow and `npm view lb4-openapi-provider-gen version` after release.
