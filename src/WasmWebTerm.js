import * as Comlink from "comlink"

import { FitAddon } from "xterm-addon-fit"
import XtermEchoAddon from "local-echo"

import WasmWorkerRAW from "./runners/WasmWorker" // will be prebuilt using webpack
import { default as PromptsFallback } from "./runners/WasmRunner"
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

        // handle module drag and drop
        setTimeout(() => this._initWasmModuleDragAndDrop(), 1)

        // set xterm prompt
        this._xtermPrompt = async () => "$ "
        // async to be able to fetch sth here

        // create xterm local echo addon
        this._xtermEcho = new XtermEchoAddon()
        this._xtermEcho.activate(this._xterm)


        // register available js commands

        this.registerJsCommand("help", async function*(argv) {
            yield "todo: show helping things"
        })

        this.registerJsCommand("clear", async (argv) => {
            // clear entire terminal, print welcome message, clear last two linebreaks
            return "\u001b[2J\u001b[0;0H" + (await this.printWelcomeMessage()) + "\x1B[A\x1B[A"
        })


        // if using webworker -> wait until initialized
        if(this._worker instanceof Promise) await this._worker


        // register xterm data handler for Ctrl+C
        this._xterm.onData(data => this._onXtermData(data))

        // write welcome message to terminal
        this._xterm.write(await this.printWelcomeMessage())

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


    /* js command handling */

    registerJsCommand(name, callback, autocomplete) {
        this._jsCommands.set(name, { name, callback, autocomplete })
        return this // to be able to stack these calls
    }

    unregisterJsCommand(name) {
        return this._jsCommands.delete(name)
    }

    get jsCommands() { return this._jsCommands }


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

            // print extra newline if outputs does not end with one
            if(this._outputBuffer.slice(-1) != "\n") this._xterm.write("\r\n")

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
            this._suppressOutputs = false

            const commandsInLine = line.split("|") // respecting pipes // TODO: <, >, &
            for(const [index, commandString] of commandsInLine.entries()) {

                // parse command string into command name and argv
                const argv = commandString.split(/[\s]{1,}/g).filter(Boolean)
                const commandName = argv.shift(), command = this._jsCommands.get(commandName)

                // try user registered js commands first
                if(typeof command?.callback == "function") {

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
                    if(result.then) output = (await result || "").toString()

                    // await yielding generator functions (3)
                    else if(result.next) for await (let data of result)
                        output = (output == null) ? data : (output + data)

                    // default: when functions return "normally" (1)
                    else output = result.toString()

                    // if is last command in pipe -> print output to xterm
                    if(index == commandsInLine.length - 1) this._stdout(output)
                    else stdinPreset = output || null // else -> use output as stdinPreset

                    // todo: make it possible for user functions to use stdERR.
                    // exceptions? they end function execution..

                }

                // otherwise try wasm commands
                else if(command == undefined) {

                    // if is not last command in pipe
                    if(index < commandsInLine.length - 1) {
                        const output = await this.runWasmCommandHeadless(commandName, argv, stdinPreset)
                        stdinPreset = output.stdout // apply last stdout to next stdin
                    }

                    // if is last command -> run normally and reset stdinPreset
                    else {
                        await this.runWasmCommand(commandName, argv, stdinPreset)
                        stdinPreset = null
                    }
                }

                // command is defined but has no function -> can not handle
                else console.error("command is defined but has no function:", commandName)

            }
        }

        // catch errors (print to terminal and developer console)
        catch(e) { this._xterm.write(e); console.error("Error running line:", e) }

    }


    /* running single wasm commands */

    runWasmCommand(programName, argv, stdinPreset, onFinishCallback) {

        console.log("called runWasmCommand:", programName, argv)

        if(this.isRunningCommand) throw "WasmWebTerm is already running a command"
        else this.isRunningCommand = true

        // enable outputs if they were suppressed
        this._suppressOutputs = false; this._outputBuffer = ""

        // define callback for when command has finished
        const onFinish = Comlink.proxy(async files => {

            console.log("command finished:", programName, argv)

            // enable commands to run again
            this.isRunningCommand = false

            // store created files
            this._wasmFsFiles = files
            await this.onFileSystemUpdate(this._wasmFsFiles)

            // wait until outputs are rendered
            this._waitForOutputPause().then(() => {

                // notify caller that command run is over
                if(typeof onFinishCallback == "function") onFinishCallback()

                // resolve await from shell
                this._runWasmCommandPromise?.resolve()
            })
        })

        // define callback for when errors occur
        const onError = Comlink.proxy(this._stderr.bind(this))

        // get or initialize wasm module
        this._stdout("loading web assembly ...")
        this._getOrFetchWasmModule(programName).then(wasmModule => {

            // clear last line
            this._xterm.write("\x1b[2K\r")

            // check if we can run on worker
            if(this._worker)

                // delegate command execution to worker thread
                this._worker.runCommand(programName, wasmModule.module, wasmModule.type, argv,
                    this._stdinProxy, this._stdoutProxy, this._stderrProxy, this._wasmFsFiles, onFinish,
                    onError, null, stdinPreset, wasmModule.runtime)

            else // if not -> fallback with prompts

                // start execution on the MAIN thread (freezes terminal)
                this._wasmRunner.runCommand(programName, wasmModule.module, wasmModule.type, argv,
                    null, this._stdoutProxy, this._stderrProxy, this._wasmFsFiles, onFinish,
                    onError, null, stdinPreset, wasmModule.runtime)
        })

        // catch errors (command not running anymore + reject (returns to shell))
        .catch(e => { this.isRunningCommand = false; this._runWasmCommandPromise?.reject("\r\n" + e) })

        // return promise (makes shell await)
        return new Promise((resolve, reject) => this._runWasmCommandPromise = { resolve, reject })
    }

    runWasmCommandHeadless(programName, argv, stdinPreset, onFinishCallback) {

        if(this.isRunningCommand) throw "WasmWebTerm is already running a command"
        else this.isRunningCommand = true

        // promise for resolving / rejecting command execution
        let runWasmCommandHeadlessPromise = { resolve: () => {}, reject: () => {} }

        // define callback for when command has finished
        const onFinish = Comlink.proxy(outBuffers => {

            // enable commands to run again
            this.isRunningCommand = false

            // call on finish callback
            if(typeof onFinishCallback == "function") onFinishCallback(outBuffers)

            // resolve promise
            runWasmCommandHeadlessPromise.resolve(outBuffers)
        })

        // define callback for when errors occur
        const onError = Comlink.proxy(this._stderr)

        // define callback for onSuccess (contains files)
        const onSuccess = Comlink.proxy(() => {}) // not used currently

        // get or initialize wasm module
        this._getOrFetchWasmModule(programName).then(wasmModule => {

            if(this._worker) // check if we can run on worker

                // delegate command execution to worker thread
                this._worker.runCommandHeadless(programName, wasmModule.module, wasmModule.type, argv,
                    this._wasmFsFiles, onFinish, onError, onSuccess, stdinPreset, wasmModule.runtime)

            else // if not -> use fallback

                // start execution on the MAIN thread (freezes terminal)
                this._wasmRunner.runCommandHeadless(programName, wasmModule.module, wasmModule.type, argv,
                    this._wasmFsFiles, onFinish, onError, onSuccess, stdinPreset, wasmModule.runtime)

        })

        // catch errors (command not running anymore + reject promise)
        .catch(e => { this.isRunningCommand = false; runWasmCommandHeadlessPromise.reject(e) })

        // return promise (makes shell await)
        return new Promise((resolve, reject) => runWasmCommandHeadlessPromise = { resolve, reject })
    }


    /* wasm module handling */

    _getOrFetchWasmModule(programName) {
        return new Promise(async (resolve, reject) => {

            let wasmModule

            // check if there is an initialized module already
            this._wasmModules.forEach(moduleObj => {
                if(moduleObj.name == programName) wasmModule = moduleObj })

            // if a module was found -> resolve
            if(wasmModule?.module instanceof WebAssembly.Module) resolve(wasmModule)

            else try { // if none is found -> initialize a new one

                let response, wasmBinary
                wasmModule = { name: programName, type: "emscripten", module: undefined }

                // only fetch when path submitted
                if(this.wasmBinaryPath != undefined)

                    // try to fetch local wasm binaries first
                    response = await fetch(this.wasmBinaryPath + "/" + programName + ".wasm")

                // if no path is submitted -> found = false
                let localWasmBinaryFound = response?.ok || false

                if(localWasmBinaryFound) { // if found

                    // get binary array from response
                    wasmBinary = await response.arrayBuffer()

                    // check if is valid wasm binary (could also be 404 html)
                    if(localWasmBinaryFound = WebAssembly.validate(wasmBinary)) {

                        // try to fetch emscripten js runtime
                        response = await fetch(this.wasmBinaryPath + "/" + programName + ".js")
                        if(response.ok) wasmModule.runtime = await response.arrayBuffer()

                        // if none was found -> it's considered a wasmer binary
                        else wasmModule.type = "wasmer"

                    }
                }

                if(!localWasmBinaryFound) { // if no local binary was found -> fetch from wapm.io
                    wasmBinary = await WapmFetchUtil.getWasmBinaryFromCommand(programName)
                    wasmModule.type = "wasmer"
                }

                // compile fetched bytes into wasm module
                wasmModule.module = await WebAssembly.compile(wasmBinary)

                // store compiled module
                this._wasmModules.push(wasmModule)

                // continue execution
                resolve(wasmModule)

            } catch(e) { reject(e) }
        })
    }

    _initWasmModuleDragAndDrop() {

        // event handler for when user starts to drag file
        this._xterm.element.addEventListener("dragenter", e => {
            this._xterm.element.style.opacity = "0.8" })

        // needed for drop event to be fired on div
        this._xterm.element.addEventListener("dragover", e => {
            e.preventDefault(); this._xterm.element.style.opacity = "0.8" })

        // event handler for when user stops to drag file
        this._xterm.element.addEventListener("dragleave", e => {
            this._xterm.element.style.opacity = "" })

        // event handler for when the user drops the file
        this._xterm.element.addEventListener("drop", async e => {
            e.preventDefault(); let files = []

            if(e.dataTransfer.items) // read files from .items
                for(let i = 0; i < e.dataTransfer.items.length; i++)
                    if(e.dataTransfer.items[i].kind == "file")
                        files.push(e.dataTransfer.items[i].getAsFile())

            // read files from .files (other browsers)
            else for(let i = 0; i < e.dataTransfer.files.length; i++)
                files.push(e.dataTransfer.files[i])

            // parse dropped files into modules
            for(let i = 0; i < files.length; i++) {
                const file = files[i]; if(file.name.endsWith(".wasm")) {

                    const programName = file.name.replace(/\.wasm$/, "")

                    // remove existing modules with that name
                    this._wasmModules = this._wasmModules.filter(mod => mod.name != programName)

                    // if has .js file -> it's an emscripten binary
                    if(files.some(f => f.name == programName + ".js")) {

                        // load emscripten js runtime and compile emscripten wasm binary
                        const emscrJsRuntime = files.find(f => f.name == programName + ".js")
                        const emscrWasmModule = await WebAssembly.compile(await file.arrayBuffer())

                        // add compiled emscripten module to this._wasmModules
                        this._wasmModules.push({ name: programName, type: "emscripten",
                            runtime: await emscrJsRuntime.arrayBuffer(), module: emscrWasmModule })

                        alert("Emscripten Wasm Module added: " + programName)
                    }

                    else { // if not -> its considered a wasmer binary

                        // compile wasmer module and store in this._wasmModules
                        const wasmerModule = await WebAssembly.compile(await file.arrayBuffer())
                        this._wasmModules.push({ name: programName, type: "wasmer", module: wasmerModule })

                        alert("WASI Module added: " + programName)
                    }
                }
            }

            this._xterm.element.style.opacity = ""
        }, false)

    }


    /* worker execution flow */

    _initWorker() {
        this._worker = new Promise(async resolve => {

            // init buffers for pausing worker and passing stdin values
            this._pauseBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 1)) // 1 bit to shift
            this._stdinBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 1000)) // 1000 chars buffer

            // create blob including webworker and its dependencies
            let blob = new Blob([WasmWorkerRAW], { type: "application/javascript" })

            // init webworker from blob (no separate file)
            this._workerRAW = new Worker(URL.createObjectURL(blob))
            const WasmWorker = Comlink.wrap(this._workerRAW)
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
        this._outputBuffer += value
        this._lastOutputTime = Date.now()

        // write to terminal
        this._xterm.write(value)
    }

    _stderr = this._stdout

    async printWelcomeMessage() {
        let message = `\x1b[1;32m
 _ _ _                  _ _ _     _      _____               \r
| | | |___ ___ _____   | | | |___| |_   |_   _|___ ___ _____ \r
| | | | .'|_ -|     |  | | | | -_| . |    | | | -_|  _|     |\r
|_____|__,|___|_|_|_|  |_____|___|___|    |_| |___|_| |_|_|_|\r
            \x1b[37m\r\n`

        message += "Run WebAssembly binaries compiled with Emscripten or Wasmer.\r\n"
        message += "You can also define and run custom JavaScript functions.\r\n\r\n"

        message += "Commands: " + [...this._jsCommands].map(commandObj => commandObj[0]).sort().join(", ") + ". "
        message += "Backend: " + (this._worker ? "WebWorker" : "Prompts Fallback") + ".\r\n\r\n"

        return message
    }

    _onXtermData(data) {

        if(data == "\x03") { // custom handler for Ctrl+C (webworker only)
            if(this._worker) {
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
