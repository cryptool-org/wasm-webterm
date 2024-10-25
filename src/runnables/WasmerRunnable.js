import { WASI } from "@wasmer/wasi"
import browserBindings from "@wasmer/wasi/lib/bindings/browser"
import { WasmFs } from "@wasmer/wasmfs"

const S_IFCHR = 8192 // magic constant from memFS

class WasmerRunnable {
  /* method wrapper class for wasmer wasm modules.
    initializes memory filesystem and can execute wasm. */

  programName
  wasmModule

  constructor(programName, wasmModule) {
    this.programName = programName
    this.wasmModule = wasmModule
  }

  run(
    argv,
    stdin,
    stdout,
    stderr,
    files,
    onFinish,
    onError,
    onSuccess,
    stdinPreset
  ) {
    console.log("wasmer runnable run:", this.programName, argv)

    // initialize default methods and values
    if (typeof stdin != "function") stdin = () => {}
    if (typeof stdout != "function") stdout = () => {}
    if (typeof stderr != "function") stderr = () => {}
    if (!(files instanceof Array)) files = []

    // initialize default callbacks
    if (typeof onFinish != "function") onFinish = () => {}
    if (typeof onError != "function")
      onError = (e) => {
        console.error(e)
      }
    if (typeof onSuccess != "function") onSuccess = () => {}

    // init new memory filesystem
    const wasmFs = new WasmFs()

    // write all files to wasmfs
    this._writeFilesToFS(wasmFs, files)

    // set /dev/stdin to stdin function
    wasmFs.volume.fds[0].node.read = stdin

    if (stdinPreset) {
      // with stdinPreset you can preset a value for stdin

      if (typeof stdinPreset != "string")
        stdinPreset = (stdinPreset || "").toString()

      let stdinCallCounter = 0
      wasmFs.volume.fds[0].node.read = (stdinBuffer) => {
        // second read means end of string
        if (stdinCallCounter % 2 !== 0) {
          stdinCallCounter++
          return 0
        }

        // copy stdin preset to stdinBuffer
        for (let i = 0; i < stdinPreset.length; i++)
          stdinBuffer[i] = stdinPreset.charCodeAt(i)

        // indicate we've read once
        stdinCallCounter++

        // return how much to read
        return stdinPreset.length
      }
    }

    // set /dev/stdout to stdout function
    wasmFs.volume.fds[1].node.write = (
      stdoutBuffer,
      offset,
      length,
      position
    ) => {
      stdout(new TextDecoder("utf-8").decode(stdoutBuffer))
      return stdoutBuffer.length
    }

    // set /dev/stderr to stderr function
    wasmFs.volume.fds[2].node.write = (
      stderrBuffer,
      offset,
      length,
      position
    ) => {
      stderr(new TextDecoder("utf-8").decode(stderrBuffer))
      return stderrBuffer.length
    }

    // map /dev/tty to /dev/stdin and /dev/stdout
    const ttyFd = wasmFs.volume.openSync("/dev/tty", "w+")
    wasmFs.volume.fds[ttyFd].node.read = wasmFs.volume.fds[0].node.read
    wasmFs.volume.fds[ttyFd].node.write = wasmFs.volume.fds[1].node.write

    // mark /dev/{stdin,stdout,stderr,tty} as character devices
    wasmFs.volume.fds[0].node.setModeProperty(S_IFCHR)
    wasmFs.volume.fds[1].node.setModeProperty(S_IFCHR)
    wasmFs.volume.fds[2].node.setModeProperty(S_IFCHR)
    wasmFs.volume.fds[ttyFd].node.setModeProperty(S_IFCHR)

    // create wasi runtime
    let wasi = new WASI({
      args: [this.programName, ...argv],
      env: {}, // todo: maybe use environment variables?
      bindings: {
        ...browserBindings,
        fs: wasmFs.fs,
      },
      preopens: {
        ".": ".",
        "/": "/",
      },
    })

    // instantiate wasm module
    const imports = wasi.getImports(this.wasmModule) // WebAssembly.Module.imports(this.wasmModule)
    WebAssembly.instantiate(this.wasmModule, { ...imports }).then(
      (instance) => {
        let filesPostRun
        try {
          // write submitted files to wasm
          this._writeFilesToFS(wasmFs, files)

          // execute command
          try {
            wasi.start(instance)
          } catch (e) {
            // make browserBindings not throw on code 0 (normal exit)
            if (e.code != 0) browserBindings.exit(e.code)
          }

          // read created files from wasm
          filesPostRun = this._readFilesFromFS(wasmFs)

          // success callback
          onSuccess(filesPostRun)
        } catch (e) {
          onError(e.message)
        } finally {
          onFinish(filesPostRun || files)
        }
      }
    )
  }

  runHeadless(argv, files, onFinish, onError, onSuccess, stdinPreset) {
    console.log("wasmer runnable run headless:", this.programName, argv)

    // initialize default callback
    if (typeof onFinish != "function") onFinish = () => {}

    // stdin is not needed
    const stdin = () => {
      console.log("called runHeadless stdin")
      return 0
    }

    // output is redirected into buffer
    let outputBuffer = "",
      stdoutBuffer = "",
      stderrBuffer = ""
    const stdout = (stdoutVal) => {
      outputBuffer += stdoutVal
      stdoutBuffer += stdoutVal
      return stdoutVal.length
    }
    const stderr = (stderrVal) => {
      outputBuffer += stderrVal
      stderrBuffer += stderrVal
      return stderrVal.length
    }

    // run command with custom input/output
    this.run(
      argv,
      stdin,
      stdout,
      stderr,
      files,
      () =>
        onFinish({
          output: outputBuffer,
          stdout: stdoutBuffer,
          stderr: stderrBuffer,
        }),
      onError,
      onSuccess,
      stdinPreset
    )
  }

  /* file handling */

  _readFilesFromFS(wasmFs, directory = "/", includeBinary = true) {
    const rootLink = wasmFs.volume.getLinkAsDirOrThrow(directory)

    const getFilesFromLink = (parentLink) => {
      let files = []
      Object.values(parentLink.children).forEach((link) => {
        let linkPath = link.getPath()
        let node = link.getNode()
        if (node.isFile())
          files.push({
            name: linkPath,
            timestamp: node.mtime.getTime(),
            bytes: includeBinary
              ? wasmFs.fs.readFileSync(linkPath)
              : new Uint8Array(),
          })
        if (node.isDirectory()) files = [...files, ...getFilesFromLink(link)]
      })
      return files
    }

    let files = getFilesFromLink(rootLink)
    return files
  }

  _writeFilesToFS(wasmFs, files = []) {
    files.forEach((file) => {
      try {
        if (file.bytes instanceof Uint8Array) {
          const path = file.name.split("/").slice(0, -1).join("/")
          wasmFs.fs.mkdirSync(path, { recursive: true })
          wasmFs.fs.writeFileSync(file.name, file.bytes)

          if (file.timestamp instanceof Date)
            wasmFs.fs.utimesSync(file.name, file.timestamp, file.timestamp)
          else if (typeof file.timestamp === "number")
            wasmFs.fs.utimesSync(
              file.name,
              file.timestamp / 1000,
              file.timestamp / 1000
            )
        }
      } catch (e) {
        console.error(e.name + ": " + e.message)
      }
    })
  }
}

export default WasmerRunnable
