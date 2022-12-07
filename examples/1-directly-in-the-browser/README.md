# Example: Run `wasm-webterm` directly in the browser with `http-server`

This example does not use a bundler but includes xterm.js and the prebundled file `webterm.bundle.js` directly. It uses `http-server` as a static HTTP server. You could also use this example with Apache or Nginx etc.

Run the following commands **inside of this folder** to execute.

```
npm install
```

```
npm run http-server
```

You can now visit http://localhost:8080/index.html


-----


## Notes

> Because `http-server` sadly does not support serving multiple directories yet (there's an open pull request though), we used a symbolic link to link the binaries into this folder. This may not work on Windows.

> You could also set the required HTTPS headers to enable web workers by generating an SSL certificate (plus a key) and extending the `http-server` command with `--ssl --cors='Cross-Origin-Embedder-Policy:require-corp,Cross-Origin-Opener-Policy:same-origin'`
