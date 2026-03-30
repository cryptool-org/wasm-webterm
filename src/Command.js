export default class Command {
  static PIPE = Symbol("PIPE")
  static STDOUT = Symbol("STDOUT")
  static STDERR = Symbol("STDERR")

  name
  argv

  constructor(name, argv, io = null) {
    this.name = name
    this.argv = argv

    this.stdout = io?.stdout ?? Command.STDOUT
    this.stderr = io?.stderr ?? Command.STDERR
    this.append = io?.append ?? false
  }
}
