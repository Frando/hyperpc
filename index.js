var multiplex = require('multiplex')
var duplexify = require('duplexify')
var through = require('through2')
var thunky = require('thunky')
var stream = require('stream')
var pump = require('pump')

var rpcify = require('./rpcify.js')

var MANIFEST = 1
var CALL = 2
var FULFIL_CALLBACK = 3
var FULFIL_PROMISE = 4

var PROMISE_RESOLVE = 0
var PROMISE_REJECT = 1

var READABLE = 1 // 10
var WRITABLE = 2 // 01
var DUPLEX = 1 | 2 // 11

var FUNCTION = 1
var VALUE = 2
var OBJECT = 3
var CONSTRUCTOR = 4

var SEPERATOR = '.'

function hyperpc (api, opts) {
  var rpc = HypeRPC(api, opts)
  return rpc.stream
}

module.exports = hyperpc

function HypeRPC (api, opts) {
  if (!(this instanceof HypeRPC)) return new HypeRPC(api, opts)
  var self = this
  opts = opts || {}

  this.promise = opts.promise || false
  this.prefix = opts.prefix || null
  this.name = opts.name || ''
  this.debug = opts.debug || false
  this.id = opts.id || 0

  this.api = api || []

  this.remote = null
  this.callbacks = {}
  this.constructors = {}
  this.transports = {}
  this.incoming = {}
  this.promises = {}
  this.cnt = 0
  this.nonce = Math.round(Math.random() * 10000000)

  this.stream = multiplex({objectMode: false}, this.onstream.bind(this))

  var rpc = this.stream.createSharedStream('rpc')
  this.send = through.obj()
  this.recv = through.obj()

  pump(this.send, maybeConvert(true, false), rpc)
  pump(rpc, maybeConvert(false, true), this.recv)

  if (opts.log) pump(this.send, this.toLog('send'))
  if (opts.log) pump(this.recv, this.toLog('recv'))

  this.recv.on('data', this.onData.bind(this))

  this.sendManifest()

  this.ready = thunky((cb) => self.stream.on('remote', () => cb()))
  this.ready()
}

HypeRPC.prototype.onData = function (data) {
  var self = this
  var [type, ...params] = data
  switch (type) {
    case MANIFEST:
      this.onManifest(params)
      break
    case CALL:
      this.ready(() => self.onCall(params))
      break
    case FULFIL_CALLBACK:
      this.ready(() => self.fulfilCallback(params))
      break
    case FULFIL_PROMISE:
      if (this.promise) this.ready(() => self.fulfilPromise(params))
      break
  }
}

HypeRPC.prototype.sendManifest = function () {
  this.send.write([MANIFEST, this.makeManifest(), this.nonce])
}

HypeRPC.prototype.makeManifest = function () {
  var manifest = reduce(this.api)
  return manifest

  function reduce (obj) {
    return Object.keys(obj).reduce((manifest, key) => {
      if (obj[key] instanceof rpcify) {
        manifest[key] = [CONSTRUCTOR, obj[key].toManifest()]
      } else if (isObject(obj[key])) {
        manifest[key] = [OBJECT, reduce(obj[key])]
      } else if (isFunc(obj[key])) {
        manifest[key] = [FUNCTION]
      } else if (isLiteral(obj[key])) {
        manifest[key] = [VALUE, obj[key]]
      }
      return manifest
    }, {})
  }
}

HypeRPC.prototype.onManifest = function (data) {
  var self = this
  var [manifest, remoteNonce] = data

  if (!this.prefix) this.prefix = calculatePrefix(this.nonce, remoteNonce)

  this.remote = reduce(manifest)
  this.stream.emit('remote', this.remote)

  function reduce (manifest, prefixes) {
    prefixes = prefixes || []
    return Object.keys(manifest).reduce((remote, name) => {
      var path = [...prefixes, name]
      var [type, data] = manifest[name]

      if (type === CONSTRUCTOR) {
        remote[name] = self.mockConstructor(path, data)
      } else if (type === OBJECT) {
        remote[name] = reduce(data, path)
      } else if (type === FUNCTION) {
        remote[name] = self.mockFunction(path)
      } else if (type === VALUE) {
        remote[name] = data
      }
      return remote
    }, {})
  }
}

HypeRPC.prototype.mockFunction = function (path, opts) {
  var self = this
  opts = opts || null
  var name = path.join(SEPERATOR)
  return function () {
    var id = self.makeId()
    var args = self.prepareArgs(id, Array.from(arguments))
    self.send.push([CALL, name, id, opts, args])

    if (self.promise) {
      return new Promise((resolve, reject) => {
        self.promises[id] = [resolve, reject]
      })
    }
  }
}

HypeRPC.prototype.mockConstructor = function (path, manifest) {
  var self = this
  var name = path.join(SEPERATOR)
  return function () {
    var id = self.makeId()

    var args = self.prepareArgs(id, Array.from(arguments))
    self.send.push([CALL, name, id, null, args])

    var MockObject = makeMockObject(manifest)
    return new MockObject()

    function makeMockObject (manifest) {
      var name = manifest.name
      this[name] = function () {
      }
      manifest.methods.forEach((key) => {
        this[name].prototype[key] = self.mockFunction(path, [id, key])
      })
      return this[name]
    }
  }
}

HypeRPC.prototype.onCall = function (data) {
  var [name, id, opts, args] = data

  args = this.resolveArgs(id, args)
  var func = name.split(SEPERATOR).reduce((api, path) => api[path], this.api)

  var ret
  if (func instanceof rpcify) {
    if (opts === null) {
      return func.makeNew(id, args)
    } else {
      ret = func.makeCall(opts, args)
    }
  } else {
    ret = func.apply(func, args)
  }

  if (this.promise && isPromise(ret)) this.preparePromise(id, ret)
}

HypeRPC.prototype.fulfilCallback = function (data) {
  var [id, args] = data
  var func = this.callbacks[id]
  if (!func) return this.log(`Invalid callback ${id}`)
  func.apply(func, this.resolveArgs(id, args))
}

HypeRPC.prototype.fulfilPromise = function (data) {
  var [id, type, args] = data
  if (!this.promises[id]) return
  args = this.resolveArgs(id, args)
  this.promises[id][type].apply(this.promises[id][type], args)
}

HypeRPC.prototype.preparePromise = function (id, promise) {
  var self = this
  promise.then(handle(PROMISE_RESOLVE), handle(PROMISE_REJECT))

  function handle (type) {
    return function () {
      var args = self.prepareArgs(id, Array.from(arguments))
      self.send.push([FULFIL_PROMISE, id, type, args])
    }
  }
}

HypeRPC.prototype.resolveArgs = function (id, args) {
  return this.convertArgs('resolve', id, args)
}

HypeRPC.prototype.prepareArgs = function (id, args) {
  return this.convertArgs('prepare', id, args)
}

HypeRPC.prototype.convertArgs = function (step, id, args) {
  var self = this
  var MATCH = 0
  var PREPARE = 1
  var RESOLVE = 2

  var STEPS = {
    prepare: prepareArg,
    resolve: resolveArg
  }

  var CONVERSION_MAP = [
    // [ MATCH, PREPARE, RESOLVE ]
    [isError, this.prepareError, this.resolveError],
    [isFunc, this.prepareCallback, this.resolveCallback],
    [isStream, this.prepareStream, this.resolveStream],
    [isBuffer, this.prepareBuffer, this.resolveBuffer],
    [() => true, (arg) => arg, (arg) => arg]
  ]

  return args.map((arg, i) => STEPS[step](arg, id, i))

  function prepareArg (arg, id, i) {
    return CONVERSION_MAP.reduce((preparedArg, functions, type) => {
      if (preparedArg === null && functions[MATCH](arg)) {
        preparedArg = [type, functions[PREPARE].apply(self, [arg, joinIds(id, i)])]
      }
      return preparedArg
    }, null)
  }

  function resolveArg (arg, id, i) {
    var [type, data] = arg
    return CONVERSION_MAP[type][RESOLVE].apply(self, [data, joinIds(id, i)])
  }
}

HypeRPC.prototype.prepareError = function (arg) {
  return { message: arg.message }
  // todo: somehow this does not alway work.
  // return Object.getOwnPropertyNames(arg).reduce((spec, name) => {
  //   spec[name] = arg[name]
  //   return spec
  // }, {})
}

HypeRPC.prototype.resolveError = function (spec, id) {
  var err = new Error()
  Object.getOwnPropertyNames(spec).map((name) => {
    err[name] = spec[name]
  })
  return err
}

HypeRPC.prototype.prepareCallback = function (arg, id) {
  this.callbacks[id] = arg
  return id
}

HypeRPC.prototype.resolveCallback = function (id) {
  var self = this
  return function () {
    var args = self.prepareArgs(id, Array.from(arguments))
    self.send.push([FULFIL_CALLBACK, id, args])
  }
}

HypeRPC.prototype.prepareStream = function (stream, id) {
  var type = streamType(stream)
  var objectMode = isObjectStream(stream)

  if (type & READABLE) {
    var rsT = this.getTransportStream(id, READABLE, stream)
    pump(stream, maybeConvert(objectMode, false), rsT)
  }
  if (type & WRITABLE) {
    var wsT = this.getTransportStream(id, WRITABLE, stream)
    pump(wsT, maybeConvert(false, objectMode), stream)
  }

  return [type, objectMode]
}

HypeRPC.prototype.resolveStream = function (spec, id) {
  var [type, objectMode] = spec
  var ds = objectMode ? duplexify.obj() : duplexify()

  if (type & READABLE) {
    var rs = through({objectMode})
    var rsT = this.getTransportStream(id, READABLE, rs)
    pump(rsT, maybeConvert(false, objectMode), rs)
    ds.setReadable(rs)
  }
  if (type & WRITABLE) {
    var ws = through({objectMode})
    var wsT = this.getTransportStream(id, WRITABLE, ws)
    pump(ws, maybeConvert(objectMode, false), wsT)
    ds.setWritable(ws)
  }

  return ds
}

HypeRPC.prototype.prepareBuffer = function (buf) {
  return buf.toString('ascii')
}

HypeRPC.prototype.resolveBuffer = function (string) {
  return Buffer.from(string, 'ascii')
}

HypeRPC.prototype.onstream = function (sT, name) {
  var self = this
  // stream names are: ID-TYPE
  var match = name.match(/^([a-zA-Z0-9.]+)-([0-3]){1}$/)

  if (!match) return console.error('received unrecognized stream: ' + name)

  var id = match[1]
  var type = match[2]

  sT.on('error', (err) => self.log(name, err))

  this.transports[`${id}-${type}`] = sT
}

HypeRPC.prototype.getTransportStream = function (id, type, stream) {
  var sid = `${id}-${type}`
  if (!this.transports[sid]) this.transports[sid] = this.stream.createSharedStream(sid)
  return this.transports[sid]
}

HypeRPC.prototype.makeId = function () {
  return joinIds(this.prefix, this.cnt++)
}

HypeRPC.prototype.toLog = function (name) {
  var self = this
  return through.obj(function (chunk, enc, next) {
    self.log(name, Buffer.isBuffer(chunk) ? chunk.toString() : chunk)
    this.push(chunk)
    next()
  })
}

HypeRPC.prototype.log = function (...args) {
  if (!this.debug) return
  var s = this.prefix + (this.name ? `=${this.name}` : '')
  console.log('rpcstream [%s]:', s, ...args)
}

// Pure helpers.

function joinIds (...ids) {
  return ids.join(SEPERATOR)
}

function calculatePrefix (nonce, remoteNonce) {
  if (remoteNonce > nonce) return 'A'
  else if (remoteNonce < nonce) return 'B'
  else return 'X' + (Math.round(Math.random() * 1000))
}

function isFunc (obj) {
  return typeof obj === 'function'
}

function isError (arg) {
  return arg instanceof Error
}

function isPromise (obj) {
  return !!obj && (typeof obj === 'object' || typeof obj === 'function') && typeof obj.then === 'function'
}

function isStream (obj) {
  return obj instanceof stream.Stream
}

function isReadable (obj) {
  return isStream(obj) && typeof obj._read === 'function' && typeof obj._readableState === 'object'
}

function isWritable (obj) {
  return isStream(obj) && typeof obj._write === 'function' && typeof obj._writableState === 'object'
}

function isTransform (obj) {
  return isStream(obj) && typeof obj._transform === 'function' && typeof obj._transformState === 'object'
}

function isObjectStream (stream) {
  if (isWritable(stream)) return stream._writableState.objectMode
  if (isReadable(stream)) return stream._readableState.objectMode
}

function isBuffer (buf) {
  return Buffer.isBuffer(buf)
}

function isObject (obj) {
  return (typeof obj === 'object')
}

function isLiteral (val) {
  return (typeof val === 'boolean' || typeof val === 'string' || typeof val === 'number')
}

function streamType (stream) {
  var type = 0

  // Special handling for transform streams. If it has no pipes attached,
  // assume its readable. Otherwise, assume its writable. If this leads
  // to unexpected behaviors, set up a duplex stream with duplexify and
  // use either setReadable() or setWritable() to only set up one end.
  if (isTransform(stream)) {
    if (typeof stream._readableState === 'object' && !stream._readableState.pipes) {
      return READABLE
    } else {
      return WRITABLE
    }
  }

  if (isReadable(stream)) type = type | READABLE
  if (isWritable(stream)) type = type | WRITABLE

  return type
}

function pass (objectMode) {
  return through({objectMode})
}

function toObj () {
  return through.obj(function (chunk, enc, next) {
    this.push(JSON.parse(chunk))
    next()
  })
}

function toBin () {
  return through.obj(function (chunk, enc, next) {
    this.push(JSON.stringify(chunk))
    next()
  })
}

function maybeConvert (oneInObjMode, twoInObjMode) {
  if (oneInObjMode && !twoInObjMode) return toBin()
  if (!oneInObjMode && twoInObjMode) return toObj()
  if (oneInObjMode && twoInObjMode) return pass(true)
  if (!oneInObjMode && !twoInObjMode) return pass(false)
}
