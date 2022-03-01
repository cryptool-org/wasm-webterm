import EmscrWasmRunnable from "../runnables/EmscriptenRunnable"
import WasmerRunnable from "../runnables/WasmerRunnable"

/* executes wasm on the main thread. asks for stdin by using prompts.
this class will be extented by WasmWorker to run on worker thread. */

class WasmRunner {

    outputBuffer

    constructor() { this.outputBuffer = "" }

    runCommand(programName, wasmModule, wasmModuleType, argv, stdinProxy, stdoutProxy,
        stderrProxy, files, onFinish, onError, onSuccess, stdinPreset, emscrJsRuntime) {

        // initialize default callbacks
        if(typeof onFinish  != "function") onFinish  = () => {}
        if(typeof onError   != "function") onError   = (e) => { console.error(e) }
        if(typeof onSuccess != "function") onSuccess = () => {}

        // store outputs of stdout in buffer (for stdin prompts)
        const bufferOutputs = (value) => { this.outputBuffer += (typeof value == "number") ? String.fromCharCode(value) : value }
        const stdoutHandler = (value) => { bufferOutputs(value); return stdoutProxy(value) }
        const stderrHandler = (value) => { bufferOutputs(value); return stderrProxy(value) }

        if(wasmModuleType == "emscripten") {

            // instantiate new emscr runnable
            console.log("wasm runner creates new emscr runnable")
            let emscrWasmExe = new EmscrWasmRunnable(programName, wasmModule, emscrJsRuntime)

            // pipe stdin calls through stdin handler (which pauses thread)
            const stdinHandler = (tty) => this._onEmscrStdinCall(tty, stdinProxy, stdoutHandler, stderrHandler)

            // run command on it
            emscrWasmExe.run(argv, stdinHandler, stdoutHandler, stderrHandler, files, onFinish, onError, onSuccess, stdinPreset)
        }

        else if(wasmModuleType == "wasmer") {

            // instantiate new wasmer runnable
            console.log("wasm runner creates new wasmer runnable")
            let wasmerExe = new WasmerRunnable(programName, wasmModule)

            // pipe stdin calls through stdin handler (which pauses thread)
            const stdinHandler = (stdinBuffer) => this._onWasmerStdinCall(stdinBuffer, stdinProxy, stdoutHandler, stderrHandler)

            // run command on it
            wasmerExe.run(argv, stdinHandler, stdoutHandler, stderrHandler, files, onFinish, onError, onSuccess, stdinPreset)
        }

        else throw new Error("Unknown wasm module type (can only handle emscripten or wasmer)")

    }

    runCommandHeadless(programName, wasmModule, wasmModuleType, argv,
        files, onFinish, onError, onSuccess, stdinPreset, emscrJsRuntime) {

        // initialize default callbacks
        if(typeof onFinish  != "function") onFinish  = () => {}
        if(typeof onError   != "function") onError   = (e) => { console.error(e) }
        if(typeof onSuccess != "function") onSuccess = () => {}

        if(wasmModuleType == "emscripten") {

            // instantiate new emscr runnable
            console.log("wasm runner creates new emscr runnable")
            let emscrWasmExe = new EmscrWasmRunnable(programName, wasmModule, emscrJsRuntime)

            // run command on it
            emscrWasmExe.runHeadless(argv, files, onFinish, onError, onSuccess, stdinPreset)
        }

        else if(wasmModuleType == "wasmer") {

            // instantiate new wasmer runnable
            let wasmerExe = new WasmerRunnable(programName, wasmModule)

            // run command on it
            wasmerExe.runHeadless(argv, files, onFinish, onError, onSuccess, stdinPreset)
        }

        else throw new Error("Unknown wasm module type (can only handle emscripten or wasmer)")

    }

    // handles stdin calls from emscr (tty is passed by emscr js runtime)
    _onEmscrStdinCall(tty, stdinProxy, stdoutProxy, stderrProxy) {
        if(tty.input.length == 0) {

            // use last line from output buffer as prompt caption
            const promptCaption = this.outputBuffer.split(/\r?\n/g).pop()

            // get input from user via prompt
            const input = window.prompt(promptCaption)

            // if aborted -> end
            if(input == null) return null

            // if input was empty -> prompt again
            // if(input == "") return this._onEmscrStdinCall(tty)

            // print input to terminal
            stdoutProxy(input + "\r\n")

            // copy input value to tty input
            tty.input = (input + "\n").split("").map(char => char.charCodeAt(0))
            tty.input.push(null) // marks end

        }

        // deliver input
        return tty.input.shift()
    }

    // handles stdin calls from wasmer
    _wasmerStdinCallCounter = 0
    _onWasmerStdinCall(stdinBuffer, stdinProxy, stdoutProxy, stderrProxy) {

        // second read means end of string
        if(this._wasmerStdinCallCounter % 2 !== 0) {
            this._wasmerStdinCallCounter++; return 0 }

        // use last line from output buffer as prompt caption
        const promptCaption = this.outputBuffer.split(/\r?\n/g).pop()

        // get input from user via prompt
        const input = window.prompt(promptCaption)

        // if aborted -> end
        if(input == null) return 0

        // print input to terminal
        stdoutProxy(input + "\r\n")

        // copy input value to stdinBuffer
        input.forEach((char, i) => stdinBuffer[i] = char.charCodeAt(0))

        // indicate we've read once
        this._wasmerStdinCallCounter++

        // return how much to read
        return input.length

    }

}

export default WasmRunner
