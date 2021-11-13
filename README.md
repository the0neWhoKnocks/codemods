# Codemods

A collection of custom codemods

---

## Install

In order to run mods, you'll need `jscodeshift`.
```sh
npm i -g jscodeshift
```

---

## Run

**React to Svelte**
```sh
MOD_REPO="${HOME}/path/to/this/repo"; jscodeshift --dry --transform="${MOD_REPO}/mods/reactToSvelte.js" "${PWD}/src/components/ComponentName/index.js"
```
