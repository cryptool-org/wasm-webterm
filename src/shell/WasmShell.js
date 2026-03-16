import parse from "shell-quote/parse"

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

  prompt

  #activePrompt
  #isActive
  #inHistory
  #partialInput // input buffer before navigating history

  constructor(options) {
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

      let line = await this.#activePrompt.promise

      // empty input -> prompt again
      if (line.trim() === "") {
        setTimeout(() => this.repl())
        return
      }

      // give user possibility to exec sth before run
      //await this.onBeforeCommandRun()

      // eval and print
      this.#tty.println(`Execute command: \`${line}\``)
      const commands = this._parseCommands(line)
      this.#tty.println(`-> ${commands}`)
      //await this.runLine(line)

      // print extra newline if output does not end with one
      //if (this._outputBuffer.slice(-1) !== "\n") this._xterm.write("\u23CE\r\n")

      // print newline after
      //this._xterm.write("\r\n")

      // give user possibility to run sth after exec
      //await this.onCommandRunFinish()

      // loop again
      setTimeout(() => this.repl())
    } catch (e) {
      // break loop when disposed
      if (e === "disposed") return

      // print error message and run again
      this.#tty.println(
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

  /** parse line as commands */
  _parseCommands(line) {
    let usesEnvironmentVars = false
    let usesBashFeatures = false

    // parse line into tokens (respect escaped spaces and quotation marks)
    const commandLine = parse(line, (_key) => {
      usesEnvironmentVars = true
      return undefined
    })

    const commands = []
    let cmd = []

    splitter: {
      for (let idx = 0; idx < commandLine.length; ++idx) {
        const item = commandLine[idx]

        if (typeof item === "string") {
          // normal word
          if (cmd.length === 0 && item.match(/^\w+=.*$/)) {
            usesEnvironmentVars = true
            continue
          } else {
            cmd.push(item)
          }
        } else {
          // shell operator
          switch (item.op) {
            case "|":
              commands.push(cmd)
              cmd = []
              break
            default:
              usesBashFeatures = true
              console.error("Unsupported shell operator:", item.op)
              break splitter
          }
        }
      }
    }
    commands.push(cmd)

    if (usesEnvironmentVars) {
      //this._stderr(
      //  "\x1b[1m[\x1b[33mWARN\x1b[39m]\x1b[0m Environment variables are not supported!\n"
      //)
    }
    if (usesBashFeatures) {
      //this._stderr(
      //  "\x1b[1m[\x1b[33mWARN\x1b[39m]\x1b[0m Advanced bash features are not supported! Only the pipe '|' works for now.\n"
      //)
    }

    return commands
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
