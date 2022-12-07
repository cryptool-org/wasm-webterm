const HtmlWebPackPlugin = require("html-webpack-plugin")
const CopyWebpackPlugin = require("copy-webpack-plugin")

module.exports = {
    entry: {
        "main": "./index.js"
    },
    output: {
        path: __dirname + "/dist",
        filename: "[name].js"
    },
    devServer: {
        port: 4201,
        headers: {
            "Cross-Origin-Embedder-Policy": "require-corp",
            "Cross-Origin-Opener-Policy": "same-origin"
        },
        https: true
    },
    module: {
        rules: [{
            test: /\.(js|jsx)$/,
            exclude: ["/node_modules/", "/bin/"],
            use: ["babel-loader"]
        }, {
            test: /\.css$/,
            use: ["style-loader", "css-loader"]
        }]
    },
    plugins: [
        new HtmlWebPackPlugin({
            template: "./index.html", inject: true
        }),
        new CopyWebpackPlugin({ patterns: [
            { from: "../binaries", to: "binaries" }
        ]})
    ],
    /* optimization: {
        concatenateModules: false,
        minimize: false
    } */
}
