import parse from "shell-quote/parse"

import { CommandParserError } from "../Errors"
import Command from "../Command"

/**
 * Checks if there is an incomplete input
 *
 * An incomplete input is considered:
 * - An input that contains unterminated single quotes
 * - An input that contains unterminated double quotes
 * - An input that ends with "\"
 * - An input that has an incomplete boolean shell expression (&& and ||)
 * - An incomplete pipe expression (|)
 */
export function isIncompleteInput(input) {
  // empty input is not incomplete
  if (input.trim() === "") return false

  // check for dangling single-quote strings
  if ((input.match(/'/g) || []).length % 2 !== 0) return true

  // Check for dangling double-quote strings
  if ((input.match(/"/g) || []).length % 2 !== 0) return true

  // Check for dangling boolean or pipe operations
  if (
    input
      .split(/(\|\||\||&&)/g)
      .pop()
      .trim() === ""
  )
    return true

  // Check for tailing slash
  if (input.endsWith("\\") && !input.endsWith("\\\\")) return true

  return false
}

const SUPPORTED_FEATURES = [";", "|" /*">", ">>", "<"*/]
const SUPPORTED_FEATURES_STR =
  SUPPORTED_FEATURES.slice(0, -1)
    .map((feat) => `'${feat}'`)
    .join(", ") + ` and '${SUPPORTED_FEATURES[SUPPORTED_FEATURES.length - 1]}'`

/**
 * Parse input line into commands with its input and output redirects
 */
export function parseCommands(line, println = console.warn) {
  let usesEnvironmentVars = false
  let usesBashFeatures = false

  // parse line into tokens (respect escaped spaces and quotation marks)
  const commandLine = parse(line, (_key) => {
    usesEnvironmentVars = true
    return undefined
  })

  const commands = []
  let buf = []
  let io = null

  splitter: {
    for (let idx = 0; idx < commandLine.length; ++idx) {
      const item = commandLine[idx]

      if (typeof item === "string") {
        // normal word
        if (buf.length === 0 && item.match(/^\w+=.*$/)) {
          usesEnvironmentVars = true
          continue
        } else {
          buf.push(item)
        }
      } else {
        // shell operator
        switch (item.op) {
          // command separator
          case ";":
            if (buf.length === 0) break
            commands.push(new Command(buf[0], buf.slice(1), io))
            buf = []
            io = null
            break
          case "|": {
            if (buf.length === 0) break
            const cmd = new Command(buf[0], buf.slice(1), io)
            // Redirect stdout through the pipe if not already redirected
            if (cmd.stdout === Command.STDOUT) cmd.stdout = Command.PIPE
            if (cmd.stderr === Command.STDOUT) cmd.stderr = Command.PIPE
            commands.push(cmd)
            buf = []
            io = null
            break
          }
          //// io redirection
          //case ">":
          //case ">>": {
          //  const prev = commandLine[idx - 1]
          //  let file = commandLine[++idx]
          //  if (file?.op === "|") file = commandLine[++idx]
          //  if (file == null || typeof file !== "string" || file === "")
          //    throw new CommandParserError(
          //      `Missing file for \`${item.op}\` redirect`
          //    )

          //  io = io ?? {}
          //  if (prev === "2") {
          //    buf.pop()
          //    io.stderr = file
          //  } else if (prev === "1") {
          //    buf.pop()
          //    io.stdout = file
          //  } else if (prev.op === "&") {
          //    io.stderr = file
          //    io.stdout = file
          //  } else {
          //    io.stdout = file
          //  }
          //  if (item.op === ">>") io.append = true
          //  break
          //}
          //case ">&": {
          //  const prev = commandLine[idx - 1]
          //  const fd = commandLine[++idx]
          //  if (fd == null || typeof fd !== "string" || fd === "")
          //    throw new CommandParserError(
          //      "Missing file descriptor for `>&` redirect"
          //    )

          //  io = io ?? {}
          //  const target =
          //    fd === "2" ? Command.STDERR : fd === "1" ? Command.STDOUT : null
          //  if (prev === "2") {
          //    buf.pop()
          //    io.stderr = target
          //  } else if (prev === "1") {
          //    buf.pop()
          //    io.stdout = target
          //  } else {
          //    io.stdout = target
          //  }
          //  break
          //}
          //case "<": {
          //  let file = commandLine[++idx]
          //  if (file?.op === ">" || file?.op === "<") {
          //    usesBashFeatures = true
          //    console.error("Unsupported shell operator:", item.op + file.op)
          //    break splitter
          //  }
          //  if (file == null || typeof file !== "string" || file === "")
          //    throw new CommandParserError("Missing file for `<` redirect")

          //  io = io ?? {}
          //  io.stdin = file
          //  break
          //}
          //// background processing (unsupported) or `&>` redirect
          //case "&": {
          //  // allow `&` followed by `>` for stdout+stderr redirect
          //  const next = commandLine[idx + 1]
          //  if (next?.op === ">") break
          //  // fall through
          //}
          default:
            usesBashFeatures = true
            console.error("Unsupported shell operator:", item.op)
            break splitter
        }
      }
    }
  }
  if (buf[0]) commands.push(new Command(buf[0], buf.slice(1), io))

  if (usesEnvironmentVars)
    println(
      "\x1b[1m[\x1b[33mWARN\x1b[39m]\x1b[0m Environment variables are not supported!"
    )
  if (usesBashFeatures)
    println(
      `\x1b[1m[\x1b[33mWARN\x1b[39m]\x1b[0m Advanced bash features are not supported! Only ${SUPPORTED_FEATURES_STR} work for now.`
    )

  return commands
}
