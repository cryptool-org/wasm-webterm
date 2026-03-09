import { offsetToColRow, countLines } from "./tty-utils"

/**
 * WASM TTY interface
 *
 * A tty is a virtual device file that handles the interaction between shell
 * and terminal, providing an interface for writing/reading from the terminal.
 */
class WasmTTY {
  _xterm
  _termSize

  _promptPrefix
  _continuationPromptPrefix

  _cursor
  _inputBuffer

  constructor() {
    this._promptPrefix = "" // current prompt prefix
    this._continuationPromptPrefix = "" // current continuation prompt prefix

    this._cursor = 0 // track current cursor position (for insert / delete)
    this._inputBuffer = "" // track current user input
  }

  activate(xterm) {
    this._xterm = xterm // keep reference to the underlying terminal

    this._termSize = {
      cols: this._xterm.cols, // get current number of columns fitting the screen
      rows: this._xterm.rows, // get current number of rows fitting the screen
    }

    // register resize handler
    this._xterm.onResize((data) => this.handleTermResize(data))
  }

  /** Generate a deconstructed readPromise */
  _getAsyncRead() {
    let readResolve
    let readReject

    const readPromise = new Promise((resolve, reject) => {
      readResolve = (response) => {
        // reset prompt prefixes
        this._promptPrefix = ""
        this._continuationPromptPrefix = ""

        resolve(response)
      }
      readReject = reject
    })

    return { promise: readPromise, resolve: readResolve, reject: readReject }
  }

  read(promptPrefix, continuationPromptPrefix) {
    if (promptPrefix?.length > 0) this._printLines(promptPrefix)

    // set prompt prefixes
    this._promptPrefix = promptPrefix
    this._continuationPromptPrefix = continuationPromptPrefix ?? "> "

    // reset input and cursor position
    this._inputBuffer = ""
    this._cursor = 0

    return this._getAsyncRead()
  }

  /* ======== OUTPUT HANDLING ======== */

  /** Print a message to the terminal */
  print(message) {
    // normalize line endings
    const normalized = message.replace(/(\r\n)+/g, "\n")
    this._xterm.write(normalized.replace(/\n/g, "\r\n"))
  }

  /** Print a message with a trailing newline to the terminal */
  println(message) {
    this.print(message + "\n")
  }

  /** Print message line-by-line and add extra linebreak if line ends in last column */
  _printLines(message) {
    // normalize line endings
    const normalized = message.replace(/(\r\n)+/g, "\n")

    const maxCols = this.size.cols

    // print each line individually
    let lineStart = 0
    while (lineStart < normalized.length) {
      // search for next linebreak
      const linebreak = normalized.indexOf("\n", lineStart)
      let line

      // no linebreak -> last line
      if (linebreak === -1) {
        line = normalized.slice(lineStart, normalized.length)
        lineStart = normalized.length

        // print extra newline if line ends on last column
        if (line.length > 0 && line.length % maxCols === 0) {
          line = line + "\n"
        }
      }

      // found linebreak, print line including its trailing newline
      else {
        const lineEnd = linebreak + 1
        line = normalized.slice(lineStart, lineEnd)
        lineStart = lineEnd

        // print extra newline if line (excluding its trailing newline) ends on last column
        if (line.length > 0 && line.length % maxCols === 1) {
          line = line + "\n"
        }
      }

      // print actual line
      this._xterm.write(line.replace(/\n/g, "\r\n"))
    }
  }

  /** Clear the already printed lines of the input buffer from the terminal */
  _clearInput() {
    const currentPrompt = this._applyPrompts(this.input)

    // get number of lines for the current input
    const numRows = countLines(currentPrompt, this.size.cols)

    // get row we are currently at
    const promptCursor = this._applyPromptsOffset(this.input, this.cursor)
    const { row } = offsetToColRow(currentPrompt, promptCursor, this.size.cols)

    // move to the last line
    const moveRows = numRows - row - 1
    if (moveRows > 0) this._xterm.write("\x1b[E".repeat(moveRows)) // move line down

    // clear all input line(s)
    this._xterm.write("\r\x1b[K") // clear line
    for (let i = 1; i < numRows; ++i) this._xterm.write("\r\x1b[F\x1b[K") // move line up and clear line
  }

  /** Clear the entire terminal and move cursor to the top-left corner */
  clearTty() {
    this._xterm.write("\x1b[2J") // Clear the whole screen
    this._xterm.write("\x1b[0;0H") // move cursor to 0,0

    // re-print current prompt
    this._setInput(this.input)
  }

  /** Add the current prompts to the input */
  _applyPrompts(input) {
    return (
      this._promptPrefix +
      input.replace(/\n/g, "\n" + this._continuationPromptPrefix)
    )
  }

  /** Advance the offset by the amount added by the prompt additions to the input */
  _applyPromptsOffset(input, offset) {
    const inputWithPrompts = this._applyPrompts(input.substring(0, offset))
    return inputWithPrompts.length
  }

  /* ======== INPUT CURSOR MOVEMENT ======== */

  /** Get the current cursor position in the input buffer */
  get cursor() {
    return this._cursor
  }

  /** Set the current cursor position in the input buffer */
  set cursor(newCursor) {
    // clamp new position to point inside the input buffer
    if (newCursor < 0) newCursor = 0
    if (newCursor > this.input.length) newCursor = this.input.length

    this.moveCursorTo(newCursor)
  }

  /** Directly move the cursor to the updated position */
  moveCursorTo(newCursor) {
    // apply current prompts to the input
    const inputWithPrompt = this._applyPrompts(this.input)

    // estimate the current physical cursor position
    const currentPromptOffset = this._applyPromptsOffset(
      this.input,
      this.cursor
    )
    const { col: currentCol, row: currentRow } = offsetToColRow(
      inputWithPrompt,
      currentPromptOffset,
      this.size.cols
    )

    // estimate the new physical cursor position
    const newPromptOffset = this._applyPromptsOffset(this.input, newCursor)
    const { col: newCol, row: newRow } = offsetToColRow(
      inputWithPrompt,
      newPromptOffset,
      this.size.cols
    )

    // adjust for vertical difference
    const rowDiff = newRow - currentRow
    if (rowDiff > 0) {
      this._xterm.write("\x1b[B".repeat(rowDiff)) // move down
    } else if (rowDiff < 0) {
      this._xterm.write("\x1b[A".repeat(-rowDiff)) // move up
    }

    // adjust for horizontal difference
    const colDiff = newCol - currentCol
    if (colDiff > 0) {
      this._xterm.write("\x1b[C".repeat(colDiff)) // move right
    } else if (colDiff < 0) {
      this._xterm.write("\x1b[D".repeat(-colDiff)) // move left
    }

    // save new cursor offset
    this._cursor = newCursor
  }

  /* ======== INPUT HANDLING ======== */

  /** Get the currently buffered input data */
  get input() {
    return this._inputBuffer
  }

  /** Set new input data to be printed to the terminal */
  set input(newInput) {
    // clear current prompt, move cursor to start position
    this._clearInput()

    // actually update the input
    this._setInput(newInput)
  }

  /** Update input buffer and print to the terminal */
  _setInput(newInput) {
    // write new input lines, including the current prompts
    const inputWithPrompt = this._applyPrompts(newInput)
    this._printLines(inputWithPrompt)

    // trim cursor overflow
    if (this._cursor > newInput.length) this._cursor = newInput.length

    // get new cursor position, taking the prompts into account
    const newCursor = this._applyPromptsOffset(newInput, this.cursor)
    let newRows = countLines(inputWithPrompt, this.size.cols)
    let { col, row } = offsetToColRow(
      inputWithPrompt,
      newCursor,
      this.size.cols
    )

    // move cursor back to the current column and row
    const moveUpRows = newRows - row - 1
    this._xterm.write("\r") // move to column 0
    if (moveUpRows > 0) this._xterm.write("\x1b[F".repeat(moveUpRows)) // move line up
    if (col > 0) this._xterm.write("\x1b[C".repeat(col)) // move right

    // replace input buffer
    this._inputBuffer = newInput
  }

  /* ======== TERMINAL RESIZING ======== */

  /** Get the current size of the underlying terminal */
  get size() {
    return this._termSize
  }

  /** Handle resize events comming from the terminal */
  handleTermResize({ rows, cols }) {
    // clear old prompt
    this._clearInput()

    // update terminal size
    this._termSize.cols = cols
    this._termSize.rows = rows

    // re-print current input with the updated size
    this._setInput(this.input)
  }
}

export default WasmTTY
