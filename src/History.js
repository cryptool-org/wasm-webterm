/**
 * Shell history controller for `size` most-recent entries.
 */
export default class History {
  #size
  #entries = []
  #cursor = 0

  constructor(size) {
    this.#size = size
  }

  get size() {
    return this.#size
  }

  // push an entry and maintain buffer size (drop oldest entry)
  push(entry) {
    // skip empty entries
    if (entry.trim() === "") return
    // skip duplicate entries
    const last = this.#entries[this.#entries.length - 1]
    if (entry === last) return

    this.#entries.push(entry)
    if (this.#entries.length > this.size) {
      this.#entries.shift() // drop oldest entry to keep size
    }

    this.#cursor = this.#entries.length
  }

  // rewind cursor to the latest entry
  rewind() {
    this.#cursor = this.#entries.length
  }

  // move cursor to the previous entry and return it
  getPrevious() {
    this.#cursor = Math.max(0, this.#cursor - 1)
    return this.#entries[this.#cursor]
  }

  // move cursor to the next entry and return it
  getNext() {
    this.#cursor = Math.min(this.#entries.length, this.#cursor + 1)
    return this.#entries[this.#cursor]
  }
}
