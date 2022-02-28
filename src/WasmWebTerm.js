import * as Comlink from "comlink"

import { FitAddon } from "xterm-addon-fit"
import XtermEchoAddon from "local-echo"

import WasmWorker from "./runners/WasmWorker" // will be prebuilt using webpack
import { default as PromptsFallback } from "./runners/WasmRunner"
import WapmFetchUtil from "./WapmFetchUtil"

class WasmWebTerm {

    _xterm
    _xtermEcho
    _xtermPrompt

    _commands
    isRunningCommand

    _worker
    _wasmRunner // prompts fallback

    _wasmModules
    _wasmFsFiles

    _lastOutputTime

    onActivated
    onDisposed

    onFileSystemUpdate
    onBeforeCommandRun
    onCommandRunFinish


    constructor({ emscrWasmBinaryPath = "/bin", emscrJsRuntimePath = emscrWasmBinaryPath }) {

        this._emscrWasmBinaryPath = emscrWasmBinaryPath // path for .wasm files
        this._emscrJsRuntimePath = emscrJsRuntimePath // path for .js files

        this._commands = new Map() // contains commands and their callback functions
        this.isRunningCommand = false // allow running only 1 command in parallel

        this._worker = false // fallback (do not use worker until it is initialized)
        this._wasmModules = [] // [{ name: "openssl", type: "emscripten|wasmer" module: WebAssembly.Module }]
        this._wasmFsFiles = [] // files created during execution (will be written to FS)

        this._lastOutputTime = 0 // can be used for guessing if output is complete on stdin

        this.onActivated = () => {} // can be overwritten to know when activation is complete
        this.onDisposed = () => {} // can be overwritten to know when disposition is complete

        this.onFileSystemUpdate = () => {} // can be overwritten to handle emscr file changes
        this.onBeforeCommandRun = () => {} // can be overwritten to show load animation (etc)
        this.onCommandRunFinish = () => {} // can be overwritten to hide load animation (etc)

        // check if browser support for web working is available
        if(![typeof Worker, typeof SharedArrayBuffer, typeof Atomics].includes("undefined"))

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

        // set xterm prompt
        this._xtermPrompt = async () => "$ "
        // async to be able to fetch sth here

        // create xterm local echo addon
        this._xtermEcho = new XtermEchoAddon()
        this._xtermEcho.activate(this._xterm)


        // register available commands

        this.registerCommand("help", async function*(argv) {
            yield "todo: show helping things"
        })

        this.registerCommand("clear", async (argv) => {
            // clear entire terminal, print welcome message, clear last line
            return "\u001b[2J\u001b[0;0H" + (await this._printWelcomeMessage()) + "\x1B[A"
        })

        /* this.registerCommand("echo", async function*(argv) {
            for(const char of argv.join(" ")) yield char // generator variant
        })

        this.registerCommand("echo2", (argv) => {
            return argv.join(" ") // sync and normal return variant
        })

        this.registerCommand("echo3", async (argv) => {
            return argv.join(" ") + "\n" // async function variant (like promises)
        }) */


        // if using webworker -> wait until initialized
        if(this._worker instanceof Promise) await this._worker


        // register xterm data handler for Ctrl+C
        this._xterm.onData(data => this._onXtermData(data))

        // write welcome message to terminal
        this._xterm.write(await this._printWelcomeMessage())

        // notify that we're ready
        await this.onActivated()

        // start REPL
        this.repl()

        // focus terminal cursor
        setTimeout(() => this._xterm.focus(), 1)

    }

    async dispose() {
        await this._xtermEcho.dispose()
        await this._xtermFitAddon.dispose()
        if(this._worker) this._workerRAW.terminate()
        await this.onDisposed()
    }


    /* command handling */

    registerCommand(name, callback, autocomplete) {
        this._commands.set(name, { name, callback, autocomplete })
        return this // to be able to stack these calls
    }

    unregisterCommand(name) {
        return this._commands.delete(name)
    }

    get commands() { return this._commands }


    /* read eval print loop */

    async repl() {

        try {

            // read
            const prompt = await this._xtermPrompt()
            const line = await this._xtermEcho.read(prompt)

            // empty input -> prompt again
            if(line.trim() == "") return this.repl()

            // give user possibility to exec sth before run
            await this.onBeforeCommandRun()

            // print newline before
            this._xterm.write("\r\n")

            // eval and print
            await this.runLine(line)

            // print newline after
            this._xterm.write("\r\n")

            // give user possibility to run sth after exec
            await this.onCommandRunFinish()

            // loop
            this.repl()

        } catch(e) { /* console.error("Error during REPL:", e) */ }

    }


    /* parse line as commands and handle them */

    async runLine(line) {

        try {

            let stdinPreset = null

            const commandsInLine = line.split("|") // respecting pipes // TODO: <, >, &
            for(const [index, commandString] of commandsInLine.entries()) {

                // parse command string into command name and argv
                const argv = commandString.split(/[\s]{1,}/g).filter(Boolean)
                const commandName = argv.shift(), command = this._commands.get(commandName)

                // try user registered commands first
                if(typeof command?.callback == "function") {

                    // call registered user function
                    const result = command.callback(argv, stdinPreset)
                    let output // where user function outputs are stored

                    /**
                     * user functions can pass outputs in various ways:
                     * 1) return value normally via "return"
                     * 2) pass value through promise resolve() / async
                     * 3) yield values via generator functions
                     */

                    // await promises if any (2)
                    if(result.then) output = (await result || "").toString()

                    // await yielding generator functions (3)
                    else if(result.next) for await (let data of result)
                        output = (output == null) ? data : (output + data)

                    // default: when functions return "normally" (1)
                    else output = result.toString()

                    // if is last command in pipe -> print output to xterm
                    if(index == commandsInLine.length - 1) this._stdout(output)
                    else stdinPreset = output || null // else -> use output as stdinPreset

                    // todo: make it possible for user functions to use stdERR
                    // exceptions? they end function execution..

                }

                // otherwise try wasm commands
                else if(command == undefined) {

                    // if is not last command in pipe
                    if(index < commandsInLine.length - 1) {
                        const output = await this.runCommandHeadless(commandName, argv, stdinPreset)
                        stdinPreset = output.stdout // apply last stdout to next stdin
                    }

                    // if is last command -> run normally and reset stdinPreset
                    else {
                        await this.runCommand(commandName, argv, stdinPreset)
                        stdinPreset = null
                    }
                }

                // command is defined but has no function -> can not handle
                else console.error("command is defined but has no function:", commandName)

            }
        }

        // catch errors (print to terminal and developer console)
        catch(e) { this._xterm.write(e + "\r\n"); console.error("Error running line:", e) }

    }


    /* running single wasm commands */

    runCommand(programName, argv, stdinPreset, onFinishCallback) {

        console.log("called runCommand:", programName, argv)

        if(this.isRunningCommand) throw "WasmWebTerm is already running a command"
        else this.isRunningCommand = true

        // enable outputs if they were suppressed
        this._suppressOutputs = false

        // define callback for when command has finished
        const onFinish = Comlink.proxy(async files => {

            console.log("command finished:", programName, argv)

            // enable commands to run again
            this.isRunningCommand = false

            // store created files
            this._wasmFsFiles = files
            this.onFileSystemUpdate(this._wasmFsFiles)

            // wait until outputs are rendered
            this._waitForOutputPause().then(() => {

                // notify caller that command run is over
                if(typeof onFinishCallback == "function") onFinishCallback()

                // resolve await from shell
                this._runCommandPromise?.resolve()
            })
        })

        // define callback for when errors occur
        const onError = Comlink.proxy(this._stderr.bind(this))

        // get or initialize wasm module
        this._stdout("loading web assembly ...")
        this._getOrInitWasmModule(programName).then(wasmModule => {

            // clear last line
            this._xterm.write("\x1b[2K\r")

            // check if we can run on worker
            if(this._worker)

                // delegate command execution to worker thread
                this._worker.runCommand(programName, wasmModule.module, wasmModule.type, argv,
                    this._stdinProxy, this._stdoutProxy, this._stderrProxy, this._wasmFsFiles, onFinish,
                    onError, null, stdinPreset, this._emscrJsRuntimePath)

            else // if not -> fallback with prompts

                // start execution on the MAIN thread (freezes terminal)
                this._wasmRunner.runCommand(programName, wasmModule.module, wasmModule.type, argv,
                    null, this._stdoutProxy, this._stderrProxy, this._wasmFsFiles, onFinish,
                    onError, null, stdinPreset, this._emscrJsRuntimePath)
        })

        // catch errors (command not running anymore + reject (returns to shell))
        .catch(e => { this.isRunningCommand = false; this._runCommandPromise?.reject("\r\n" + e) })

        // return promise (makes shell await)
        return new Promise((resolve, reject) => this._runCommandPromise = { resolve, reject })
    }

    runCommandHeadless(programName, argv, stdinPreset, onFinishCallback) {

        if(this.isRunningCommand) throw "WasmWebTerm is already running a command"
        else this.isRunningCommand = true

        // promise for resolving / rejecting command execution
        let runCommandHeadlessPromise = { resolve: () => {}, reject: () => {} }

        // define callback for when command has finished
        const onFinish = Comlink.proxy(outBuffers => {

            // enable commands to run again
            this.isRunningCommand = false

            // call on finish callback
            if(typeof onFinishCallback == "function") onFinishCallback(outBuffers)

            // resolve promise
            runCommandHeadlessPromise.resolve(outBuffers)
        })

        // define callback for when errors occur
        const onError = Comlink.proxy(this._stderr)

        // define callback for onSuccess (contains files)
        const onSuccess = Comlink.proxy(() => {}) // not used currently

        // get or initialize wasm module
        this._getOrInitWasmModule(programName).then(wasmModule => {

            // clear last line
            this._xterm.write("\x1b[2K\r")

            if(this._worker) // check if we can run on worker

                // delegate command execution to worker thread
                this._worker.runCommandHeadless(programName, wasmModule.module, wasmModule.type, argv,
                    this._wasmFsFiles, onFinish, onError, onSuccess, stdinPreset, this._emscrJsRuntimePath)

            else // if not -> use fallback

                // start execution on the MAIN thread (freezes terminal)
                this._wasmRunner.runCommandHeadless(programName, wasmModule.module, wasmModule.type, argv,
                    this._wasmFsFiles, onFinish, onError, onSuccess, stdinPreset, this._emscrJsRuntimePath)

        })

        // catch errors (command not running anymore + reject promise)
        .catch(e => { this.isRunningCommand = false; runCommandHeadlessPromise.reject(e) })

        // return promise (makes shell await)
        return new Promise((resolve, reject) => runCommandHeadlessPromise = { resolve, reject })
    }


    /* wasm module handling */

    _getOrInitWasmModule(programName) {
        return new Promise((resolve, reject) => {

            let wasmModule

            // check if there is an initialized module already
            this._wasmModules.forEach(moduleObj => {
                if(moduleObj.name == programName) wasmModule = moduleObj
            })

            // if a module was found -> resolve
            if(wasmModule?.module instanceof WebAssembly.Module) resolve(wasmModule)

            else { // if none is found -> initialize a new one

                let type = "emscripten" // try emscripten first, else wasmer
                const emscrWasmModuleURL = this._emscrWasmBinaryPath + "/" + programName + ".wasm"

                // try to fetch emscripten wasm module
                fetch(emscrWasmModuleURL).then(async response => {

                    // if found -> return it as array buffer
                    if(response.ok) return response.arrayBuffer()

                    else

                        try { type = "wasmer"

                            // if not -> try to fetch wasmer binary from wapm.io
                            return await WapmFetchUtil.getWasmBinaryFromCommand(programName)

                        } catch(e) {

                            // return error as Promise.reject -> jumps into catch block
                            return Promise.reject(e.toString())
                        }

                })

                // compile fetched bytes into wasm module
                .then(bytes => WebAssembly.compile(bytes)).then(module => {

                    // create wrapper object for compiled module
                    wasmModule = { name: programName, type: type, module: module }

                    // store compiled module in this._wasmModules
                    this._wasmModules.push(wasmModule)

                    resolve(wasmModule) // resolve continues execution
                })

                // handle errors
                .catch(e => reject(e))
            }
        })
    }


    /* worker execution flow */

    _initWorker() {
        this._worker = new Promise(async resolve => {

            // init buffers for pausing worker and passing stdin values
            this._pauseBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 1)) // 1 bit to shift
            this._stdinBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 1000)) // 1000 chars buffer

            // create blob including webworker and its dependencies
            let blob = new Blob([WasmWorker], { type: "application/javascript" })

            // init webworker from blob (no separate file)
            this._workerRAW = new Worker(URL.createObjectURL(blob))
            this._worker = await new (Comlink.wrap(this._workerRAW))(this._pauseBuffer, this._stdinBuffer)

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
        this._workerRAW.terminate()
    }

    _waitForOutputPause(pauseDuration = 80, interval = 20) {
        // note: timeout because web worker outputs are not always rendered to
        // the term directly. therefore we wait until we guess it's all there.
        return new Promise(resolve => {
            const timeout = () => { setTimeout(() => {

                // if there has been output in the last pauseDuration -> run again
                if(this._lastOutputTime > Date.now() - pauseDuration) timeout()

                // if not -> resolve
                else resolve()

            }, interval)}; timeout()
        })
    }


    /* input output handling -> web worker */

    _setStdinBuffer(string) {
        for(let i = 0; i < this._stdinBuffer.length; i++)
            this._stdinBuffer[i] = (string[i]) ? string[i].charCodeAt(0) : 0 // 0 = null (empty bits = end of string)
    }

    _stdinProxy = Comlink.proxy(message => {
        this._waitForOutputPause().then(async () => {

            console.log("called _stdinProxy", message)

            // read new line of input
            this._xterm.write("\r\x1B[K") // clear last line
            const input = await this._xtermEcho.read(message)

            // remove submitted input from command history
            this._xtermEcho.history.entries.pop()
            this._xtermEcho.history.cursor--

            // pass value to webworker
            this._setStdinBuffer(input + "\n")
            this._resumeWorker()

        })
    })

    _stdoutProxy = Comlink.proxy(value => this._stdout(value))
    _stderrProxy = Comlink.proxy(value => this._stderr(value))


    /* input output handling -> term */

    _stdout(value) { // string or char code

        if(this._suppressOutputs) return // used for Ctrl+C

        // numbers are interpreted as char codes -> convert to string
        if(typeof value == "number") value = String.fromCharCode(value)

        // avoid offsets with line breaks
        value = value.replace(/\n/g, "\r\n")

        // buffer time for synchronity
        this._lastOutputTime = Date.now()

        // write to terminal
        this._xterm.write(value)
    }

    _stderr = this._stdout

    async _printWelcomeMessage() {
        let message = `\x1b[1;32m
 _ _ _                  _ _ _     _      _____               \r
| | | |___ ___ _____   | | | |___| |_   |_   _|___ ___ _____ \r
| | | | .'|_ -|     |  | | | | -_| . |    | | | -_|  _|     |\r
|_____|__,|___|_|_|_|  |_____|___|___|    |_| |___|_| |_|_|_|\r
            \x1b[37m\r\n`

        message += "Run WebAssembly binaries compiled with Emscripten or Wasmer.\r\n"
        message += "You can also define and run custom JavaScript functions.\r\n\r\n"

        message += "Commands: " + [...this._commands].map(commandObj => commandObj[0]).sort().join(", ") + ". "
        message += "Backend: " + (this._worker ? "WebWorker" : "Prompts Fallback") + ".\r\n\r\n"

        return message
    }

    _onXtermData(data) {

        if(data == "\x03") { // custom handler for Ctrl+C (webworker only)
            if(this._worker) {
                this._suppressOutputs = true
                this._terminateWorker()
                this._initWorker() // reinit
                this._runCommandPromise?.reject("Ctrl + C")
                this.isRunningCommand = false
            }
        }
    }

}

export default WasmWebTerm
