import { KeyboardInterruptError, CommandParserError } from "../Errors"
import { parseCommands } from "./shell-utils"

import { isIncompleteInput } from "./shell-utils"
import WasmTTY from "./WasmTTY"
import History from "./History"

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
  #tty
  #history

  #execute

  prompt

  #activePrompt
  #isActive
  #inHistory
  #partialInput // input buffer before navigating history

  constructor(executeFn, options) {
    if (typeof executeFn !== "function")
      throw new Error("`executeFn` parameter must be a function")
    this.#execute = executeFn

    // create new command history
    this.#history = new History(options?.historySize ?? 1000)

    this.prompt = this._defaultPrompt.bind(this) // default prompt

    this.#isActive = false // start in disabled mode
    this.#inHistory = false
  }

  activate(xterm) {
    this.#tty = new WasmTTY() // internal tty device

    // activate the tty device
    this.#tty.activate(xterm)

    // register data input handler
    xterm.onData((data) => this.handleDataInput(data))
  }

  dispose() {
    this.#isActive = false

    // stop any pending prompt
    if (this.#activePrompt?.reject) {
      this.#activePrompt.reject("disposed")
      this.#activePrompt = undefined
    }

    // deactivate the tty device
    this.#tty.dispose()
    this.#tty = undefined
  }

  /** Main read-eval-print-loop */
  async repl() {
    // do nothing if already running
    if (this.#activePrompt) return

    try {
      // read line from tty
      const prompt = await this.prompt()

      if (prompt instanceof Array) {
        this.#activePrompt = this.#tty.read(prompt[0], prompt[1])
      } else {
        this.#activePrompt = this.#tty.read(prompt)
      }
      this.#isActive = true

      const line = (await this.#activePrompt.promise).trim()

      // empty input -> prompt again
      if (line === "") {
        setTimeout(() => this.repl())
        return
      }

      // eval
      await this._evalLine(line)

      // loop again
      setTimeout(() => this.repl())
    } catch (e) {
      // break loop when disposed
      if (e === "disposed") return

      // loop again
      setTimeout(() => this.repl())
    }
  }

  /** Evaluate a single line of input (drop any existing input) */
  async injectCommand(input) {
    if (typeof input !== "string")
      throw new TypeError("can only execute strings")
    if (input.trim() === "") return

    let restartRepl = false

    // stop any pending prompt
    if (this.#activePrompt?.reject) {
      this.#activePrompt.reject("disposed")
      this.#activePrompt = undefined
      restartRepl = true
    }

    // set prompt
    this.#tty.input = input
    this._handleReadComplete()
    // evaluate input line
    await this._evalLine(this.#tty.input)

    // restart repl if we stopped it
    if (restartRepl) setTimeout(() => this.repl())
  }

  /** The default prompt */
  async _defaultPrompt() {
    return ["$ ", "> "]
  }

  /** Read line-buffered input from the terminal */
  async readLine(message) {
    return new Promise((resolve) => {
      // read input until RETURN (LF), CTRL+D (EOF), or CTRL+C
      let buffer = ""
      const handler = this.#tty.onData((data) => {
        // CTRL + C -> return without data
        if (data === "\x03") {
          this.#tty.write("^C")
          handler.dispose()
          return resolve("")
        }

        // CTRL + D -> return input buffer
        else if (data === "\x04") {
          handler.dispose()
          return resolve(buffer)
        }

        // map return to '\n'
        if (data === "\r") data = "\n"
        // map backspace to CTRL+H
        else if (data === "\x7f") data = "\x08"

        // add character or delete last one
        if (data === "\x08") buffer = buffer.slice(0, -1)
        else buffer += data

        // line complete -> return the input buffer
        if (data === "\n") {
          // only echo the linebreak when there is no prompt (i.e. we assume multi-line input)
          if (!message) this.#tty.write("\r\n")

          handler.dispose()
          return resolve(buffer)
        }

        // echo input back (special handling for backspace and escape sequences)
        if (data === "\x08") this.#tty.write("^H")
        else if (data.charCodeAt(0) === 0x1b)
          this.#tty.write("^[" + data.slice(1))
        else this.#tty.write(data)
      })
    })
  }

  /* ======== COMMAND EXECUTION ======== */

  _handleReadComplete() {
    // push to history
    this.#history.push(this.#tty.input)
    this.#inHistory = false
    this.#partialInput = undefined

    if (this.#activePrompt?.resolve) {
      // resolve the pending prompt with the current input
      this.#activePrompt.resolve(this.#tty.input)
      this.#activePrompt = undefined
    }

    // print terminating newline
    this.#tty.print("\r\n")
    this.#isActive = false
  }

  async _evalLine(line) {
    try {
      // print extra newline before
      this.#tty.write("\r\n")

      try {
        // eval and print
        const commands = parseCommands(line, this.#tty.println.bind(this.#tty))
        await this.#execute(commands)
      } finally {
        // print extra newline after
        this.#tty.write("\r\n")
      }
    } catch (e) {
      // print error message and run again
      console.error("Error while executing commands:", e)
      if (!(e instanceof KeyboardInterruptError)) {
        this.#tty.println(
          `\x1b[1m[\x1b[31mERROR\x1b[39m]\x1b[0m ${e.toString()}\n`
        )
      }
    }
  }

  /* ======== INPUT HANDLING ======== */

  /** Move cursor in specified direction */
  _handleCursorMove(direction) {
    if (direction > 0) {
      // move at most to the end of the current input
      const columns = Math.min(
        direction,
        this.#tty.input.length - this.#tty.cursor
      )
      this.#tty.moveCursorTo(this.#tty.cursor + columns)
    } else if (direction < 0) {
      // move at most to the beginning of the input
      const columns = Math.max(direction, -this.#tty.cursor)
      this.#tty.moveCursorTo(this.#tty.cursor + columns)
    }
  }

  /** Insert data at current cursor position */
  _handleCursorInsert(data) {
    // insert data into old input at current cursor position
    const newInput =
      this.#tty.input.substring(0, this.#tty.cursor) +
      data +
      this.#tty.input.substring(this.#tty.cursor)

    // move cursor after the inserted data and set new input
    this.#tty.moveCursorTo(this.#tty.cursor + data.length)
    this.#tty.input = newInput
  }

  _handleCursorErase(backspace = true) {
    if (backspace) {
      if (this.#tty.cursor <= 0) return

      // remove character at the cursor position
      const newInput =
        this.#tty.input.substring(0, this.#tty.cursor - 1) +
        this.#tty.input.substring(this.#tty.cursor)
      // move cursor back by one position
      const newCursor = this.#tty.cursor - 1

      this.#tty.input = newInput
      this.#tty.cursor = newCursor
    } else {
      if (this.#tty.cursor >= this.#tty.input.length) return

      // remove character behind the cursor position
      const newInput =
        this.#tty.input.substring(0, this.#tty.cursor) +
        this.#tty.input.substring(this.#tty.cursor + 1)

      this.#tty.input = newInput
    }
  }

  /** Handle a single logical tty input (key-press, escape-sequence, ...) */
  _handleData(data) {
    const ord = data.charCodeAt(0)

    // handle ANSI escape sequences
    if (ord === 0x1b) {
      // escape character `^[`
      switch (data.substring(1)) {
        // History
        case "[A": {
          // Arrow Up
          const value = this.#history.getPrevious()
          if (value) {
            if (!this.#inHistory) {
              // save current input
              this.#inHistory = true
              this.#partialInput = this.#tty.input
            }
            this.#tty.moveCursorTo(value.length)
            this.#tty.input = value
          }
          break
        }
        case "[B": {
          // Arrow Down
          const value = this.#history.getNext()
          if (value) {
            this.#tty.moveCursorTo(value.length)
            this.#tty.input = value
          } else if (this.#inHistory) {
            // reached end of history, restore input buffer
            this.#tty.input = this.#partialInput ?? ""
            this.#tty.cursor = this.#tty.input.length
            this.#inHistory = false
            this.#partialInput = undefined
          }
          break
        }
        case "[5~": {
          // Page Up
          const value = this.#history.getFirst()
          if (value) {
            if (!this.#inHistory) {
              // save current input
              this.#inHistory = true
              this.#partialInput = this.#tty.input
            }
            this.#tty.moveCursorTo(value.length)
            this.#tty.input = value
          }
          break
        }
        case "[6~":
          // Page Down
          if (this.#inHistory) {
            // reached end of history, restore input buffer
            this.#tty.input = this.#partialInput ?? ""
            this.#tty.cursor = this.#tty.input.length
            this.#history.rewind()
            this.#inHistory = false
            this.#partialInput = undefined
          }
          break

        // Navigation
        case "[D": // Arrow Left
          this._handleCursorMove(-1)
          break
        case "[C": // Arrow Right
          this._handleCursorMove(1)
          break
        case "[H": // Home
          this.#tty.cursor = 0
          break
        case "[F": // End
          this.#tty.cursor = this.#tty.input.length
          break

        // Other
        case "[3~": // Delete
          this._handleCursorErase(false)

        default:
          console.debug("Escape Sequence:", data.substring(1))
      }
    }

    // handle special characters
    else if (ord < 0x20 || ord === 0x7f) {
      // below 0x20 (+ 0x7f) are control characters
      switch (data) {
        case "\x03": // CTRL + C
          this.#tty.input = ""
          this.#history.rewind()
          break
        case "\r": // Enter
        case "\x0a": // CTRL + J
        case "\x0d": // CTRL + M
          if (isIncompleteInput(this.#tty.input)) {
            this._handleCursorInsert("\n")
          } else {
            this._handleReadComplete()
          }
          break

        case "\t": // Tab
          // TODO: Handle autocomplete
          break

        case "\x01": // CTRL + A
          this.#tty.cursor = 0
          break
        case "\x05": // CTRL + E
          this.#tty.cursor = this.#tty.input.length
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
          this.#tty.clearTty()
          break

        default:
          console.debug("Control Character:", ord, data)
      }
    }

    // handle standard printable characters
    else this._handleCursorInsert(data)
  }

  /** Handle input events comming from the terminal */
  handleDataInput(data) {
    // Only pass CTRL + C when not active
    if (!this.#isActive && data !== "\x03") return

    this._handleData(data)
  }
}

export default WasmShell
