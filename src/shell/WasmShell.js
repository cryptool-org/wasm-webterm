import { isIncompleteInput } from "./shell-utils"
import WasmTTY from "./WasmTTY"

/**
 * WASM Shell interface
 *
 * A shell is an interactive command-line interface to start other programs.
 * Its purpose is to handle:
 * - Interpret tty input to launch processes
 *   - parameter handling
 *   - job control, chaining
 * - Handle Control Sequences (job control and line editing)
 * - Output text to the tty
 */
class WasmShell {
  _tty

  prompt

  _activePrompt
  _isActive

  constructor() {
    this.prompt = this._defaultPrompt.bind(this) // default prompt

    this._isActive = false // start in disabled mode
  }

  activate(xterm) {
    this._tty = new WasmTTY() // internal tty device

    // activate the tty device
    this._tty.activate(xterm)

    // register data input handler
    xterm.onData((data) => this.handleDataInput(data))
  }

  /** Main read-eval-print-loop */
  async repl() {
    // do nothing if already running
    if (this._activePrompt) return

    try {
      // read line from tty
      const prompt = await this.prompt()

      if (prompt instanceof Array) {
        this._activePrompt = this._tty.read(prompt[0], prompt[1])
      } else {
        this._activePrompt = this._tty.read(prompt)
      }
      this._isActive = true

      let line = await this._activePrompt.promise

      // empty input -> prompt again
      if (line.trim() === "") {
        setTimeout(() => this.repl())
        return
      }

      // give user possibility to exec sth before run
      //await this.onBeforeCommandRun()

      this._tty.println(`Execute command: \`${line}\``)

      // eval and print
      //await this.runLine(line)

      // print extra newline if outputs does not end with one
      //if (this._outputBuffer.slice(-1) != "\n") this._xterm.write("\u23CE\r\n")

      // print newline after
      //this._xterm.write("\r\n")

      // give user possibility to run sth after exec
      //await this.onCommandRunFinish()

      // loop again
      setTimeout(() => this.repl())
    } catch (e) {
      this._tty.println(
        `\x1b[1m[\x1b[31mWasmWebTerm\x1b[39m]\x1b[0m ${e.toString()}`
      )
      setTimeout(() => this.repl())
    }
  }

  /** The default prompt */
  async _defaultPrompt() {
    return ["$ ", "> "]
  }

  /* ======== COMMAND EXECUTION ======== */

  _handleReadComplete() {
    if (this._activePrompt?.resolve) {
      // resolve the pending prompt with the current input
      this._activePrompt.resolve(this._tty.input)
      this._activePrompt = undefined
    }

    // print terminating newline
    this._tty.print("\r\n")
    this._isActive = false
  }

  /* ======== INPUT HANDLING ======== */

  /** Move cursor in specified direction */
  _handleCursorMove(direction) {
    if (direction > 0) {
      // move at most to the end of the current input
      const columns = Math.min(
        direction,
        this._tty.input.length - this._tty.cursor
      )
      this._tty.moveCursorTo(this._tty.cursor + columns)
    } else if (direction < 0) {
      // move at most to the beginning of the input
      const columns = Math.max(direction, -this._tty.cursor)
      this._tty.moveCursorTo(this._tty.cursor + columns)
    }
  }

  /** Insert data at current cursor position */
  _handleCursorInsert(data) {
    // insert data into old input at current cursor position
    const newInput =
      this._tty.input.substring(0, this._tty.cursor) +
      data +
      this._tty.input.substring(this._tty.cursor)

    // move cursor after the inserted data and set new input
    this._tty.moveCursorTo(this._tty.cursor + data.length)
    this._tty.input = newInput
  }

  _handleCursorErase(backspace = true) {
    if (backspace) {
      if (this._tty.cursor <= 0) return

      // remove character at the cursor position
      const newInput =
        this._tty.input.substring(0, this._tty.cursor - 1) +
        this._tty.input.substring(this._tty.cursor)
      // move cursor back by one position
      const newCursor = this._tty.cursor - 1

      this._tty.input = newInput
      this._tty.cursor = newCursor
    } else {
      if (this._tty.cursor >= this._tty.input.length) return

      // remove character behind the cursor position
      const newInput =
        this._tty.input.substring(0, this._tty.cursor) +
        this._tty.input.substring(this._tty.cursor + 1)

      this._tty.input = newInput
    }
  }

  /** Handle a single logical tty input (key-press, escape-sequence, ...) */
  _handleData(data) {
    const ord = data.charCodeAt(0)

    // handle ANSI escape sequences
    if (ord === 0x1b) {
      // escape character `^[`
      console.debug("Escape Sequence:", data.substring(1))

      switch (data.substring(1)) {
        // History
        case "[A": // Arrow Up
          // TODO: retrieve previous history item
          break
        case "[B": // Arrow Down
          // TODO: retrieve next history item
          break

        // Navigation
        case "[D": // Arrow Left
          this._handleCursorMove(-1)
          break
        case "[C": // Arrow Right
          this._handleCursorMove(1)
          break
        case "[H": // Home
          this._tty.cursor = 0
          break
        case "[F": // End
          this._tty.cursor = this._tty.input.length
          break

        // Other
        case "[3~": // Delete
          this._handleCursorErase(false)
      }
    }

    // handle special characters
    else if (ord < 0x20 || ord === 0x7f) {
      // below 0x20 (+ 0x7f) are control characters
      console.debug("Control Character:", ord, data)

      switch (data) {
        case "\x03": // CTRL + C
          this._tty.input = ""
          break
        case "\r": // Enter
        case "\x0a": // CTRL + J
        case "\x0d": // CTRL + M
          if (isIncompleteInput(this._tty.input)) {
            this._handleCursorInsert("\n")
          } else {
            this._handleReadComplete()
          }
          break

        case "\t": // Tab
          // TODO: Handle autocomplete
          break

        case "\x01": // CTRL + A
          this._tty.cursor = 0
          break
        case "\x05": // CTRL + E
          this._tty.cursor = this._tty.input.length
          break
        case "\x02": // CTRL + B
          this._handleCursorMove(-1)
          break
        case "\x06": // CTRL + F
          this._handleCursorMove(1)
          break

        case "\x7f": // Backspace
        case "\x08": // CTRL + H
        case "\x04": // CTRL + D
          this._handleCursorErase(true)
          break

        case "\x0c": // CTRL + L
          this._tty.clearTty()
          break
      }
    }

    // handle standard printable characters
    else this._handleCursorInsert(data)
  }

  /** Handle input events comming from the terminal */
  handleDataInput(data) {
    // Only pass CTRL + C when not active
    if (!this._isActive && data !== "\x03") return

    this._handleData(data)
  }
}

export default WasmShell
