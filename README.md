# hyperpc

Yet another streaming RPC function. Works over any binary stream and supports callbacks and passing arbitrary streams (both object and binary streams). Also supports returning promises. Uses [multiplex](https://github.com/maxogden/multiplex) under the hood to float many streams through a single binary stream.

In the spirit of [dnode](https://github.com/substack/dnode), [rpc-stream](https://github.com/dominictarr/rpc-stream), [muxrpc](https://github.com/ssbc/muxrpc) and [rpc-multistream](https://github.com/biobricks/rpc-multistream).

## Installation

`npm install hyperpc`

## Usage

```js
  var hyperpc = require('hyperpc')

  var values = ['hello', 'world!']
  var api = {
    upper: (str, cb) => cb(null, str.toUpperCase()),
    readStream: (str, cb) => {
      var rs = new stream.Readable({
        objectMode: true,
        read () { this.push(values.length ? values.shift() : null)}
      })
      cb(null, rs)
    }
  }

  var server = hyperpc(api)
  var client = hyperpc()

  server.pipe(client).pipe(server)
  // usually, you'd do something like:
  // server.pipe(serverSideTransportStream).pipe(server)
  // clientTransport.pipe(client).pipe(clientTransport)

  client.on('remote', (remote) => {
    remote.upper('foo', (err, res) => {
      console.log('res') // FOO
    })

    remote.readStream('bar', (err, rs) => {
      rs.on('data', (data) => {
        console.log(data)
      })
      rs.on('end', () => console.log('read stream ended'))

      // prints:
      // hello
      // world!
      // read stream ended
    })
  })
})
```

More examples are in `test.js` and `examples/`.

## API

### `var stream = hyperpc([api], [opts])`

`api` is an object of functions. The functions can be called from the remote site. The implementing side may call any callbacks that are passed. For both the call and the callbacks you may pass readable streams, writable streams, callbacks or errors as args. They all work transparently over the remote connection.

`opts` and their defaults are:

* `log: false`: Enable debug mode. Log all messages to `console.log`
* `name: null`: Set a name for this end of the connection. Only used in log mode.
* `promise: false`: Support returning promises (experimental)

### Support for promises and `async/await`

Return values are ignored, unless `{ promise: true }` is set in `opts` AND the return value is a promise. In that case, on the remote end a promise is returned as well and the resolve/reject callbacks are streamed transparently.

This allows to use `hyperpc` with `async/await`:

```js
  var api = {
    promtest: async function (str) {
      if (!str) throw new Error('no arg')
      return str.toUpperCase()
    }
  }

  var server = hyperpc(api, {promise: true})
  var client = hyperpc(null, {promise: true})

  pump(server, client, server)

  client.on('remote', async (api) => {
    var val = 'hello'
    try {
      var bar = await api.promtest(val)
      console.log(bar)
    } catch (err) {
      console.log(err.message)
    }
    // prints "HELLO", and would print "no arg" if val were false.
  })
```
