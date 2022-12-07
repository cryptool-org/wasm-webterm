/**
 * Webpack config to bundle WasmWebTerm
 * Generates the files "webterm.bundle.js" and "webterm.bundle.js.map"
 */

const webpack = require("webpack")

module.exports = {
    entry: {
        WasmWebTerm: "./src/WasmWebTerm.js"
    },
    output: {
        path: __dirname,
        filename: "webterm.bundle.js",
        library: { type: "umd", name: "[name]" }
    },
    plugins: [
        new webpack.ProvidePlugin({
            Buffer: ["buffer", "Buffer"],
            process: "process/browser"
        })
    ],
    module: {
        rules: [{
            test: __dirname + "/src/runners/WasmWorker.js",
            use: [{ loader: "worker-loader" }],
            type: "asset/source"
        }]
    },
    resolveLoader: {
        alias: { "worker-loader": __dirname + "/worker.loader.js" }
    },
    devtool: "source-map"
}
