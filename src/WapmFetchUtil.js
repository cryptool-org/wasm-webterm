/**
 * Script to fetch wasmer binaries from wapm.io -- Code taken from:
 * https://github.com/wasmerio/wasmer-js/tree/0.x/packages/wasm-terminal
 */


// some imports need to be lowered
// import { lowerI64Imports } from "@wasmer/wasm-transformer"

// packages come as .tar.gz
import pako from "pako" // gunzip
import untar from "js-untar" // untar

class WapmFetchUtil {

    static WAPM_GRAPHQL_QUERY =
    `query shellGetCommandQuery($command: String!) {
        command: getCommand(name: $command) {
            command
            module {
                name
                abi
                source
            }
            packageVersion {
                version
                package {
                    name
                    displayName
                }
                filesystem {
                    wasm
                    host
                }
                distribution {
                    downloadUrl
                }
                modules {
                    name
                    publicUrl
                    abi
                }
                commands {
                    command
                    module {
                        name
                        abi
                        source
                    }
                }
            }
        }
    }`

    static getCommandFromWAPM = async (commandName) => {

        const fetchResponse = await fetch("https://registry.wapm.io/graphql", {
            method: "POST",
            mode: "cors",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                operationName: "shellGetCommandQuery",
                query: WapmFetchUtil.WAPM_GRAPHQL_QUERY,
                variables: {
                    command: commandName
                }
            })
        })

        const response = await fetchResponse.json()

        if(response && response.data && response.data.command)
            return response.data.command

        else throw new Error(`command not found ${commandName}`)

    }

    static fetchCommandFromWAPM = async ({args, env}) => {
        const commandName = args[0]
        const command = await WapmFetchUtil.getCommandFromWAPM(commandName)
        if(command.module.abi !== "wasi")
            throw new Error(`Only WASI modules are supported. The "${commandName}" command is using the "${command.module.abi}" ABI.`)
        return command
    }

    static WAPM_PACKAGE_QUERY =
    `query shellGetPackageQuery($name: String!, $version: String) {
        packageVersion: getPackageVersion(name: $name, version: $version) {
            version
            package {
                name
                displayName
            }
            filesystem {
                wasm
                host
            }
            distribution {
                downloadUrl
            }
            modules {
                name
                publicUrl
                abi
            }
            commands {
                command
                module {
                    name
                    abi
                    source
                }
            }
        }
    }`

    static execWapmQuery = async (query, variables) => {

        const fetchResponse = await fetch("https://registry.wapm.io/graphql", {
            method: "POST",
            mode: "cors",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                query,
                variables
            })
        })

        const response = await fetchResponse.json()
        if(response && response.data) return response.data

    }

    static getBinaryFromUrl = async url => {
        const fetched = await fetch(url)
        const buffer = await fetched.arrayBuffer()
        return new Uint8Array(buffer)
    }

    static getWAPMPackageFromPackageName = async (packageName) => {

        let version

        if(packageName.indexOf("@") > -1) {
            const splitted = packageName.split("@")
            packageName = splitted[0]
            version = splitted[1]
        }

        let data = await WapmFetchUtil.execWapmQuery(WapmFetchUtil.WAPM_PACKAGE_QUERY,
            { name: packageName, version: version })

        if(data && data.packageVersion) return data.packageVersion
        else throw new Error(`Package not found in the registry ${packageName}`)

    }

    static getWasmBinaryFromUrl = async (url) => {
        const fetched = await fetch(url)
        const buffer = await fetched.arrayBuffer()
        return new Uint8Array(buffer)
    }

    static getWasmBinaryFromCommand = async (programName) => {

        // fetch command from wapm.io (includes path to binary)
        const command = await WapmFetchUtil.fetchCommandFromWAPM({ args: [programName] })

        // fetch binary from wapm and extract wasmer files from .tar.gz
        const binary = await WapmFetchUtil.getBinaryFromUrl(command.packageVersion.distribution.downloadUrl)
        const inflatedBinary = pako.inflate(binary); const wapmFiles = await untar(inflatedBinary.buffer)
        const wasmerFiles = wapmFiles.filter(wapmFile => wapmFile.name.split("/").pop().endsWith(".wasm"))

        // console.log("wasmerFiles", wasmerFiles)

        // check if we got exactly one binary and then lower its imports
        if(wasmerFiles.length > 1) throw Error("more than 1 wasm file, don't know what to do :D")
        const wasmModule = wasmerFiles[0].buffer // await lowerI64Imports(wasmerFiles[0].buffer)

        // todo: there is a file "wapm.toml" that contains info about which command uses which module/binary

        return wasmModule
    }

}

export default WapmFetchUtil
