import { proxy, wrap } from "comlink"

import { FitAddon } from "xterm-addon-fit"
import { inflate } from "pako" // fallback for DecompressionStream API (free as its used in WapmFetchUtil)

import LineBuffer from "./LineBuffer"
import WasmWorkerRAW from "./runners/WasmWorker" // will be prebuilt using webpack
import {
  default as PromptsFallback,
  MODULE_ID as WasmRunnerID, // get the id of this module in the final webpack bundle
} from "./runners/WasmRunner"
import WapmFetchUtil from "./WapmFetchUtil"

import { CommandNotFoundError, KeyboardInterruptError } from "./Errors"
import Command from "./Command"
import WasmShell from "./shell/WasmShell"

class WasmWebTerm {
  isRunningCommand

  onActivated
  onDisposed

  onFileSystemUpdate
  onBeforeCommandRun
  onCommandRunFinish

  _xterm
  _shell

  _worker
  _wasmRunner // prompts fallback

  _jsCommands
  _wasmModules
  _wasmFsFiles

  _stdoutBuffer
  _stderrBuffer
  _stdoutClosed
  _stderrClosed

  _outputBuffer
  _lastOutputTime

  constructor(wasmBinaryPath) {
    this.wasmBinaryPath = wasmBinaryPath

    this._jsCommands = new Map() // js commands and their callback functions
    this.isRunningCommand = false // allow running only 1 command in parallel

    this._worker = false // fallback (do not use worker until it is initialized)
    this._wasmModules = [] // [{ name: "abc", type: "emscripten|wasmer", module: WebAssembly.Module, [runtime: Blob] }]
    this._wasmFsFiles = [] // files created during wasm execution (will be written to wasm runtime's FS)

    this._outputBuffer = "" // buffers outputs to determine if it ended with line break
    this._lastOutputTime = 0 // can be used for guessing if output is complete on stdin calls

    this._stdoutClosed = false
    this._stderrClosed = false

    this.onActivated = () => {} // can be overwritten to know when activation is complete
    this.onDisposed = () => {} // can be overwritten to know when disposition is complete

    this.onFileSystemUpdate = () => {} // can be overwritten to handle emscr file changes
    this.onBeforeCommandRun = () => {} // can be overwritten to show load animation (etc)
    this.onCommandRunFinish = () => {} // can be overwritten to hide load animation (etc)

    // check if browser support for web working is available
    if (
      ![typeof Worker, typeof SharedArrayBuffer, typeof Atomics].includes(
        "undefined"
      )
    ) {
      // if yes, initialize worker
      this._initWorker()
    } else {
      // if no support -> use prompts as fallback
      this._wasmRunner = new PromptsFallback()
    }

    this._suppressOutputs = false
  }

  /* xterm.js addon life cycle */

  async activate(xterm) {
    this._xterm = xterm

    // create xterm addon to fit size
    this._xtermFitAddon = new FitAddon()
    this._xtermFitAddon.activate(xterm)

    // fit xterm size to container
    setTimeout(() => this._xtermFitAddon.fit(), 1)

    // handle container resize
    window.addEventListener("resize", () => this._xtermFitAddon.fit())

    // handle module drag and drop
    setTimeout(() => this._initWasmModuleDragAndDrop(), 1)

    // initialize shell interface
    this._shell = new WasmShell(this.runCommands.bind(this))
    this._shell.activate(xterm)

    // register available js commands
    this.registerJsCommand("help", async function* (argv) {
      yield "todo: show helping things\n"
    })
    this.registerJsCommand("about", async (argv) => {
      return (
        "Wasm-WebTerm version " +
        __VERSION__ +
        ".\nBackend: " +
        (this._worker ? "WebWorker" : "Prompts Fallback") +
        ".\n"
      )
    })
    this.registerJsCommand(
      "clear",
      async (argv) => await this.printWelcomeMessagePlusControlSequences()
    )

    // if using webworker -> wait until initialized
    if (this._worker instanceof Promise) await this._worker

    // register xterm data handler for Ctrl+C
    this._xterm.onData((data) => this._onXtermData(data))

    // notify that we're ready
    await this.onActivated()

    // write welcome message to terminal
    this._xterm.writeln(
      await this.printWelcomeMessagePlusControlSequences(),

      // callback for when welcome message was printed
      () => {
        // start REPL
        this._shell.repl()

        // focus terminal cursor
        setTimeout(() => this._xterm.focus(), 1)
      }
    )
  }

  async dispose() {
    await this._xtermFitAddon.dispose()
    if (this._worker) this._terminateWorker()
    await this._shell.dispose()
    await this.onDisposed()
  }

  /* js command handling */

  registerJsCommand(name, callback, autocomplete) {
    this._jsCommands.set(name, { name, callback, autocomplete })
    return this // to be able to stack these calls
  }

  unregisterJsCommand(name) {
    return this._jsCommands.delete(name)
  }

  get jsCommands() {
    return this._jsCommands
  }

  /* execute list of commands */
  async runCommands(commands) {
    // give user possibility to run sth before exec
    await this.onBeforeCommandRun()

    try {
      let stdinPreset = null
      this._suppressOutputs = false

      for (const [index, command] of commands.entries()) {
        const isLast = index === commands.length - 1

        // split into command name and argv
        const { name: commandName, argv, stdout, stderr } = command

        // try user registered js commands first
        try {
          const output = await this.runJsCommand(commandName, argv, stdinPreset)

          // if is last command in pipe -> print output to xterm
          if (isLast) this._stdout(output || "")
          else stdinPreset = output || null // else -> use output as stdinPreset
        } catch (e) {
          if (!(e instanceof CommandNotFoundError)) throw e

          // otherwise try wasm commands
          if (stdout === Command.PIPE || stderr === Command.PIPE) {
            // capture command output
            const output = await this.runWasmCommandHeadless(
              commandName,
              argv,
              stdinPreset
            )
            if (stdout === Command.PIPE && stderr === Command.PIPE)
              stdinPreset = output.output
            else if (stdout === Command.PIPE) stdinPreset = output.stdout
            else if (stderr === Command.PIPE) stdinPreset = output.stderr
          } else {
            // don't capture output
            await this.runWasmCommand(commandName, argv, stdinPreset)
          }
        }
      }
    } finally {
      // print extra newline if output does not end with one
      if (this._outputBuffer.slice(-1) !== "\n") this._xterm.write("\u23CE\r\n")

      // give user possibility to run sth after exec
      await this.onCommandRunFinish()
    }
  }

  /* running single js commands */

  async runJsCommand(programName, argv, stdinPreset) {
    if (this.isRunningCommand) throw "WasmWebTerm is already running a command"
    else this.isRunningCommand = true

    // enable outputs if they were suppressed
    this._suppressOutputs = false
    this._outputBuffer = ""

    try {
      const command = this._jsCommands.get(programName)
      if (command == null) {
        throw new CommandNotFoundError()
      }
      if (typeof command?.callback !== "function") {
        throw new Error(
          `Command '${programName}' is defined but has no function`
        )
      }

      // call registered user function
      const result = command.callback(argv, stdinPreset)
      let output // where user function outputs are stored

      /**
       * user functions are another word for custom js
       * commands and can pass outputs in various ways:
       *
       * 1) return value normally via "return"
       * 2) pass value through promise resolve() / async
       * 3) yield values via generator functions
       */

      // await promises if any (2)
      if (result.then) output = ((await result) || "").toString()
      // await yielding generator functions (3)
      else if (result.next)
        for await (let data of result)
          output = output == null ? data : output + data
      // default: when functions return "normally" (1)
      else output = result.toString()

      // todo: make it possible for user functions to use stdERR.
      // exceptions? they end function execution..

      return output
    } finally {
      // enable commands to run again
      this.isRunningCommand = false
    }
  }

  /* running single wasm commands */

  runWasmCommand(programName, argv, stdinPreset, onFinishCallback) {
    if (this.isRunningCommand) throw "WasmWebTerm is already running a command"
    else this.isRunningCommand = true

    // enable outputs if they were suppressed
    this._suppressOutputs = false
    this._outputBuffer = ""
    this._stdoutClosed = false
    this._stderrClosed = false

    // define callback for when command has finished
    const onFinish = proxy(async (files) => {
      // enable commands to run again
      this.isRunningCommand = false

      // store created files
      this._wasmFsFiles = files
      await this.onFileSystemUpdate(this._wasmFsFiles)

      // wait until outputs are rendered
      await this._waitForOutputClose()

      // flush out any pending outputs
      this._stdoutBuffer.flush()
      this._stderrBuffer.flush()

      // wait until the rest is rendered
      this._waitForOutputPause().then(() => {
        // notify caller that command run is over
        if (typeof onFinishCallback === "function") onFinishCallback()

        // resolve await from shell
        this._runWasmCommandPromise?.resolve()
      })
    })

    // define callback for when errors occur
    const onError = proxy((value) => this._stderr(value + "\n"))

    // get or initialize wasm module
    this._xterm.write(
      "\x1b[1m[\x1b[32mWasmWebTerm\x1b[39m]\x1b[0m Loading web assembly ..."
    )
    this._getOrFetchWasmModule(programName)
      .then((wasmModule) => {
        // clear last line
        this._xterm.write("\x1b[2K\r")

        // check if we can run on worker, else use fallback with prompts
        const runner = this._worker || this._wasmRunner
        // delegate command execution to worker thread or
        // start execution on the MAIN thread (freezes terminal)
        runner.runCommand(
          programName,
          wasmModule.module,
          wasmModule.type,
          argv,
          this._worker ? this._stdinProxy : null,
          this._stdoutProxy,
          this._stderrProxy,
          this._wasmFsFiles,
          onFinish,
          onError,
          null,
          stdinPreset,
          wasmModule.runtime,
          wasmModule.linkedName
        )
      })

      // catch errors (command not running anymore + reject (returns to shell))
      .catch((e) => {
        this.isRunningCommand = false
        this._runWasmCommandPromise?.reject(e)
      })

    // return promise (makes shell await)
    return new Promise(
      (resolve, reject) => (this._runWasmCommandPromise = { resolve, reject })
    )
  }

  runWasmCommandHeadless(programName, argv, stdinPreset, onFinishCallback) {
    if (this.isRunningCommand) throw "WasmWebTerm is already running a command"
    else this.isRunningCommand = true

    // promise for resolving / rejecting command execution
    let runWasmCommandHeadlessPromise = { resolve: () => {}, reject: () => {} }

    // define callback for when command has finished
    const onFinish = proxy((outBuffers) => {
      // enable commands to run again
      this.isRunningCommand = false

      // flush outputs
      this._stdoutBuffer.flush()
      this._stderrBuffer.flush()

      // call on finish callback
      if (typeof onFinishCallback === "function") onFinishCallback(outBuffers)

      // resolve promise
      runWasmCommandHeadlessPromise.resolve(outBuffers)
    })

    // define callback for when errors occur
    const onError = proxy((value) => this._stderr(value + "\n"))

    // define callback for onSuccess (contains files)
    const onSuccess = proxy(() => {}) // not used currently

    // get or initialize wasm module
    this._getOrFetchWasmModule(programName)
      .then((wasmModule) => {
        // check if we can run on worker, else use fallback with prompts
        const runner = this._worker || this._wasmRunner
        // delegate command execution to worker thread or
        // start execution on the MAIN thread (freezes terminal)
        runner.runCommandHeadless(
          programName,
          wasmModule.module,
          wasmModule.type,
          argv,
          this._wasmFsFiles,
          onFinish,
          onError,
          onSuccess,
          stdinPreset,
          wasmModule.runtime,
          wasmModule.linkedName
        )
      })

      // catch errors (command not running anymore + reject promise)
      .catch((e) => {
        this.isRunningCommand = false
        runWasmCommandHeadlessPromise.reject(e)
      })

    // return promise (makes shell await)
    return new Promise(
      (resolve, reject) => (runWasmCommandHeadlessPromise = { resolve, reject })
    )
  }

  /* wasm module handling */

  async _fetchWasmModule(programName) {
    // create wasm module object
    const wasmModule = {
      name: programName,
      type: "emscripten",
      module: undefined,
    }

    // fetch wasm binary
    const wasmPath = this.wasmBinaryPath + "/" + programName + ".wasm"
    const response = await fetch(wasmPath)
    const wasmBinary = await response.arrayBuffer()

    // validate if response contains a wasm binary
    if (response?.ok && WebAssembly.validate(wasmBinary)) {
      // try to fetch emscripten js runtime
      const jsRuntimeResponse = await fetch(
        this.wasmBinaryPath + "/" + programName + ".js"
      )
      if (jsRuntimeResponse?.ok) {
        // read js runtime from response
        const jsRuntimeCode = await jsRuntimeResponse.arrayBuffer()

        // check if the first char of the response is not "<"
        // (because dumb parcel does not return http errors but an html page)
        const firstChar = String.fromCharCode(
          new Uint8Array(jsRuntimeCode, 0, 1)[0]
        )
        if (firstChar !== "<")
          // set this module's runtime
          wasmModule.runtime = jsRuntimeCode
      }

      // if no valid js runtime was found -> it's considered a wasmer binary
      if (!wasmModule.runtime) wasmModule.type = "wasmer"

      // compile fetched bytes into wasm module
      wasmModule.module = await WebAssembly.compile(wasmBinary)

      return wasmModule
    }

    // not a valid wasm binary
    throw new Error(`Cannot load wasm binary at ${wasmPath}`)
  }

  _getOrFetchWasmModule(programName) {
    return new Promise(async (resolve, reject) => {
      let wasmModule,
        localBinaryFound = false

      // check if there is an initialized module already
      this._wasmModules.forEach((moduleObj) => {
        if (moduleObj.name === programName) wasmModule = moduleObj
      })

      // if a module was found -> resolve
      if (wasmModule?.module instanceof WebAssembly.Module) resolve(wasmModule)
      else
        try {
          // if none is found -> initialize a new one

          // try to find local wasm binary
          // (only if wasmBinaryPath is provided, otherwise use wapm directly)
          if (this.wasmBinaryPath != null) {
            // try to fetch local wasm binaries first
            try {
              wasmModule = await this._fetchWasmModule(programName)

              // local binary was found -> do not fetch wapm
              localBinaryFound = true
            } catch {
              // if none was found or it was invalid -> try for a .lnk file
              // explanation: .lnk files can contain a different module/runtime name.
              // this enables `echo` and `ls` to both use `coreutils.wasm`, for example.

              // try to fetch .lnk file
              try {
                const linkPath =
                  this.wasmBinaryPath + "/" + programName + ".lnk"
                const linkResponse = await fetch(linkPath)
                if (linkResponse?.ok) {
                  // read new program name from .lnk file
                  const linkedProgramName = (await linkResponse.text()).trim()
                  // fetch the the linked module or use already initialized one
                  const linkedModule =
                    await this._getOrFetchWasmModule(linkedProgramName)
                  // save the linked name to find the runtime
                  wasmModule = {
                    ...linkedModule,
                    name: programName,
                    linkedName: linkedProgramName,
                  }

                  // local binary was found -> do not fetch wapm
                  localBinaryFound = true
                }
              } catch {}
            }
          }

          // if no local binary was found -> fetch from wapm.io
          if (!localBinaryFound) {
            const wasmBinary =
              await WapmFetchUtil.getWasmBinaryFromCommand(programName)

            // create wasm module object (to resolve and to store)
            wasmModule = {
              name: programName,
              type: "wasmer",
              module: await WebAssembly.compile(wasmBinary),
            }
          }

          // store compiled module
          this._wasmModules.push(wasmModule)

          // continue execution
          resolve(wasmModule)
        } catch (e) {
          reject(e)
        }
    })
  }

  _initWasmModuleDragAndDrop() {
    // event handler for when user starts to drag file
    this._xterm.element.addEventListener("dragenter", (e) => {
      this._xterm.element.style.opacity = "0.8"
    })

    // needed for drop event to be fired on div
    this._xterm.element.addEventListener("dragover", (e) => {
      e.preventDefault()
      this._xterm.element.style.opacity = "0.8"
    })

    // event handler for when user stops to drag file
    this._xterm.element.addEventListener("dragleave", (e) => {
      this._xterm.element.style.opacity = ""
    })

    // event handler for when the user drops the file
    this._xterm.element.addEventListener(
      "drop",
      async (e) => {
        e.preventDefault()
        let files = []

        if (e.dataTransfer.items) {
          // read files from .items
          for (let i = 0; i < e.dataTransfer.items.length; i++)
            if (e.dataTransfer.items[i].kind === "file")
              files.push(e.dataTransfer.items[i].getAsFile())
        } else {
          // read files from .files (other browsers)
          for (let i = 0; i < e.dataTransfer.files.length; i++)
            files.push(e.dataTransfer.files[i])
        }

        // parse dropped files into modules
        for (let i = 0; i < files.length; i++) {
          const file = files[i]
          if (file.name.endsWith(".wasm")) {
            // todo: also support dropping .lnk files?

            const programName = file.name.replace(/\.wasm$/, "")

            // remove existing modules with that name
            this._wasmModules = this._wasmModules.filter(
              (mod) => mod.name !== programName
            )

            // if has .js file -> it's an emscripten binary
            if (files.some((f) => f.name === programName + ".js")) {
              // load emscripten js runtime and compile emscripten wasm binary
              const emscrJsRuntime = files.find(
                (f) => f.name === programName + ".js"
              )
              const emscrWasmModule = await WebAssembly.compile(
                await file.arrayBuffer()
              )

              // add compiled emscripten module to this._wasmModules
              this._wasmModules.push({
                name: programName,
                type: "emscripten",
                runtime: await emscrJsRuntime.arrayBuffer(),
                module: emscrWasmModule,
              })

              alert("Emscripten Wasm Module added: " + programName)
            } else {
              // if not -> its considered a wasmer binary

              // compile wasmer module and store in this._wasmModules
              const wasmerModule = await WebAssembly.compile(
                await file.arrayBuffer()
              )
              this._wasmModules.push({
                name: programName,
                type: "wasmer",
                module: wasmerModule,
              })

              alert("WASI Module added: " + programName)
            }
          }
        }

        this._xterm.element.style.opacity = ""
      },
      false
    )
  }

  /* worker execution flow */

  _initWorker() {
    this._worker = new Promise(async (resolve) => {
      // init buffers for pausing worker and passing stdin values
      this._pauseBuffer = new Int32Array(
        new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 1)
      ) // 1 bit to shift
      this._stdinBuffer = new Int32Array(
        new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 1000)
      ) // 1000 chars buffer

      // create blob including webworker and its dependencies
      const workerSource = fetch(WasmWorkerRAW).then((response) => {
        if ("DecompressionStream" in self) {
          const stream = response.body.pipeThrough(
            new DecompressionStream("gzip")
          )
          const decompressed = new Response(stream)
          return decompressed.text()
        } else {
          return response.bytes().then((data) => inflate(data))
        }
      })

      // HACK: Forward all modules for the `WasmRunner`(`PromptsFallback`) to the worker
      //       instead of bundling them directly. This saves about 90 KiB by not serializing
      //       these dependencies twice. This works fine, since we already use the identical
      //       module already as a fallback.
      const extraModules = {}
      try {
        const webpackModuleIds = Object.keys(__webpack_modules__)
        let dependencies = [WasmRunnerID] // start with the `WasmRunner` module
        for (
          let dep = dependencies.shift();
          dep != null;
          dep = dependencies.shift()
        ) {
          // put the module into the list of modules to forward
          const mod = __webpack_modules__[dep]
          extraModules[dep] = mod

          // parse module for imports of other module dependencies (like `r(MODULE_ID)`)
          const matches = mod.toString().matchAll(/\br\((\d+)\)/g)
          for (const match of matches) {
            if (webpackModuleIds.includes(match[1])) dependencies.push(match[1])
          }
        }
      } catch (err) {
        // Could not collect the `WasmRunner` module and its dependencies for forwarding
        console.error(
          `Cannot collect the \`WasmRunner\` module and its dependencies for use in the Worker: ${err}`
        )
        console.error(
          "Falling back to excuting `WasmRunner` in the PromptsFallback"
        )

        // -> use prompts as fallback
        this._wasmRunner = new PromptsFallback()
        this._worker = false
        resolve(this._worker)

        return
      }

      // prepend source of collected modules as well as the ID for the
      // `WasmRunner` module to the original worker source
      let prelude = "self._modules={"
      for (const [id, module] of Object.entries(extraModules)) {
        const str = module.toString()
        prelude += str.startsWith(id) ? `${str},` : `${id}:${str},`
      }
      prelude += `};self.WasmRunnerID=${WasmRunnerID}\n`

      const blob = new Blob([prelude, await workerSource], {
        type: "application/javascript",
      })

      // init webworker from blob (no separate file, no cross-origin problems)
      this._workerRAW = new Worker(URL.createObjectURL(blob))
      const WasmWorker = wrap(this._workerRAW)
      this._worker = await new WasmWorker(this._pauseBuffer, this._stdinBuffer)

      resolve(this._worker) // webworker is now initialized
    })
  }

  _resumeWorker() {
    console.log("resuming worker (request)")
    Atomics.store(this._pauseBuffer, 0, 0) // mem[0] = 0 (means do not hold)
    Atomics.notify(this._pauseBuffer, 0) // awake waiting
  }

  _terminateWorker() {
    console.log("called terminate worker")
    this._workerRAW?.terminate()
  }

  _waitForOutputPause(pauseDuration = 80, interval = 20) {
    // note: timeout because web worker outputs are not always rendered to
    // the term directly. therefore we wait until we guess it's all there.
    return new Promise((resolve) => {
      const timeout = () => {
        setTimeout(() => {
          // if there has been output in the last pauseDuration -> run again
          if (this._lastOutputTime > Date.now() - pauseDuration) timeout()
          // if not -> resolve
          else resolve()
        }, interval)
      }
      timeout()
    })
  }

  _waitForOutputClose(interval = 20, timeout = 1000) {
    // note: additional timeout to wait for the last call to the output buffers
    // which should be blocking until everything has been output.
    const start = Date.now()
    return new Promise((resolve) => {
      const wait = () => {
        setTimeout(() => {
          // if both buffers are closed -> resolve
          if (this._stdoutClosed && this._stderrClosed) resolve()
          // if wasn't closed in timeout -> resolve anyway
          else if (start + timeout < Date.now()) resolve()
          // -> wait until closed or timeout
          else wait()
        }, interval)
      }
      wait()
    })
  }

  /* input output handling -> web worker */

  _setStdinBuffer(string) {
    for (let i = 0; i < this._stdinBuffer.length; i++)
      this._stdinBuffer[i] = string[i] ? string[i].charCodeAt(0) : 0 // 0 = null (empty bits = end of string)
  }

  _stdinProxy = proxy((message) => {
    this._waitForOutputPause().then(async () => {
      // flush outputs (to show the prompt)
      this._stdoutBuffer.flush()
      this._stderrBuffer.flush()

      // read input line
      const input = await this._shell.readLine(message)

      // pass value to webworker
      this._setStdinBuffer(input)
      this._resumeWorker()
    })
  })

  _stdoutProxy = proxy((value, close = false) => {
    this._lastOutputTime = Date.now() // keep track of time
    if (close) this._stdoutClosed = true
    this._stdoutBuffer.write(value)
  })
  _stderrProxy = proxy((value, close = false) => {
    this._lastOutputTime = Date.now() // keep track of time
    if (close) this._stderrClosed = true
    this._stderrBuffer.write(value)
  })

  /* input output handling -> term */

  _stdoutBuffer = new LineBuffer(this._stdout.bind(this))
  _stderrBuffer = new LineBuffer(this._stderr.bind(this))

  _stdout(value) {
    if (this._suppressOutputs) return // used for Ctrl+C

    // numbers are interpreted as char codes -> convert to string
    if (typeof value === "number") value = String.fromCharCode(value)

    // avoid offsets with line breaks
    value = value.replace(/\n/g, "\r\n")

    // write to terminal
    this._outputBuffer += value
    this._xterm.write(value)
  }

  _stderr(value) {
    // check if it's a javascript error
    if (value instanceof Error) {
      // log error to the console
      console.error("stderr error:", value)

      // convert error object to string
      value = value.toString() + "\n"
    }

    // print to terminal
    this._stdout(value)
  }

  async printWelcomeMessage() {
    let message = `\x1b[1;32m
 _ _ _                  _ _ _     _      _____               \r
| | | |___ ___ _____   | | | |___| |_   |_   _|___ ___ _____ \r
| | | | .'|_ -|     |  | | | | -_| . |    | | | -_|  _|     |\r
|_____|__,|___|_|_|_|  |_____|___|___|    |_| |___|_| |_|_|_|\r
            \x1b[37m\r\n`

    message +=
      "Run WebAssembly binaries compiled with Emscripten or Wasmer.\r\n"
    message +=
      "You can also define and run custom JavaScript functions.\r\n\r\n"

    message += "Version: " + __VERSION__ + ". "
    message +=
      "Backend: " + (this._worker ? "WebWorker" : "Prompts Fallback") + ".\r\n"
    message +=
      "Commands: " +
      [...this._jsCommands]
        .map((commandObj) => commandObj[0])
        .sort()
        .join(", ") +
      ". "

    return message
  }

  // helper function to cleanly print the welcome message
  async printWelcomeMessagePlusControlSequences() {
    // clear terminal, reset color, print welcome message, reset color, add empty line
    return (
      "\x1bc" +
      "\x1b[0;37m" +
      (await this.printWelcomeMessage()) +
      "\x1b[0;37m\r\n"
    )
  }

  // custom handler for Ctrl+C (webworker only)
  _onXtermData(data) {
    if (data === "\x03") {
      if (this._worker) {
        this._suppressOutputs = true
        this._stdoutClosed = true
        this._stderrClosed = true
        this._terminateWorker()
        this._initWorker() // reinit
        this._runWasmCommandPromise?.reject(new KeyboardInterruptError())
        this.isRunningCommand = false
      }
    }
  }
}

export default WasmWebTerm
