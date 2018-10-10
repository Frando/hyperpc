var multiplex = require('multiplex')
var duplexify = require('duplexify')
var through = require('through2')
var thunky = require('thunky')
var stream = require('stream')
var pump = require('pump')
// var debug = require('debug')

var m = require('./messages.js')
var rpcify = require('./rpcify.js')

var READABLE = 1 // 10
var WRITABLE = 2 // 01
// var DUPLEX = 1 | 2 // 11

var FUNCTION = 1
var VALUE = 2
var OBJECT = 3
var CONSTRUCTOR = 4

var SEPERATOR = '.'

function hyperpc (api, opts) {
  var rpc = HypeRPC(api, opts)
  return rpc.stream
}

hyperpc.rpcify = rpcify

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
  this.objects = {}
  this.transports = {}
  this.incoming = {}
  this.promises = {}
  this.cnt = 0
  this.nonce = Math.round(Math.random() * 10000000)

  this.stream = multiplex({objectMode: false}, this.onstream.bind(this))

  var rpc = this.stream.createSharedStream('rpc')
  this.send = through()
  this.recv = through()

  pump(this.send, rpc)
  pump(rpc, this.recv)

  this.recv.on('data', this.onData.bind(this))

  this.sendManifest()

  this.ready = thunky((cb) => self.stream.on('remote', () => cb()))
  this.ready()
}

HypeRPC.prototype.onData = function (data) {
  var self = this
  var msg = m.Msg.decode(data)
  if (this.debug) this.log('in', msg)

  switch (msg.type) {
    case m.TYPE.MANIFEST:
      this.onManifest(msg.manifest)
      break
    case m.TYPE.CALL:
      this.ready(() => self.onCall(msg.call))
      break
    case m.TYPE.RETURN:
      this.ready(() => self.onReturn(msg.return))
      break
  }
}

HypeRPC.prototype.send = function (data) {
  this.send.write(data)
}

HypeRPC.prototype.sendMsg = function (msg) {
  if (this.debug) this.log('out', msg)
  this.send.write(m.Msg.encode(msg))
}

HypeRPC.prototype.sendManifest = function () {
  this.sendMsg({
    type: m.TYPE.MANIFEST,
    manifest: {
      manifest: JSON.stringify(this.makeManifest()),
      nonce: this.nonce
    }
  })
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

HypeRPC.prototype.onManifest = function (msg) {
  var self = this
  var manifest = JSON.parse(msg.manifest)
  var remoteNonce = msg.nonce

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

HypeRPC.prototype.mockFunction = function (path, objectid, method) {
  var self = this
  var name, type
  if (path) {
    type = m.CALL.API
    name = path.join(SEPERATOR)
  } else {
    type = m.CALL.OBJECT
  }
  return function () {
    var id = self.makeId()
    var args = self.prepareArgs(id, Array.from(arguments))
    self.sendMsg({
      type: m.TYPE.CALL,
      call: { type, id, name, objectid, method, args }
    })

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
    self.sendMsg({
      type: m.TYPE.CALL,
      call: { type: m.CALL.API, id, name, args }
    })

    var MockConstructor = function () {}
    manifest.methods.forEach((method) => {
      MockConstructor.prototype[method] = self.mockFunction(path, id, method)
    })
    Object.defineProperty(MockConstructor, 'name', { value: manifest.name })
    return new MockConstructor()
  }
}

HypeRPC.prototype.onCall = function (msg) {
  var { type, id, name, objectid, method, args } = msg

  args = this.resolveArgs(id, args)

  var ret
  switch (type) {
    case m.CALL.OBJECT:
      ret = this.objects[objectid].makeCall(method, objectid, args)
      break

    case m.CALL.API:
      var obj = name.split(SEPERATOR).reduce((api, path) => api[path], this.api)
      if (obj instanceof rpcify) {
        if (objectid) ret = obj.makeCall(method, objectid, args)
        else ret = obj.makeNew(id, args)
      } else {
        ret = obj.apply(obj, args)
      }
      break
  }

  if (this.promise) {
    var promise
    if (isPromise(ret)) promise = ret
    else promise = new Promise((resolve, reject) => resolve(ret))
    this.preparePromise(id, promise)
  }
}

HypeRPC.prototype.onReturn = function (msg) {
  var { id, args, type } = msg

  args = this.resolveArgs(id, args)

  switch (type) {
    case m.RETURN.CALLBACK:
      var func = this.callbacks[id]
      func.apply(func, args)
      break
    case m.RETURN.PROMISE:
      var promise = this.promises[id]
      if (!promise) return
      var res = msg.promise
      promise[res].apply(promise[res], args)
      break
  }
}

HypeRPC.prototype.preparePromise = function (id, promise) {
  var self = this
  promise.then(handle(m.PROMISE.RESOLVE), handle(m.PROMISE.REJECT))

  function handle (result) {
    return function () {
      var args = self.prepareArgs(id, Array.from(arguments))
      self.sendMsg({
        type: m.TYPE.RETURN,
        return: {
          type: m.RETURN.PROMISE,
          id,
          args,
          promise: result
        }
      })
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
  var TYPE = 0
  var MATCH = 1
  var PREPARE = 2
  var RESOLVE = 3

  var STEPS = {
    prepare: prepareArg,
    resolve: resolveArg
  }

  var CONVERSION_MAP = [
    // [ TYPE, MATCH, PREPARE, RESOLVE ]
    [m.ARGUMENT.RPCIFIED, isRpcified, this.prepareRpcified, this.resolveRpcified],
    [m.ARGUMENT.ERROR, isError, this.prepareError, this.resolveError],
    [m.ARGUMENT.CALLBACK, isFunc, this.prepareCallback, this.resolveCallback],
    [m.ARGUMENT.STREAM, isStream, this.prepareStream, this.resolveStream],
    [m.ARGUMENT.BYTES, isBuffer, this.prepareBuffer, this.resolveBuffer],
    [m.ARGUMENT.JSON, () => true, this.prepareJson, this.resolveJson]
  ]

  return args.map((arg, i) => STEPS[step](arg, id, i))

  function prepareArg (arg, id, i) {
    return CONVERSION_MAP.reduce((preparedArg, info, type) => {
      if (preparedArg === null && info[MATCH](arg)) {
        preparedArg = info[PREPARE].apply(self, [arg, joinIds(id, i)])
        preparedArg.type = info[TYPE]
      }
      return preparedArg
    }, null)
  }

  function resolveArg (arg, id, i) {
    var group = CONVERSION_MAP.filter(group => group[0] === arg.type)[0]
    return group[RESOLVE].apply(self, [arg, joinIds(id, i)])
  }
}

HypeRPC.prototype.prepareJson = function (arg) {
  try {
    return { json: JSON.stringify(arg) }
  } catch (e) {
    this.log('JSON encoding error.')
    return { json: null }
  }
}

HypeRPC.prototype.resolveJson = function (arg) {
  if (!arg.json) return null
  try {
    return JSON.parse(arg.json)
  } catch (e) {
    return null
  }
}

HypeRPC.prototype.prepareRpcified = function (arg, id) {
  this.objects[id] = arg
  return {
    rpcified: {
      manifest: JSON.stringify(arg.toManifest())
    }
  }
}

HypeRPC.prototype.resolveRpcified = function (arg, id) {
  var self = this
  var spec = JSON.parse(arg.rpcified.manifest)
  var MockConstructor = function () {}
  spec.methods.forEach((key) => {
    MockConstructor.prototype[key] = self.mockFunction(null, id, key)
  })
  Object.defineProperty(MockConstructor, 'name', { value: spec.name })
  return new MockConstructor()
}

HypeRPC.prototype.prepareError = function (arg) {
  return { error: JSON.stringify({ message: arg.toString() }) }
  // todo: somehow this does not alway work.
  // return Object.getOwnPropertyNames(arg).reduce((spec, name) => {
  //   spec[name] = arg[name]
  //   return spec
  // }, {})
}

HypeRPC.prototype.resolveError = function (arg, id) {
  var spec = JSON.parse(arg.error)
  var err = new Error()
  Object.getOwnPropertyNames(spec).map((name) => {
    err[name] = spec[name]
  })
  return err
}

HypeRPC.prototype.prepareCallback = function (arg, id) {
  this.callbacks[id] = arg
  return { callback: id }
}

HypeRPC.prototype.resolveCallback = function (arg) {
  var self = this
  var id = arg.callback
  return function () {
    var args = self.prepareArgs(id, Array.from(arguments))
    self.sendMsg({
      type: m.TYPE.RETURN,
      return: {
        type: m.RETURN.CALLBACK,
        id,
        args
      }
    })
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

  return { stream: { type, objectMode } }
}

HypeRPC.prototype.resolveStream = function (arg, id) {
  var { type, objectMode } = arg.stream
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

HypeRPC.prototype.prepareBuffer = function (arg) {
  return { bytes: arg }
}

HypeRPC.prototype.resolveBuffer = function (arg) {
  return arg.bytes
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
  if (!this.__logger) {
    try {
      this.__logger = require('debug')('hyperpc')
    } catch (e) {
      this.__logger = console.log
    }
  }
  var s = this.prefix + (this.name ? `=${this.name}` : '')
  this.__logger('rpcstream [%s]:', s, ...args)
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

function isRpcified (arg) {
  return arg instanceof rpcify
}

function isPromise (obj) {
  return !!obj && (typeof obj === 'object' || typeof obj === 'function') && typeof obj.then === 'function'
}

function isStream (obj) {
  return obj instanceof stream.Stream || (isObject(obj) && obj && (obj._readableState || obj._writableState))
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
