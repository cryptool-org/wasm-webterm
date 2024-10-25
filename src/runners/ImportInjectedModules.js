// HACK: Inject all the modules that have been forward from the parent thread into
//       our own bundle. This has to be done before importing any of these modules.
const existingModules = Object.keys(__webpack_modules__)

for (const [id, mod] of Object.entries(global._modules)) {
  if (!existingModules.includes(id)) __webpack_modules__[id] = mod
}

// HACK: Make the lexicographic first export of the `WasmRunner` module available
//       as the default export. Webpack does mangle/minify names longer than 2 characters.
const WasmRunnerModule = __webpack_require__(global.WasmRunnerID)
const defaultKey = Object.keys(WasmRunnerModule)[0]
self.WasmRunner = WasmRunnerModule[defaultKey]
