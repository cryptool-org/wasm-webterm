class EmscrWasmRunnable {

    /* method wrapper class for emscr wasm modules.
    loads emscripten js runtime and can execute wasm. */

    programName
    wasmModule

    _emscrJsRuntime

    constructor(programName, wasmModule, jsRuntime) {
        this.programName = programName
        this.wasmModule = wasmModule
        this._loadEmscrJsRuntime(jsRuntime)
    }

    /**
     * Executes given arguments (argv) on wasm module.
     * onFinish is called even if there are errors during execution.
     *
     * if stdinPreset (string) is set, it will be delivered instead of reading stdin
     * from terminal (this feature is used for piping and running headless commands)
     */
    run(argv, stdin, stdout, stderr, files, onFinish, onError, onSuccess, stdinPreset) {

        console.log("emscr runnable run:", this.programName, argv)

        // initialize default methods and values
        if(typeof stdin  != "function") stdin  = () => {}
        if(typeof stdout != "function") stdout = () => {}
        if(typeof stderr != "function") stderr = () => {}
        if(!(files instanceof Array)) files = []

        // initialize default callbacks
        if(typeof onFinish  != "function") onFinish  = () => {}
        if(typeof onError   != "function") onError   = (e) => { console.error(e) }
        if(typeof onSuccess != "function") onSuccess = () => {}

        // define emscr module
        let emscrModule = {
            thisProgramm: this.programName,
            instantiateWasm: (imports, callback) => {
                WebAssembly.instantiate(this.wasmModule, imports)
                    .then(instance => callback(instance, this.wasmModule))
                return {}
            },
            preInit: [() => {
                emscrModule.TTY.register(emscrModule.FS.makedev(5, 0), {
                    get_char: tty => stdin(tty),
                    put_char: (tty, val) => { tty.output.push(val); stdout(val) },
                    flush: tty => tty.output = [],
                    fsync: tty => console.log("fsynced stdout (EmscriptenRunnable does nothing in this case)")
                })
                emscrModule.TTY.register(emscrModule.FS.makedev(6, 0), {
                    get_char: tty => stdin(tty),
                    put_char: (tty, val) => { tty.output.push(val); stderr(val) },
                    flush: tty => tty.output = [],
                    fsync: tty => console.log("fsynced stderr (EmscriptenRunnable does nothing in this case)")
                })
            }]
        }

        if(stdinPreset) { // with stdinPreset you can preset a value for stdin

            if(typeof stdinPreset != "string") stdinPreset = (stdinPreset || "").toString()
            if(!stdinPreset.endsWith("\n")) stdinPreset += "\n" // must end with \n

            let stdinIndex = 0
            emscrModule.stdin = () => {
                if(stdinIndex < stdinPreset.length)
                    return stdinPreset.charCodeAt(stdinIndex++)
                return null
            }

        }

        let filesPostRun // instantiate emscripten module and call main
        this._emscrJsRuntime(emscrModule).then(instance => { // emscr module instance

            // write submitted files to wasm
            this._writeFilesToFS(instance, files)

            // execute command
            instance.callMain(argv)

            // read created files from wasm
            filesPostRun = this._readFilesFromFS(instance)

            // success callback
            onSuccess(filesPostRun)

        })

        .catch(error => onError(error))
        .finally(() => onFinish(filesPostRun || files))

    }

    /**
     * Executes a command without command line input/output.
     * It runs the command and returns all outputs in onFinish.
     *
     * --> only supports commands that do not ask for CLI input
     * --> stdin can be preset by passing string as stdinPreset
     */
    runHeadless(argv, files, onFinish, onError, onSuccess, stdinPreset) {

        console.log("emscr runnable run headless:", this.programName, argv)

        // initialize default callback
        if(typeof onFinish  != "function") onFinish  = () => {}

        // stdin is not needed
        const stdin = () => { console.log("called runHeadless stdin") }

        // output is redirected into buffer
        let outputBuffer = "", stdoutBuffer = "", stderrBuffer = ""
        const stdout = (val) => { outputBuffer += String.fromCharCode(val); stdoutBuffer += String.fromCharCode(val) }
        const stderr = (val) => { outputBuffer += String.fromCharCode(val); stderrBuffer += String.fromCharCode(val) }

        // run command with custom input/output
        this.run(argv, stdin, stdout, stderr, files, () => onFinish({
            output: outputBuffer, stdout: stdoutBuffer, stderr: stderrBuffer
        }), onError, onSuccess, stdinPreset)

    }


    /* file handling */

    _readFilesFromFS(instance, directory = "/", includeBinary = true, filesToIgnore = []) {
        const path = instance.FS.lookupPath(directory)
        const getFilesFromNode = (parentNode) => { let files = []
            Object.values(parentNode.contents).forEach(node => {
                let nodePath = instance.FS.getPath(node)
                if(instance.FS.isFile(node.mode))
                    files.push({
                        name: nodePath,
                        timestamp: node.timestamp,
                        bytes: includeBinary ? instance.FS.readFile(nodePath) : new Uint8Array()
                    })
                if(instance.FS.isDir(node.mode))
                    files = [...files, ...getFilesFromNode(node)]
            })
            return files
        }
        let files = getFilesFromNode(path.node)
        if(filesToIgnore.length > 0) files = files.filter(file => {
            return filesToIgnore.some(ignofile => ignofile.name != file.name)
        })
        return files
    }

    _writeFilesToFS(instance, files = []) {
        files.forEach(file => {
            try {
                if(file.bytes instanceof Uint8Array)
                    instance.FS.writeFile(file.name, file.bytes)
            }
            catch(e) { console.error(e.name + ": " + e.message) }
        })
    }


    /* internal methods */

    _loadEmscrJsRuntime(jsRuntime) {

        const emscrJsModuleName = "EmscrJSR_" + this.programName

        // try worker import
        if(this._isWorkerScope()) {

            // import js runtime
            let blob = new Blob([jsRuntime], { type: "application/javascript" })
            importScripts(URL.createObjectURL(blob))

            console.log(jsRuntime, blob)

            // read emscripten Module from js runtime
            this._emscrJsRuntime = self[emscrJsModuleName] || self["_createPyodideModule"]
            // todo: find better solution for module names
        }

        // check if is in normal browser dom
        else if(typeof document != "undefined") {

            const jsRuntimeElemID = this.programName + "_emscrJSR"

            // inject js runtime if not done before
            if(!document.getElementById(jsRuntimeElemID)) {

                // create new script element for runtime
                let script = document.createElement("script")
                script.type = "text/javascript"; script.id = jsRuntimeElemID

                // insert js runtime script into DOM
                script.innerHTML = new TextDecoder("utf-8").decode(jsRuntime)
                document.head.appendChild(script)
            }

            // read emscripten Module from js runtime
            this._emscrJsRuntime = window[emscrJsModuleName]
        }

        else throw new Error("can not load emscr js runtime environment")

    }

    _isWorkerScope() { // checks if script is executed in worker or main thread
        return (typeof WorkerGlobalScope != "undefined" && self instanceof WorkerGlobalScope)
    }

}

export default EmscrWasmRunnable
