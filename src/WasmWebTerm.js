import { proxy, wrap } from "comlink"

import { FitAddon } from "xterm-addon-fit"
import XtermEchoAddon from "local-echo"
import parse from "shell-quote/parse"
import { inflate } from "pako" // fallback for DecompressionStream API (free as its used in WapmFetchUtil)

import LineBuffer from "./LineBuffer"
import History from "./History"
import WasmWorkerRAW from "./runners/WasmWorker" // will be prebuilt using webpack
import {
  default as PromptsFallback,
  MODULE_ID as WasmRunnerID, // get the id of this module in the final webpack bundle
} from "./runners/WasmRunner"
import WapmFetchUtil from "./WapmFetchUtil"

class WasmWebTerm {
  isRunningCommand

  onActivated
  onDisposed

  onFileSystemUpdate
  onBeforeCommandRun
  onCommandRunFinish

  _xterm
  _xtermEcho
  _xtermPrompt

  _worker
  _wasmRunner // prompts fallback

  _jsCommands
  _wasmModules
  _wasmFsFiles

  _stdoutBuffer
  _stderrBuffer

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
    )
      // if yes, initialize worker
      this._initWorker()
    // if no support -> use prompts as fallback
    else this._wasmRunner = new PromptsFallback()

    this._suppressOutputs = false
    window.term = this // todo: debug
  }

  /* xterm.js addon life cycle */

  async activate(xterm) {
    this._xterm = xterm

    // create xterm addon to fit size
    this._xtermFitAddon = new FitAddon()
    this._xtermFitAddon.activate(this._xterm)

    // fit xterm size to container
    setTimeout(() => this._xtermFitAddon.fit(), 1)

    // handle container resize
    window.addEventListener("resize", () => {
      this._xtermFitAddon.fit()
    })

    // handle module drag and drop
    setTimeout(() => this._initWasmModuleDragAndDrop(), 1)

    // set xterm prompt
    this._xtermPrompt = async () => "$ "
    // async to be able to fetch sth here

    // create xterm local echo addon
    this._xtermEcho = new XtermEchoAddon(null, { historySize: 1000 })
    this._xtermEcho.activate(this._xterm)

    // patch history controller
    this._xtermEcho.history = new History(this._xtermEcho.history.size || 10)

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
        this.repl()

        // focus terminal cursor
        setTimeout(() => this._xterm.focus(), 1)
      }
    )
  }

  async dispose() {
    await this._xtermEcho.dispose()
    await this._xtermFitAddon.dispose()
    if (this._worker) this._terminateWorker()
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

  /* read eval print loop */

  async repl() {
    try {
      // read
      const prompt = await this._xtermPrompt()
      const line = await this._xtermEcho.read(prompt)

      // empty input -> prompt again
      if (line.trim() == "") return this.repl()

      // give user possibility to exec sth before run
      await this.onBeforeCommandRun()

      // print newline before
      this._xterm.write("\r\n")

      // eval and print
      await this.runLine(line)

      // print extra newline if output does not end with one
      if (this._outputBuffer.slice(-1) != "\n") this._xterm.write("\u23CE\r\n")

      // print newline after
      this._xterm.write("\r\n")

      // give user possibility to run sth after exec
      await this.onCommandRunFinish()

      // loop
      this.repl()
    } catch (e) {
      /* console.error("Error during REPL:", e) */
    }
  }

  /* parse line as commands and handle them */
  _parseCommands(line) {
    let usesEnvironmentVars = false
    let usesBashFeatures = false

    // parse line into tokens (respect escaped spaces and quotation marks)
    const commandLine = parse(line, (_key) => {
      usesEnvironmentVars = true
      return undefined
    })

    const commands = []
    let cmd = []

    splitter: {
      for (let idx = 0; idx < commandLine.length; ++idx) {
        const item = commandLine[idx]

        if (typeof item === "string") {
          if (cmd.length === 0 && item.match(/^\w+=.*$/)) {
            usesEnvironmentVars = true
            continue
          } else {
            cmd.push(item)
          }
        } else {
          switch (item.op) {
            case "|":
              commands.push(cmd)
              cmd = []
              break
            default:
              usesBashFeatures = true
              console.error("Unsupported shell operator:", item.op)
              break splitter
          }
        }
      }
    }
    commands.push(cmd)

    if (usesEnvironmentVars) {
      this._stderr(
        "\x1b[1m[\x1b[33mWARN\x1b[39m]\x1b[0m Environment variables are not supported!\n"
      )
    }
    if (usesBashFeatures) {
      this._stderr(
        "\x1b[1m[\x1b[33mWARN\x1b[39m]\x1b[0m Advanced bash features are not supported! Only the pipe '|' works for now.\n"
      )
    }

    return commands
  }

  async runLine(line) {
    try {
      let stdinPreset = null
      this._suppressOutputs = false

      const commandsInLine = this._parseCommands(line)
      for (const [index, argv] of commandsInLine.entries()) {
        // split into command name and argv
        const commandName = argv.shift()
        const command = this._jsCommands.get(commandName)

        // try user registered js commands first
        if (typeof command?.callback == "function") {
          // todo: move this to a method like "runJsCommand"?

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

          // if is last command in pipe -> print output to xterm
          if (index == commandsInLine.length - 1) this._stdout(output)
          else stdinPreset = output || null // else -> use output as stdinPreset

          // todo: make it possible for user functions to use stdERR.
          // exceptions? they end function execution..
        }

        // otherwise try wasm commands
        else if (command == undefined) {
          // if is not last command in pipe
          if (index < commandsInLine.length - 1) {
            const output = await this.runWasmCommandHeadless(
              commandName,
              argv,
              stdinPreset
            )
            stdinPreset = output.stdout // apply last stdout to next stdin
          }

          // if is last command -> run normally and reset stdinPreset
          else {
            await this.runWasmCommand(commandName, argv, stdinPreset)
            stdinPreset = null
          }
        }

        // command is defined but has no function -> can not handle
        else
          console.error("command is defined but has no function:", commandName)
      }
    } catch (e) {
      // catch errors (print to terminal and developer console)
      if (this._outputBuffer.slice(-1) != "\n") this._stderr("\n")
      this._stderr(`\x1b[1m[\x1b[31mERROR\x1b[39m]\x1b[0m ${e.toString()}\n`)
      console.error("Error running line:", e)
    }
  }

  /* running single wasm commands */

  runWasmCommand(programName, argv, stdinPreset, onFinishCallback) {
    console.log("called runWasmCommand:", programName, argv)

    if (this.isRunningCommand) throw "WasmWebTerm is already running a command"
    else this.isRunningCommand = true

    // enable outputs if they were suppressed
    this._suppressOutputs = false
    this._outputBuffer = ""

    // define callback for when command has finished
    const onFinish = proxy(async (files) => {
      console.log("command finished:", programName, argv)

      // enable commands to run again
      this.isRunningCommand = false

      // store created files
      this._wasmFsFiles = files
      await this.onFileSystemUpdate(this._wasmFsFiles)

      // wait until outputs are rendered
      await this._waitForOutputPause()

      // flush out any pending outputs
      this._stdoutBuffer.flush()
      this._stderrBuffer.flush()

      // wait until the rest is rendered
      this._waitForOutputPause().then(() => {
        // notify caller that command run is over
        if (typeof onFinishCallback == "function") onFinishCallback()

        // resolve await from shell
        this._runWasmCommandPromise?.resolve()
      })
    })

    // define callback for when errors occur
    const onError = proxy((value) => this._stderr(value + "\n"))

    // get or initialize wasm module
    this._stdout("loading web assembly ...")
    this._getOrFetchWasmModule(programName)
      .then((wasmModule) => {
        // clear last line
        this._xterm.write("\x1b[2K\r")

        // check if we can run on worker
        if (this._worker)
          // delegate command execution to worker thread
          this._worker.runCommand(
            programName,
            wasmModule.module,
            wasmModule.type,
            argv,
            this._stdinProxy,
            this._stdoutProxy,
            this._stderrProxy,
            this._wasmFsFiles,
            onFinish,
            onError,
            null,
            stdinPreset,
            wasmModule.runtime
          )
        // if not -> fallback with prompts
        // start execution on the MAIN thread (freezes terminal)
        else
          this._wasmRunner.runCommand(
            programName,
            wasmModule.module,
            wasmModule.type,
            argv,
            null,
            this._stdoutProxy,
            this._stderrProxy,
            this._wasmFsFiles,
            onFinish,
            onError,
            null,
            stdinPreset,
            wasmModule.runtime
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
      if (typeof onFinishCallback == "function") onFinishCallback(outBuffers)

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
        if (this._worker)
          // check if we can run on worker

          // delegate command execution to worker thread
          this._worker.runCommandHeadless(
            programName,
            wasmModule.module,
            wasmModule.type,
            argv,
            this._wasmFsFiles,
            onFinish,
            onError,
            onSuccess,
            stdinPreset,
            wasmModule.runtime
          )
        // if not -> use fallback
        // start execution on the MAIN thread (freezes terminal)
        else
          this._wasmRunner.runCommandHeadless(
            programName,
            wasmModule.module,
            wasmModule.type,
            argv,
            this._wasmFsFiles,
            onFinish,
            onError,
            onSuccess,
            stdinPreset,
            wasmModule.runtime
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

  _getOrFetchWasmModule(programName) {
    return new Promise(async (resolve, reject) => {
      let wasmModule,
        wasmBinary,
        localBinaryFound = false

      // check if there is an initialized module already
      this._wasmModules.forEach((moduleObj) => {
        if (moduleObj.name == programName) wasmModule = moduleObj
      })

      // if a module was found -> resolve
      if (wasmModule?.module instanceof WebAssembly.Module) resolve(wasmModule)
      else
        try {
          // if none is found -> initialize a new one

          // create wasm module object (to resolve and to store)
          wasmModule = {
            name: programName,
            type: "emscripten",
            module: undefined,
          }

          // try to find local wasm binary
          // (only if wasmBinaryPath is provided, otherwise use wapm directly)
          if (this.wasmBinaryPath != undefined) {
            // try to fetch local wasm binaries first
            const localBinaryResponse = await fetch(
              this.wasmBinaryPath + "/" + programName + ".wasm"
            )
            wasmBinary = await localBinaryResponse.arrayBuffer()

            // validate if localBinaryResponse contains a wasm binary
            if (localBinaryResponse?.ok && WebAssembly.validate(wasmBinary)) {
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
                  new Uint8Array(jsRuntimeCode).subarray(0, 1).toString()
                )
                if (firstChar != "<")
                  // set this module's runtime
                  wasmModule.runtime = jsRuntimeCode
              }

              // if no valid js runtime was found -> it's considered a wasmer binary
              if (!wasmModule.runtime) wasmModule.type = "wasmer"

              // local binary was found -> do not fetch wapm
              localBinaryFound = true
            }

            // if none was found or it was invalid -> try for a .lnk file
            else {
              // explanation: .lnk files can contain a different module/runtime name.
              // this enables `echo` and `ls` to both use `coreutils.wasm`, for example.

              // try to fetch .lnk file
              const linkResponse = await fetch(
                this.wasmBinaryPath + "/" + programName + ".lnk"
              )
              if (linkResponse?.ok) {
                // read new program name from .lnk file
                const linkedProgramName = await linkResponse.text()
                const linkDestination =
                  this.wasmBinaryPath + "/" + linkedProgramName + ".wasm"

                // try to fetch the new binary
                const linkedBinaryResponse = await fetch(linkDestination)
                if (linkedBinaryResponse?.ok) {
                  // read binary from response
                  wasmBinary = await linkedBinaryResponse.arrayBuffer()

                  // validate if linkedBinaryResponse contains a wasm binary
                  if (WebAssembly.validate(wasmBinary)) {
                    // try to fetch emscripten js runtime
                    const jsRuntimeResponse = await fetch(
                      this.wasmBinaryPath + "/" + linkedProgramName + ".js"
                    )
                    if (jsRuntimeResponse?.ok) {
                      // todo: note that this code is redundant, maybe use a function?

                      // read js runtime from response
                      const jsRuntimeCode =
                        await jsRuntimeResponse.arrayBuffer()

                      // check if the first char of the response is not "<"
                      // (because dumb parcel does not return http errors but an html page)
                      const firstChar = String.fromCharCode(
                        new Uint8Array(jsRuntimeCode).subarray(0, 1).toString()
                      )
                      if (firstChar != "<")
                        // set this module's runtime
                        wasmModule.runtime = jsRuntimeCode
                    }

                    // if no valid js runtime was found -> it's considered a wasmer binary
                    if (!wasmModule.runtime) wasmModule.type = "wasmer"

                    // local binary was found -> do not fetch wapm
                    localBinaryFound = true
                  }
                }
              }
            }
          }

          // if no local binary was found -> fetch from wapm.io
          if (!localBinaryFound) {
            wasmBinary =
              await WapmFetchUtil.getWasmBinaryFromCommand(programName)
            wasmModule.type = "wasmer"
          }

          // compile fetched bytes into wasm module
          wasmModule.module = await WebAssembly.compile(wasmBinary)

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

        if (e.dataTransfer.items)
          // read files from .items
          for (let i = 0; i < e.dataTransfer.items.length; i++)
            if (e.dataTransfer.items[i].kind == "file")
              files.push(e.dataTransfer.items[i].getAsFile())
            // read files from .files (other browsers)
            else
              for (let i = 0; i < e.dataTransfer.files.length; i++)
                files.push(e.dataTransfer.files[i])

        // parse dropped files into modules
        for (let i = 0; i < files.length; i++) {
          const file = files[i]
          if (file.name.endsWith(".wasm")) {
            // todo: also support dropping .lnk files?

            const programName = file.name.replace(/\.wasm$/, "")

            // remove existing modules with that name
            this._wasmModules = this._wasmModules.filter(
              (mod) => mod.name != programName
            )

            // if has .js file -> it's an emscripten binary
            if (files.some((f) => f.name == programName + ".js")) {
              // load emscripten js runtime and compile emscripten wasm binary
              const emscrJsRuntime = files.find(
                (f) => f.name == programName + ".js"
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
          dep != undefined;
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
        prelude += `${id}:${module.toString()},`
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

  /* input output handling -> web worker */

  _setStdinBuffer(string) {
    for (let i = 0; i < this._stdinBuffer.length; i++)
      this._stdinBuffer[i] = string[i] ? string[i].charCodeAt(0) : 0 // 0 = null (empty bits = end of string)
  }

  _stdinProxy = proxy((message) => {
    this._waitForOutputPause().then(async () => {
      console.log("called _stdinProxy", message)

      // flush outputs (to show the prompt)
      this._stdoutBuffer.flush()
      this._stderrBuffer.flush()

      // read input until RETURN (LF), CTRL+D (EOF), or CTRL+C
      const input = await new Promise((resolve, reject) => {
        let buffer = ""
        const handler = this._xterm.onData((data) => {
          // CTRL + C -> return without data
          if (data == "\x03") {
            this._xterm.write("^C")
            handler.dispose()
            return resolve("")
          }
          // CTRL + D -> return input buffer
          else if (data == "\x04") {
            handler.dispose()
            return resolve(buffer)
          }

          // map return to '\n'
          if (data == "\r") data = "\n"
          // map backspace to CTRL+H
          else if (data == "\x7f") data = "\x08"

          // add character or delete last one
          if (data == "\x08") buffer = buffer.slice(0, -1)
          else buffer += data

          // line complete -> return the input buffer
          if (data == "\n") {
            // only echo the linebreak when there is no prompt (i.e. we assume multi-line input)
            if (!message) this._xterm.write("\r\n")

            handler.dispose()
            return resolve(buffer)
          }

          // echo input back (special handling for backspace and escape sequences)
          if (data == "\x08") this._xterm.write("^H")
          else if (data.charCodeAt(0) == 0x1b)
            this._xterm.write("^[" + data.slice(1))
          else this._xterm.write(data)
        })
      })

      // pass value to webworker
      this._setStdinBuffer(input)
      this._resumeWorker()
    })
  })

  _stdoutProxy = proxy((value) => {
    this._lastOutputTime = Date.now() // keep track of time
    this._stdoutBuffer.write(value)
  })
  _stderrProxy = proxy((value) => {
    this._lastOutputTime = Date.now() // keep track of time
    this._stderrBuffer.write(value)
  })

  /* input output handling -> term */

  _stdoutBuffer = new LineBuffer(this._stdout.bind(this))
  _stderrBuffer = new LineBuffer(this._stderr.bind(this))

  _stdout(value) {
    // string or char code

    if (this._suppressOutputs) return // used for Ctrl+C

    // numbers are interpreted as char codes -> convert to string
    if (typeof value == "number") value = String.fromCharCode(value)

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

  _onXtermData(data) {
    if (data == "\x03") {
      // custom handler for Ctrl+C (webworker only)
      if (this._worker) {
        this._suppressOutputs = true
        this._terminateWorker()
        this._initWorker() // reinit
        this._runWasmCommandPromise?.reject("Ctrl + C")
        this.isRunningCommand = false
      }
    }
  }
}

export default WasmWebTerm
