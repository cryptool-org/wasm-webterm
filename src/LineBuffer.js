export default class LineBuffer {
  #outputFn
  #buffer

  constructor(outputFn) {
    if (typeof outputFn !== "function") {
      throw new ValueError(
        `'outputFn' must be a function but is '${typeof outputFn}'!`
      )
    }
    this.#outputFn = outputFn
    this.#buffer = ""
  }

  write(value) {
    // numbers are interpreted as char codes -> convert to string
    if (typeof value == "number") value = String.fromCharCode(value)

    this.#buffer += value

    let idx = this.#buffer.indexOf("\n")
    while (idx >= 0) {
      this.#outputFn(this.#buffer.slice(0, idx + 1))
      this.#buffer = this.#buffer.slice(idx + 1)
      idx = this.#buffer.indexOf("\n")
    }
  }

  flush() {
    if (this.#buffer.length > 0) {
      this.#outputFn(this.#buffer)
      this.#buffer = ""
    }
  }
}
