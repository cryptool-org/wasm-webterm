import * as Comlink from "comlink"

import { FitAddon } from "xterm-addon-fit"
import XtermEchoAddon from "local-echo"

import EmscrWasmExecutable from "./EmscrWasmExecutable"
import EmscrWasmWebWorker from "./EmscrWasmWebWorker"

class EmscrWasmController {

    _xterm
    _xtermEcho

    _commands
    _isRunningCommand

    _worker

    _wasmModules
    _wasmFsFiles

    _outputBuffer
    _lastOutputTime

    onActivated
    onFileSystemUpdate
    onBeforeCommandRun
    onCommandRunFinish
    // todo: onDisposed ?

    constructor(emscrWasmBinaryPath, emscrJsRuntimePath) {

        this._emscrWasmBinaryPath = emscrWasmBinaryPath // path for .wasm files
        this._emscrJsRuntimePath = emscrJsRuntimePath // path for .js files

        this._commands = new Map() // contains commands and their callback functions
        this._isRunningCommand = false // allow running only 1 command in parallel

        this._worker = false // fallback (do not use worker until it is initialized)
        this._wasmModules = [] // [{ name: "openssl", module: WebAssembly.Module }]
        this._wasmFsFiles = [] // files created during execution (will be written to FS)

        this._outputBuffer = "" // buffers outputs to know last line for shell prompts
        this._lastOutputTime = 0 // can be used for guessing if output is complete on stdin

        this.onActivated = () => {} // can be overwritten to know when activation is complete
        this.onFileSystemUpdate = () => {} // can be overwritten to handle emscr file changes
        this.onBeforeCommandRun = () => {} // can be overwritten to show load animation (etc)
        this.onCommandRunFinish = () => {} // can be overwritten to hide load animation (etc)

        // check if browser support for web working is available -> if yes, initialize worker
        if(typeof Worker != "undefined" && typeof SharedArrayBuffer != "undefined" && typeof Atomics != "undefined") {
            this._initWorker()
        }

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
            this._xterm.write("\u001b[2J\u001b[0;0H") // clear
            await this._printWelcomeMessage() // print welcome
            this._xterm.write("\x1B[A\x1B[A") // clear 2 lines
        })

        this.registerCommand("echo", async function*(argv) {
            for(const char of argv.join(" ")) yield char // generator variant
        })

        this.registerCommand("echo2", (argv) => {
            return argv.join(" ") // sync and normal return variant
        })

        this.registerCommand("echo3", async (argv) => {
            return argv.join(" ") + "\n" // async function variant (like promises)
        })


        // if using webworker -> wait until initialized
        if(this._worker instanceof Promise) await this._worker


        // register xterm data handler for Ctrl+C
        this._xterm.onData(data => this._onXtermData(data))

        // write welcome message to terminal
        await this._printWelcomeMessage()

        // notify that we're ready
        await this.onActivated()

        // start REPL
        this.repl()

        // focus terminal cursor
        setTimeout(() => this._xterm.focus(), 1)

    }

    dispose() {
        this._xtermEcho.dispose()
        this._xtermFitAddon.dispose()
        if(this._worker) this._workerRAW.terminate()
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
            if(line.trim() == "") { this.repl(); return }

            // give user possibility to exec sth before run
            this.onBeforeCommandRun()

            // print newline before
            this._xterm.write("\r\n")

            // eval and print
            await this.runLine(line)

            // print extra newline if outputs does not end with one
            if(this._outputBuffer.slice(-1) != "\n") this._xterm.write("\r\n")

            // print newline after
            this._xterm.write("\r\n")

            // give user possibility to run sth after exec
            this.onCommandRunFinish()

            // loop
            this.repl()

        } catch(e) { /* console.error("Error during REPL:", e) */ }

    }


    /* parse line as commands and handle them */

    async runLine(line) {

        try {

        // reset stdin preset and output buffer
        let stdinPreset = null; this._outputBuffer = ""

        const commandsInLine = line.split("|") // respecting pipes // TODO: <, >, &
        for(const [index, commandString] of commandsInLine.entries()) {

            const argv = commandString.split(/[\s]{1,}/g).filter(Boolean)
            const commandName = argv.shift(), command = this._commands.get(commandName)

            // try user registered commands first
            if(typeof command?.callback == "function") {

                // call registered user function
                const result = command.callback(argv)

                /**
                 * user functions can pass outputs in various ways:
                 * 1) return value normally via "return"
                 * 2) pass value through promise resolve() / async
                 * 3) yield values via generator functions
                 */

                // await promises if any
                if(result.then) {
                    const output = (await result || "").toString()
                    stdinPreset = output; this._xterm.write(output)
                }

                // yielding generator functions
                else if(result.next) for await (let data of result) {

                    // save yielded output as stdin for next command
                    if(stdinPreset == null) stdinPreset = ""
                    stdinPreset += data

                    this._stdout(data) // write yielded data to term
                }

                // fallback for when functions return "normally"
                else { stdinPreset = result.toString(); this._xterm.write(result) }

                // todo: unterscheiden ob letztes command oder in einer pipe
                // ansonsten funktionieren user functions als letztes in der pipe nicht
                // stdinPreset einfach als zweiten function parameter übergeben

            }

            // default for other commands
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

        } catch(e) { console.error("Error while running line:", e) }

    }


    /* running single commands */

    runCommand(programName, argv, stdinPreset, onFinishCallback) {

        console.log("called runCommand:", programName, argv)

        if(this._isRunningCommand) throw "EmscrWasmTerm is already running a command"
        else this._isRunningCommand = true

        // console.log("controller delegates command:", programName, argv)

        this._suppressOutputs = false

        // define callback for when command has finished
        const onFinish = Comlink.proxy(async files => {

            this._isRunningCommand = false

            console.log("command finished:", programName, argv)

            // store created files
            this._wasmFsFiles = files
            this.onFileSystemUpdate(this._wasmFsFiles)

            // wait until outputs are rendered
            this._waitForOutputPause().then(() => {

                // notify caller that command run is over
                if(typeof onFinishCallback == "function") onFinishCallback()

                // resolve await from shell
                this._resolveRunCommand()

            })

        })

        // define callback for when errors occur
        const onError = Comlink.proxy(this._stderr)

        // get or initialize wasm module
        this._stdout("loading web assembly ...")
        this._getOrInitWasmModule(programName).then(wasmModule => {

            this._xterm.write("\x1b[2K\r") // clear last line
            this._outputBuffer = "" // reset output buffer before exec

            // check if we can run on worker
            if(this._worker) {

                // delegate command execution to worker thread
                this._worker.runCommand(programName, wasmModule, argv,
                    this._stdinProxy, this._stdoutProxy, this._stderrProxy,
                    this._wasmFsFiles, onFinish, onError, null, stdinPreset,
                    this._emscrJsRuntimePath) // todo: maybe order these better

            }

            // if not -> fallback with prompts
            else {

                const promptsStdinHandler = (tty) => {
                    if(tty.input.length == 0) {

                        // use last line from output buffer as prompt caption
                        const promptCaption = this._outputBuffer.split(/\r?\n/g).pop()

                        // get input from user via prompt
                        const input = window.prompt(promptCaption)

                        // if aborted -> end
                        if(input == null) return null

                        // if input was empty -> prompt again
                        // if(input == "") return promptsStdinHandler(tty)

                        // print input to terminal
                        this._stdout(input + "\r\n")

                        // copy input value to tty input
                        tty.input = (input + "\n").split("").map(char => char.charCodeAt(0))
                        tty.input.push(null) // marks end

                    }

                    // deliver input
                    return tty.input.shift()
                }

                // instantiate new emscr executable
                console.log("prompts fallback creates new emscr executable")
                let emscrWasmExe = new EmscrWasmExecutable(programName, wasmModule, () => {

                    // run command on it (using proxies just because they're already defined as variables)
                    // console.log("prompts fallback delegates command to emscr executable:", programName, argv)
                    emscrWasmExe.run(argv, promptsStdinHandler, this._stdoutProxy, this._stderrProxy, this._wasmFsFiles, onFinish, onError, null, stdinPreset)

                    // idea: does running the command async help with gui freezing? -> nope :|
                    // it would be nice if the outputs were written to xterm before prompting
                    // vielleicht einen render frame requesten?

                }, this._emscrJsRuntimePath)

            }

        })

        .catch(e => { // catch errors
            this._isRunningCommand = false // error means exit
            this._stderr(e) // write error to term
            this._resolveRunCommand() // return back to shell
        })

        // return promise (makes shell await)
        return new Promise((resolve, reject) => {
            this._resolveRunCommand = resolve
            this._rejectRunCommand = reject
        })

    }

    runCommandHeadless(programName, argv, stdinPreset, onFinishCallback) {

        if(this._isRunningCommand) throw "EmscrWasmTerm is already running a command"
        else this._isRunningCommand = true

        let resolveHeadlessCommandPromise = () => {}
        let rejectHeadlessCommandPromise = () => {}

        // define callback for when command has finished
        const onFinish = Comlink.proxy(outBuffers => {

            this._isRunningCommand = false

            // call on finish callback
            if(typeof onFinishCallback == "function") onFinishCallback(outBuffers)

            // resolve promise
            resolveHeadlessCommandPromise(outBuffers)

        })

        // console.log("controller delegates: run command headless:", programName, argv)

        // define callback for when errors occur
        const onError = Comlink.proxy(this._stderr)

        // define callback for onSuccess (contains files)
        const onSuccess = Comlink.proxy(() => {}) // not used currently

        // get or initialize wasm module
        this._getOrInitWasmModule(programName).then(wasmModule => {

            this._xterm.write("\x1b[2K\r") // clear last line
            this._outputBuffer = "" // reset output buffer before exec

            // check if we can run on worker
            if(this._worker) {

                // delegate command execution to worker thread
                this._worker.runCommandHeadless(programName, wasmModule, argv,
                    this._wasmFsFiles, onFinish, onError, onSuccess, stdinPreset,
                    this._emscrJsRuntimePath) // todo: maybe order these better?

            }

            // if not -> fallback with prompts
            else {

                // instantiate new emscr executable
                console.log("prompts fallback creates new emscr executable")
                let emscrWasmExe = new EmscrWasmExecutable(programName, wasmModule, () => {

                    // run command on it
                    // console.log("prompts fallback delegates headless command to emscr executable:", programName, argv)
                    emscrWasmExe.runHeadless(argv, this._wasmFsFiles, onFinish, onError, onSuccess, stdinPreset)

                }, this._emscrJsRuntimePath)

            }

        }).catch(e => { this._isRunningCommand = false; rejectHeadlessCommandPromise(e) })

        // return promise (makes shell await)
        return new Promise((resolve, reject) => {
            resolveHeadlessCommandPromise = resolve
            rejectHeadlessCommandPromise = reject
        })

    }


    /* wasm module handling */

    _getOrInitWasmModule(programName) {
        return new Promise((resolve, reject) => {

            let wasmModule
            let wasmModuleURL = this._emscrWasmBinaryPath + "/" + programName + ".wasm"

            // check if there is an initialized module already
            this._wasmModules.forEach(moduleObj => {
                if(moduleObj.name == programName) wasmModule = moduleObj.module
            })

            // if a module was found -> resolve
            if(wasmModule instanceof WebAssembly.Module) resolve(wasmModule)

            else // if none is found -> initialize a new one

                // load wasm module from server
                fetch(wasmModuleURL).then(response => {
                    if(response.ok) return response.arrayBuffer()
                    else return Promise.reject("module not found: " + wasmModuleURL)  })

                // compile fetched bytes into wasm module
                .then(bytes => WebAssembly.compile(bytes)).then(module => {

                    // store initialized module in this._wasmModules
                    this._wasmModules.push({ name: programName, module: module })
                    resolve(module) // resolve continues execution
                })

                // handle errors
                .catch(e => reject(e))

        })
    }


    /* worker execution flow */

    _initWorker() {
        this._worker = new Promise(async resolve => {

            // init buffers for pausing worker and passing stdin values
            this._pauseBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 1)) // 1 bit to shift
            this._stdinBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 1000)) // 1000 chars buffer

            // create blob including webworker and its dependencies
            let blob = new Blob([EmscrWasmExecutable, EmscrWasmWebWorker,
                "EmscrWasmWebWorker.expose()"], { type: "application/javascript" })

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
        this._initWorker()
        this._resolveRunCommand()
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

            if(!message) { // worker might pass a message

                // otherwise -> use last line from output buffer
                message = this._outputBuffer.split(/\r?\n/g).pop()

                this._xterm.write("\r\x1B[K") // clear last line
                this._outputBuffer = "" // reset for further lines
            }

            // read new line of input
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

        // console.log("_stdout", `"${value}"`)

        // avoid offsets with line breaks
        value = value.replace("\n", "\r\n")

        // buffer and store time
        this._outputBuffer += value
        this._lastOutputTime = Date.now()

        // write to terminal
        this._xterm.write(value)
    }

    _stderr = this._stdout

    async _printWelcomeMessage() {
        this._xterm.write(`\x1b[1;32m
╔═╗┌┬┐┌─┐┌─┐┬─┐  ╦ ╦┌─┐┌─┐┌┬┐  ╔╦╗┌─┐┬─┐┌┬┐\r
║╣ │││└─┐│  ├┬┘  ║║║├─┤└─┐│││   ║ ├┤ ├┬┘│││\r
╚═╝┴ ┴└─┘└─┘┴└─  ╚╩╝┴ ┴└─┘┴ ┴   ╩ └─┘┴└─┴ ┴\r
            \x1b[37m\r\n`)
        this._xterm.write("Commands: " + [...this._commands]
            .map(commandObj => commandObj[0]).sort().join(", ") + "\r\n\r\n")
    }

    _onXtermData(data) {

        if(data == "\x03") { // custom handler for Ctrl+C (webworker only)
            if(this._worker) {
                this._stdout("^C\r\n")
                this._suppressOutputs = true
                this._terminateWorker()
            }
        }

    }

}

export default EmscrWasmController
