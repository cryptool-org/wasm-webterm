import React from "react"
import ReactDOM from "react-dom"

import XTerm from "./xterm-for-react"
import WasmWebTerm from "wasm-webterm"

// instantiate wasm-webterm addon
let wasmterm = new WasmWebTerm("./binaries")

// create component containing xterm and the addon
class WebtermComponent extends React.Component {
    render() {
        return <XTerm
            addons={[wasmterm]}
            options={{ fontSize: 15, fontFamily: "monospace" }}
        />
    }
}

// load stylesheet
require("./index.css")

// initialize wasm webterm component
ReactDOM.render(<WebtermComponent />, document.getElementById("wasm-webterm"))
