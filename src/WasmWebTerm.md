# [`WasmWebTerm.js`](./WasmWebTerm.js) Code API

The main class `WasmWebTerm`, located in `WasmWebTerm.js`, has some attributes and methods that you can use or overwrite to adapt its behaviour to your needs. You can see an [example on how we used it for OpenSSL](https://github.com/cryptool-org/openssl-webterm).

For example, you can interact with the files in the filesystem, or change the welcome message, or write custom command with JS functions.

> Private attributes or methods are indicated by an underscore (`_`). For example: [`_jsCommands`](#_jscommands) would be private while [`jsCommands`](#jscommands) would be public. You can of course use these none the less.

To begin with, initialize a new instance of `WasmWebTerm`. Then overwrite its methods (if you want) and attach it to the xterm.js `Terminal`. Then you can execute methods on it.

Here's an example for a webterm with custom welcome message and custom prompt. It then executes `cowsay hi` ([cowsay binary](https://wapm.io/syrusakbary/cowsay))

```js
import { Terminal } from "xterm"
import WasmWebTerm from "wasm-webterm"

let term = new Terminal()
let wasmterm = new WasmWebTerm()

wasmterm.printWelcomeMessage = () => "Hello world shell \r\n"
wasmterm._xtermPrompt = () => "custom> "

term.loadAddon(wasmterm)
term.open(document.getElementById("terminal"))

wasmterm.runWasmCommand("cowsay", ["hi"])
```


### Public Attributes

* #### `isRunningCommand`
  Boolean value if the addon is currently running a command. Both using the `Terminal` or executing headless. This is to make sure, only a single command runs in parallel.

* #### `jsCommands`
  Getter for [`_jsCommands`](#_jscommands), a [`Map()`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Map) containing JS commands that can be ran on the webterm.


### Public Methods

* #### async `repl()`
  Starts a [Read Eval Print Loop](https://en.wikipedia.org/wiki/Read–eval–print_loop). It reads a line from the terminal, calls `onBeforeCommandRun()`, calls `runLine(line)` (which evaluates the line and runs the contained command), calls `onCommandRunFinish()`, and then recursively calls itself again (loop).

* #### async `runLine(line)`
  Gets a string (line), splits it into single commands (separated by `|`), and iterates over them. It then checks, if there is a JS function defined in [`_jsCommands`](#_jscommands) with the given command name. If there is, it'll execute it. See [defining custom JS commands](#defining-custom-js-commands) for more details. Otherwise, it will interpret the command name as the name of a WebAssembly binary and delegate to `runWasmCommand(..)` and `runWasmCommandHeadless(..)`.

* #### `runWasmCommand(programName, argv, stdinPreset, onFinishCallback)`
  The method for running single wasm commands on the Terminal. Only one command in parallel is allowed. It will call [`_getOrFetchWasmModule(name)`](#_getorfetchwasmmoduleprogramname) to fetch the according WebAssembly Module. It will then delegate the call to the Worker or the WasmRunner (which is the Prompts fallback). It also defines callback functions for when the wasm execution has finished or errored. It also passes (proxies to) `_stdout(val)`, `_stderr(val)`, and `_stdinProxy(msg)` to the WebAssembly binary. `stdinPreset` can be a string (when using pipes) or `null`. After the run (if successfull or on errors), `onFinishCallback()` will be called. This method can also be awaited instead of using the callback.

* #### `runWasmCommandHeadless(programName, argv, stdinPreset, onFinishCallback)`
  Same as `runWasmCommand(..)` but without writing to the Terminal. It does not pass proxies for input/output but buffers outputs and returns them in the callback. Errors will be printed though. This method can also be awaited instead of using the callback.

* #### `registerJsCommand(name, callback, autocomplete)`
  Registers a JS function in `callback` as to be called when the command with the name of `name` is entered into the Terminal. `autocomplete` does not work yet. These JS functions are also refered to as "user functions".

  They're callback functions will receive `argv` (array) and `stdinPreset` (string) as input. `argv` contains the command parameters and `stdinPreset` contains the output of a previous command when using pipes).

  They can pass outputs in 3 ways:

  * Normally return a string via `return`
  * Return a promise and use `resolve()` (async functions are fine too)
  * Using `yield` in generator functions

  See [defining custom JS commands](#defining-custom-js-commands) for examples.

* #### `unregisterJsCommand(name)`
  Counter part to [`registerJsCommand(..)`](#registerjscommandname-callback-autocomplete). Removes the entry from the Map.

* #### async `printWelcomeMessage()`
  Returns a string which is then printed to the Terminal on startup. This can be overwritten and is async so you could fetch something.


### Event methods

The following methods are called on specific events. You can overwrite them to customly handle the events.

* #### async `onActivated()`
  Is fired after the addon has been attached to the xterm.js Terminal instance. Usually triggered by including the Terminal into the DOM. It is called in the method `activate`, where the addon is being initialized.

* #### async `onDisposed()`
  The counter part to `onActivated` is called when the addon has been detached from the Terminal. Usually triggered by closing the tab or something.

* #### async `onFileSystemUpdate(_wasmFsFiles)`
  Is called every time the filesystem is being updated. This does not happen immediatly when a file is being written by the wasm binary, but when a command has been ran. Contains the value of `_wasmFsFiles`.

* #### async `onBeforeCommandRun()`
  Is called before every line/command ran via the REPL. Gives the opportunity to show loading animations or something like that.

* #### async `onCommandRunFinish()`
  Is called after a line/command has been ran via the REPL. Gives the opportunity to hide loading animations etc.


### Private Attributes

* #### `_xterm`
  The local instance of xterm.js `Terminal` which the addon is attached to.

* #### `_xtermEcho`
  The local instance of `local-echo`, which provides the possibility to read from the Terminal.
  > It also makes sense to look at the underlying [local-echo](https://github.com/wavesoft/local-echo). For example, its API offers the possibility to `.abortRead(reason)`, which exits the REPL.

* #### `_xtermPrompt`
  An async function that returns what is shown as prompt in the Terminal. Default is `$`.

* #### `_jsCommands`
  ES6 [`Map()`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Map) containing JS commands in the form of `["command" => function(argv, stdin)]` (simplified). There is a getter called [`jsCommands`](#jscommands), so you don't need the underscore. This can be mutated by using [`registerJsCommand(..)`](#registerjscommandname-callback-autocomplete) and [`unregisterJsCommand(..)`]((#unregisterjscommand)).

* #### `_worker`
  Instance of [Comlink](https://github.com/GoogleChromeLabs/comlink) worker if there is support for Workers. Or the boolean value `false` if there is not and the Prompts Fallback is being used.

* #### `_pauseBuffer`
  [SharedArrayBuffer](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer) (1 bit) for pausing the Worker by using [Atomics](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Atomics). If the value is set to `1`, the worker will hold on its next call of `pauseExecution()` inside of [`WasmWorker`](https://github.com/cryptool-org/wasm-webterm/blob/master/src/runners/WasmWorker.js). It can then be resumed by setting the value to `0` again.

* #### `_stdinBuffer`
  [SharedArrayBuffer](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer) (1000 bit) for passing strings to the Worker which are then used as Stdin values. Zeros (0) mark the end of the string.

* #### `_wasmRunner`
  Instance of `WasmRunner` (see `WasmRunner.js`) that is being used as fallback, when Workers are not available. Also refered to as "Prompts Fallback", as it uses `window.prompt()` and runs on the main thread.

* #### `_wasmModules`
  Array of objects containing WebAssembly modules. The object structure is as follows. The `runtime` will only be set if it's an Emscripten binary and contain the JS code then.
  ```json
  [{ name: "<commandname>", type: "emscripten|wasmer", module: WebAssembly.Module, runtime: [optional] }]
  ```

* #### `_wasmFsFiles`
  Array of objects containing the files from the virtual memory filesystem used for the wasm binaries encoded as binary data. The format is as follows:
  ```json
  [{ name: "<path/to/file.xyz>", timestamp: <unixtimestamp>, bytes: Uint8Array }]
  ```

* #### `_outputBuffer`
  String that buffers both outputs (stdout and stderr). It is used to determine if a command's output has ended with a line break or not, thus one should be appended or not.

* #### `_lastOutputTime`
  Unix timestamp updated on every output (stdout and stderr). Worker outputs are not always rendered to the Terminal directly. Therefore we wait for like 80ms before we ask for Stdin or return control to the REPL.


### Internal methods

* #### async `activate(xterm)`
  This is an [xterm.js addon life cycle method](https://xtermjs.org/docs/guides/using-addons/#creating-an-addon) and it's being called when the addon is loaded into the xterm.js Terminal instance. It loads the [xterm.js FitAddon](https://github.com/xtermjs/xterm.js/tree/master/addons/xterm-addon-fit) for dynamic Terminal resizing and the [`local-echo` addon](https://github.com/wavesoft/local-echo) for reading from the Terminal. It also initializes the drag&drop mechanism, registers default JS commands (`help` and `clear`), prints the welcome message, and starts the REPL.

* #### async `dispose()`
  Counter part to `activate(xterm)`. Disposes the FitAddon and `local-echo` and terminates the Worker.

* #### `_onXtermData(data)`
  Handler for data from the xterm.js Terminal. Whenever a user enters something, this method is called. It's currently only used for `Ctrl+C` but could be overwritten and extended.

* #### `_getOrFetchWasmModule(programName)`
  Fetches WebAssembly binaries and compiles them into WebAssembly Modules. Returns Promise to be awaited or handled by using `.then(wasmModule)`. If there already is a compiled module stored in `_wasmModules`, it will be used and nothing will be fetched. If there is none yet, it will fetch `<wasmBinaryPath>/<programName>.wasm` and validate if it's WebAssembly. If so, it will also try to fetch a JS runtime at `<wasmBinaryPath>/<programName>.js`. If it is found, the wasm binary is determined to be an Emscripten binary and the JS runtime is stored. If none is found, the wasm binary is considered a WASI binary. If no `.wasm` binary is found, it will query [wapm.io](https://wapm.io) and try to fetch a WASI binary from there.

* #### `_initWasmModuleDragAndDrop()`
  Registers event handlers for dragging and dropping WebAssembly binaries into the Terminal window. If binaries are dropped, they're compiled and added to `_wasmModules`.

* #### `_initWorker()`
  Creates [SharedArrayBuffer](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)s (`_pauseBuffer` and `_stdinBuffer`) and creates a Comlink instance of the prebuilt `WasmWorker` bundle, which is being initialized as a Worker thread from a Blob. This Blob initialization only works because all dependencies are bundles into `worker.bundle.js` by Webpack.

* #### `_resumeWorker()`
  Sets the [SharedArrayBuffer](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer) `_pauseBuffer` to `0` which resumes the Worker if its locked in `WasmWorker`'s `pauseExecution()`.

* #### `_terminateWorker()`
  Immediately [terminates](https://developer.mozilla.org/docs/Web/API/Worker/terminate) the Worker thread. "This does not offer the worker an opportunity to finish its operations; it is stopped at once."

* #### `_waitForOutputPause(pauseDuration = 80, interval = 20)`
  Worker outputs are not always rendered to the Terminal directly. Therefore we wait for like 80ms before we ask for Stdin or return control to the REPL. `interval` determines the time between each check.

* #### `_setStdinBuffer(string)`
  Sets the value of `_stdinBuffer` to a given string, which can then be read from the Worker.

* #### `_stdinProxy(message)`
  Comlink Proxy which will be passed to the Worker thread. It will be called when the wasm binary reads from `/dev/stdin` or `/dev/tty`. It then reads a line from the xterm.js Terminal by using `local-echo`, sets the `_stdinBuffer` accordingly, and resumes the Worker.

* #### `_stdoutProxy(value)` and `_stderrProxy(value)`
  Comlink proxies that map to `_stdout(value)` and `_stderr(value)`. They're proxies so that we can pass them to the Worker. But they can also be called directly, so we can also pass them to the `WasmRunner` Prompts fallback.

* #### `_stdout(value)`
  Prints the string `value` to the xterm.js Terminal, stores it in the `_outputBuffer`, and updates `_lastOutputTime`. If `value` is a number, it will be interpreted as an ASCI char code and converted into a string.

* #### `_stderr(value)`
  Just maps to `_stdout(value)` but could be used to handle Stderr separatly.


-----
