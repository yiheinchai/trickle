---
name: publish
description: "Publish all trickle packages (npm, PyPI, VSCode extension). Use when the user asks to publish, release, bump versions, or push packages to registries."
argument-hint: "[version-bump: patch|minor|major]"
---

# Publish Trickle Packages

Publishes all packages in the trickle monorepo. Default bump is `patch`.

## Packages

| Package          | Registry       | Name                        | Location                    |
| ---------------- | -------------- | --------------------------- | --------------------------- |
| JS Client        | npm            | `trickle-observe`           | `packages/client-js`        |
| CLI              | npm            | `trickle-cli`               | `packages/cli`              |
| Backend          | npm            | `trickle-backend`           | `packages/backend`          |
| Python Client    | PyPI           | `trickle-observe`           | `packages/client-python`    |
| VSCode Extension | VS Marketplace | `yiheinchai.trickle-vscode` | `packages/vscode-extension` |

## Auth tokens

All auth tokens are in `.env` at the repo root:

- `NPM_ACCESS_TOKEN` — npm publish token
- `PYPI_TOKEN` — PyPI API token (username is `__token__`)
- `VSCODE_PAT` — VS Code Marketplace Personal Access Token

Read `.env` at the start to get these values.

## Steps

### 1. Bump versions

Determine the bump type from the argument (default: `patch`).

**npm packages** (JS client, CLI, backend, VSCode extension):

```bash
cd packages/client-js && npm version <bump> --no-git-tag-version
cd packages/cli && npm version <bump> --no-git-tag-version
cd packages/backend && npm version <bump> --no-git-tag-version
cd packages/vscode-extension && npm version <bump> --no-git-tag-version
```

**Python** — edit `packages/client-python/pyproject.toml` and update the `version` field.

### 2. Build all packages

Run all builds **in parallel**:

```bash
cd packages/client-js && npm run build
cd packages/cli && npm run build
cd packages/backend && npm run build
cd packages/vscode-extension && npm run build
cd packages/client-python && rm -rf dist/ && python3 -m build
```

Note: Use `python3 -m build` (anaconda python at `/Users/yiheinchai/anaconda3/bin/python3`). If `build` module is missing, install with `python3 -m pip install build`.

### 3. Publish npm packages

**IMPORTANT**: npm requires auth. Write the token to `~/.npmrc` temporarily:

```bash
echo "//registry.npmjs.org/:_authToken=<NPM_ACCESS_TOKEN>" > ~/.npmrc
```

Then publish each package (can run in parallel):

```bash
cd packages/client-js && npm publish
cd packages/cli && npm publish
cd packages/backend && npm publish
```

**Clean up after**: `rm -f ~/.npmrc`

Note: Do NOT use a local `.npmrc` in the package directory — npm ignores workspace config files. The token MUST be in `~/.npmrc`.

### 4. Publish Python package

Use twine with env vars for auth (no interactive prompt needed):

```bash
cd packages/client-python && TWINE_USERNAME=__token__ TWINE_PASSWORD='<PYPI_TOKEN>' twine upload dist/*
```

If twine is broken (missing `rich` module etc.), fix with: `conda install rich` or `python3 -m pip install rich twine`.

### 5. Publish VSCode extension

The extension is in a monorepo, so `vsce package` picks up parent files. Work around this by packaging from an isolated temp directory:

```bash
mkdir -p /tmp/trickle-vsce/dist
cp packages/vscode-extension/package.json /tmp/trickle-vsce/
cp packages/vscode-extension/dist/extension.js /tmp/trickle-vsce/dist/
cd /tmp/trickle-vsce && npx @vscode/vsce package --allow-missing-repository
cd /tmp/trickle-vsce && npx @vscode/vsce publish --allow-missing-repository --pat '<VSCODE_PAT>'
```

Note: Use `npx @vscode/vsce` (not bare `vsce` which may not be installed globally).

### 6. Update installed VSCode extension locally

After publishing, clean up old extension versions and update the local copy so the user sees changes immediately. VSCode keeps old versioned folders around and may load a stale one if multiple exist.

```bash
# Remove ALL old versions first
rm -rf ~/.vscode/extensions/yiheinchai.trickle-vscode-*/

# Install fresh from the just-published VSIX
code --install-extension /tmp/trickle-vsce/trickle-vscode-*.vsix --force
```

If `code` CLI is not available, manually copy both files:
```bash
NEW_VERSION=$(node -p "require('./packages/vscode-extension/package.json').version")
mkdir -p ~/.vscode/extensions/yiheinchai.trickle-vscode-${NEW_VERSION}/dist
cp packages/vscode-extension/package.json ~/.vscode/extensions/yiheinchai.trickle-vscode-${NEW_VERSION}/
cp packages/vscode-extension/dist/extension.js ~/.vscode/extensions/yiheinchai.trickle-vscode-${NEW_VERSION}/dist/
```

Then tell user to reload VSCode (Cmd+Shift+P -> "Developer: Reload Window").

### 7. Commit and push

```bash
git add packages/backend/package.json packages/cli/package.json packages/client-js/package.json packages/client-python/pyproject.toml packages/vscode-extension/package.json package-lock.json
git commit -m "Bump versions for publish: <list versions>"
git push
```

## Important notes

- Read `.env` for all auth tokens — never hardcode them
- npm token MUST go in `~/.npmrc` (not package-level `.npmrc`) — clean up after publish
- PyPI package name is `trickle-observe` (not `trickle`, which is taken by someone else)
- VSCode publisher is `yiheinchai`
- Use `python3` from anaconda (`/Users/yiheinchai/anaconda3/bin/python3`, Python 3.11)
- Use `npx @vscode/vsce` instead of bare `vsce`
- Always build before publishing to ensure dist is up to date
- Run all independent publish commands in parallel for speed
