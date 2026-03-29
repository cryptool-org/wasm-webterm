export class CommandNotFoundError extends Error {
  constructor(...params) {
    super(...params)

    // Maintains proper stack trace for where our error was thrown (non-standard)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CommandNotFoundError)
    }

    this.name = "CommandNotFoundError"
  }
}

export class KeyboardInterruptError extends Error {
  constructor(...params) {
    super(...params)

    // Maintains proper stack trace for where our error was thrown (non-standard)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, KeyboardInterruptError)
    }

    this.name = "KeyboardInterruptError"
  }
}
