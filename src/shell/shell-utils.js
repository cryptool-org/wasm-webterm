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
