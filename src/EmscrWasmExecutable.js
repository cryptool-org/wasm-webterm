class EmscrWasmExecutable {

    /* method wrapper class for emscr wasm modules.
    loads emscripten js runtime and can execute wasm. */

    programName
    wasmModule

    _emscrJsRuntime

    constructor(programName, wasmModule, onJsRuntimeInit, emscrJsRuntimePath) { // todo: jsRuntimeModuleName

        this.programName = programName
        this.wasmModule = wasmModule

        this._loadEmscrJsRuntime(onJsRuntimeInit, emscrJsRuntimePath)
        // todo? setTimeout(() => { this._loadEmscrJsRuntime(onJsRuntimeInit) }, 1)

    }

    /**
     * Executes given arguments (argv) on wasm module.
     * onCommandFinished is called even if there are errors during execution.
     *
     * if stdinPreset (string) is set, it will be delivered instead of reading stdin
     * from terminal (this feature is used for piping and running headless commands)
     */
    run(argv, stdin, stdout, stderr, files, onFinish, onError, onSuccess, stdinPreset) {

        console.log("emscr executable run:", this.programName, argv)

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
                    flush: tty => tty.output = []
                })
                emscrModule.TTY.register(emscrModule.FS.makedev(6, 0), {
                    get_char: tty => stdin(tty),
                    put_char: (tty, val) => { tty.output.push(val); stderr(val) },
                    flush: tty => tty.output = []
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
            this._writeFilesToWasmFS(instance, files)

            // execute command
            instance.callMain(argv)

            // read created files from wasm
            filesPostRun = this._readFilesFromWasmFS(instance)

            // success callback
            onSuccess(filesPostRun)

        }).catch(error => onError(error)).finally(() => onFinish(filesPostRun))

    }

    /**
     * Executes a command without command line input/output.
     * It runs the command and returns all outputs in onSuccess.
     *
     * --> only supports commands that do not ask for CLI input
     * --> stdin can be preset by passing string as stdinPreset
     */
    runHeadless(argv, files, onFinish, onError, onSuccess, stdinPreset) {

        console.log("emscr executable run headless:", this.programName, argv)

        // initialize default callbacks
        if(typeof onFinish  != "function") onFinish  = () => {}
        if(typeof onError   != "function") onError   = (e) => { console.error(e) }
        if(typeof onSuccess != "function") onSuccess = () => {}

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

    _readFilesFromWasmFS(instance, directory = "/", includeBinary = true, filesToIgnore = []) {
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

    _writeFilesToWasmFS(instance, files = []) {
        files.forEach(file => {
            try {
                if(file.bytes instanceof Uint8Array) {
                    // console.log("writing file:", file)
                    instance.FS.writeFile(file.name, file.bytes)
                }
            }
            catch(e) { console.error(e.name + ": " + e.message) }
        })
    }


    /* internal methods */

    // loads emscripten javascript runtime environment
    _loadEmscrJsRuntime(onJsRuntimeInit, emscrJsRuntimePath = "bin") {

        const emscrJSRuntimeURL = emscrJsRuntimePath + "/" + this.programName + ".js"
        const emscrJsModuleName = "EmscrJsRE_" + this.programName

        if(typeof onJsRuntimeInit != "function") onJsRuntimeInit = () => {}

        // try worker import
        if(this._isWorkerScope()) {
            importScripts(emscrJSRuntimeURL)
            this._emscrJsRuntime = self[emscrJsModuleName] || self["_createPyodideModule"]
            setTimeout(onJsRuntimeInit, 1) // todo: vllt ne bessere lösung als den timeout finden?
        }

        // check if is in normal browser dom
        else if(typeof document != "undefined") {
            let script = document.createElement("script")
            script.type = "text/javascript"
            script.onload = () => {
                this._emscrJsRuntime = window[emscrJsModuleName]
                setTimeout(onJsRuntimeInit, 1) // todo: vllt ne bessere lösung als den timeout finden?
            }
            script.src = emscrJSRuntimeURL
            document.head.appendChild(script)
        }

        else throw new Error("can not load emscr js runtime environment")

    }

    _isWorkerScope() { // checks if script is executed in worker or main thread
        return (typeof WorkerGlobalScope != "undefined" && self instanceof WorkerGlobalScope)
    }

}

export default EmscrWasmExecutable
