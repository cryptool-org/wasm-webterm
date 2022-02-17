// import * as Comlink from "comlink"
// import EmscrWasmExecutable from "./EmscrWasmExecutable"

class EmscrWasmWebWorker {

    _pauseBuffer
    _stdinBuffer

    constructor(pauseBuffer, stdinBuffer) {

        // buffers can be accessed both from the main thread and the worker
        this._pauseBuffer = pauseBuffer // used to pause/resume worker execution
        this._stdinBuffer = stdinBuffer // used to pass user inputs to worker

    }


    /* running commands */

    runCommand(programName, wasmModule, argv, stdinProxy, stdoutProxy, stderrProxy,
        files, onFinish, onError, onSuccess, stdinPreset, emscrJsRuntimePath) {

        // initialize default callbacks
        if(typeof onFinish  != "function") onFinish  = () => {}
        if(typeof onError   != "function") onError   = (e) => { console.error(e) }
        if(typeof onSuccess != "function") onSuccess = () => {}

        // instantiate new emscr executable
        console.log("web worker creates new emscr executable")
        let emscrWasmExe = new EmscrWasmExecutable(programName, wasmModule, () => {

            // pipe stdin calls through stdin handler (which pauses worker)
            const stdinHandler = (tty) => this._onStdinCall(tty, stdinProxy)

            // run command on it
            // console.log("web worker delegates command to emscr executable:", programName, argv)
            emscrWasmExe.run(argv, stdinHandler, stdoutProxy, stderrProxy, files, onFinish, onError, onSuccess, stdinPreset)

        }, emscrJsRuntimePath)

    }

    runCommandHeadless(programName, wasmModule, argv, files, onFinish,
        onError, onSuccess, stdinPreset, emscrJsRuntimePath) {

        // initialize default callbacks
        if(typeof onFinish  != "function") onFinish  = () => {}
        if(typeof onError   != "function") onError   = (e) => { console.error(e) }
        if(typeof onSuccess != "function") onSuccess = () => {}

        // instantiate new emscr executable
        console.log("web worker creates new emscr executable")
        let emscrWasmExe = new EmscrWasmExecutable(programName, wasmModule, () => {

            // run command on it
            // console.log("web worker delegates headless command to emscr executable:", programName, argv)
            emscrWasmExe.runHeadless(argv, files, onFinish, onError, onSuccess, stdinPreset)

        }, emscrJsRuntimePath)

    }


    /* pausing and resuming */

    pauseExecution() {
        console.log("pausing worker execution")
        Atomics.store(this._pauseBuffer, 0, 1) // mem[0] = 1 (means hold)
        Atomics.wait(this._pauseBuffer, 0, 1) // wait while value is 1
        console.log("resuming worker execution")
    }

    resumeExecution() {
        console.log("resuming worker execution")
        Atomics.store(this._pauseBuffer, 0, 0) // mem[0] = 0 (means do not hold)
        // note: this method is just for completeness (the worker will be
        // resumed from outside by changing the pause buffer value)
    }


    /* input output handling */

    _readStdinBuffer(index = null) { // null = read all
        if(index != null) return Atomics.load(this._stdinBuffer, index)
        let result = []
        for(let i = 0; i < this._stdinBuffer.length; i++) {
            const value = Atomics.load(this._stdinBuffer, i)
            if(value === 0) break // 0 marks end of input
            result.push(value)
        }
        return result
    }

    // handles stdin calls from wasm (pause -> call stdin proxy -> deliver)
    _onStdinCall(tty, stdinProxy) { // tty is passed by emscr js runtime

        // read input
        if(tty.input.length == 0) {
            stdinProxy() // will set stdin buffer
            this.pauseExecution() // resumes after input

            // copy stdin buffer to tty input
            tty.input = this._readStdinBuffer()

            if(tty.input.length == 0) return null
            else tty.input.push(null) // marks end
        }

        // deliver input
        return tty.input.shift()
    }


    /* expose (sets up comlink communication) */

    static expose() {
        if(typeof Comlink == "undefined" /* todo: && is worker scope */)
            importScripts("https://cdn.jsdelivr.net/npm/comlink@4.3.1/dist/umd/comlink.min.js")
        Comlink.expose(EmscrWasmWebWorker)
    }

}

// if this runs in worker scope -> expose
// if(typeof WorkerGlobalScope != "undefined"
//     && self instanceof WorkerGlobalScope)
//         EmscrWasmWebWorker.expose()

export default EmscrWasmWebWorker
