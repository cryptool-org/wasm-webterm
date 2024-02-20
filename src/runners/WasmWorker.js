import { expose } from "comlink"
import WasmRunner from "./WasmRunner"

class WasmWorker extends WasmRunner {
  #pauseBuffer
  #stdinBuffer

  constructor(pauseBuffer, stdinBuffer) {
    super()
    // buffers can be accessed both from the main thread and the worker
    this.#pauseBuffer = pauseBuffer // used to pause/resume worker execution
    this.#stdinBuffer = stdinBuffer // used to pass user inputs to worker
  }

  // note: running commands is handled by parent class

  /* pausing and resuming */

  pauseExecution() {
    console.log("pausing worker execution")
    Atomics.store(this.#pauseBuffer, 0, 1) // mem[0] = 1 (means hold)
    Atomics.wait(this.#pauseBuffer, 0, 1) // wait while value is 1
    console.log("resuming worker execution")
  }

  resumeExecution() {
    console.log("resuming worker execution")
    Atomics.store(this.#pauseBuffer, 0, 0) // mem[0] = 0 (means do not hold)
    // note: this method is just for completeness (the worker will be
    // resumed from outside by changing the pause buffer value)
  }

  /* input output handling */

  #readStdinBuffer(index = null) {
    // null = read all
    if (index != null) return Atomics.load(this.#stdinBuffer, index)
    let result = []
    for (let i = 0; i < this.#stdinBuffer.length; i++) {
      const value = Atomics.load(this.#stdinBuffer, i)
      if (value === 0) break // 0 marks end of input
      result.push(value)
    }
    return result
  }

  // handles stdin calls from emscr (pause -> call stdin proxy -> deliver)
  _onEmscrStdinCall(tty, stdinProxy, stdoutProxy, stderrProxy) {
    if (tty.input.length == 0) {
      // read input (will set stdin buffer)
      stdinProxy(this.outputBuffer.split(/\r?\n/g).pop())
      this.pauseExecution() // resumes after input

      // copy stdin buffer to tty input
      tty.input = this.#readStdinBuffer()
      this.outputBuffer += tty.input.map((c) => String.fromCharCode(c)).join("")

      if (tty.input.length == 0) return null
      else tty.input.push(null) // marks end
    }

    // deliver input
    return tty.input.shift()
  }

  // handles stdin calls from wasmer
  _onWasmerStdinCall(stdinBuffer, stdinProxy, stdoutProxy, stderrProxy) {
    // second read means end of string
    if (this._wasmerStdinCallCounter % 2 !== 0) {
      this._wasmerStdinCallCounter++
      return 0
    }

    // read input (will set stdin buffer)
    stdinProxy(this.outputBuffer.split(/\r?\n/g).pop())
    this.pauseExecution() // resumes after input

    // copy stdin buffer to stdinBuffer
    const _stdinBuffer = this.#readStdinBuffer()
    _stdinBuffer.forEach((char, i) => (stdinBuffer[i] = char))
    this.outputBuffer += _stdinBuffer
      .map((c) => String.fromCharCode(c))
      .join("")

    // indicate we've read once
    this._wasmerStdinCallCounter++

    // return how much to read
    return _stdinBuffer.length
  }

  /* expose (sets up comlink communication) */

  static expose() {
    expose(WasmWorker)
  }

  static isWorkerScope() {
    // checks if script is executed in worker or main thread
    return (
      typeof WorkerGlobalScope != "undefined" &&
      self instanceof WorkerGlobalScope
    )
  }
}

// if this runs in worker scope -> expose
if (WasmWorker.isWorkerScope()) WasmWorker.expose()

export default WasmWorker
