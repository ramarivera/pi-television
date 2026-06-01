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
  "refreshMs": 10000
}
```

`includeFolders` defaults to `true`, so folder paths are returned alongside files. Set it to `false` to restrict the picker to regular files only.

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
