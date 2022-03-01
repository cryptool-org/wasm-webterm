/**
 * Webpack loader to prebundle WasmWorker.
 * This eliminates the need of a separate webworker js file.
 */

const path = require("path")
const webpack = require("webpack")
const memfs = require("memfs")

module.exports = function (source) {

    const inputFilename = "./src/runners/WasmWorker.js"
    const outputFilename = "worker.compiled.js"

    // create webpack compiler
    let compiler = webpack({
        entry: inputFilename,
        output: {
            path: "/",
            filename: outputFilename,
            library: {
                type: "umd",
                name: "[name]"
            }
        },
        plugins: [
            new webpack.ProvidePlugin({
                Buffer: ["buffer", "Buffer"],
                process: "process/browser"
            })
        ]
    })

    // make compiler use memfs as *output* file system
    compiler.outputFileSystem = memfs.createFsFromVolume(new memfs.Volume())
    compiler.outputFileSystem.join = path.join.bind(path)

    return new Promise((resolve, reject) => {

        // compile webworker
        compiler.run((error, stats) => {

            // exit on errors
            if(error != null) reject(error)
            if(stats?.hasErrors()) reject(stats.compilation.errors)

            // read compiled bundle from file system and resolve
            try {
                const compiled = compiler.outputFileSystem.readFileSync("/" + outputFilename, "utf-8")
                resolve(compiled)
            }
            catch(e) { console.error("Errors while compiling with worker.loader.js") }

        })

    })

}
