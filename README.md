# @ramarivera/pi-television

Pi extension that replaces the fuzzy file finder with television (tv) for faster, non-blocking file search

## Install

```sh
pi install npm:@ramarivera/pi-television@0.0.1
```

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

