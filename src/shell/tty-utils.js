/** Convert offset at the given input to col/row location */
export function offsetToColRow(input, offset, maxCols) {
  let row = 0
  let col = 1

  // strip out escape sequences
  input = input.replace(/\x1b\[[^m]*?m/g, "")

  let lineStart = 0
  while (true) {
    // search for next line break
    const linebreak = input.indexOf("\n", lineStart)

    // no line break left or after the target offset -> stop
    if (linebreak === -1 || linebreak >= offset) {
      // get length of the current line
      const lineLength = offset - lineStart
      // how many rows does this line span (when wrapped after maxCols)
      row += Math.floor(lineLength / maxCols)
      // how many columns are left in the last wrapped row
      col = lineLength % maxCols
      break
    }

    // explicit line break
    const lineLength = linebreak - lineStart

    // how many rows does this line span (when wrapped after maxCols) + next line
    row += Math.floor(lineLength / maxCols) + 1

    // search for the next line
    lineStart = linebreak + 1
  }

  return { row, col }
}

/** Count the lines in the given input */
export function countLines(input, maxCols) {
  return offsetToColRow(input, input.length, maxCols).row + 1
}
