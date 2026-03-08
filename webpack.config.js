/**
 * Webpack config to bundle WasmWebTerm
 * Generates the files "dist/wasm-webterm.js" and "dist/wasm-webterm.js.map"
 */

const webpack = require("webpack")

module.exports = {
  entry: {
    WasmWebTerm: "./src/WasmWebTerm.js",
  },
  output: {
    path: __dirname + "/dist/",
    filename: "wasm-webterm.js",
    library: { type: "umd", name: "[name]" },
  },
  target: ["web", "es2015"],
  optimization: {
    moduleIds: "deterministic", // share deterministic ids with the worker bundle
  },
  plugins: [
    new webpack.ProvidePlugin({
      Buffer: ["buffer", "Buffer"],
      process: "process/browser",
    }),
    new webpack.DefinePlugin({
      __VERSION__: JSON.stringify(process.env.npm_package_version),
    }),
  ],
  module: {
    rules: [
      {
        test: __dirname + "/src/runners/WasmWorker.js",
        use: [{ loader: "worker-loader" }],
        type: "asset/source",
      },
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
  resolveLoader: {
    alias: { "worker-loader": __dirname + "/worker.loader.js" },
  },
  devtool: "source-map",
}
