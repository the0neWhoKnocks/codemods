# Codemods

A collection of custom codemods

---

## Install

In order to run mods, you'll need `jscodeshift`. At the time of writing, I installed version `0.13.0`.
```sh
npm i -g jscodeshift
```

---

## React to Svelte

This is not a comprehensive mod for React. This was written for a repo using an older version of React, but it does cover a lot of the basics.

Handles:
- Convert `class` components to Svelte components.
  - All `this.` references are removed.
- `props` and `state` 
  - Are converted to `export`ed and internal `let` variables.
    - Props or state with initial/default values are maintained.
  - Any destructured values are repointed to internal variables.
  - Calls to `setState` are repointed to internal variables.
  - prop function calls are repointed to internal variables.
- `ref`s
  - Are converted to internal `let` variables.
  - Their attribute usages are updated to `bind:this`.
  - Any usage with `current` are repointed to internal variables.
- Markup
  - Logical operators (`&&`) are converted to `{#if}` blocks.
  - `.map` calls are converted to `{#each}` blocks.
- Emotion
  - Converts external `styles.js` file's `css` calls to un-nested static rules, since that's how Svelte evaluates whether a style rule is being used.
  - Dumps the raw CSS rules into a `<style>` node.
  - Replaces any exported names/modifiers in the markup with the static value.
- External repo specific
  - Replaces module path aliases with relative paths
  - Replace tokens in a module with path with something else

```sh
# run on another repo (common use case)
MOD_REPO="${HOME}/path/to/this/repo"; MOD_CONF="${PWD}/reactToSvelte.conf.js" jscodeshift --dry --transform="${MOD_REPO}/mods/reactToSvelte.js" "${PWD}/src/components/ComponentName/index.js"

# run example in this repo
MOD_CONF="${PWD}/example/react/reactToSvelte.conf.js" jscodeshift --dry --transform="${PWD}/mods/reactToSvelte.js" "${PWD}/example/react/components/Component1/index.js"
```
