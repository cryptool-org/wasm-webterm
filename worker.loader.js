/**
 * Webpack loader to prebundle WasmWorker.
 * This eliminates the need of a separate webworker js file.
 */

const path = require("path")
const webpack = require("webpack")
const memfs = require("memfs")

function bytesToBase64DataUrl(bytes, type = "application/octet-stream") {
  const buffer = Buffer.from(bytes)
  const encoded = buffer.toString("base64")
  return `data:${type};base64,${encoded}`
}

async function compress(bytes, method = "gzip") {
  const blob = new Blob([bytes])
  const stream = blob.stream().pipeThrough(new CompressionStream(method))
  const response = new Response(stream, {
    headers: { "Content-Type": `application/${method}` },
  })
  return response.arrayBuffer()
}

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
        name: "[name]",
      },
    },
    target: ["web", "es2015"],
    optimization: {
      moduleIds: "deterministic", // share deterministic ids with the main bundle
    },
    externals: {
      // HACK: Do not bundle the `WasmRunner` module and its dependencies again.
      //       Instead let the main thread forward it from its bundle when
      //       instantiating the worker.
      "./WasmRunner": "global WasmRunner",
    },
    plugins: [
      new webpack.ProvidePlugin({
        Buffer: ["buffer", "Buffer"],
        process: "process/browser",
      }),
    ],
    module: {
      rules: [
        {
          test: /\.m?js$/,
          include: [__dirname + "/src"],
          exclude: /\bnode_modules\b/,
          use: [
            {
              loader: "swc-loader",
              options: {
                minify: true,
                jsc: { target: "es2015" },
              },
            },
          ],
        },
      ],
    },
  })

  // make compiler use memfs as *output* file system
  compiler.outputFileSystem = memfs.createFsFromVolume(new memfs.Volume())
  compiler.outputFileSystem.join = path.join.bind(path)

  return new Promise((resolve, reject) => {
    // compile webworker
    compiler.run(async (error, stats) => {
      // exit on errors
      if (error != null) reject(error)
      if (stats?.hasErrors()) reject(stats.compilation.errors)

      // read compiled bundle from file system and resolve
      try {
        const compiled = compiler.outputFileSystem.readFileSync(
          "/" + outputFilename,
          "utf-8"
        )
        const compressed = await compress(compiled, "gzip")
        const encoded = bytesToBase64DataUrl(compressed, "application/gzip")
        console.log(
          "Worker size:",
          Math.ceil((compiled.length / 1024) * 10) / 10,
          "KiB,",
          Math.ceil((encoded.length / 1024) * 10) / 10,
          "KiB compressed"
        )
        resolve(encoded)
      } catch (e) {
        console.error("Errors while compiling with worker.loader.js:", e)
      }
    })
  })
}
