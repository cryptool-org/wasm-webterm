<div align="center">
  <img height="100" src="https://user-images.githubusercontent.com/9321076/156306369-67d21652-3b81-475c-8b70-2bd7cbfbdf44.png" valign="middle" />
  <h1 style="border-bottom: none;">WebAssembly WebTerm</h1>
  🚀 <a href="https://www.cryptool.org/webterm">Live Demo</a> &nbsp;&nbsp;
  ⚛️ <a href="https://github.com/cryptool-org/wasm-webterm-react">React Example</a> &nbsp;&nbsp;
  🔐 <a href="https://github.com/cryptool-org/openssl-webterm">OpenSSL</a>
</div>
&nbsp;

Run your [WebAssembly](https://webassembly.org) binaries on a terminal/tty emulation in your browser. [Emscripten](https://emscripten.org) and [WASI](https://github.com/WebAssembly/WASI) are supported. This project is developed as an addon for [xterm.js](https://github.com/xtermjs/xterm.js) v4, so you can easily use it in your own projects.

> It originated from the [CrypTool project](https://www.cryptool.org) in 2022 for [running OpenSSL v3 in a browser](https://github.com/cryptool-org/openssl-webterm).

Please note that xterm.js and this addon need a browser to run.

<!-- todo: how bout xterm.js-headless? -->


-----


## Readme Contents

* [Installation](#installation) and [Usage](#usage) ([Plain JS](#variant-1-load-via-plain-js-script-tag), [Node.js](#variant-2-import-as-nodejs-module-and-use-a-web-bundler), or [React](#variant-3-using-react-and-a-web-bundler))
* [Binaries](#binaries) ([Predelivery](#predelivering-binaries), [Compiling C/C++](#compiling-cc-to-wasm-binaries), and [Compiling Rust](#compiling-rust-to-wasm-binaries))
* [Internal workings](#internal-procedure-flow), [JS commands](#defining-custom-js-commands), and [`WasmWebTerm.js` Code API](#wasmwebtermjs-code-api)
* [Contributing](#contributing) and [License](#license)


-----


## Installation

First, [install Node.js and npm](https://nodejs.org). Then install xterm.js and wasm-webterm:

```shell
$ npm install --save xterm cryptool-org/wasm-webterm
```

## Usage

JavaScript can be written for browsers or nodes, but this addon needs a browser to run (or at least a DOM and Workers or a `window` object). So if you use Node.js, you have to also use a web bundler like [Webpack](https://webpack.js.org) or [Parcel](https://parceljs.org).

Using plain JS does not require a bundler.

> Please note: To make use of WebWorkers you will need to configure your server or web bundler to use [custom HTTPS headers for cross-origin isolation](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer#security_requirements). You can find an [example using Webpack in the React example](https://github.com/cryptool-org/wasm-webterm-launcher/blob/master/webpack.config.js#L14-L18).

### Variant 1: Load via plain JS `<script>` tag

```html
<html>
    <head>
        <!-- import xterm.js -->
        <script src="node_modules/xterm/lib/xterm.js"></script>
        <link rel="stylesheet" href="node_modules/xterm/css/xterm.css"/>

        <!-- import wasm-webterm (bundled) -->
        <script src="node_modules/wasm-webterm/webterm.bundle.js"></script>
    </head>
    <body>

        <div id="terminal"></div> <!-- xterm.js spawnpoint -->

        <script>
            let term = new Terminal()  // init xterm.js terminal
            term.loadAddon(new WasmWebTerm.default())  // load wasm-webterm addon
            term.open(document.getElementById("terminal"))  // render terminal into dom
        </script>

        <style> /* apply some style (full width and height) */
            html, body { margin: 0; padding: 0; background: #000; }
            .xterm.terminal { height: calc(100vh - 2rem); padding: 1rem; }
        </style>
    </body>
</html>
```

> Please note that the plain JS version uses `new WasmWebTerm.default()` \[containing <ins>.default</ins>\] instead of just `new WasmWebTerm()` like in the Node.js examples.

<details>
  <summary>Quicktip: Load from CDN</summary>

  > If you want a quick way without installing the Node Packages first, you can fetch the scripts from a CDN using the following `<head>` tags. The JS code in the `<body>` stays the same.

  ```html
  <head>
      <!-- import xterm.js -->
      <link rel="stylesheet" href="https://unpkg.com/xterm/css/xterm.css" crossorigin="true" />
      <script src="https://unpkg.com/xterm/lib/xterm.js" crossorigin="true"></script>

      <!-- import wasm-webterm (bundled) -->
      <script src="https://unpkg.com/wasm-webterm/webterm.bundle.js" crossorigin="true"></script>
  </head>
  ```
</details>


### Variant 2: Import as Node.js Module and use a web bundler

1) Create a `.js` file, let's say `index.js`
```js
import { Terminal } from "xterm"  // import xterm.js
import WasmWebTerm from "wasm-webterm"  // import wasm-webterm

let term = new Terminal()  // init xterm.js terminal
term.loadAddon(new WasmWebTerm())  // load wasm-webterm addon
term.open(document.getElementById("terminal"))  // render terminal into dom
```

2) Create an `.html` file, let's say `index.html`
```html
<html>
    <head>
        <!-- import local xterm.js stylesheet -->
        <link rel="stylesheet" href="node_modules/xterm/css/xterm.css" />
    </head>
      <body>
          <div id="terminal"></div>  <!-- xterm.js spawnpoint -->
          <script src="./index.js" type="module"></script>  <!-- inject index.js -->

          <style> /* apply some style (full width and height) */
              html, body { margin: 0; padding: 0; background: #000; }
              .xterm.terminal { height: calc(100vh - 2rem); padding: 1rem; }
          </style>
      </body>
</html>
```

3) Use a web bundler to make it run in a browser. Let's try [Parcel](https://github.com/parcel-bundler/parcel) as it's easy:

```shell
# npm install -g parcel-bundler
$ parcel index.html
```


### Variant 3: Using React and a web bundler

For React there's [xterm-for-react](https://github.com/robert-harbison/xterm-for-react) that lets us use xterm.js as a React Component. We can also easily pass our addon.

#### Installation

```shell
$ npm install --save react-dom xterm-for-react cryptool-org/wasm-webterm
```

#### Usage

```js
import ReactDOM from "react-dom"
import { XTerm } from "xterm-for-react"
import WasmWebTerm from "wasm-webterm"

ReactDOM.render(<XTerm addons={[new WasmWebTerm()]} />,
    document.getElementById("terminal"))
```

You will also need an HTML spawnpoint of course. You can then use a bundler like Webpack to bundle your React app. [See the React example](https://github.com/cryptool-org/wasm-webterm-launcher).


-----


## Binaries

This addon executes [WebAssembly](https://en.wikipedia.org/wiki/WebAssembly) binaries. They are compiled from native languages like C, C++, Rust, etc.

WebAssembly binaries are files ending on `.wasm` and can either be [predelivered by you](#predelivering-binaries) (shipping them with your application) or added live via drag and drop by users. If no binary was found locally, [wapm.io](https://wapm.io/explore) is fetched.


<details>
  <summary>What is a runtime and why do we need it?</summary>

  > "WebAssembly is an assembly language for a conceptual machine, not a physical one. This is why it can be run across a variety of different machine architectures." [(source)](https://hacks.mozilla.org/2019/03/standardizing-wasi-a-webassembly-system-interface/)

  To run programs intended to run in an OS like Linux, the "machine architecture" (your browser which is running JS) needs to initialize a runtime environment. It provides a virtual memory filesystem, handles system-calls, etc. <!-- streaming devices like `/dev/tty`, -->

  When using [WASI](https://github.com/WebAssembly/WASI) (a standard) this is handled by [WASI from `wasmer-js` v0.12](https://github.com/wasmerio/wasmer-js/tree/0.x/packages/wasi). You can alternatively use compilers like Emscripten, which will generate a <ins>specific</ins> `.js` file containing the JS runtime for your wasm binary.

  > If you provide a `.js` file with the same name than your `.wasm` file (for example drop or ship `test.wasm` and `test.js` <ins>together</ins>), the `.wasm` binary will be interpreted as compiled with Emscripten and use the `.js` file as its runtime. If you just drop a `.wasm` file, it's interpreted as WASI.

</details>


### Predelivering binaries

When you host your webterm instance somewhere, you might want to deliver some precompiled wasm binaries for your users to use. For example, [we compiled OpenSSL with Emscripten to run it in the webterm](https://github.com/cryptool-org/openssl-webterm).

[See below](#compiling-cc-to-wasm-binaries) how to compile them. Then copy your binaries (`.wasm` and optionally `.js` files) into a folder, let's say `./binaries`. Make sure, that your web bundler (or however you're serving your project) also delivers these binaries, so that they're available when running the webterm. [We used Webpack's CopyPlugin in our React example](https://github.com/cryptool-org/wasm-webterm-launcher/blob/master/webpack.config.js#L34-L36).

Then pass their path to the [`WasmWebTerm`](https://github.com/cryptool-org/wasm-webterm/blob/master/src/WasmWebTerm.js) instance:

```js
let wasmterm = new WasmWebTerm("./binaries")
```

When executing a command on the webterm, it will fetch `<binarypath>/<programname>.wasm` and validate if it's WebAssembly. So make sure, that the file name of your wasm binary matches the command name. If it's available, it'll also try to fetch `<binarypath>/<programname>.js` and thereby determine if WASI or Emscripten.


### Compiling C/C++ to `.wasm` binaries

C or C++ code can be compiled to WebAssembly using [Emscripten](https://emscripten.org/docs/compiling/Building-Projects.html) or a [WASI compliant](https://github.com/WebAssembly/WASI) compiler like [WASI CC](https://github.com/wasienv/wasienv).

In both following examples we will use this little C program and put it in a file named `test.c`.

```c
#include <stdio.h>

int main()
{
    char name[200];
    fgets(name, 200, stdin);
    printf("You entered: %s", name);
    return 0;
}
```

#### Example 1: Compile with Emscripten

First, [install the Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html). It supplies `emcc` and tools like `emconfigure` and `emmake` for [building projects](https://emscripten.org/docs/compiling/Building-Projects.html).

Running the following command will create two files: `test.wasm` (containing the WebAssembly binary) and `test.js` (containing a JS runtime for that specific wasm binary). The flags are used to configure the JS runtime:

```shell
$ emcc test.c -o test.js -s EXPORT_NAME='EmscrJSR_test' -s ENVIRONMENT=web,worker -s FILESYSTEM=1 -s MODULARIZE=1 -s EXPORTED_RUNTIME_METHODS=callMain,FS,TTY -s INVOKE_RUN=0 -s EXIT_RUNTIME=1 -s EXPORT_ES6=0 -s USE_ES6_IMPORT_META=0 -s ALLOW_MEMORY_GROWTH=1
```

<details>
  <summary>Explain these flags to me</summary>

  You can also use other Emscripten flags, as long as they don't interfere with the flags we've used here. These are essential. Here's what they mean:

  | Flag                      | Value                     | Description                                            |
  |---------------------------|---------------------------|--------------------------------------------------------|
  | EXPORT_NAME               | EmscrJSR_\<programname\> | FIXED name for Module, needs to match exactly to work! |
  | ENVIRONMENT               | web,worker                | Specifies we don't need Node.js (only web and worker)  |
  | FILESYSTEM                | 1                         | Make sure Emscripten inits a memory filesystem (MemFS) |
  | MODULARIZE                | 1                         | Use a Module factory so we can create custom instances |
  | EXPORTED_RUNTIME_METHODS  | callMain,FS,TTY           | Export Filesystem, Teletypewriter, and our main method |
  | INVOKE_RUN                | 0                         | Do not run immediatly when instanciated (but manually) |
  | EXIT_RUNTIME              | 1                         | Exit JS runtime after wasm, will be re-init by webterm |
  | EXPORT_ES6                | 0                         | Do not export as ES6 module so we can load in browser  |
  | USE_ES6_IMPORT_META       | 0                         | Also do not import via ES6 to easily run in a browser  |
  | ALLOW_MEMORY_GROWTH       | 1                         | Allow the memory to grow (allocate more memory space)  |

  > ℹ️ The _fixed Emscripten Module_ name is a todo! If you have ideas for an elegant solution, please let us now :)

</details>

Then copy the created files `test.wasm` and `test.js` into your predelivery folder or drag&drop them into the terminal window. You can now execute the command "test" in the terminal and it should ask you for input.

#### Example 2: Compile with WASI CC

First, [install wasienv](https://github.com/wasienv/wasienv). It includes `wasicc` and tools like `wasiconfigure` and `wasimake`.

You can then compile `test.c` with the following line:

```shell
$ wasicc test.c -o test.wasm
```

> There is no need for lots of flags here, because WASI is a standard interface and uses a standardized JS runtime for all binaries.

Then copy the created file `test.wasm` into your predelivery folder or drag&drop it into the terminal window. You can now execute the command "test" in the terminal and it should ask you for input.


### Compiling Rust to `.wasm` binaries

Rust code can be compiled to target `wasm32-wasi` which can be executed by this addon. You can either compile it directly with `rustc` or by using Rust's build tool `cargo`.

If you haven't already, [install Rust](https://www.rust-lang.org/tools/install). Then install the `wasm32-wasi` target:

```shell
$ rustup target add wasm32-wasi
```

#### Example 1: Using `rustc`

Take some Rust source code, let's say in a file named `test.rs`

```rust
fn main() {
    println!("Hello, world!");
}
```

and compile it with

```shell
$ rustc test.rs --target wasm32-wasi
```

Then copy the created file `test.wasm` into your predelivery folder or drag&drop it into the terminal window. You can now execute the command "test" in the terminal and it should print `Hello, world!` to you.

#### Example 2: Using `cargo`

Create a new project

```shell
$ cargo new <projectname>
$ cd <projectname>
```

and build it to `wasm32-wasi`

```shell
$ cargo build --target=wasm32-wasi
```

You should find the binary `<projectname>.wasm` in the folder `<projectname>/target/wasm32-wasi/debug`.

Copy it into your predelivery folder or drag&drop it into the terminal window. You can now execute the command "\<projectname\>" in the terminal.


-----


## Internal procedure flow

<img width="521" src="https://user-images.githubusercontent.com/9321076/158201274-233b2a04-5bc5-4bd0-8628-afa34364e86b.png" />

When a user visits your page, it loads xterm.js and attaches our addon. [See the upper code examples](https://github.com/z11labs/wasm-webterm-readme#variant-2-import-as-nodejs-module-and-use-a-web-bundler). That calls the xterm.js life cycle method [`activate(xterm)`](#async-activatexterm) in [`WasmWebTerm.js`](https://github.com/cryptool-org/wasm-webterm/blob/master/src/WasmWebTerm.js) which starts the [REPL](#async-repl).

The REPL waits for the user to enter a line (any string, usually commands) into the terminal. This line is then evaluated by [`runLine(line)`](#async-runlineline). If there is a predefined JS command, it'll execute it. If not, it'll delegate to [`runWasmCommand(..)`](#runwasmcommandprogramname-argv-stdinpreset-onfinishcallback) (or [`runWasmCommandHeadless(..)`](#runwasmcommandheadlessprogramname-argv-stdinpreset-onfinishcallback) when piping).

This then calls [`_getOrFetchWasmModule(..)`](#_getorfetchwasmmoduleprogramname). It will search for a WebAssembly binary with the name of the command in the [predelivery folder](#predelivering-binaries). If none is found, it'll fetch [wapm.io](https://wapm.io/explore).

The binary will then be passed to an instance of [`WasmRunner`](https://github.com/cryptool-org/wasm-webterm/blob/master/src/runners/WasmRunner.js). If it receives both a wasm binary and a JS runtime, it'll instanciate an [`EmscrWasmRunnable`](https://github.com/cryptool-org/wasm-webterm/blob/master/src/runnables/EmscriptenRunnable.js). If it only received a wasm binary, it'll instanciate a [`WasmerRunnable`](https://github.com/cryptool-org/wasm-webterm/blob/master/src/runnables/WasmerRunnable.js). Both runnables setup the runtime required for the wasm execution and start the execution.

> If WebWorker support is available (including [SharedArrayBuffer](https://caniuse.com/sharedarraybuffer)s and [Atomics](https://caniuse.com/mdn-javascript_builtins_atomics)), this will be wrapped into a [Worker thread](https://en.wikipedia.org/wiki/Web_worker) (see [`WasmWorker.js`](https://github.com/cryptool-org/wasm-webterm/blob/master/src/runners/WasmWorker.js)) using [Comlink](https://github.com/GoogleChromeLabs/comlink). This is done using a [Blob](https://en.wikipedia.org/wiki/Binary_large_object) instead of delivering a separate Worker JS file: When [importing `WasmWorker.js`](https://github.com/cryptool-org/wasm-webterm/blob/master/src/WasmWebTerm.js#L6), Webpack will prebuild/bundle all its dependencies and return it as `"asset/source"` (plain text) instead of a instantiable class. This is done using a [Webpack loader](https://github.com/cryptool-org/wasm-webterm/blob/master/worker.loader.js).

Communication between the `WasmRunner` and the xterm.js window is done trough [Comlink proxy callbacks](https://github.com/GoogleChromeLabs/comlink#callbacks), as they might be on different threads. For example, if the wasm binary asks for Stdin (while running on the worker thread), it'll be paused, the Comlink proxy [`_stdinProxy`](#_stdinproxymessage) is called, and the execution resumes after the proxy has finished.

> This pausing on the worker thread is done by using Atomics. That's why we rely on that browser support. The fallback (prompts) pauses the browser main thread by calling `window.prompt()`, which also blocks execution.

When the execution has finished, the respective `onFinish(..)` callback is called and the REPL starts again.


## Defining custom JS commands

In addition to running WebAssembly, you can also run JS commands on the terminal. You can register them with [`registerJsCommand(name, callback)`](#registerjscommandname-callback-autocomplete). When typing `name` into the terminal, the `callback` function is called.

The `callback` function will receive `argv` (array) and `stdinPreset` (string) as input parameters. Output can be `return`ed, `resolve()`d or `yield`ed.

> todo: stderr and file system access are not implemented yet

Simple `echo` examples:

```js
wasmterm.registerJsCommand("echo1", (argv) => {
    return argv.join(" ") // sync and normal return
})

wasmterm.registerJsCommand("echo2", async (argv) => {
    return argv.join(" ") // async function return
})

wasmterm.registerJsCommand("echo3", async (argv) => {
    return new Promise(resolve => resolve(argv.join(" "))) // promise resolve()
})

wasmterm.registerJsCommand("echo4", async function*(argv) {
    for(const char of argv.join(" ")) yield char // generator yield
})
```


-----


## [`WasmWebTerm.js`](https://github.com/cryptool-org/wasm-webterm/blob/master/src/WasmWebTerm.js) Code API

The main class `WasmWebTerm`, located in `WasmWebTerm.js`, has some attributes and methods that you can use or overwrite to adapt its behaviour to your needs. You can see an [example on how we used it for OpenSSL](https://github.com/cryptool-org/openssl-webterm).

For example, you can interact with the files in the filesystem, or change the welcome message, or write custom command with JS functions.

> Private attributes or methods are indicated by an underscore (`_`). For example: [`_jsCommands`](#_jscommands) would be private while [`jsCommands`](#jscommands) would be public. You can of course use these none the less.

To begin with, initialize a new instance of `WasmWebTerm`. Then overwrite its methods (if you want) and attach it to the xterm.js `Terminal`. Then you can execute methods on it.

Here's an example for a webterm with custom welcome message and custom prompt. It then executes `[cowsay](https://wapm.io/syrusakbary/cowsay) hi`

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


## Contributing

Any contributions are **greatly appreciated**. If you have a suggestion that would make this better, please open an issue or fork the repository and create a pull request.

## License

Distributed under the [`Apache-2.0`](https://www.apache.org/licenses/LICENSE-2.0) License. See [`LICENSE`](https://github.com/cryptool-org/wasm-webterm/blob/master/LICENSE) for more information.
