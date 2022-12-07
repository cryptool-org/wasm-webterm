/**
 * Example on how to use wasm-webterm with Node.js
 */

// import xterm.js
import { Terminal } from "xterm"

// import the prebundled webterm addon
import WasmWebTerm from "wasm-webterm"

// instantiate xterm.js
let term = new Terminal()

// load the wasm-webterm addon
// and pass it the path to your wasm binaries (optionally)
term.loadAddon(new WasmWebTerm("./binaries"))

// spawn the terminal into index.html
term.open(document.getElementById("terminal"))
