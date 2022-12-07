<div align="center">
  <img height="100" src="https://user-images.githubusercontent.com/9321076/156306369-67d21652-3b81-475c-8b70-2bd7cbfbdf44.png" valign="middle" />
  <h1 style="border-bottom: none;">WebAssembly WebTerm</h1>
  🚀 <a href="https://www.cryptool.org/webterm">Live Demo</a> &nbsp;&nbsp;
  ⚛️ <a href="./examples/3-react-with-webpack">React Example</a> &nbsp;&nbsp;
  🔐 <a href="https://github.com/cryptool-org/openssl-webterm">OpenSSL</a>
</div>
&nbsp;

Run your [WebAssembly](https://webassembly.org) binaries on a terminal/tty emulation in your browser. [Emscripten](https://emscripten.org) and [WASI](https://github.com/WebAssembly/WASI) are supported. This project is developed as an addon for [xterm.js](https://github.com/xtermjs/xterm.js) v4, so you can easily use it in your own projects.

> It originated from the [CrypTool project](https://www.cryptool.org) in 2022 for [running OpenSSL v3 in a browser](https://github.com/cryptool-org/openssl-webterm).

Please note that xterm.js and this addon need a browser to run.

<!-- todo: how bout xterm.js-headless? -->


-----


## Readme Contents

* [Installation](#installation) and [Usage](#usage) (via [`script` tag](#variant-1-load-via-plain-js-script-tag), [Node.js](#variant-2-import-as-nodejs-module-and-use-a-web-bundler), or [React](#variant-3-using-react-and-a-web-bundler))
* [Binaries](#binaries) ([Predelivery](#predelivering-binaries), [Compiling C/C++](#compiling-cc-to-wasm-binaries), and [Compiling Rust](#compiling-rust-to-wasm-binaries))
* [Internal workings](#internal-procedure-flow), [JS commands](#defining-custom-js-commands), and [`WasmWebTerm.js` Code API](#wasmwebtermjs-code-api)
* [Contributing](#contributing) and [License](#license)


-----


## Installation

First, [install Node.js and npm](https://nodejs.org). Then install xterm.js and wasm-webterm:

```shell
npm install xterm cryptool-org/wasm-webterm --save
```

## Usage

JavaScript can be written for browsers or nodes, but this addon needs a browser to run (or at least a DOM and Workers or a `window` object). So if you use Node.js, you have to also use a web bundler like [Webpack](https://webpack.js.org) or [Parcel](https://parceljs.org). Using plain JS does not require a bundler.

> Please note: To make use of WebWorkers you will need to configure your server or web bundler to use [custom HTTPS headers for cross-origin isolation](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer#security_requirements). You can find an [example using Webpack in the examples folder](./examples/3-react-with-webpack/webpack.config.js#L14-L18).

Choose the variant that works best for your existing setup:


### Variant 1: Load via plain JS `<script>` tag

The first and most simple way is to include the prebundled [`webterm.bundle.js`](./webterm.bundle.js) into an HTML page using a `<script>` tag.

Create an HTML file (let's say `index.html`) and open it in your browser. You could also use [example 1 in the examples folder](./examples/1-directly-in-the-browser).

```html
<html>
    <head>
        <script src="node_modules/xterm/lib/xterm.js"></script>
        <link rel="stylesheet" href="node_modules/xterm/css/xterm.css"/>
        <script src="node_modules/wasm-webterm/webterm.bundle.js"></script>
    </head>
    <body>

        <div id="terminal"></div>

        <script>
            let term = new Terminal()
            term.loadAddon(new WasmWebTerm.default())
            term.open(document.getElementById("terminal"))
        </script>

        <style>
            html, body { margin: 0; padding: 0; background: #000; }
            .xterm.terminal { height: calc(100vh - 2rem); padding: 1rem; }
        </style>
    </body>
</html>
```

> Please note that the plain JS version uses `new WasmWebTerm.default()` \[containing **.default**] instead of just `new WasmWebTerm()` like in the Node.js examples.


### Variant 2: Import as Node.js module and use a web bundler

If you are writing a Node.js module and use a web bundler to make it runnable in web browsers, here's how you could include this project:

> You can also see [example 2 in the examples folder](./examples/2-nodejs-with-parcel). We used Parcel as an example, but any other bundler would work too.

1) Create a JS file (let's say `index.js`)

```js
import { Terminal } from "xterm"
import WasmWebTerm from "wasm-webterm"

let term = new Terminal()
term.loadAddon(new WasmWebTerm())
term.open(document.getElementById("terminal"))
```

2) Create an HTML file (let's say `index.html`)

```html
<html>
    <head>
        <link rel="stylesheet" href="node_modules/xterm/css/xterm.css" />
    </head>
      <body>
          <div id="terminal"></div>
          <script src="./index.js" type="module"></script>

          <style>
              html, body { margin: 0; padding: 0; background: #000; }
              .xterm.terminal { height: calc(100vh - 2rem); padding: 1rem; }
          </style>
      </body>
</html>
```

3) Use a web bundler to make it run in a browser

```shell
npm install -g parcel-bundler
parcel index.html
```


### Variant 3: Using React and a web bundler

If you are using React, [example 3 in the examples folder](./examples/3-react-with-webpack) includes a React wrapper for xterm.js that was taken from [xterm-for-react](https://github.com/robert-harbison/xterm-for-react). We can use this to pass our addon.

The following code is not complete (you'd also need an HTML spawnpoint and a web bundler like Webpack) and we recommend to [see the React example](./examples/3-react-with-webpack).

```js
import ReactDOM from "react-dom"
import XTerm from "./examples/3-react-with-webpack/xterm-for-react"
import WasmWebTerm from "wasm-webterm"

ReactDOM.render(<XTerm addons={[new WasmWebTerm()]} />,
    document.getElementById("terminal"))
```


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

[See below](#compiling-cc-to-wasm-binaries) how to compile them. Then copy your binaries (`.wasm` and optionally `.js` files) into a folder, let's say `./binaries`. Make sure, that your web bundler (or however you're serving your project) also delivers these binaries, so that they're available when running the webterm. [We used Webpack's CopyPlugin in our React example](./examples/3-react-with-webpack/webpack.config.js#L34-L36).

Then pass their path to the [`WasmWebTerm`](./src/WasmWebTerm.js) instance:

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

When a user visits your page, it loads xterm.js and attaches our addon. [See the upper code examples](#variant-2-import-as-nodejs-module-and-use-a-web-bundler). That calls the xterm.js life cycle method [`activate(xterm)`](./src/WasmWebTerm.md#async-activatexterm) in [`WasmWebTerm.js`](./src/WasmWebTerm.js) which starts the [REPL](#async-repl).

The REPL waits for the user to enter a line (any string, usually commands) into the terminal. This line is then evaluated by [`runLine(line)`](./src/WasmWebTerm.md#async-runlineline). If there is a predefined JS command, it'll execute it. If not, it'll delegate to [`runWasmCommand(..)`](./src/WasmWebTerm.md#runwasmcommandprogramname-argv-stdinpreset-onfinishcallback) (or [`runWasmCommandHeadless(..)`](./src/WasmWebTerm.md#runwasmcommandheadlessprogramname-argv-stdinpreset-onfinishcallback) when piping).

This then calls [`_getOrFetchWasmModule(..)`](./src/WasmWebTerm.md#_getorfetchwasmmoduleprogramname). It will search for a WebAssembly binary with the name of the command in the [predelivery folder](#predelivering-binaries). If none is found, it'll fetch [wapm.io](https://wapm.io/explore).

The binary will then be passed to an instance of [`WasmRunner`](./src/runners/WasmRunner.js). If it receives both a wasm binary and a JS runtime, it'll instanciate an [`EmscrWasmRunnable`](./src/runnables/EmscriptenRunnable.js). If it only received a wasm binary, it'll instanciate a [`WasmerRunnable`](./src/runnables/WasmerRunnable.js). Both runnables setup the runtime required for the wasm execution and start the execution.

> If WebWorker support is available (including [SharedArrayBuffer](https://caniuse.com/sharedarraybuffer)s and [Atomics](https://caniuse.com/mdn-javascript_builtins_atomics)), this will be wrapped into a [Worker thread](https://en.wikipedia.org/wiki/Web_worker) (see [`WasmWorker.js`](./src/runners/WasmWorker.js)) using [Comlink](https://github.com/GoogleChromeLabs/comlink). This is done using a [Blob](https://en.wikipedia.org/wiki/Binary_large_object) instead of delivering a separate Worker JS file: When [importing `WasmWorker.js`](./src/WasmWebTerm.js#L6), Webpack will prebuild/bundle all its dependencies and return it as `"asset/source"` (plain text) instead of a instantiable class. This is done using a [Webpack loader](./worker.loader.js).

Communication between the `WasmRunner` and the xterm.js window is done trough [Comlink proxy callbacks](https://github.com/GoogleChromeLabs/comlink#callbacks), as they might be on different threads. For example, if the wasm binary asks for Stdin (while running on the worker thread), it'll be paused, the Comlink proxy [`_stdinProxy`](./src/WasmWebTerm.md#_stdinproxymessage) is called, and the execution resumes after the proxy has finished.

> This pausing on the worker thread is done by using Atomics. That's why we rely on that browser support. The fallback (prompts) pauses the browser main thread by calling `window.prompt()`, which also blocks execution.

When the execution has finished, the respective `onFinish(..)` callback is called and the REPL starts again.


-----


## [`WasmWebTerm.js`](./src/WasmWebTerm.js) Code API

The code API of the main class `WasmWebterm` is documented in [src/WasmWebTerm.md](./src/WasmWebTerm.md).


-----


## Defining custom JS commands

In addition to running WebAssembly, you can also run JS commands on the terminal. You can register them with [`registerJsCommand(name, callback)`](./src/WasmWebTerm.md#registerjscommandname-callback-autocomplete). When typing `name` into the terminal, the `callback` function is called.

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


## Contributing

Any contributions are greatly appreciated. If you have a suggestion that would make this better, please open an issue or fork the repository and create a pull request.


## License

Distributed under the [`Apache-2.0`](https://www.apache.org/licenses/LICENSE-2.0) License. See [`LICENSE`](./LICENSE) for more information.
