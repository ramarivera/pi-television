# @ramarivera/pi-television

Pi extension that keeps Pi's native file picking UX while replacing the default `@file` search path with a faster background television-style search.

## Install

```sh
pi install npm:@ramarivera/pi-television@0.0.4
```

## Modes

### Default: native live picker

By default, typing `@` in Pi keeps using Pi's native picker UI, but the suggestions come from this extension's background file search instead of launching the full-screen `tv` interface.

### Optional: select dialog mode

If you want the simpler fallback flow, create `.pi/television.json` in your project:

```json
{
  "mode": "select-dialog"
}
```

That mode uses background search plus a native Pi select dialog when you trigger `@`.

## Config

Project config lives at:

```text
.pi/television.json
```

You can also set a user-level default at:

```text
~/.pi/agent/television.json
```

Project config overrides user config.

Supported fields:

```json
{
  "mode": "native-live",
  "includeFolders": true,
  "maxResults": 20,
  "refreshMs": 10000,
  "gitTracked": true,
  "gitRecencyDays": 14
}
```

`includeFolders` defaults to `true`, so folder paths are returned alongside files. Set it to `false` to restrict the picker to regular files only.

`gitTracked` defaults to `true`. When the project is inside a git work tree, the searcher runs best-effort `git ls-files` and `git log --since=N` in the background to build ranking signals:

- Tracked files rank above untracked ones (noise like generated/vendored files sinks to the bottom of the list).
- Files edited within the last `gitRecencyDays` days (default `14`) get an additional boost.

Git is fully optional: if git is missing or the directory is not a repo, ranking silently falls back to `fd`-only fuzzy matching. Set `"gitTracked": false` to disable the git probes entirely.

## Ranking

Results are ordered as exact path prefix, then basename prefix, then fuzzy match (pi-tui's `fuzzyMatch`, tokenized on whitespace and `/`). Within each bucket, ties are broken by git tier (tracked + recent > tracked > untracked), then path depth, then length, so the canonical file wins over vendored/test copies. Case-variant paths (e.g. `Foo.ts` / `foo.ts`) collapse to the best-ranked spelling.

The native picker shows the **basename** as the item label and the **directory** as the description, so the first column stays readable instead of truncating long paths.

## Local Development

This checkout is live-enabled for Pi through:

```text
.pi/extensions/television/index.ts
```

That shim imports the package entrypoint in `src/index.ts`, which imports the extension factory from `src/extension.ts`. Tests use the same symbol so local behavior, package behavior, and manual Pi behavior do not drift.

```sh
npm install
npm run check
npm test
npm run test:e2e
npm pack --dry-run
```

## Publishing

Publishing uses GitHub Actions trusted publishing in `.github/workflows/publish.yml`.

Before the first publish, configure npm trusted publishing:

- owner/repo: `ramarivera/pi-television`
- workflow: `.github/workflows/publish.yml`
- environment: blank unless the workflow is changed to require one

No `NPM_TOKEN` is required for trusted publishing.
